/**
 * Packs' servers (Pack.server, API 2.1, #304): a pack's code run apart from the app, locally in a
 * thread that a call over time ends, hosted over a service binding to a Worker that
 * src/packs/servers.ts generates.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packsOf } from "../src/app.ts";
import { hostedSetup } from "../src/hosted/setup.ts";
import { boundServer, localServer, serverBinding, serverWhy } from "../src/packs/server.ts";
import { buildServers, serverEntry } from "../src/packs/servers.ts";
import { packApp, serverOf } from "../src/packs/testing.ts";
import { PACK_API, type Pack, type PackServer } from "../src/packs/types.ts";
import { sha16 } from "../src/packs/wasm.ts";

/** A hand-built module: add(a, b) and spin(), a loop that never ends. */
const MATH = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x0a, 0x02, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x60, 0x00, 0x00,
  0x03, 0x03, 0x02, 0x00, 0x01,
  0x07, 0x0e, 0x02, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x04, 0x73, 0x70, 0x69, 0x6e, 0x00, 0x01,
  0x0a, 0x11, 0x02, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b, 0x07, 0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b,
]);

const SCRIPT = `
export async function call(fn, input, wasm) {
  const m = new WebAssembly.Instance(wasm.math, {}).exports;
  if (fn === "add") return { sum: m.add(input.a, input.b) };
  if (fn === "spin") return m.spin();
  if (fn === "boom") throw new Error("boom: " + input.why);
  if (fn === "env") return Object.keys(process.env);
  if (fn === "big") return "x".repeat(5 * 1024 * 1024);
}
`;
const CALLS = ["add", "spin", "boom", "env", "big"];

async function scriptFile(text = SCRIPT) {
  const bytes = new TextEncoder().encode(text);
  return { sha256: await sha16(bytes), load: () => bytes };
}

async function mathPack(over: Partial<PackServer> = {}, id = "math"): Promise<Pack> {
  return {
    manifest: { id, name: "Math", description: "Adds", domain: "general", api: PACK_API },
    wasm: { math: { sha256: await sha16(MATH), load: () => MATH } },
    server: { script: await scriptFile(), wasm: ["math"], calls: CALLS, ...over },
  };
}

test("a pack's server runs its calls in a thread: JSON in and out, its throws as errors, no environment", async () => {
  const call = serverOf(await mathPack());
  try {
    assert.deepEqual(await call("add", { a: 2, b: 40 }), { ok: true, value: { sum: 42 } });
    assert.deepEqual(await call("boom", { why: "no" }), { ok: false, error: "boom: no" });
    assert.deepEqual(await call("env", null), { ok: true, value: [] }, "the thread sees none of Dovre's environment");
    assert.deepEqual(await call("nope", {}), { ok: false, error: "nope isn't one of its calls" });
    assert.match((await call("add", { a: 1n }) as { error: string }).error, /isn't JSON/);
    assert.deepEqual(await call("add", "x".repeat(5 * 1024 * 1024)), { ok: false, error: "the input is over 4 MB" });
    assert.deepEqual(await call("big", null), { ok: false, error: "its answer is over 4 MB" });
    // Calls go one at a time, in order.
    const many = await Promise.all([1, 2, 3].map((a) => call("add", { a, b: 0 })));
    assert.deepEqual(many.map((r) => (r as { value: { sum: number } }).value.sum), [1, 2, 3]);
  } finally {
    await call.stop();
  }
});

test("a call over its time ends the thread; the next call starts a fresh one", async () => {
  const lines: string[] = [];
  const call = localServer(await mathPack({ ms: 300 }), (l) => lines.push(l));
  try {
    const t = Date.now();
    const behind = call("add", { a: 1, b: 1 });
    assert.deepEqual(await Promise.race([call("spin", null), behind.then(() => "add first")]), "add first");
    const spun = call("spin", null);
    assert.deepEqual(await spun, { ok: false, error: "spin took over 0.3 s; stopped" });
    assert.ok(Date.now() - t < 5000, "stopped, not waited out");
    assert.deepEqual(await call("add", { a: 1, b: 2 }), { ok: true, value: { sum: 3 } });
    assert.ok(lines.some((l) => /spin took over 300 ms/.test(l)), "logged under the pack");
  } finally {
    await call.stop();
  }
});

test("a server is checked before it runs: its declaration, the script's sha256, the modules'", async () => {
  assert.equal(serverWhy(await mathPack()), "");
  assert.equal(serverWhy(await mathPack({ wasm: ["nope"] })), "uses wasm nope, which the pack doesn't ship");
  assert.equal(serverWhy(await mathPack({ calls: [] })), "needs calls: camelCase names, at least one");
  assert.equal(serverWhy(await mathPack({ calls: ["no-dash"] })), "needs calls: camelCase names, at least one");
  assert.equal(serverWhy(await mathPack({ script: { sha256: "x", load: () => new Uint8Array() } })), "its script needs a 16-digit hex sha256 and a load");
  const stale = localServer(await mathPack({ script: { ...(await scriptFile()), sha256: "0000000000000000" } }));
  assert.match((await stale("add", { a: 1, b: 1 }) as { error: string }).error, /^its server didn't start: its script has SHA-256 \w{16}, not the 0000000000000000 it declares/);
  const p = await mathPack();
  p.wasm!.math = { sha256: "0000000000000000", load: () => MATH };
  assert.match((await localServer(p)("add", {}) as { error: string }).error, /didn't start: wasm math has SHA-256/);
  const noCall = localServer(await mathPack({ script: await scriptFile("export const x = 1;") }));
  assert.match((await noCall("add", {}) as { error: string }).error, /exports no call/);
  await noCall.stop();
  assert.throws(() => serverOf({ ...p, server: undefined }), /server has no server/);
});

test("ctx.call in the app: a pack's own server, and an answer, not a throw, for one without", async () => {
  const p = await mathPack();
  const plain: Pack = { manifest: { id: "plain", name: "Plain", description: "None", domain: "general", api: PACK_API } };
  const { app } = packApp([p, plain]);
  const { ctxOf } = packsOf(app)!;
  assert.deepEqual(await ctxOf(p).call("add", { a: 20, b: 22 }), { ok: true, value: { sum: 42 } });
  assert.deepEqual(await ctxOf(plain).call("add", {}), { ok: false, error: "Plain has no server" });
});

test("hosted: a call goes over the pack's binding, and a missing binding says what to add", async () => {
  const p = await mathPack({}, "code-review");
  assert.equal(serverBinding("code-review"), "SERVER_CODE_REVIEW");
  const asked: [string, string][] = [];
  const call = boundServer(p, { call: async (fn: string, input: string) => (asked.push([fn, input]), JSON.stringify({ sum: 3 })) });
  assert.deepEqual(await call("add", { a: 1, b: 2 }), { ok: true, value: { sum: 3 } });
  assert.deepEqual(asked, [["add", '{"a":1,"b":2}']]);
  assert.deepEqual(await call("nope", {}), { ok: false, error: "nope isn't one of its calls" }, "checked before it's sent");
  assert.match((await boundServer(p, undefined)("add", {}) as { error: string }).error, /isn't bound here \(SERVER_CODE_REVIEW/);
  assert.deepEqual(await boundServer(p, { call: async () => Promise.reject(new Error("Worker exceeded CPU time limit.")) })("add", {}), { ok: false, error: "Worker exceeded CPU time limit." });
  assert.deepEqual(await boundServer(p, { call: async () => "{nope" })("add", {}), { ok: false, error: "it answered something that isn't JSON" });
  const lines = hostedSetup({}, { servers: [{ name: "Code review", binding: "SERVER_CODE_REVIEW" }] }).filter((l) => l.name.startsWith("Pack server"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.on, false);
  assert.match(lines[0]!.fix ?? "", /servers\.ts .*SERVER_CODE_REVIEW/);
  assert.equal(hostedSetup({ SERVER_CODE_REVIEW: {} } as never, { servers: [{ name: "Code review", binding: "SERVER_CODE_REVIEW" }] }).find((l) => l.name.startsWith("Pack server"))!.on, true);
});

test("servers.ts writes a Worker per pack with a server: its modules imported, no URL, its CPU limit, the binding to add", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "servers-")), ".servers");
  const plain: Pack = { manifest: { id: "plain", name: "Plain", description: "None", domain: "general", api: PACK_API } };
  const built = await buildServers({ packs: [await mathPack({ ms: 5000 }, "code-review"), plain], out, name: "dovre", compat: "2026-10-06" });
  assert.deepEqual(built.map((b) => [b.worker, b.binding]), [["dovre-pack-code-review", { binding: "SERVER_CODE_REVIEW", service: "dovre-pack-code-review", entrypoint: "PackServer" }]]);
  const dir = join(out, "code-review");
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, "math.wasm"))), MATH);
  assert.equal(readFileSync(join(dir, "server.js"), "utf8"), SCRIPT);
  const config = JSON.parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8").replace(/^\/\/.*\n/, ""));
  assert.deepEqual(config, { name: "dovre-pack-code-review", main: "index.js", compatibility_date: "2026-10-06", workers_dev: false, preview_urls: false, limits: { cpu_ms: 5000 }, rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: false }] });
  await assert.rejects(buildServers({ packs: [await mathPack({ wasm: ["nope"] })], out, name: "dovre" }), /pack math: server uses wasm nope/);
  await assert.rejects(buildServers({ packs: [], out, name: "Not ok" }), /isn't a lowercase Worker name/);
});

test("the generated entry runs the script with the modules it imports, and takes only its calls", async () => {
  const entry = serverEntry(["add"], ["math"]);
  // As the Worker would load it: cloudflare:workers, the script and the module stood in for.
  const runnable = entry
    .replace('import { WorkerEntrypoint } from "cloudflare:workers";', "class WorkerEntrypoint {}")
    .replace('import { call } from "./server.js";', `import { call } from "data:text/javascript;base64,${Buffer.from(SCRIPT).toString("base64")}";`)
    .replace('import w0 from "./math.wasm";', "const w0 = globalThis.__mathModule;");
  (globalThis as { __mathModule?: WebAssembly.Module }).__mathModule = await WebAssembly.compile(MATH);
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(runnable).toString("base64")}`)) as { PackServer: new () => { call(fn: string, input: string): Promise<string> }; default: { fetch(): Response } };
  const s = new mod.PackServer();
  assert.equal(await s.call("add", '{"a":4,"b":5}'), '{"sum":9}');
  await assert.rejects(s.call("spin", "null"), /not one of its calls/);
  assert.equal(mod.default.fetch().status, 404, "no page of its own");
});
