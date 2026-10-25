/** Today: the briefing, the horizon, red branches, and the live layer that keeps it current. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { eyebrow, greeting, isoWeek, lede, glance } from "../src/home/brief.ts";
import { horizon, nightIn, peaks, rng, sunTimes } from "../src/home/horizon.ts";
import { createHub, signature, throttle } from "../src/live.ts";
import { type Need, needsOf } from "../src/home/needs.ts";
import { DEFAULT_POLICY, type Note, createNotifier, createRinger, noteOf, policyOf, toastXml, workHours } from "../src/notify.ts";
import { failedRunOf, failedRuns, loadRedBranches } from "../src/sources/ghe.ts";
import { H, assertInert, deploy, fakeGhe, move, note, pr, snapshot } from "./helpers.ts";
import { feedOf } from "../src/home/feed.ts";
import { homePage, prStats } from "../src/pages/home.ts";

const at = (iso: string) => Date.parse(iso);
const text = (bits: ReturnType<typeof lede>) => bits.map((s) => s.map((b) => (typeof b === "string" ? b : b.code ? `\`${b.code}\`` : b.text)).join("")).join(" ");

test("the greeting follows the hour in Oslo", () => {
  assert.equal(greeting(at("2026-10-22T07:42:00Z")), "God morgen"); // 09:42 CEST
  assert.equal(greeting(at("2026-10-22T12:00:00Z")), "God dag");
  assert.equal(greeting(at("2026-10-22T18:30:00Z")), "God kveld");
  assert.equal(greeting(at("2026-10-22T23:30:00Z")), "God natt");
  assert.equal(eyebrow(at("2026-10-22T07:42:00Z")), "Thursday 22 October · Week 43 · 09:42");
  assert.equal(isoWeek(at("2027-01-01T12:00:00Z")), 53);
});

test("the briefing says what needs me in sentences, the packs' between deploys and red builds, and leaves out leftover deploys", () => {
  const s = snapshot({
    deploys: { ok: true, value: [deploy({ id: 1 }), deploy({ id: 2 }), deploy({ id: 3 })] },
    changelogs: new Map([[3, { ok: true, value: { repo: "ACME/a", env: "prod", prodSha: "x", prodAt: "", head: "x", commits: 0, files: 0, additions: 0, deletions: 0, changes: [], compareUrl: "" } }]]),
    prs: { ok: true, value: { mine: [pr({ checks: "FAILURE" }), pr({ number: 2, checks: "FAILURE" })], review: [] } },
    red: [{ repo: "ACME/shop-api", branch: "main", workflow: "Build", failures: 45, since: "2026-10-22T07:36:00Z", url: "https://acme.ghe.com/x" }],
  });
  const app = [{ text: "one agent", href: "#agents", tone: "warn" as const }, " wants your OK for ", { text: "", href: "", code: "dotnet test" }, "."];
  assert.equal(text(lede(s, [app])), "Two deploys wait for your approval. One agent wants your OK for `dotnet test`. The build is red on shop-api main. Two PRs have red builds. No reviews waiting.");
  assert.equal(text(lede(snapshot(), [app])), "One agent wants your OK for `dotnet test`. No reviews waiting.", "a pack's sentence is something that needs me");
  assert.equal(text(lede(snapshot())), "Nothing needs you. No reviews waiting.");
  assert.match(text(lede(snapshot({ prs: { ok: true, value: { mine: [], review: [pr()] } } }))), /One review waits on you\./);
  const red = (workflow: string, repo = "ACME/shop-api") => ({ repo, branch: "main", workflow, failures: 1, since: "2026-10-22T07:36:00Z", url: "https://acme.ghe.com/x" });
  assert.match(text(lede(snapshot({ red: [red("Build"), red("Deploy")] }))), /The build is red on shop-api main\./, "two workflows on one branch name it once");
  assert.match(text(lede(snapshot({ red: [red("Build"), red("Deploy"), red("Build", "ACME/web")] }))), /Builds are red on shop-api main and web main\./);
});

test("the glance counts the last day's merges and releases (the packs add their own numbers)", () => {
  const s = snapshot({ moves: { ok: true, value: [move({ verb: "merged" }), move({ verb: "released" }), move({ verb: "opened" })] } });
  assert.deepEqual(glance(s), { merged: 1, released: 1 });
});

test("the sun over Oslo: on 22 October, noon near 13:00 summer time and about 9 h 38 min of day", () => {
  const t = sunTimes(at("2026-10-22T10:00:00Z"))!;
  const local = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" }).format(ms);
  assert.match(local(t.rise), /^08:1/);
  assert.match(local(t.set), /^17:(4|5)/);
  assert.ok(Math.abs((t.set - t.rise) / 60e3 - 578) < 10, "day length");
  assert.equal(sunTimes(at("2026-06-21T10:00:00Z"), 78.2, 15.6), null, "midnight sun in Longyearbyen");
  const night = nightIn(at("2026-10-21T07:42:00Z"), at("2026-10-22T07:42:00Z"))!;
  assert.ok(night.from < night.to && night.to > at("2026-10-22T05:00:00Z"));
});

test("peaks name the busiest stretches of people's work, apart from each other", () => {
  const now = at("2026-10-22T08:00:00Z");
  const t0 = now - 86400e3;
  const burst = (center: number, n: number, verb = "merged") => Array.from({ length: n }, (_, i) => move({ at: new Date(center + i * 60e3).toISOString(), verb }));
  const moves = [...burst(t0 + 3 * 3600e3, 8), ...burst(t0 + 3 * 3600e3 + 20 * 60e3, 3, "released"), ...burst(t0 + 20 * 3600e3, 5, "opened")];
  const p = peaks(moves, t0, now, "ola-nordmann");
  assert.equal(p.length, 2);
  assert.match(p[0]!.line, /8 merged · 3 released/);
  assert.ok(p[1]!.at > p[0]!.at);
});

test("the horizon draws the same ridge for the same day, and text in it stays text", async () => {
  const now = at("2026-10-22T08:00:00Z");
  const s = { moves: [move({ actor: H, title: H, verb: "merged", at: "2026-10-22T06:00:00Z" })], deploys: [deploy({ repo: `ACME/${H}` })], lanes: [{ label: H, legend: H, marks: [{ at: now - 3600e3, size: 99, title: H }, { at: now, live: true, title: H }] }], me: "x", now };
  const a = String(await horizon(s));
  assert.equal(a, String(await horizon(s)));
  assertInert("horizon", a);
  assert.match(a, /<svg class="hz"/);
  assert.equal((a.match(/class="hz-mark/g) ?? []).length, 2, "a pack's row: one mark at its time, one live at the right");
  assert.ok(String(horizon({ ...s, lanes: [] })).length < a.length);
  const r = rng(1);
  assert.notEqual(r(), r());
});

test("red branches: failure notices are only candidates; the newest finished run decides", async () => {
  assert.deepEqual(failedRunOf("Build, test and deploy 🚀 workflow run failed for main branch"), { workflow: "Build, test and deploy 🚀", branch: "main" });
  assert.equal(failedRunOf("Something else"), null);
  const notes = [note({ reason: "ci_activity", repo: "ACME/a", title: "Build workflow run failed for main branch" }), note({ reason: "ci_activity", repo: "ACME/a", title: "Build workflow run failed for main branch", updatedAt: "2026-10-22T05:00:00Z" }), note({ reason: "ci_activity", repo: "ACME/b", title: "Build workflow run failed for main branch" })];
  assert.equal(failedRuns(notes).find((c) => c.repo === "ACME/a")!.failures, 2);
  const { ghe } = fakeGhe({
    "GET /repos/ACME/a/actions/runs?branch=main&status=completed&per_page=20": { workflow_runs: [{ name: "Build", conclusion: "failure", status: "completed", html_url: "https://acme.ghe.com/ACME/a/actions/runs/1" }] },
    "GET /repos/ACME/b/actions/runs?branch=main&status=completed&per_page=20": { workflow_runs: [{ name: "Build", conclusion: "success", status: "completed", html_url: "u" }] },
  });
  const red = await loadRedBranches(ghe, notes);
  assert.deepEqual(red.map((r) => [r.repo, r.failures]), [["ACME/a", 2]]);
});

test("the hub tells everyone listening; a listener that throws doesn't stop the rest", () => {
  const hub = createHub(() => 5);
  const got: string[][] = [];
  const off = hub.subscribe(() => {
    throw new Error("x");
  });
  hub.subscribe((c) => got.push(c.topics));
  hub.publish(["snapshot"]);
  off();
  assert.equal(hub.size(), 1);
  assert.deepEqual(got, [["snapshot"]]);
});

test("the hub knows how many open pages can show a notification themselves (the rest get a Windows toast)", () => {
  const hub = createHub();
  hub.subscribe(() => {});
  assert.equal(hub.notifiers(), 0, "a page without permission doesn't count");
  const off = hub.subscribe(() => {}, { notifies: true });
  assert.equal(hub.notifiers(), 1);
  off();
  assert.equal(hub.notifiers(), 0);
  assert.equal(hub.size(), 1);
});

test("throttle: first call at once, then the latest at most once per window", async () => {
  const calls: number[] = [];
  const t = throttle((n: number) => calls.push(n), 40);
  t(1);
  t(2);
  t(3);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(calls, [1, 3]);
});

test("notifications: the first look is silent; then only new things that ring under the policy, each once", () => {
  const n = createNotifier();
  const need = (key: string, ring?: Need["ring"], kind: Need["kind"] = "review"): Need => ({ kind, key, ring, rank: 0, at: 0, title: "t", href: "/prs", tone: "accent" });
  assert.deepEqual(n.observe([need("review:a", "review")]), []);
  assert.deepEqual(n.observe([need("review:a", "review")]), []);
  const fresh = n.observe([need("review:a", "review"), need("review:b", "review"), need("mention:1", "mention", "mention"), need("agents:s:idle:1", undefined, "pack"), need("deploy:ACME/x:Deploy", "deploy", "deploy")]);
  assert.deepEqual(fresh.map((x) => x.tag), ["review:b", "deploy:ACME/x"], "mentions are off by default; an idle agent never rings");
  assert.equal(fresh[0]!.url, "/prs");
  assert.deepEqual(n.observe([need("x:1", "review")], { ...DEFAULT_POLICY, kinds: { ...DEFAULT_POLICY.kinds, review: false } }), [], "a kind switched off stays quiet");
  assert.equal(noteOf({ ...need("ci:x", "ci"), href: "https://acme.ghe.com/x" }).url, undefined, "only this app's own pages open from a note");
});

test("a newer deploy run superseding the last doesn't ring (agents need me through the agents pack, its own test)", () => {
  const n = createNotifier();
  const base = snapshot({ deploys: { ok: true, value: [deploy({ id: 1 })] } });
  n.observe(needsOf(base));
  const later = snapshot({ deploys: { ok: true, value: [deploy({ id: 2, superseded: [deploy({ id: 1 })] })] } });
  assert.deepEqual(n.observe(needsOf(later)), []);
});

test("the ringer: the first note at once, the rest of a burst as one; quiet hours hold everything", () => {
  const delivered: Note[][] = [];
  let timer: (() => void) | undefined;
  let policy = { ...DEFAULT_POLICY, bundleSec: 45 };
  let now = at("2026-10-22T08:00:00Z"); // Thursday 10:00 in Oslo
  const r = createRinger({ deliver: (x) => delivered.push(x), policy: () => policy, now: () => now, setTimer: (fn) => (timer = fn) });
  const note = (t: string): Note => ({ title: t, tag: t });
  r.ring([note("a"), note("b")]);
  r.ring([note("c")]);
  assert.deepEqual(delivered.map((d) => d.map((x) => x.title)), [["a"]]);
  timer!();
  assert.deepEqual(delivered[1]!.map((x) => x.title), ["2 more things need you"]);
  assert.equal(delivered[1]![0]!.body, "b · c");
  policy = { ...policy, workHoursOnly: true };
  now = at("2026-10-24T10:00:00Z"); // Saturday
  r.ring([note("d")]);
  assert.equal(delivered.length, 2);
  assert.equal(r.log()[0]!.held, "quiet");
  assert.equal(workHours(at("2026-10-22T14:59:00Z")), true);
  assert.equal(workHours(at("2026-10-22T15:01:00Z")), false, "17:01 in Oslo");
});

test("a stored policy is read safely: missing or odd values fall back, numbers are kept in range", () => {
  assert.deepEqual(policyOf(undefined), DEFAULT_POLICY);
  const p = policyOf({ kinds: { mention: true, deploy: "yes" }, longTurnMin: 9999, bundleSec: -4, workHoursOnly: true });
  assert.equal(p.kinds.mention, true);
  assert.equal(p.kinds.deploy, true, "a non-boolean keeps the default");
  assert.equal(p.longTurnMin, 240);
  assert.equal(p.bundleSec, 0);
  assert.equal(p.workHoursOnly, true);
});

test("a toast's text is escaped into its XML", () => {
  const x = toastXml({ title: `<a & "b">`, body: "'c'", url: "/agents", tag: "t" }, "http://127.0.0.1:4848");
  assert.match(x, /&lt;a &amp; &quot;b&quot;&gt;/);
  assert.match(x, /launch="dovre:\/\/open\/agents"/, "through the launcher, so it opens the signed-in window");
  assert.match(toastXml({ title: "t", url: "/x?y=1#z", tag: "t" }), /launch="dovre:\/\/open\/"/, "only a plain path");
  assert.match(toastXml({ title: "t", url: "//evil.example", tag: "t" }), /launch="dovre:\/\/open\/"/);
  assert.ok(!x.includes("<a "));
});

test("the signature changes with what pages show, not with when it was gathered", () => {
  const a = snapshot();
  assert.equal(signature(a), signature({ ...a, at: a.at + 1000 }));
  assert.notEqual(signature(a), signature({ ...a, red: [{ repo: "ACME/x", branch: "main", workflow: "ci", since: "2026-10-22T06:00:00Z", failures: 1, url: "https://acme.ghe.com/x" }] as never }));
});

test("what's moving: people's work, releases and waiting deploys in one log, newest first; bots only when they release", () => {
  const now = at("2026-10-22T08:00:00Z");
  const s = snapshot({
    moves: { ok: true, value: [move({ at: "2026-10-22T07:30:00Z", verb: "merged", title: `Fix ${H}` }), move({ at: "2026-10-22T07:40:00Z", actor: "renovate[bot]", bot: true, verb: "opened" }), move({ at: "2026-10-22T07:41:00Z", actor: "release-please[bot]", bot: true, verb: "released", title: "v1.2.0" }), move({ at: "2026-10-20T07:00:00Z", verb: "opened" })] },
    deploys: { ok: true, value: [deploy({ createdAt: "2026-10-22T07:50:00Z" })] },
  });
  const f = feedOf(s, now);
  assert.deepEqual(f.map((e) => [e.who, e.what, e.tone]), [["per-hansen", "waits for prod approval", "warn"], ["release-please", "released", "ok"], ["per-hansen", "merged", "ok"]]);
  assert.equal(new Set(f.map((e) => e.key)).size, f.length, "keys are unique");
  const page = String(homePage({ operator: "me", nav: [] }, s, () => undefined, { now }));
  assertInert("today with the feed", page);
  assert.match(page, /<li class="fe" data-key="m:2026-10-22T07:30:00Z:per-hansen:/);
});

test("my PRs counted once each by what they wait on, drafts apart (a red draft is red too, as the briefing says)", () => {
  const n = prStats([pr({ checks: "FAILURE" }), pr({ checks: "FAILURE", draft: true }), pr({ review: "CHANGES_REQUESTED" }), pr({ openThreads: 2 }), pr({ review: "APPROVED" }), pr()]);
  assert.deepEqual({ ...n, ready: undefined }, { failing: 2, changes: 1, threads: 1, drafts: 1, ready: undefined });
});
