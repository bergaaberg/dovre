/** The Agents setup (#425): languages found in my repos, the two sandbox files each gets, one PR a repo. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setupOf } from "../../../../agents/sandbox.ts";
import { allowOf } from "../../../../agents/egress.ts";
import type { Proposal } from "../../../../actions/propose.ts";
import { type Pack, PACK_API } from "../../../types.ts";
import { agentsSetup, BUDGET_MS, byLang, configText, LANGS, SANDBOX_KIND, STALE_MS } from "../setup.ts";
import { signedIn, snapshot } from "../../../../../test/helpers.ts";

const REPOS: { repo: string; files: Record<string, string> }[] = [
  { repo: "ACME/web", files: { "package.json": "{}", "pnpm-lock.yaml": "" } },
  { repo: "ACME/api", files: { "package.json": "{}", "pnpm-lock.yaml": "" } },
  { repo: "ACME/ingest", files: { "Cargo.toml": "", "package.json": "{}" } },
  { repo: "ACME/docs", files: { "package.json": "{}" } },
  { repo: "ACME/done", files: { ".dovre/sandbox.json": "{}", "go.mod": "" } },
  { repo: "ACME/notes", files: {} },
];
/** A repo name the forge shouldn't send, drawn as text. */
const HOSTILE: { repo: string; files: Record<string, string> } = { repo: 'ACME/<img src=x onerror="alert(1)">', files: { "package.json": "{}" } };

test("byLang: one language a repo, the first that matches; a repo with a sandbox is apart", () => {
  const { langs, have } = byLang(REPOS);
  assert.deepEqual(Object.fromEntries(langs), { pnpm: ["ACME/web", "ACME/api"], rust: ["ACME/ingest"], npm: ["ACME/docs"] });
  assert.deepEqual(have, ["ACME/done"]);
});

test("each language's sandbox.json reads back as the sandbox reads it", () => {
  for (const l of LANGS) {
    assert.deepEqual(allowOf(configText(l)), l.allow, l.id);
    assert.equal(setupOf(configText(l)), l.setup, l.id);
    assert.match(l.containerfile, /^# .*\nFROM dovre-sandbox\n/, l.id);
  }
});

function agentsLike() {
  const s = agentsSetup();
  const pack: Pack = {
    manifest: { api: PACK_API, id: "agents", name: "Agents", description: "", domain: "general", onboard: { steps: [{ id: "repos", title: "Which repos get a sandbox?" }, { id: "files", title: "Here's what goes in." }, { id: "open", title: "Open the PRs?" }] } },
    writes: [{ kind: SANDBOX_KIND, label: "Sandbox PRs" }],
    setup: s.setup,
    routes: (app, ctx) => s.routes(app, ctx),
  };
  return pack;
}

const settle = async (get: (p: string) => Promise<Response> | Response, until: RegExp) => {
  for (let i = 0; i < 50; i++) {
    const page = await (await get("/setup/agents?at=open")).text();
    if (until.test(page)) return page;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`never: ${until}`);
};

test("the Agents setup: pick languages, see the files, open one PR a repo with both, wait till they're open", async () => {
  const asked: Proposal[] = [];
  const { get, post } = signedIn(snapshot(), {}, {
    packs: [agentsLike()],
    forge: {
      id: "github",
      name: "GitHub",
      can: [],
      host: "github.com",
      everyRepo: async () => [...REPOS, HOSTILE],
      propose: async (p) => {
        asked.push(p);
        if (p.repo === "ACME/api") throw new Error(".dovre/sandbox.Containerfile exists now.");
        return { number: 40 + asked.length, url: `https://github.com/${p.repo}/pull/${40 + asked.length}` };
      },
    },
  });

  const first = await (await get("/setup/agents")).text();
  assert.match(first, /JavaScript · pnpm · 2 repos.*ACME\/web, ACME\/api/s);
  assert.match(first, /name="lang" value="rust" checked/, "all ticked at first");
  assert.match(first, /1 repo has a sandbox already: ACME\/done/);
  assert.ok(!first.includes("<img src=x") && first.includes("&lt;img src=x"), "a repo's name is text");

  assert.equal((await post("/setup/agents/next", "step=repos&lang=pnpm&lang=rust")).headers.get("location"), "/setup/agents?at=files");
  const files = await (await get("/setup/agents?at=files")).text();
  assert.match(files, /<h3>Rust<\/h3>.*&quot;cargo fetch&quot;.*<h3>JavaScript · pnpm<\/h3>.*pnpm install --frozen-lockfile/s);
  assert.doesNotMatch(files, /JavaScript · npm/, "only the picked ones");
  await post("/setup/agents/next", "step=files");

  const open = await (await get("/setup/agents?at=open")).text();
  assert.match(open, /Opens 3 PRs, one per repo/);
  assert.match(open, /action="\/agents\/setup\/open"/);
  assert.match(open, /climb-go" disabled/, "Next waits for the PRs");
  assert.doesNotMatch(open, /http-equiv="refresh"/, "nothing reloads under the Confirm");

  assert.equal((await post("/agents/setup/open", "")).headers.get("location"), "/setup/agents?at=open");
  const after = await settle(get, /didn&#39;t open|didn't open/);
  assert.deepEqual(asked.map((p) => [p.repo, p.files.map((f) => f.path)]), [
    ["ACME/ingest", [".dovre/sandbox.json", ".dovre/sandbox.Containerfile"]],
    ["ACME/web", [".dovre/sandbox.json", ".dovre/sandbox.Containerfile"]],
    ["ACME/api", [".dovre/sandbox.json", ".dovre/sandbox.Containerfile"]],
  ]);
  assert.ok(asked.every((p) => p.files.every((f) => f.expect === null)));
  assert.match(asked[0]!.files[0]!.text, /"cargo fetch"/);
  assert.match(after, /#41 open/);
  assert.match(after, /sandbox.Containerfile exists now/);
  assert.match(after, /Try 1 repo again/);
  assert.doesNotMatch(after, /climb-go" disabled/, "every repo was tried: Next goes on");

  // Again: only the one that didn't open.
  await post("/agents/setup/open", "");
  await settle(get, /Try 1 repo again/);
  assert.equal(asked.at(-1)!.repo, "ACME/api");
  assert.equal(asked.length, 4);
  assert.equal((await post("/setup/agents/next", "step=open")).headers.get("location"), "/setup/agents?at=done");

  // Run it again: the repos whose PRs opened aren't asked twice; the one that never opened is.
  await post("/setup/agents/next", "step=repos&lang=pnpm&lang=rust");
  assert.match(await (await get("/setup/agents?at=open")).text(), /Opens 1 PR,/);
  await post("/agents/setup/open", "");
  await settle(get, /Try 1 repo again/);
  assert.deepEqual(asked.slice(4).map((p) => p.repo), ["ACME/api"]);
});

test("the Agents setup: a press opens what fits in its time; the rest wait for the next press", async () => {
  const asked: string[] = [];
  // Each PR takes 15 s on this clock: the first two start inside BUDGET_MS, the third doesn't.
  const real = performance.now.bind(performance);
  let skew = 0;
  performance.now = () => real() + skew;
  try {
    const { get, post } = signedIn(snapshot(), {}, {
      packs: [agentsLike()],
      forge: {
        id: "github",
        name: "GitHub",
        can: [],
        host: "github.com",
        everyRepo: async () => REPOS,
        propose: async (p) => {
          asked.push(p.repo);
          skew += BUDGET_MS * 0.75;
          return { number: asked.length, url: `https://github.com/${p.repo}/pull/${asked.length}` };
        },
      },
    });
    await post("/setup/agents/next", "step=repos&lang=pnpm&lang=rust");
    await post("/setup/agents/next", "step=files");
    await post("/agents/setup/open", "");
    const first = await settle(get, /Open 1 more PR/);
    assert.equal(asked.length, 2, "the third waits: the time ran out");
    assert.match(first, /1 PR to go/);
    assert.match(first, /not yet/, "the one it didn't reach isn't \"opening\"");
    assert.doesNotMatch(first, /opening…/);
    assert.match(first, /climb-go" disabled/, "Next waits for it");
    await post("/agents/setup/open", "");
    const all = await settle(get, /All 3 PRs open/);
    assert.deepEqual(asked, ["ACME/ingest", "ACME/web", "ACME/api"]);
    assert.doesNotMatch(all, /climb-go" disabled/);
  } finally {
    performance.now = real;
  }
});

test("the Agents setup: a job gone silent (its isolate died) stops saying it's opening, and the button is back", async () => {
  const { get, db } = signedIn(snapshot(), {}, {
    packs: [agentsLike()],
    forge: { id: "github", name: "GitHub", can: [], host: "github.com", everyRepo: async () => REPOS, propose: async (p) => ({ number: 1, url: `https://github.com/${p.repo}/pull/1` }) },
  });
  const put = (running: number) =>
    db.DB.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES (?, ?, ?)").bind("agents.sandboxes", JSON.stringify({ langs: ["pnpm"], repos: ["ACME/web"], prs: {}, running }), new Date().toISOString()).run();
  await put(Date.now() - 5_000);
  const alive = await (await get("/setup/agents?at=open")).text();
  assert.match(alive, /Opening 1 PR…/);
  assert.match(alive, /opening…/);
  await put(Date.now() - STALE_MS - 1_000);
  const dead = await (await get("/setup/agents?at=open")).text();
  assert.doesNotMatch(dead, /Opening 1 PR…|opening…/);
  assert.match(dead, /not yet/);
  assert.match(dead, /Open 1 more PR/);
});

test("the Agents setup waits for the repos, and says so when the forge can't open PRs", async () => {
  const { get } = signedIn(snapshot(), {}, { packs: [agentsLike()], forge: { id: "gitlab", name: "GitLab", can: [], host: "gitlab.com", everyRepo: async () => REPOS } });
  assert.match(await (await get("/setup/agents")).text(), /doesn&#39;t reach|doesn't reach/);
});
