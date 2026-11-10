/**
 * First run's suggestions (#415, src/packs/suggest.ts): packs say which roles, answers and marker
 * files suit them; core asks and suggests without naming a pack.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { answersOf, INTERVIEW, markerMatches, markersOf, onboardOf, QUESTIONS, rolesOf, ROLES, suggest } from "../src/packs/suggest.ts";
import type { PackManifest } from "../src/packs/types.ts";
import { assistantPack } from "../src/packs/core/assistant/index.ts";
import { autoreviewPack } from "../src/packs/core/autoreview/index.ts";
import { dependabotPack } from "../src/packs/core/dependabot/index.ts";
import { deploysPack } from "../src/packs/core/deploys/index.ts";
import { historyPack } from "../src/packs/core/history/index.ts";
import { issuesPack } from "../src/packs/core/issues/index.ts";
import { prsPack } from "../src/packs/core/prs/index.ts";
import { reviewsPack } from "../src/packs/core/reviews/index.ts";
import { stacksPack } from "../src/packs/core/stacks/index.ts";
import { terminalPack } from "../src/packs/core/terminal/index.ts";
import { todoPack } from "../src/packs/core/todo/index.ts";

const m = (id: string, more: Partial<PackManifest> = {}): PackManifest => ({ api: "2.0", id, name: id, description: "", domain: "general", ...more });

test("every role has two questions the interview knows, and every option is lowercase", () => {
  for (const [role, qs] of Object.entries(INTERVIEW)) {
    assert.ok(ROLES[role as keyof typeof ROLES]);
    assert.equal(qs.length, 2, role);
    for (const q of qs) assert.ok(QUESTIONS[q], `${role}: ${q}`);
  }
  for (const q of Object.values(QUESTIONS)) for (const o of q.opts) assert.match(o.v, /^[a-z]+$/);
});

test("the checks keep known roles and answers, each once", () => {
  const x = m("x", { roles: ["dev", "dev", "boss" as never, 3 as never, "an"], answers: ["tasks:linear", "tasks:linear", "tasks:trello", "nope:x", "TASKS:linear", 7 as never] });
  assert.deepEqual(rolesOf(x), ["dev", "an"]);
  assert.deepEqual(answersOf(x), ["tasks:linear"]);
  assert.deepEqual(rolesOf(m("y", { roles: "dev" as never })), []);
  assert.deepEqual(answersOf(undefined), []);
});

test("markers are relative names: folders end in /, a * only in the last part, at most 3 parts and 8", () => {
  const ok = ["wrangler.toml", ".storybook/", "*.http", ".github/dependabot.yml", "a/b/c.txt", "docs/"];
  const bad = ["/etc/passwd", "../up.txt", "a/../b", "./x", "a/b/c/d", "*", ".*", "*/x.txt", "a b.txt", "", "x".repeat(81), "a//b"];
  assert.deepEqual(markersOf(m("x", { markers: [...ok, ...bad] })), ok);
  assert.equal(markersOf(m("x", { markers: Array.from({ length: 12 }, (_, i) => `f${i}.txt`) })).length, 8);
  assert.deepEqual(markersOf(m("x", { markers: "x.txt" as never })), []);
});

test("a marker matches a path in a checkout by name, a folder only as a folder", () => {
  assert.ok(markerMatches("wrangler.toml", "wrangler.toml"));
  assert.ok(!markerMatches("wrangler.toml", "sub/wrangler.toml"));
  assert.ok(markerMatches(".storybook/", ".storybook/"));
  assert.ok(!markerMatches(".storybook/", ".storybook"));
  assert.ok(!markerMatches("Dockerfile", "Dockerfile/"));
  assert.ok(markerMatches("*.http", "api.http"));
  assert.ok(!markerMatches("*.http", "api.https"));
  assert.ok(!markerMatches("*.http", "api.xhttp.txt"));
  assert.ok(markerMatches(".github/dependabot.yml", ".github/dependabot.yml"));
  assert.ok(!markerMatches(".github/dependabot.yml", "x/dependabot.yml"));
  // The dot is a dot, not any character.
  assert.ok(!markerMatches("a.b", "axb"));
});

test("a pack's own setup: up to 3 steps with lowercase unique ids and a title; required only when it says so", () => {
  const steps = [{ id: "one", title: "One" }, { id: "One", title: "Bad id" }, { id: "one", title: "Again" }, { id: "two", title: "  \n " }, { id: "three", title: "Three\nlines" }, { id: "four", title: "Four" }, { id: "five", title: "Five" }];
  assert.deepEqual(onboardOf(m("x", { onboard: { steps } })), { steps: [{ id: "one", title: "One" }, { id: "three", title: "Three lines" }, { id: "four", title: "Four" }], required: false });
  assert.equal(onboardOf(m("x", { onboard: { steps: [{ id: "a", title: "A" }], required: "yes" as never } }))?.required, false);
  assert.equal(onboardOf(m("x", { onboard: { steps: [{ id: "a", title: "A" }], required: true } }))?.required, true);
  assert.equal(onboardOf(m("x", { onboard: { steps: [] } })), undefined);
  assert.equal(onboardOf(m("x", { onboard: { steps: "a" as never } })), undefined);
  assert.equal(onboardOf(m("x")), undefined);
  assert.equal(onboardOf(m("x", { onboard: { steps: [{ id: "a", title: "x".repeat(90) }] } }))!.steps[0]!.title.length, 60);
});

test("suggest: the role, its own answers and found markers, each with why, in the packs' order", () => {
  const packs = [
    m("linear", { roles: ["po"], answers: ["tasks:linear", "hear:slack"] }),
    m("bino", { roles: ["dev", "po"] }),
    m("slack", { answers: ["hear:slack", "alert:slack", "share:slack"] }),
    m("wrangler", { markers: ["wrangler.toml"] }),
    m("unsuited", { roles: ["an"] }),
  ];
  const got = suggest(packs, "po", { tasks: ["linear", "jira"], hear: ["slack"] }, ["wrangler.toml"]);
  assert.deepEqual([...got], [
    ["linear", ["Product owner", "Linear", "Slack"]],
    ["bino", ["Product owner"]],
    ["slack", ["Slack"]],
    ["wrangler", ["found wrangler.toml"]],
  ]);
});

test("suggest: another role's questions, unknown options and a single question's extra answers don't count", () => {
  const packs = [m("agents", { answers: ["agents:many", "agents:some"] }), m("ops", { answers: ["run:containers"] }), m("x", { answers: ["tasks:github"] })];
  // run is an operator's question, not a developer's.
  assert.deepEqual([...suggest(packs, "dev", { run: ["containers"], tasks: ["gitlab"] }, [])], []);
  // agents is single: only the first of a list counts.
  assert.deepEqual([...suggest(packs, "dev", { agents: ["no", "many"] }, [])], []);
  assert.deepEqual([...suggest(packs, "dev", { agents: "some", tasks: "github" }, [])], [["agents", ["Sometimes"]], ["x", ["GitHub Issues"]]]);
  // No role yet: only what the scan found.
  assert.deepEqual([...suggest([m("d", { roles: ["dev"], markers: ["Dockerfile"] })], undefined, {}, ["Dockerfile"])], [["d", ["found Dockerfile"]]]);
  assert.deepEqual([...suggest([m("d", { roles: ["dev"] })], "boss" as never, {}, [])], []);
});

test("suggest: a bad id or a second pack with the same id is left out", () => {
  const packs = [m("Bad", { roles: ["dev"] }), m("twin", { roles: ["an"] }), m("twin", { roles: ["dev"] }), undefined as never];
  assert.deepEqual([...suggest(packs, "dev", {}, [])], []);
});

test("the core packs' declarations pass the checks unchanged, and a developer who uses agents gets the cockpit", () => {
  const core = [
    assistantPack(), autoreviewPack(), deploysPack({} as never), dependabotPack({} as never), historyPack({} as never), issuesPack({} as never),
    prsPack({} as never), reviewsPack({} as never), stacksPack({} as never), terminalPack({} as never), todoPack({} as never),
  ].map((p) => p.manifest);
  for (const c of core) {
    assert.deepEqual(rolesOf(c), c.roles ?? [], c.id);
    assert.deepEqual(answersOf(c), c.answers ?? [], c.id);
    assert.deepEqual(markersOf(c), c.markers ?? [], c.id);
    if (c.onboard) assert.deepEqual(onboardOf(c)!.steps, c.onboard.steps, c.id);
  }
  const dev = suggest(core, "dev", { agents: "many", tasks: ["github"] }, [".storybook/", "Dockerfile"]);
  assert.deepEqual([...dev.keys()].sort(), ["assistant", "autoreview", "prs", "reviews", "stacks", "terminal", "tracker"]);
  // Bino is suggested to every role.
  for (const r of Object.keys(ROLES)) assert.ok(suggest(core, r as never, {}, []).has("assistant"), r);
});
