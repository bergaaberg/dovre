/** The docker pack (src/packs/core/docker/): the model reads strictly, the service only does what's on its list, the pages keep hostile names inert. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { createDocker, type Docker, findEngineSocket, readPipe } from "../docker.ts";
import { createEngine, demuxer } from "../engine.ts";
import { allowed, groupsOf, parseContainers } from "../model.ts";
import { dockerPage } from "../view.ts";
import { dockerPack } from "../index.ts";
import { dockerRoutes } from "../routes.ts";
import type { AppEnv } from "../../../../env.ts";
import { shell } from "../../../../html.ts";
import { H, assertInert, signedIn, snapshot } from "../../../../../test/helpers.ts";

/** The pack's routes on their own, in a shell whose frame is `operator`'s. */
function routesOf(docker: Docker, operator: string) {
  const app = new Hono<AppEnv>();
  dockerRoutes(app, () => docker, async (c, o) => c.html(shell({ title: o.title, frame: { operator, nav: [], host: "acme.ghe.com" }, current: o.current ?? c.req.path, body: o.body, head: o.head })));
  return app;
}

const ID = "a".repeat(64);
const ID2 = "b".repeat(64);
const raw = (o: Record<string, unknown> = {}) => ({ Id: ID, Names: ["/sql"], Image: "mcr.microsoft.com/mssql/server:2022-latest", State: "running", Status: "Up 2 hours (healthy)", Ports: [{ IP: "0.0.0.0", PrivatePort: 1433, PublicPort: 1433, Type: "tcp" }, { IP: "::", PrivatePort: 1433, PublicPort: 1433, Type: "tcp" }], Labels: { "com.docker.compose.project": "shop", "com.docker.compose.service": "db" }, Created: 1_700_000_000, ...o });

test("containers read strictly: odd ids and states are left out, ports told once", () => {
  const got = parseContainers([raw(), raw({ Id: "nope" }), raw({ Id: ID2, State: "exploded" }), raw({ Id: "c".repeat(64), Names: ["/x"], Labels: { "com.docker.compose.project": "../evil" }, Ports: "x" })]);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { id: ID, name: "sql", image: "mcr.microsoft.com/mssql/server:2022-latest", state: "running", status: "Up 2 hours (healthy)", health: "healthy", ports: ["1433→1433/tcp"], project: "shop", service: "db", created: 1_700_000_000_000 });
  assert.equal(got[1]!.project, undefined, "a project name compose wouldn't make isn't one");
  assert.deepEqual(got[1]!.ports, []);
  assert.throws(() => parseContainers({ message: "no" }));
});

test("groups: compose projects by name, loose containers last, running first", () => {
  const cs = parseContainers([raw({ Id: ID, Names: ["/b"], State: "exited" }), raw({ Id: ID2, Names: ["/a"] }), raw({ Id: "c".repeat(64), Names: ["/loose"], Labels: {} })]);
  const g = groupsOf(cs);
  assert.deepEqual(g.map((x) => [x.project, x.containers.map((c) => c.name), x.running]), [["shop", ["a", "b"], 1], [undefined, ["loose"], 1]]);
});

test("a verb is only for a container in a state it fits", () => {
  assert.ok(allowed("start", "exited") && !allowed("start", "running"));
  assert.ok(allowed("stop", "running") && !allowed("stop", "exited"));
  assert.ok(!allowed("remove", "running") && allowed("remove", "exited"));
});

test("logs without a TTY come apart into their frames, across chunks", () => {
  const out: string[] = [];
  const feed = demuxer((b) => out.push(b.toString()));
  const frame = (s: string, kind = 1) => Buffer.concat([Buffer.from([kind, 0, 0, 0, 0, 0, 0, Buffer.byteLength(s)]), Buffer.from(s)]);
  const all = Buffer.concat([frame("hello\n"), frame("oops\n", 2)]);
  feed(all.subarray(0, 5));
  feed(all.subarray(5, 17));
  feed(all.subarray(17));
  assert.deepEqual(out, ["hello\n", "oops\n"]);
});

test("only a local pipe's name is taken from the launcher's file", () => {
  const dir = mkdtempSync(join(tmpdir(), "u-docker-"));
  const f = join(dir, "p");
  writeFileSync(f, "\\\\.\\pipe\\dovre_docker\n");
  assert.equal(readPipe(f), "\\\\.\\pipe\\dovre_docker");
  writeFileSync(f, "\\\\evil-host\\pipe\\x");
  assert.equal(readPipe(f), undefined);
  assert.equal(readPipe(join(dir, "none")), undefined);
});

/** A Docker Engine on a real pipe (or socket), answering from `state`, recording what it's asked. */
async function fakeEngine(list: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), "u-docker-"));
  const at = process.platform === "win32" ? `\\\\.\\pipe\\dovre-test-${process.pid}-${Math.random().toString(36).slice(2)}` : join(dir, "d.sock");
  const calls: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? "").replace(/^\/v1\.\d+/, "");
    calls.push(`${req.method} ${url}`);
    const json = (s: number, b: unknown) => (res.writeHead(s, { "content-type": "application/json" }), res.end(JSON.stringify(b)));
    if (url.startsWith("/containers/json")) return json(200, list);
    if (url === "/version") return json(200, { Version: "29.1.3" });
    if (url.startsWith("/events")) return void res.writeHead(200); // held open, like the engine
    const m = url.match(/^\/containers\/([0-9a-f]+)(?:\/(\w+))?/);
    if (m && req.method === "POST") {
      const c = list.find((x) => x.Id === m[1]);
      if (c) c.State = m[2] === "stop" ? "exited" : "running";
      return void (res.writeHead(204), res.end());
    }
    if (m && req.method === "DELETE") return void (res.writeHead(204), res.end());
    if (m && url.endsWith("/json")) return json(200, { Config: { Tty: true } });
    if (url.includes("/logs")) return void (res.writeHead(200), res.end("line one\nline two\n"));
    json(404, { message: "no such thing" });
  });
  await new Promise<void>((r) => server.listen(at, r));
  const pipeFile = join(dir, "docker-pipe");
  writeFileSync(pipeFile, at);
  return { at, calls, dir, pipeFile, close: () => server.close() };
}

const settle = () => new Promise((r) => setTimeout(r, 120));

test("the service lists, acts after re-reading, logs by name, and switches the engine off", async (t) => {
  const list = [raw(), raw({ Id: ID2, Names: ["/web"], State: "exited", Labels: {} })];
  const e = await fakeEngine(list);
  t.after(e.close);
  const logged: string[] = [];
  let terminated = 0;
  const docker = createDocker({ engine: createEngine(() => readPipe(e.pipeFile)), pipeFile: e.pipeFile, offFile: join(e.dir, "off"), ours: true, log: async (k, target, ok) => void logged.push(`${k} ${target} ${ok}`), terminate: async () => void terminated++ });
  t.after(docker.stop);
  await docker.refresh();
  assert.equal(docker.view().state, "ok");
  assert.equal(docker.view().version, "29.1.3");
  assert.equal(docker.view().containers.length, 2);

  docker.act(ID2, "stop"); // it's exited: refused after the re-read, nothing sent
  await settle();
  assert.ok(!e.calls.some((c) => c.startsWith(`POST /containers/${ID2}`)));
  assert.match(docker.takeFlash()!.message, /exited now/);

  docker.act(ID2, "start");
  assert.equal(docker.view().busy[ID2], "start", "busy at once; the page redirects without waiting");
  await settle();
  assert.ok(e.calls.includes(`POST /containers/${ID2}/start`));
  assert.deepEqual(logged, ["docker.stop web false", "docker.start web true"]);
  assert.equal(docker.view().busy[ID2], undefined);

  assert.equal(docker.act("../../x", "start").ok, false);
  docker.engine(false);
  assert.ok(existsSync(join(e.dir, "off")));
  assert.equal(docker.view().state, "off");
  await settle();
  assert.equal(terminated, 1);
});

test("the routes: strict origin on writes, ids checked, hostile names inert", async (t) => {
  const list = [raw({ Names: [`/${H}`], Image: H, Status: H, Labels: { "com.docker.compose.service": H } })];
  const e = await fakeEngine(list);
  t.after(e.close);
  const docker = createDocker({ engine: createEngine(() => readPipe(e.pipeFile)), pipeFile: e.pipeFile, offFile: join(e.dir, "off") });
  t.after(docker.stop);
  await docker.refresh();
  const app = routesOf(docker, H);
  const get = (p: string) => app.request(`http://localhost${p}`);
  for (const p of ["/docker", `/docker/c/${ID}`]) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assertInert(p, await res.text());
  }
  assert.equal((await get(`/docker/c/${"f".repeat(64)}`)).status, 404);
  const post = (p: string, headers: Record<string, string>) => app.request(`http://localhost${p}`, { method: "POST", headers });
  assert.equal((await post(`/docker/c/${ID}/stop`, {})).status, 403, "no Origin, no write");
  assert.equal((await post(`/docker/c/${ID}/stop`, { origin: "http://evil.example" })).status, 403);
  assert.equal((await post(`/docker/c/${ID}/exec`, { origin: "http://localhost" })).status, 404, "nothing off the list");
  assert.equal((await post(`/docker/c/${ID}/stop`, { origin: "http://localhost", "sec-fetch-site": "cross-site" })).status, 404);
  const ok = await post(`/docker/c/${ID}/stop`, { origin: "http://localhost" });
  assert.equal(ok.status, 303);
  await settle();
  assert.ok(e.calls.includes(`POST /containers/${ID}/stop`));
  const logs = await (await get(`/docker/c/${ID}/logs`)).text();
  assert.match(logs, /event: out\ndata: "line one\\nline two\\n"/);
});

test("no engine set up: the page says how, and nothing is asked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u-docker-"));
  const docker = createDocker({ engine: createEngine(() => undefined), pipeFile: join(dir, "none"), offFile: join(dir, "off"), ours: true });
  await docker.refresh();
  assert.equal(docker.view().state, "none");
  const app = routesOf(docker, "me");
  assert.match(await (await app.request("http://localhost/docker")).text(), /scripts\/docker\.ps1/);
  docker.stop();
});

test("in the app: the Docker pages keep the engine's names inert", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "u-docker-app-"));
  writeFileSync(join(dir, "pipe"), "\\\\.\\pipe\\none");
  const id = "e".repeat(64);
  const list = [{ Id: id, Names: [`/${H}`], Image: H, State: "running", Status: H, Ports: [], Labels: { "com.docker.compose.project": "p1", "com.docker.compose.service": H } }];
  const engine = { json: async (_m: string, path: string) => ({ status: 200, body: path.startsWith("/containers/json") ? list : { Version: H } }), stream: async () => 200 };
  const docker = createDocker({ engine, pipeFile: join(dir, "pipe"), offFile: join(dir, "off") });
  t.after(docker.stop);
  await docker.refresh();
  const pack = dockerPack(() => docker);
  await pack.init!({} as never);
  const { get } = signedIn(snapshot(), {}, { packs: [pack] });
  for (const path of ["/docker", `/docker/c/${id}`, "/search?q=docker"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assertInert(path, await res.text());
  }
  assert.match(await (await get("/")).text(), /href="\/docker"/, "in the menu");
  // Off like any pack: gone from the menu, its pages 404.
  const off = signedIn(snapshot(), {}, { packs: [pack], packEnv: { PACK_DOCKER: "off" } });
  assert.equal((await off.get("/docker")).status, 404);
  assert.doesNotMatch(await (await off.get("/")).text(), /href="\/docker"/);
});

test("findEngineSocket: finds engine socket in order, ignoring remote tcp hosts and missing files", () => {
  const home = "/Users/alice";
  const existing = new Set<string>();
  const exists = (p: string) => existing.has(p);

  // 1. None exists: returns undefined
  assert.equal(findEngineSocket({}, home, exists), undefined);

  // 2. /var/run/docker.sock
  existing.add("/var/run/docker.sock");
  assert.equal(findEngineSocket({}, home, exists), "/var/run/docker.sock");

  // 3. XDG_RUNTIME_DIR
  existing.add("/run/user/1000/docker.sock");
  assert.equal(findEngineSocket({ XDG_RUNTIME_DIR: "/run/user/1000" }, home, exists), "/run/user/1000/docker.sock");

  // 4. Colima
  existing.add("/Users/alice/.colima/default/docker.sock");
  assert.equal(findEngineSocket({}, home, exists), "/Users/alice/.colima/default/docker.sock");

  // 5. OrbStack
  existing.add("/Users/alice/.orbstack/run/docker.sock");
  assert.equal(findEngineSocket({}, home, exists), "/Users/alice/.orbstack/run/docker.sock");

  // 6. Docker Desktop
  existing.add("/Users/alice/.docker/run/docker.sock");
  assert.equal(findEngineSocket({}, home, exists), "/Users/alice/.docker/run/docker.sock");

  // 7. DOCKER_HOST with unix://
  existing.add("/custom/daemon.sock");
  assert.equal(findEngineSocket({ DOCKER_HOST: "unix:///custom/daemon.sock" }, home, exists), "/custom/daemon.sock");

  // DOCKER_HOST with tcp:// is ignored (falls back to Docker Desktop)
  assert.equal(findEngineSocket({ DOCKER_HOST: "tcp://127.0.0.1:2375" }, home, exists), "/Users/alice/.docker/run/docker.sock");

  // 8. DOCKER_PIPE
  existing.add("/explicit/pipe.sock");
  assert.equal(findEngineSocket({ DOCKER_PIPE: "/explicit/pipe.sock", DOCKER_HOST: "unix:///custom/daemon.sock" }, home, exists), "/explicit/pipe.sock");

  // Missing DOCKER_PIPE falls through
  assert.equal(findEngineSocket({ DOCKER_PIPE: "/missing/pipe.sock", DOCKER_HOST: "unix:///custom/daemon.sock" }, home, exists), "/custom/daemon.sock");
});

test("off Windows: ours is false, no engine controls or wsl calls, containers still act", async (t) => {
  const list = [raw({ Id: ID, State: "running" }), raw({ Id: ID2, State: "exited", Names: ["/web"] })];
  const e = await fakeEngine(list);
  t.after(e.close);
  let terminated = 0;
  const logged: string[] = [];
  const docker = createDocker({
    engine: createEngine(() => readPipe(e.pipeFile)),
    pipeFile: e.pipeFile,
    offFile: join(e.dir, "off"),
    ours: false,
    log: async (k, target, ok) => void logged.push(`${k} ${target} ${ok}`),
    terminate: async () => void terminated++,
  });
  t.after(docker.stop);
  await docker.refresh();

  assert.equal(docker.view().ours, false);
  assert.equal(docker.view().state, "ok");

  // Engine on/off is refused: does not touch offFile and never calls terminate
  assert.deepEqual(docker.engine(false), { ok: false, message: "This engine isn't Dovre's to switch." });
  assert.deepEqual(docker.engine(true), { ok: false, message: "This engine isn't Dovre's to switch." });
  assert.equal(existsSync(join(e.dir, "off")), false);
  assert.equal(terminated, 0);

  // The page has no Stop Docker button
  const app = routesOf(docker, "tester");
  const pageHtml = await (await app.request("http://localhost/docker")).text();
  assert.doesNotMatch(pageHtml, /action="\/docker\/engine\/off"/);
  assert.doesNotMatch(pageHtml, /Stop Docker/);

  // But container actions still work
  docker.act(ID2, "start");
  await settle();
  assert.ok(e.calls.includes(`POST /containers/${ID2}/start`));
  assert.deepEqual(logged, ["docker.start web true"]);
});

test("no engine found: a Mac is pointed at scripts/docker.sh (Colima, #101); Dovre's own engine at docker.ps1", () => {
  const none = { state: "none" as const, containers: [], busy: {} };
  const mac = String(dockerPage({ ...none, ours: false }).body);
  assert.match(mac, /No Docker engine found/);
  assert.match(mac, /<pre class="code">sh scripts\/docker\.sh<\/pre>/);
  const win = String(dockerPage({ ...none, ours: true }).body);
  assert.match(win, /pwsh scripts\/docker\.ps1/);
  assert.doesNotMatch(win, /docker\.sh/);
});
