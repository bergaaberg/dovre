/**
 * My list (/todo): small things and small initiatives that live nowhere else, kept on this
 * machine (src/todo/store.ts). Quick add at the top, grouped by where things stand, one click to
 * tick off, everything else behind an item's "Edit". A card on Today shows what's on now.
 * Every form works without the script; the list sits in a live region, and a change publishes
 * on the hub so every open window shows it.
 */
import { Hono } from "hono";
import { html } from "hono/html";
import type { AppEnv, Env } from "../env.ts";
import type { Snapshot } from "../gather.ts";
import { type Frame, shell } from "../html.ts";
import type { Hub } from "../live.ts";
import { type LinkCtx, linked, refLink, refsOnly } from "../todo/links.ts";
import type { RefRule } from "../packs/types.ts";
import {
  addTodo,
  daysUntil,
  deleteTodo,
  getTodo,
  isState,
  listTodos,
  MAX_NOTES,
  MAX_TITLE,
  moveTodo,
  osloDate,
  parseQuick,
  STATES,
  type State,
  type Todo,
  toggleDone,
  treeOf,
  type Tree,
  updateTodo,
} from "../todo/store.ts";
import { Confirm, type Html, PageHeader, Pill } from "../ui/kit.ts";
import { markdown } from "../ui/markdown.ts";
import { safeUrl } from "./parts.ts";

/** Done items show this long, then fold away under "Done earlier". */
const DONE_SHOWN_MS = 3 * 86_400_000;
const LABEL: Record<State, string> = { doing: "Doing", next: "Next", waiting: "Waiting", done: "Done" };

/** What links in my list can say about PRs, from what's already gathered; `rules`: the packs' kinds of reference. */
export function linkCtxOf(env: Pick<Env, "GHE_HOST" | "GHE_ORG">, s?: Snapshot, rules: RefRule[] = []): LinkCtx {
  const prs = new Map<string, { state: string; title?: string }>();
  if (s) {
    for (const [k, r] of s.refs) prs.set(k, { state: r.state, title: r.title });
    if (s.prs.ok) for (const p of [...s.prs.value.mine, ...s.prs.value.review]) prs.set(`${p.repo}#${p.number}`, { state: "OPEN", title: p.title });
  }
  return { ghe: env.GHE_HOST, org: env.GHE_ORG, rules, prs };
}

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** When it's due, said the short way, coloured only when it's due now or late. */
export function dueOf(due: string | null, today: string, done = false): Html | "" {
  if (!due) return "";
  const d = daysUntil(due, today);
  const at = new Date(`${due}T12:00:00Z`);
  const text = d < 0 ? `${-d} d late` : d === 0 ? "today" : d === 1 ? "tomorrow" : d < 7 ? WEEKDAY.format(at) : DAY_MONTH.format(at);
  return Pill({ tone: done ? undefined : d < 0 ? "bad" : d === 0 ? "warn" : undefined, children: text, title: due });
}

const tick = (t: Todo, back: string) =>
  html`<form method="post" action="/todo/${t.id}/toggle" class="todo-tick-f"><input type="hidden" name="back" value="${back}"><button type="submit" class="todo-tick${t.state === "done" ? " on" : ""}" aria-pressed="${t.state === "done" ? "true" : "false"}" aria-label="${t.state === "done" ? "Not done" : "Done"}: ${t.title}" title="${t.state === "done" ? "Not done after all" : "Done"}"></button></form>`;

const agentHref = (t: Todo) => safeUrl(`/agents/new?prompt=${encodeURIComponent(`${t.title}${t.notes ? `\n\n${t.notes.slice(0, 1500)}` : ""}`)}`);

function editor(t: Todo, ctx: LinkCtx, back: string, isChild: boolean, bino = false): Html {
  const refs = refsOnly(t.notes, ctx);
  return html`<details class="todo-more" id="tm-${t.id}"><summary>${t.notes ? "Notes · edit" : "Edit"}</summary>
${t.notes ? html`<div class="todo-notes">${markdown(t.notes, { headingOffset: 3 })}</div>${refs.length ? html`<p class="todo-refs">${refs.map((r) => html`${refLink(r, ctx)} `)}</p>` : ""}` : ""}
<form method="post" action="/todo/${t.id}" class="todo-form"><input type="hidden" name="back" value="${back}">
<label class="field"><span class="label">Title</span><input type="text" name="title" value="${t.title}" maxlength="${MAX_TITLE}" required></label>
<label class="field"><span class="label">Notes</span><textarea name="notes" rows="${Math.min(12, Math.max(3, t.notes.split("\n").length + 1))}" maxlength="${MAX_NOTES}" placeholder="Markdown. Links, repo#12, DEV-12 and agent session ids turn into links.">${t.notes ? html`\n${t.notes}` : ""}</textarea></label>
<div class="fields"><label class="field"><span class="label">Where it stands</span><select name="state">${STATES.map((s) => html`<option value="${s}"${s === t.state ? html` selected` : ""}>${LABEL[s]}</option>`)}</select></label>
<label class="field"><span class="label">Due</span><input type="date" name="due" value="${t.due ?? ""}"></label>
<div class="field"><button type="submit" class="primary">Save</button></div></div>
</form>
<div class="todo-acts">
<form method="post" action="/todo/${t.id}/move"><input type="hidden" name="back" value="${back}"><input type="hidden" name="dir" value="up"><button type="submit" class="sm ghost">Move up</button></form>
<form method="post" action="/todo/${t.id}/move"><input type="hidden" name="back" value="${back}"><input type="hidden" name="dir" value="down"><button type="submit" class="sm ghost">Move down</button></form>
<a class="btn sm ghost" href="${agentHref(t)}">Start an agent on this</a>
${bino ? html`<form method="post" action="/bino/new"><input type="hidden" name="todo" value="${t.id}"><button type="submit" class="sm ghost" data-busy="Asking Bino">Break it down with Bino</button></form>` : ""}
${Confirm({ action: `/todo/${t.id}/delete`, fields: { back }, label: "Delete", question: isChild ? "Delete this step?" : "Delete this, and the steps under it?", danger: true })}
</div></details>`;
}

function row(tr: Tree, ctx: LinkCtx, today: string, back: string, bino = false): Html {
  const t = tr.item;
  const open = tr.children.filter((c) => c.state !== "done").length;
  return html`<li class="todo-item ${t.state}" id="t-${t.id}">${tick(t, back)}<div class="todo-main">
<p class="todo-title"><span>${linked(t.title, ctx)}</span> ${dueOf(t.due, today, t.state === "done")}${tr.children.length ? html` <span class="todo-count" title="Steps done">${tr.children.length - open}/${tr.children.length}</span>` : ""}</p>
${tr.children.length ? html`<ul class="todo-sub">${tr.children.map((c) => html`<li class="todo-item ${c.state}" id="t-${c.id}">${tick(c, back)}<div class="todo-main"><p class="todo-title"><span>${linked(c.title, ctx)}</span> ${dueOf(c.due, today, c.state === "done")}</p>${editor(c, ctx, back, true, bino)}</div></li>`)}</ul>` : ""}
${t.state !== "done" ? html`<form method="post" action="/todo/add" class="todo-step"><input type="hidden" name="parent" value="${t.id}"><input type="hidden" name="back" value="${back}"><input type="text" name="q" maxlength="${MAX_TITLE + 40}" placeholder="Add a step" aria-label="Add a step to ${t.title}"><button type="submit" class="sm">Add</button></form>` : ""}
${editor(t, ctx, back, false, bino)}
</div></li>`;
}

const quickAdd = (back: string, id: string, label = "Add to my list", bino = false) =>
  html`<form method="post" action="/todo/add" class="todo-add"><input type="hidden" name="back" value="${back}"><input type="text" id="${id}" name="q" maxlength="${MAX_TITLE + 40}" placeholder="Add something… end it with fre, i morgen, 30.10 or ! to give it a date" aria-label="${label}" required><button type="submit" class="primary">Add</button>${
    bino ? html`<button type="submit" formaction="/bino/new" class="ghost" data-busy="Asking Bino" title="Think it through with Bino first: how to group it, how to break it down">Talk it through with Bino</button>` : ""
  }</form>`;

/** The page: quick add, then Doing, Next, Waiting and recent Done; older done things folded away. */
export function todoPage(frame: Frame, all: Todo[], ctx: LinkCtx, opts: { now?: number; bino?: boolean; /** Proposals from elsewhere (Teams' crawler), above the list. */ proposals?: Html | "" } = {}): Html {
  const now = opts.now ?? Date.now();
  const today = osloDate(now);
  const trees = treeOf(all);
  const back = "/todo";
  const by = (s: State) => trees.filter((t) => t.item.state === s);
  const done = by("done");
  const recent = done.filter((t) => (t.item.doneAt ?? 0) > now - DONE_SHOWN_MS);
  const older = done.filter((t) => (t.item.doneAt ?? 0) <= now - DONE_SHOWN_MS);
  const open = trees.length - done.length;
  const group = (s: State, list: Tree[]) =>
    list.length ? html`<section class="todo-group" aria-labelledby="g-${s}"><h2 id="g-${s}">${LABEL[s]} <span class="t3">${list.length}</span></h2><ul class="todo-list">${list.map((t) => row(t, ctx, today, back, opts.bino))}</ul></section>` : "";
  const body = html`${PageHeader({ title: "My list", sub: html`Small things and small initiatives that live nowhere else. Kept on this machine only.` })}
${quickAdd(back, "todo-q", "Add to my list", opts.bino)}
<div data-live id="todo">
${opts.proposals ?? ""}
${open || recent.length ? "" : html`<div class="empty"><strong>Nothing on your list</strong><p>Write it above and press Enter. An item gets steps under it once you add them.</p></div>`}
${group("doing", by("doing"))}${group("next", by("next"))}${group("waiting", by("waiting"))}${group("done", recent)}
${older.length ? html`<details class="todo-older" id="todo-older"><summary>Done earlier <span class="t3">${older.length}</span></summary><ul class="todo-list">${older.map((t) => row(t, ctx, today, back))}</ul></details>` : ""}
</div>`;
  return shell({ title: "My list · Dovre", frame, current: "/todo", body });
}

/** On Today: what I'm doing, and what's next and due within two days (or late). */
export function todoCard(all: Todo[], ctx: LinkCtx, now = Date.now()): Html {
  const today = osloDate(now);
  const trees = treeOf(all).filter((t) => t.item.state !== "done");
  const soon = (t: Todo) => !!t.due && daysUntil(t.due, today) <= 2;
  const shown = [...trees.filter((t) => t.item.state === "doing"), ...trees.filter((t) => t.item.state !== "doing" && soon(t.item))].slice(0, 6);
  const doing = trees.filter((t) => t.item.state === "doing").length;
  return html`<section class="card" id="todo-card" aria-labelledby="todo-h">
<div class="card-h"><h2 id="todo-h">On my list</h2><p>${doing} doing · ${trees.length} open</p></div>
${shown.length ? html`<ul class="todo-list">${shown.map((t) => html`<li class="todo-item ${t.item.state}" id="tc-${t.item.id}">${tick(t.item, "/")}<div class="todo-main"><p class="todo-title"><span>${linked(t.item.title, ctx)}</span> ${dueOf(t.item.due, today)}${t.children.length ? html` <span class="todo-count">${t.children.filter((c) => c.state === "done").length}/${t.children.length}</span>` : ""}</p></div></li>`)}</ul>` : html`<p class="notes">Nothing you're doing or that's due soon.</p>`}
${quickAdd("/", "todo-q-today", "Add to my list from Today")}
<div class="card-f"><span></span><a href="/todo">My list (${trees.length})</a></div>
</section>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

const first = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? (v.find((x) => typeof x === "string") ?? "") : "");
/** Back to the page the form was on (only this app's own pages), at the item. */
const backTo = (form: Record<string, unknown>, id?: number) => {
  const b = first(form.back);
  const path = /^\/(?![/\\])[\w\-/]*$/.test(b) ? b : "/todo";
  return id && path === "/todo" ? `${path}#t-${id}` : path;
};
const idOf = (s: string) => (/^\d{1,9}$/.test(s) ? Number(s) : undefined);

/** /todo…: mounted at "/" by app.ts, behind its cookie and same-origin checks. */
export function createTodoRoutes(env: Env, deps: { page: () => Promise<{ s: Snapshot; frame: Frame }>; /** The packs' kinds of reference. */ rules?: () => RefRule[]; hub?: Hub; now?: () => number; /** Bino can answer: offer talking a task through. */ bino?: boolean; /** Proposals to show above the list (Teams' crawler). */ proposals?: () => Promise<Html | ""> }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const db = env.DB;
  const now = deps.now ?? Date.now;
  const changed = () => deps.hub?.publish(["snapshot"]);

  app.get("/todo", async (c) => {
    const { s, frame } = await deps.page();
    return c.html(todoPage(frame, await listTodos(db), linkCtxOf(env, s, deps.rules?.()), { now: now(), bino: deps.bino, proposals: deps.proposals ? await deps.proposals().catch(() => "" as const) : "" }));
  });
  app.post("/todo/add", async (c) => {
    const form = await c.req.parseBody();
    const q = parseQuick(first(form.q), osloDate(now()));
    const parent = idOf(first(form.parent)) ?? null;
    const t = q.title ? await addTodo(db, { title: q.title, due: q.due, parent }, now()) : undefined;
    if (t) changed();
    return c.redirect(backTo(form, t?.parent ?? t?.id), 303);
  });
  app.post("/todo/:id", async (c) => {
    const id = idOf(c.req.param("id"));
    const form = await c.req.parseBody();
    if (id === undefined) return c.notFound();
    const state = first(form.state);
    const due = first(form.due);
    await updateTodo(db, id, { title: first(form.title) || undefined, notes: typeof form.notes === "string" ? form.notes : undefined, state: isState(state) ? state : undefined, due: form.due === undefined ? undefined : due || null }, now());
    changed();
    return c.redirect(backTo(form, id), 303);
  });
  app.post("/todo/:id/toggle", async (c) => {
    const id = idOf(c.req.param("id"));
    const form = await c.req.parseBody();
    if (id === undefined) return c.notFound();
    const t = await toggleDone(db, id, now());
    if (t) changed();
    return c.redirect(backTo(form, t?.parent ?? id), 303);
  });
  app.post("/todo/:id/move", async (c) => {
    const id = idOf(c.req.param("id"));
    const form = await c.req.parseBody();
    if (id === undefined) return c.notFound();
    await moveTodo(db, id, first(form.dir) === "down" ? "down" : "up");
    changed();
    return c.redirect(backTo(form, id), 303);
  });
  app.post("/todo/:id/delete", async (c) => {
    const id = idOf(c.req.param("id"));
    const form = await c.req.parseBody();
    if (id === undefined) return c.notFound();
    const t = await getTodo(db, id);
    await deleteTodo(db, id);
    changed();
    return c.redirect(backTo(form, t?.parent ?? undefined), 303);
  });
  return app;
}
