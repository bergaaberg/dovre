/** Search (Ctrl K): folding and ranking, prefixes for one kind, what's searched (never Teams), and the views. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { corpus, fold, pagesOf, parseQuery, score, search } from "../src/search/search.ts";
import type { Todo } from "../src/todo/store.ts";
import { H, assertInert, pr, session, signedIn, snapshot } from "./helpers.ts";

test("folding: case, æ ø å and punctuation away, so «epost» finds «E-post» and «medredaktorer» «Medredaktører»", () => {
  assert.equal(fold("E-post"), "epost");
  assert.equal(fold("Medredaktører"), "medredaktorer");
  assert.equal(fold("Å være #863"), "avaere#863");
});

test("ranking: a name's start, a word's start, anywhere, then its other names", () => {
  const q = fold("dep");
  assert.equal(score({ title: "Deploys" }, q), 0);
  assert.equal(score({ title: "Waiting deploys" }, q), 1);
  assert.equal(score({ title: "Undeployed" }, q), 2);
  assert.equal(score({ title: "Release", also: ["deploy"] }, q), 3);
  assert.equal(score({ title: "Release", also: ["undeploy"] }, q), 4);
  assert.equal(score({ title: "Release", also: ["x"] }, q), null);
});

test("a prefix narrows to one kind; the rest is the query", () => {
  assert.deepEqual(parseQuery("pr: 863"), { q: "863", only: "prs" });
  assert.deepEqual(parseQuery("a:review"), { q: "review", only: "agents" });
  assert.deepEqual(parseQuery("> new"), { q: "new", only: "actions" });
  assert.deepEqual(parseQuery("prod", "deploys"), { q: "prod", only: "deploys" });
  assert.deepEqual(parseQuery("prod", "nope"), { q: "prod", only: undefined });
  assert.equal(parseQuery("x".repeat(500)).q.length, 200);
});

const todo = (o: Partial<Todo>): Todo => ({ id: 1, parent: null, title: "t", notes: "", state: "next", due: null, pos: 0, createdAt: 0, updatedAt: 0, doneAt: null, ...o });
const world = () =>
  snapshot({
    prs: { ok: true, value: { mine: [pr({ repo: "ACME/shop-api", number: 863, title: "Helseerklæring: person path", branch: "feat/helse" })], review: [pr({ repo: "ACME/ledger", number: 191, title: "feat(Katalog): forslaget finner endepunkter", author: "per-hansen" })] } },
  });
// What a pack offers in search's own groups (the agents pack's finds, by kind).
const kinds = {
  agents: [{ title: "Review shop-api#863", sub: "shop-api · needs your OK", href: "/agents/s/11111111-1111-4111-8111-111111111111", icon: "✦", also: ["shop-api"] }],
  code: [{ title: "shop-api-pr863", sub: "worktree of shop-api · feat/helse", href: "/code/shop-api-pr863", icon: "⑂", also: ["shop-api", "feat/helse"] }],
};

test("finds pages by their other names, PRs by number, branch and repo, the packs' rows by kind, My list, and things to do", () => {
  const src = { s: world(), kinds, todos: [todo({ id: 7, title: "Ring Per om stacken" }), todo({ id: 8, title: "Gammel", state: "done" })], repos: ["shop-api", "shop-api-pr863", "ledger"], pages: pagesOf() };
  const first = (q: string) => search(src, q).groups[0]?.rows[0];
  assert.equal(search(src, "863").groups.find((g) => g.id === "prs")?.rows[0]?.href, "/prs/ACME/shop-api/863");
  assert.equal(search(src, "#863").groups.find((g) => g.id === "prs")?.rows.length, 1);
  assert.equal(search(src, "feat/helse").groups.find((g) => g.id === "code")?.rows[0]?.title, "shop-api-pr863");
  assert.equal(search(src, "helseerklaering").groups.find((g) => g.id === "prs")?.rows.length, 1, "æ typed as ae");
  assert.equal(search(src, "a: review").groups[0]?.rows[0]?.href, "/agents/s/11111111-1111-4111-8111-111111111111");
  assert.equal(search(src, "t: per").groups[0]?.rows[0]?.href, "/todo#t-7");
  assert.equal(search(src, "gammel").groups.length, 0, "done items aren't searched");
  assert.ok(search(src, "oppgave").groups.some((g) => g.id === "actions"));
  const doRows = corpus({ ...src, kinds: { actions: [{ title: "Start an agent", href: "/agents/new", icon: "✦", also: [] }] } }).actions.map((r) => r.title);
  assert.deepEqual(doRows.slice(-2), ["Start an agent", "Refresh everything"], "a pack's things to start come before Refresh everything");
  assert.ok(!corpus(src).actions.some((r) => r.href === "/agents/new"), "core names no pack's action");
  const code = corpus(src).code.map((r) => r.title);
  assert.deepEqual(code, ["shop-api-pr863", "shop-api", "ledger"], "a worktree once, checkouts beside it");
  assert.ok(!pagesOf().some((p) => p.href === "/bino"), "pages this machine hasn't got aren't offered");
  assert.ok(!pagesOf().some((p) => /teams/i.test(p.href)), "never Teams");
});

test("issue and PR numbers: from notifications, moves and linked PRs, each once; then what GHE's search found", async () => {
  const s = {
    ...world(),
    refs: new Map([["ACME/shop-web#1134", { state: "OPEN" as const, title: "Person rute", url: "https://acme.ghe.com/ACME/shop-web/pull/1134" }]]),
    notes: { ok: true as const, value: [{ id: "1", reason: "mention", type: "Issue", title: "Helseerklæring: tekst", repo: "ACME/FORMS", updatedAt: "2026-10-22", url: "https://acme.ghe.com/ACME/FORMS/issues/512" }] },
    moves: { ok: true as const, value: [{ at: "2026-10-22T06:00:00Z", actor: "x", bot: false, repo: "ACME/FORMS", type: "IssuesEvent", verb: "opened", ref: "ACME/FORMS#512", title: "Helseerklæring: tekst", url: "https://acme.ghe.com/ACME/FORMS/issues/512" }] },
  };
  const issues = (q: string, remote: Parameters<typeof search>[0]["remote"] = []) => search({ s, remote }, q).groups.find((g) => g.id === "issues")?.rows ?? [];
  assert.deepEqual(issues("512").map((r) => [r.title, r.href, r.out]), [["#512 Helseerklæring: tekst", "https://acme.ghe.com/ACME/FORMS/issues/512", true]], "an issue once, on GHE");
  assert.deepEqual(issues("FORMS#512").length, 1);
  assert.equal(issues("1134")[0]?.href, "/prs/ACME/shop-web/1134", "a PR in the org opens in Dovre");
  assert.equal(issues("863").length, 0, "my own PRs are under Pull requests");
  const { createGheSearch } = await import("../src/search/ghe.ts");
  const asked: string[] = [];
  const ghe = { host: "acme.ghe.com", graphql: async () => ({}) as never, rest: async <T>(path: string) => {
    asked.push(path);
    if (path.startsWith("/repos/ACME/ledger/issues/77")) return { number: 77, title: "Kvittering", html_url: "https://acme.ghe.com/ACME/ledger/pull/77", state: "open", pull_request: {} } as T;
    if (path.startsWith("/search/issues")) return { items: [{ number: 9, title: "Body only match", html_url: "https://acme.ghe.com/ACME/x/issues/9", state: "closed", repository_url: "https://api.acme.ghe.com/repos/ACME/x" }] } as T;
    throw new Error("404");
  } };
  const find = createGheSearch(ghe, "ACME");
  assert.deepEqual((await find("ledger#77")).map((r) => [r.title, r.href]), [["#77 Kvittering", "/prs/ACME/ledger/77"]]);
  const found = await find("kvittering tekst");
  assert.equal(issues("kvittering tekst", found)[0]?.title, "#9 Body only match", "kept though the title doesn't say it");
  await find("kvittering tekst");
  assert.equal(asked.filter((p) => p.startsWith("/search/issues")).length, 1, "asked once, then kept");
  assert.match(asked[1]!, /q=kvittering%20tekst%20user%3AACME/);
  assert.deepEqual(await find("ab"), [], "too short to ask");
});

test("nothing typed: the main pages, newest PRs and agents, a few things to do", () => {
  const r = search({ s: world(), kinds }, "");
  assert.deepEqual(r.groups.map((g) => g.id), ["pages", "prs", "agents", "actions"]);
  assert.equal(r.groups[0]!.rows[0]!.href, "/");
});

test("the page and the palette's list: hostile names inert, unsafe links defused, the list alone when asked", async () => {
  const s = snapshot({
    prs: { ok: true, value: { mine: [pr({ title: H, repo: `ACME/${H}`, branch: H, author: H })], review: [] } },
  });
  const app = signedIn(s, {}, { sessions: { live: [session({ title: H, repo: H, lastPrompt: H })] } });
  for (const path of ["/search?q=" + encodeURIComponent("x"), "/search?q=" + encodeURIComponent(H), "/search?q=script", "/search?q=DEV", "/search?q=&only=prs", "/search?q=" + encodeURIComponent(H) + "&frag=1"]) {
    const res = await app.get(path);
    assert.equal(res.status, 200, path);
    const out = await res.text();
    assertInert(path, out);
    assert.doesNotMatch(out, /href="javascript:/i, path);
  }
  const frag = await (await app.get(`/search?q=${encodeURIComponent(H.slice(0, 6))}&frag=1`)).text();
  assert.match(frag, /^<div class="pal-list" id="pal-list" role="listbox"/);
  assert.doesNotMatch(frag, /<html|<header/);
  assert.match(frag, /role="option" id="pal-o-0"/);
  const page = await (await app.get("/")).text();
  assert.match(page, /<a class="search-btn" id="search-btn" href="\/search"/, "the top bar's way in, which works without script");
});
