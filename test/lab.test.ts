/** The lab: shown in the nav only when there is one, every page has a way back, and a lab page can't act as me. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { harnessTag } from "../src/pages/parts.ts";
import { fakeGhe, fixedGatherer, session, signedIn, snapshot } from "./helpers.ts";

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };

function appWithLab(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "dovre-lab-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, "lab", name, ".."), { recursive: true });
    writeFileSync(join(dir, "lab", name), body);
  }
  const app = createApp({ ...ENV, U_DB: join(dir, "u.sqlite"), DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe });
  return (path: string) => app.request(`http://127.0.0.1:4848${path}`, { headers: { cookie: "u_tk=test-token" } });
}

test("the Lab is in the nav only when there's one", async () => {
  const without = appWithLab({});
  assert.doesNotMatch(await (await without("/")).text(), /href="\/lab"/);
  const withLab = appWithLab({ "index.html": "<!doctype html><title>Looks</title><body><h1>Looks</h1></body>" });
  assert.match(await (await withLab("/")).text(), /href="\/lab"/);
});

test("every lab page has a way back to the app, and may show and frame only the lab", async () => {
  const get = appWithLab({ "index.html": "<!doctype html><html><body class=x><iframe src=\"a/one.html\"></iframe></body></html>", "a/one.html": "<p>a fragment</p>" });
  for (const path of ["/lab/index.html", "/lab/a/one.html"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const out = await res.text();
    assert.match(out, /id="u-lab-exit"[^>]*>← Dovre<\/a>/, `${path}: the way back`);
    assert.match(out, /href="\/" target="_top"/, "back to the app, out of any frame");
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const rule of ["connect-src 'none'", "form-action 'none'", "frame-src http://127.0.0.1:4848/lab/", "default-src 'none'"]) assert.ok(csp.includes(rule), `${path}: ${rule} in ${csp}`);
    assert.ok(!/frame-src[^;]*'self'/.test(csp), "can't frame the app's own pages");
  }
  assert.match(await (await get("/lab/index.html")).text(), /<body class=x><a href="\/"/, "the link goes right after <body>");
  assert.equal((await get("/lab/../u.sqlite")).status, 404);
  assert.equal((await get("/lab/a/one.js")).status, 404);
});

test("every agent says which harness it runs in", async () => {
  assert.match(String(harnessTag("claude")), /class="harness claude"[^>]*>Claude Code</);
  assert.match(String(harnessTag("omp", "github-copilot/gpt-6-luna")), /Copilot · omp<span class="harness-m"> · gpt-6-luna/);
  assert.match(String(harnessTag(undefined)), /Claude Code/, "sessions from before harnesses were told apart are Claude's");
  const { get } = signedIn(snapshot(), {}, { sessions: { live: [session({ title: "A", harness: "omp" }), session({ title: "B", sessionId: "b0000000-0000-0000-0000-000000000000" })] } });
  for (const path of ["/", "/agents"]) {
    const out = await (await get(path)).text();
    assert.match(out, /harness omp/, `${path}: omp tagged`);
    assert.match(out, /harness claude/, `${path}: Claude tagged`);
  }
});

test("the side menu: Today, then Code, Agents and Plan in groups (a pack adds Ops); Settings at the foot; the page you're on marked", async () => {
  const { get } = signedIn(snapshot());
  const out = await (await get("/")).text();
  const side = out.slice(out.indexOf('<nav class="side"'), out.indexOf("</nav>"));
  const groups = [...side.matchAll(/<p class="side-h">([^<]+)<\/p>/g)].map((m) => m[1]);
  assert.deepEqual(groups, ["Code", "Agents", "Plan"]);
  const hrefs = [...side.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of ["/", "/prs", "/deploys", "/worktrees", "/code", "/movement", "/agents", "/todo", "/issues/new", "/settings"]) assert.ok(hrefs.includes(href), href);
  assert.ok(hrefs.indexOf("/settings") > hrefs.indexOf("/issues/new"), "Settings at the foot");
  assert.match(side, /<a href="\/" title="Today" aria-current="page">/);
  assert.match(out, /<script src="\/assets\/side\.js"><\/script>/, "folded before the page draws");
  const stacks = await (await get("/prs/stacks")).text();
  assert.match(stacks, /<a href="\/prs" title="Pull requests" aria-current="page">/, "a page under Pull requests marks it");
  const js = await get("/assets/side.js");
  assert.equal(js.status, 200);
  assert.match(await js.text(), /u-side/);
});
