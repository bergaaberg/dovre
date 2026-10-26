/** My list: quick add reads a trailing date, items keep their order and state, references become links, hostile text stays text. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { linkCtxOf, todoCard, todoPage } from "../src/pages/todo.ts";
import { refsIn } from "../src/todo/links.ts";
import { addTodo, deleteTodo, listTodos, moveTodo, osloDate, parseQuick, toggleDone, treeOf, updateTodo } from "../src/todo/store.ts";
import { assertInert, H, pr, signedIn, snapshot } from "./helpers.ts";

// Thursday 22 October 2026.
const TODAY = "2026-10-22";

test("quick add takes a due date only from the end", () => {
  assert.deepEqual(parseQuick("Ring Kari fre", TODAY), { title: "Ring Kari", due: "2026-10-23" });
  assert.deepEqual(parseQuick("Ring Kari tor", TODAY), { title: "Ring Kari", due: TODAY }, "today's weekday is today");
  assert.deepEqual(parseQuick("Ring Kari man", TODAY), { title: "Ring Kari", due: "2026-10-26" });
  assert.deepEqual(parseQuick("Svar på PR i morgen", TODAY), { title: "Svar på PR", due: "2026-10-23" });
  assert.deepEqual(parseQuick("Deploy note !", TODAY), { title: "Deploy note", due: TODAY });
  assert.deepEqual(parseQuick("Rydd 30.10", TODAY), { title: "Rydd", due: "2026-10-30" });
  assert.deepEqual(parseQuick("Rydd 1.2", TODAY), { title: "Rydd", due: "2027-02-01" }, "a day that's passed this year is next year's");
  assert.deepEqual(parseQuick("Rydd 2026-11-05", TODAY), { title: "Rydd", due: "2026-11-05" });
  assert.deepEqual(parseQuick("Fix man page", TODAY), { title: "Fix man page", due: null }, "only the last word counts");
  assert.deepEqual(parseQuick("man", TODAY), { title: "man", due: null }, "a lone word is a title");
  assert.deepEqual(parseQuick("Rydd 31.02", TODAY).due, null, "no such day");
  assert.equal(osloDate(Date.parse("2026-10-21T22:30:00Z"), "Europe/Oslo"), TODAY, "Oslo's date, not UTC's");
});

test("items keep order, state and steps; done folds steps' count; delete takes the steps with it", async () => {
  const db = openDb().DB;
  const a = (await addTodo(db, { title: "Initiative A" }, 1))!;
  const b = (await addTodo(db, { title: "B" }, 2))!;
  const step = (await addTodo(db, { title: "Step 1", parent: a.id }, 3))!;
  const deeper = (await addTodo(db, { title: "Step 2", parent: step.id }, 4))!;
  assert.equal(deeper.parent, a.id, "one level deep: a step's step belongs to the initiative");
  assert.equal(await addTodo(db, { title: "  \n " }), undefined, "nothing to add");
  await moveTodo(db, b.id, "up");
  assert.deepEqual(treeOf(await listTodos(db)).map((t) => t.item.title), ["B", "Initiative A"]);
  await updateTodo(db, a.id, { state: "doing", due: "2026-10-30", notes: "See DEV-12" }, 5);
  const done = (await toggleDone(db, step.id, 6))!;
  assert.equal(done.state, "done");
  assert.equal(done.doneAt, 6);
  assert.equal((await toggleDone(db, step.id, 7))!.doneAt, null, "not done after all");
  assert.equal((await updateTodo(db, a.id, { due: "not a date" }))!.due, null);
  await deleteTodo(db, a.id);
  assert.deepEqual((await listTodos(db)).map((t) => t.title), ["B"]);
});

/** A pack's kind of reference: ticket keys of two projects, so UTF-8 isn't one. */
const TICKETS = [{ pattern: /\b(?:DEV|FS)-\d+\b/, href: (k: string) => `https://example.atlassian.net/browse/${k}` }];
const ctx = linkCtxOf({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME" }, snapshot({ prs: { ok: true, value: { mine: [pr({ repo: "ACME/shop-api", number: 840, title: "Stack base" })], review: [] } } }), TICKETS);

test("references become links: PRs with their state, a pack's kinds (ticket keys), agent sessions, plain links", () => {
  const kinds = (s: string) => refsIn(s, ctx).map((p) => (typeof p === "string" ? "text" : p.kind));
  assert.deepEqual(kinds("Rebase shop-api#840 after DEV-12"), ["text", "gh", "text", "app"]);
  assert.equal((refsIn("DEV-12", ctx)[0] as { url: string }).url, "https://example.atlassian.net/browse/DEV-12");
  assert.deepEqual(refsIn("DEV-12", linkCtxOf({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME" }, undefined, [{ pattern: /DEV-\d+/, href: () => { throw new Error("broken pack"); } }])), ["DEV-12"], "a rule that throws links nothing");
  const gh = refsIn("shop-api#840", ctx)[0] as { state?: string; url: string };
  assert.equal(gh.state, "OPEN");
  assert.equal(gh.url, "https://acme.ghe.com/ACME/shop-api/issues/840");
  assert.deepEqual(kinds("UTF-8 isn't a ticket"), ["text"]);
  assert.deepEqual(kinds("https://acme.ghe.com/ACME/people/pull/12."), ["gh", "text"], "trailing punctuation isn't the link");
  assert.deepEqual(kinds("agent 149b2627-6461-4857-8a90-2f4522ba4529 done"), ["text", "agent", "text"]);
  assert.deepEqual(kinds("see https://example.com/x"), ["text", "url"]);
});

test("the page and the Today card render, and hostile titles and notes stay text", async () => {
  const { get, post, db } = signedIn(snapshot());
  const add = await post("/todo/add", { q: `${H} fre` });
  assert.equal(add.status, 303);
  assert.match(add.headers.get("location") ?? "", /^\/todo#t-\d+$/);
  const [t] = await listTodos(db.DB);
  assert.equal(t!.due !== null, true);
  await post(`/todo/${t!.id}`, { title: `${H} javascript:alert(1)`, notes: `${H}\n[x](javascript:alert(1))`, state: "doing", due: "" });
  await post("/todo/add", { q: "a step", parent: String(t!.id) });
  for (const path of ["/todo", "/"]) {
    const out = await (await get(path)).text();
    assertInert(path, out);
    assert.ok(!out.includes('href="javascript:'), `${path}: no javascript: link`);
    assert.match(out, /id="todo-card"|id="todo"/, path);
  }
  const page = await (await get("/todo")).text();
  assert.match(page, /0\/1/, "the initiative counts its steps");
  assert.match(page, /<details class="confirm"><summary>Delete…/, "delete takes a second click");
  const back = await post(`/todo/${t!.id}/toggle`, { back: "/" });
  assert.equal(back.headers.get("location"), "/", "back to where the tick was pressed");
  assert.equal((await post(`/todo/${t!.id}/toggle`, { back: "//evil.example" })).headers.get("location"), `/todo#t-${t!.id}`);
  assert.equal((await post("/todo/x/toggle", {})).status, 404);
});

test("done things fold away after a few days; the card shows what's doing and what's due soon", async () => {
  const db = openDb().DB;
  const now = Date.parse("2026-10-22T10:00:00Z");
  const old = (await addTodo(db, { title: "Old one" }, now))!;
  await updateTodo(db, old.id, { state: "done" }, now - 5 * 86_400_000);
  await addTodo(db, { title: "Doing it", state: "doing" }, now);
  await addTodo(db, { title: "Due tomorrow", due: "2026-10-23" }, now);
  await addTodo(db, { title: "Someday" }, now);
  const all = await listTodos(db);
  const page = String(todoPage({ operator: "me", nav: [] }, all, ctx, { now }));
  assert.match(page, /<details class="todo-older" id="todo-older"><summary>Done earlier/);
  const card = String(todoCard(all, ctx, now));
  assert.match(card, /Doing it/);
  assert.match(card, /Due tomorrow/);
  assert.doesNotMatch(card, /Someday/);
});

test("adding with details: notes, where it stands and a due date in one form; ?add opens them (dovre#86)", async () => {
  const { get, post, db } = signedIn(snapshot());
  const plain = await (await get("/todo")).text();
  assert.match(plain, /<details class="todo-add-more" id="todo-add-more"><summary>With details/, "folded by default");
  assert.doesNotMatch(plain, /id="todo-q"[^>]*autofocus/);
  const adding = await (await get("/todo?add")).text();
  assert.match(adding, /<details class="todo-add-more" id="todo-add-more" open>/);
  assert.match(adding, /id="todo-q"[^>]*autofocus/);
  assert.doesNotMatch(adding, /<option value="done"/, "not added as done");

  await post("/todo/add", { q: "Write the release notes fre", notes: `Line one\r\n${H}\r\n`, state: "waiting", due: "2026-12-24" });
  await post("/todo/add", { q: "Only text fre", notes: "", state: "done", due: "" });
  const [a, b] = await listTodos(db.DB);
  assert.deepEqual([a!.title, a!.notes, a!.state, a!.due], ["Write the release notes", `Line one\n${H}`, "waiting", "2026-12-24"], "the date field wins over one in the text");
  assert.deepEqual([b!.title, b!.notes, b!.state], ["Only text", "", "next"], "done isn't a state to add in");
  assert.notEqual(b!.due, null, "without a date field, the text's date stays");
  assertInert("/todo", await (await get("/todo")).text());
});
