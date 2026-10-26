/**
 * Bino's pages: /bino (conversations, and what Bino remembers), /bino/c/<id> (one conversation).
 * A message posts and comes straight back; Bino's reply fills in over the hub. A plan Bino
 * proposes shows as a card whose fields can be changed; nothing reaches my list before "Add".
 * Bino's text is model output: rendered through the kit's markdown, which escapes.
 *
 * What Bino proposes to do (src/packs/core/assistant/bino/acts.ts) shows as a filled-in card too: a
 * dev task goes to the normal preview, whose Create is the confirm; a pack's act (Teams: a message)
 * is drawn and carried out by its pack, behind a second click unless it's one-click.
 *
 * The pane (/bino/dock…, framed by every other page like a pack's dock): the same conversations,
 * small. What I ask from it carries the page I'm on, which src/packs/core/assistant/bino/view.ts turns into names and
 * states (a private page only by name).
 */
import { Hono } from "hono";
import { html } from "hono/html";
import { type Act, type PackAct as PackActOf, isPackAct } from "./acts.ts";
import type { PackAct } from "../../../registry.ts";
import type { Bino, Conv, Msg } from "./bino.ts";
import { MAX_SAY } from "./bino.ts";
import { MAX_STEPS, type Plan, planOf } from "./context.ts";
import { type ViewApp, viewOf } from "./view.ts";
import type { AppEnv, Env } from "../../../../env.ts";
import type { Snapshot } from "../../../../gather.ts";
import { dockShell, type Frame, shell } from "../../../../html.ts";
import type { Hub } from "../../../../live.ts";
import { addTodo, getTodo, listTodos, STATES, type Todo } from "../../../../todo/store.ts";
import { Confirm, type Html, Notice, PageHeader, Panel } from "../../../../ui/kit.ts";
import { markdown } from "../../../../ui/markdown.ts";
import { Ago, harnessTag } from "../../../../pages/parts.ts";

const LABEL: Record<string, string> = { doing: "Doing", next: "Next", waiting: "Waiting" };
const OPEN_STATES = STATES.filter((s) => s !== "done");

function planCard(c: Conv, i: number, plan: Plan, m: Msg, target?: Todo, ax?: ActCtx): Html {
  if (m.added) return html`<div class="bino-plan done"><p>Added to your list. <a href="/todo#t-${m.added}"${out(ax)}>Open it</a></p></div>`;
  const step = (s: { title: string; state: string; due: string | null } | undefined, n: number) =>
    html`<li class="bino-step"><input type="text" name="step_title" value="${s?.title ?? ""}" maxlength="300" aria-label="Step ${n + 1}" placeholder="${s ? "" : "Another step (optional)"}"><select name="step_state" aria-label="Step ${n + 1}: where it stands">${OPEN_STATES.map((st) => html`<option value="${st}"${st === (s?.state ?? "next") ? html` selected` : ""}>${LABEL[st]}</option>`)}</select><input type="date" name="step_due" value="${s?.due ?? ""}" aria-label="Step ${n + 1}: due"></li>`;
  const rows = [...plan.steps.map((s, n) => step(s, n)), ...(plan.steps.length < MAX_STEPS ? [step(undefined, plan.steps.length)] : [])];
  return html`<form method="post" action="/bino/c/${c.id}/plan/${i}" class="bino-plan"${out(ax)}>
<p class="bino-plan-h">A breakdown for your list</p>
<label class="field"><span class="label">Initiative</span><input type="text" name="title" value="${plan.title}" maxlength="300" required></label>
${plan.notes ? html`<label class="field"><span class="label">Notes</span><textarea name="notes" rows="2" maxlength="2000">\n${plan.notes}</textarea></label>` : ""}
<ol class="bino-steps">${rows}</ol>
${target ? html`<fieldset class="bino-target"><legend>Where</legend><label class="check"><input type="radio" name="target" value="${target.id}" checked> As steps under «${target.title}»</label><label class="check"><input type="radio" name="target" value="new"> As a new item</label></fieldset>` : html`<input type="hidden" name="target" value="new">`}
<div class="buttons"><button type="submit" class="primary">Add these to my list</button><span class="hint">Change anything above first. Empty steps are left out.</span></div>
</form>`;
}


/** What a card needs from outside Bino: the org, and what packs' cards need. */
export type ActCtx = { org: string; /** In the pane: forms that lead to a full page open it there. */ dock?: boolean; /** A pack's act by its kind, when that pack is on (src/packs/registry.ts actsFrom). */ packAct?: (kind: string) => PackAct | undefined; /** What I typed in a pack act's card that was refused, by card. */ keptForms?: Map<string, Record<string, string>> };
const out = (ax?: ActCtx) => (ax?.dock ? html` target="_top"` : "");

const actKey = (c: Conv, i: number, n: number) => `${c.id}:${i}:${n}`;

function taskCard(i: number, n: number, a: Act & { kind: "task" }, ax: ActCtx): Html {
  const repo = a.repo && !a.repo.includes("/") ? `${ax.org}/${a.repo}` : a.repo;
  return html`<form method="post" action="/issues/task/preview" class="bino-plan" id="act-${i}-${n}"${out(ax)}>
<p class="bino-plan-h">A dev task</p>
<input type="hidden" name="type" value="Task"><input type="hidden" name="assign" value="on">
<label class="field"><span class="label">Under</span><input type="text" name="parent" value="${a.parent}" maxlength="200" required placeholder="${ax.org}/repo#45"></label>
<label class="field"><span class="label">Repo</span><input type="text" name="repo" value="${repo}" maxlength="200" placeholder="${ax.org}/repo"></label>
<label class="field"><span class="label">Title</span><input type="text" name="title" value="${a.title}" maxlength="255" required></label>
<label class="field"><span class="label">Description</span><textarea name="body" rows="5">\n${a.body}</textarea></label>
<div class="buttons"><button type="submit" class="primary">Preview</button><span class="hint">Nothing is created before Create on the next page.</span></div>
</form>`;
}

/**
 * A pack's act (src/packs/types.ts ActKind): its inputs inside the core's card, posting to the
 * core, which runs it in the background. Two clicks unless the pack says one is enough.
 */
function packCard(c: Conv, i: number, n: number, a: PackActOf & Act, ax: ActCtx): Html {
  const id = `act-${i}-${n}`;
  if (a.done) return html`<div class="bino-plan done" id="${id}"><p>${a.done.text} ${Ago(a.done.at)}.${a.done.href ? html` <a href="${a.done.href}"${out(ax)}>Open it</a>` : ""}</p></div>`;
  if (a.sending) return html`<div class="bino-plan" id="${id}" aria-live="polite"><p><span class="spinner" aria-hidden="true"></span> Working on it…</p></div>`;
  const k = ax.packAct?.(a.kind);
  const inputs = k?.inputs(a.fields, ax.keptForms?.get(actKey(c, i, n)));
  if (!k || !inputs)
    return html`<div class="bino-plan" id="${id}"><p class="bino-plan-h">${k?.title ?? "A proposal for one of your apps"}</p>${Notice({ tone: "warn", children: k ? "That app can't show this card right now." : "The app it's for isn't on here now, so it can't be done from Dovre." })}<dl class="facts">${Object.entries(a.fields).map(([name, v]) => html`<dt>${name}</dt><dd>${v}</dd>`)}</dl></div>`;
  const press = html`<button type="submit" class="primary" data-busy="Working">${k.button}</button>`;
  return html`<form method="post" action="/bino/c/${c.id}/act/${i}/${n}" class="bino-plan" id="${id}">${ax.dock ? DOCK_FIELD : ""}
<p class="bino-plan-h">${k.title}</p>
${a.error ? Notice({ tone: "bad", children: html`<strong>Not done.</strong> ${a.error}` }) : ""}
${inputs}
<div class="buttons">${k.oneClick ? press : html`<details class="confirm"><summary>${k.button}…</summary><div class="confirm-body"><p>${k.question}</p>${press}</div></details>`}${k.hint ? html`<span class="hint">${k.hint}</span>` : ""}</div>
</form>`;
}

function actCard(c: Conv, i: number, n: number, a: Act, ax: ActCtx): Html {
  if (isPackAct(a)) return packCard(c, i, n, a, ax);
  // One of a kind that's gone (an old conversation's Teams message, from before Teams was a pack): not drawn.
  if (a.kind !== "task") return html``;
  return taskCard(i, n, a, ax);
}

function message(c: Conv, m: Msg, i: number, target?: Todo, ax?: ActCtx): Html {
  if (m.role === "user") return html`<li class="bino-msg you" data-stop="1" data-stop-label="${m.text.slice(0, 120)}"><p class="bino-who">You <span class="t3">${Ago(m.at)}</span></p><div class="bino-text">${markdown(m.text)}</div></li>`;
  return html`<li class="bino-msg bino" data-stop="2"><p class="bino-who">Bino <span class="t3">${Ago(m.at)}${m.cost ? ` · $${m.cost.toFixed(3)}` : ""}</span></p><div class="bino-text">${markdown(m.text)}</div>${m.plan ? planCard(c, i, m.plan, m, target, ax) : ""}${ax ? (m.acts ?? []).map((a, n) => actCard(c, i, n, a, ax)) : ""}</li>`;
}

/** The box Bino is talked to in: one field, the send button in its own footer, Ctrl+Enter sends. */
function composer(o: { action: string; label: string; placeholder: string; button: string; busy: string; extra?: Html; dock?: boolean }): Html {
  return html`<form method="post" action="${o.action}" class="bino-compose${o.dock ? " dock-compose" : ""}" data-ctrl-enter>${o.dock ? DOCK_FIELD : ""}<textarea name="text" rows="${o.dock ? 3 : 4}" maxlength="${MAX_SAY}" required aria-label="${o.label}" placeholder="${o.placeholder}"></textarea>
<div class="bino-compose-f"><span class="hint">Ctrl+Enter sends</span><button type="submit" class="primary" data-busy="${o.busy}">${o.button}</button></div>${o.extra ?? ""}</form>`;
}

const cantAnswer = (b: Bino) => Notice({ tone: "warn", children: b.route.why ?? "Bino can't answer here." });

/** Where Bino answers from, as a tag in the header: the harness and its model. */
const binoTag = (b: Bino) => (b.route.via === "claude" ? harnessTag("claude", b.route.model) : "");
/** My avatar beside Bino's header (the dock, where it usually is, isn't on Bino's pages): at work while Bino answers. */
const binoAvatar = (frame: Frame, thinking = false) => frame.face?.({ place: "mini", thinking }) ?? "";

/** One conversation; the messages sit in a live region, the box to answer in outside it. */
export function convPage(frame: Frame, b: Bino, c: Conv, target?: Todo, ax?: ActCtx): Html {
  const body = html`${PageHeader({ title: c.title, crumbs: [{ href: "/bino", label: "Bino" }], actions: html`${binoTag(b)}${binoAvatar(frame, c.thinking)}` })}
<div class="bino-thread"><div data-live id="bino-conv"><ol class="bino-msgs" data-follow>${c.msgs.map((m, i) => message(c, m, i, target, ax))}</ol>
${c.thinking ? html`<p class="bino-thinking" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Bino is thinking…</p>` : ""}
${c.error ? Notice({ tone: "bad", children: c.error }) : ""}</div>
${b.route.ready ? composer({ action: `/bino/c/${c.id}/say`, label: "Your answer", placeholder: "Answer, or ask for a breakdown", button: "Send", busy: "Sending" }) : cantAnswer(b)}</div>`;
  return shell({ title: `${c.title} · Bino`, frame, current: "/bino", body, head: html`<meta name="u-topics" content="bino:${c.id}">` });
}

/** Ready-made openings: whole questions about what Bino can see. */
const STARTERS = ["What should I do first today?", "Group and tidy what's on my list", "What's waiting on me?"];

/** Starting points: a box for anything, the openings, and the open items on my list to break down. */
export async function binoPage(frame: Frame, b: Bino, todos: Todo[] = []): Promise<Html> {
  const convs = await b.list();
  const memories = await b.memory.list().catch(() => []);
  const open = todos.filter((t) => t.parent === null && t.state !== "done").slice(0, 4);
  const starts = html`<div class="bino-starts"><p class="bino-starts-h">Or start from</p><div class="bino-chips">${STARTERS.map((q) => html`<button type="submit" class="bino-chip" name="q" value="${q}" formnovalidate>${q}</button>`)}${open.map((t) => html`<button type="submit" class="bino-chip todo" name="todo" value="${t.id}" formnovalidate title="Break this down with Bino"><span class="t3">Break down</span> ${t.title}</button>`)}</div></div>`;
  const start = b.route.ready ? composer({ action: "/bino/new", label: "What's on your mind?", placeholder: "What's on your mind? Something to think through, group or break down.", button: "Talk it through", busy: "Starting", extra: starts }) : cantAnswer(b);
  const list = html`<div data-live id="bino-list">${
    convs.length
      ? html`<ul class="bino-convs">${convs.map((c) => html`<li><a href="/bino/c/${c.id}"><span class="bino-conv-t">${c.title}</span><span class="t3">${c.msgs.length} messages · ${Ago(c.at)}${c.thinking ? " · thinking" : ""}</span></a></li>`)}</ul>`
      : html`<p class="notes">None yet. What you start here shows up here.</p>`
  }</div>`;
  const remembered = Panel({
    title: "What Bino remembers",
    meta: b.memory.available ? String(memories.length) : "off",
    children: !b.memory.available
      ? html`<p class="notes">${b.memory.why}</p>`
      : memories.length
        ? html`<ul class="bino-mems">${memories.map((m) => html`<li><span>${m.scope.startsWith("app:") ? html`<span class="tag">${m.scope.slice(4)}</span> ` : ""}${m.text}</span> ${Confirm({ action: `/bino/memory/${m.id}/forget`, label: "Forget", question: "Forget this?" })}</li>`)}</ul>`
        : html`<p class="notes">Nothing yet. Bino keeps a few short facts from your conversations, never secrets. You can make it forget any of them here.</p>`,
  });
  const body = html`${PageHeader({ title: "Bino", sub: `Sees ${b.sees ?? "My list and pull requests"}. Changes nothing by itself.`, actions: html`${binoTag(b)}${binoAvatar(frame, convs.some((x) => x.thinking))}` })}
<div class="bino-hub"><div class="bino-main">${start}</div>
<aside class="bino-side">${Panel({ title: "Conversations", meta: String(convs.length), children: list })}${remembered}</aside></div>`;
  return shell({ title: "Bino · Dovre", frame, current: "/bino", body, head: html`<meta name="u-topics" content="bino">` });
}

/** In the pane: back to the conversation there, and the page I'm on, filled in as I send (src/ui/app.js.ts). */
const DOCK_FIELD = html`<input type="hidden" name="dock" value="1"><input type="hidden" name="view" value="" data-view>`;

function dockBar(title: string, o: { back?: boolean; full: string }): Html {
  return html`<header class="dock-h">${o.back ? html`<a class="dock-i" href="/bino/dock" title="Start over" aria-label="Start over">←</a>` : ""}<h1>${title}</h1><a class="dock-l" href="${o.full}" target="_top" title="Open as a page">Page</a><button type="button" class="dock-i ghost" data-dock-close title="Minimise (Esc)" aria-label="Minimise">–</button></header>`;
}

/** The pane's first view: a box to ask in (about the page I'm on, or anything), and the last few conversations. */
export async function binoDockPage(b: Bino): Promise<Html> {
  const convs = (await b.list()).slice(0, 8);
  const body = html`${dockBar("Bino", { full: "/bino" })}
<div class="dock-b">${
    b.route.ready
      ? composer({ action: "/bino/new", label: "Ask Bino", placeholder: "Ask about this page, or anything", button: "Ask", busy: "Asking", dock: true })
      : cantAnswer(b)
  }
<div data-live id="bino-list">${convs.length ? html`<ul class="bino-convs">${convs.map((c) => html`<li><a href="/bino/dock/c/${c.id}"><span class="bino-conv-t">${c.title}</span><span class="t3">${Ago(c.at)}${c.thinking ? " · thinking" : ""}</span></a></li>`)}</ul>` : ""}</div></div>`;
  return dockShell({ title: "Bino", body, head: html`<meta name="u-topics" content="bino">` });
}

/** One conversation in the pane: the thread scrolls, the box stays at the bottom. */
export function binoDockConvPage(b: Bino, c: Conv, ax: ActCtx, target?: Todo): Html {
  const body = html`${dockBar(c.title, { back: true, full: `/bino/c/${c.id}` })}
<div class="dock-b"><div data-live id="bino-conv"><ol class="bino-msgs" data-follow>${c.msgs.map((m, i) => message(c, m, i, target, ax))}</ol>
${c.thinking ? html`<p class="bino-thinking" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Bino is thinking…</p>` : ""}
${c.error ? Notice({ tone: "bad", children: c.error }) : ""}</div></div>
${b.route.ready ? composer({ action: `/bino/c/${c.id}/say`, label: "Your answer", placeholder: "Answer, or ask about this page", button: "Send", busy: "Sending", dock: true }) : cantAnswer(b)}`;
  return dockShell({ title: `${c.title} · Bino`, body, head: html`<meta name="u-topics" content="bino:${c.id}">` });
}

const first = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? (v.find((x) => typeof x === "string") ?? "") : "");
const all = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => (typeof x === "string" ? x : ""));
const idOf = (s: string) => (/^\d{1,9}$/.test(s) ? Number(s) : undefined);
const CONV = /^[0-9a-f-]{36}$/;

/** The plan as the card's form says it now: the same checks as Bino's own block. */
export function planFromForm(form: Record<string, unknown>): Plan | null {
  const titles = all(form.step_title);
  const states = all(form.step_state);
  const dues = all(form.step_due);
  return planOf({ title: first(form.title), notes: first(form.notes), steps: titles.map((title, i) => ({ title, state: states[i], due: dues[i] || undefined })) });
}

export function createBinoRoutes(env: Env, deps: {
  bino: Bino;
  page: () => Promise<{ frame: Frame }>;
  hub?: Hub;
  /** The newest gathered snapshot, for what a page I ask from shows. */
  peek?: () => Snapshot | undefined;
  /** What Bino knows right now, sent with each message when Bino answers elsewhere (hosted: the Durable Object). */
  context?: () => Promise<string>;
  /** The packs' apps: a conversation started on one of their pages is about that app (its memory scope). */
  apps?: () => ViewApp[];
  /** A pack's act by its kind, when that pack is on. */
  packAct?: (kind: string) => PackAct | undefined;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { bino } = deps;
  const db = env.DB;
  /** What I wrote in a pack act's card that was refused: in memory only, to try again with. */
  const keptForms = new Map<string, Record<string, string>>();
  const ax = (dock = false): ActCtx => ({ org: env.GHE_ORG, dock, packAct: deps.packAct, keptForms });
  /** Where a conversation is shown: in the pane when it was asked from there. */
  const convHref = (id: string, dock: boolean) => (dock ? `/bino/dock/c/${id}` : `/bino/c/${id}`);
  const viewIn = (form: Record<string, unknown>) => (first(form.dock) === "1" ? viewOf(first(form.view).slice(0, 500), deps.peek?.(), deps.apps?.()) || undefined : undefined);
  /** The app the page I asked from belongs to, if it's one of the packs'. */
  const appIn = (form: Record<string, unknown>) => {
    const path = first(form.dock) === "1" ? first(form.view) : "";
    if (!path.startsWith("/") || path.startsWith("//")) return undefined;
    const seg = path.slice(1).split(/[/?#]/)[0]!.toLowerCase();
    return deps.apps?.().find((a) => a.id === seg)?.id;
  };
  const known = async () => (deps.context ? { context: await deps.context() } : {});

  app.get("/bino", async (c) => c.html(await binoPage((await deps.page()).frame, bino, await listTodos(db).catch(() => []))));
  app.post("/bino/new", async (c) => {
    const form = await c.req.parseBody();
    const todo = idOf(first(form.todo));
    const item = todo !== undefined ? await getTodo(db, todo) : undefined;
    const text = first(form.text) || first(form.q) || (item ? `Help me group and break this down: ${item.title}${item.notes ? `\n\n${item.notes}` : ""}` : "");
    if (!text.trim() || !bino.route.ready) return c.redirect(first(form.dock) === "1" ? "/bino/dock" : "/bino", 303);
    const conv = await bino.start(text, { todo: item ? (item.parent ?? item.id) : undefined, view: viewIn(form), app: appIn(form), ...(await known()) });
    return c.redirect(convHref(conv.id, first(form.dock) === "1"), 303);
  });
  app.get("/bino/c/:id", async (c) => {
    const conv = CONV.test(c.req.param("id")) ? await bino.get(c.req.param("id")) : undefined;
    if (!conv) return c.notFound();
    const target = conv.todo !== undefined ? await getTodo(db, conv.todo) : undefined;
    return c.html(convPage((await deps.page()).frame, bino, conv, target, ax()));
  });
  app.post("/bino/c/:id/say", async (c) => {
    const id = c.req.param("id");
    if (!CONV.test(id) || !(await bino.get(id))) return c.notFound();
    const form = await c.req.parseBody();
    await bino.say(id, first(form.text), { view: viewIn(form), ...(await known()) });
    return c.redirect(convHref(id, first(form.dock) === "1"), 303);
  });
  app.get("/bino/dock", async (c) => c.html(await binoDockPage(bino)));
  app.get("/bino/dock/c/:id", async (c) => {
    const conv = CONV.test(c.req.param("id")) ? await bino.get(c.req.param("id")) : undefined;
    if (!conv) return c.redirect("/bino/dock", 303);
    const target = conv.todo !== undefined ? await getTodo(db, conv.todo) : undefined;
    return c.html(binoDockConvPage(bino, conv, ax(true), target));
  });
  /** The card's "Add these to my list": exactly what its form says, once. */
  app.post("/bino/c/:id/plan/:i", async (c) => {
    const id = c.req.param("id");
    const conv = CONV.test(id) ? await bino.get(id) : undefined;
    const i = idOf(c.req.param("i"));
    const m = conv && i !== undefined ? conv.msgs[i] : undefined;
    if (!conv || i === undefined || !m?.plan) return c.notFound();
    if (m.added) return c.redirect(`/todo#t-${m.added}`, 303);
    const form = await c.req.parseBody({ all: true });
    const plan = planFromForm(form);
    if (!plan) return c.redirect(`/bino/c/${id}`, 303);
    const targetId = idOf(first(form.target));
    const target = targetId !== undefined && targetId === conv.todo ? await getTodo(db, targetId) : undefined;
    const parent = target && target.parent === null ? target : await addTodo(db, { title: plan.title, notes: plan.notes });
    if (!parent) return c.redirect(`/bino/c/${id}`, 303);
    for (const s of plan.steps) await addTodo(db, { title: s.title, parent: parent.id, state: s.state, due: s.due });
    await bino.added(id, i, parent.id);
    deps.hub?.publish(["snapshot"]);
    return c.redirect(`/todo#t-${parent.id}`, 303);
  });
  /** A pack's act from Bino's card: what the card says now, carried out by the pack in the background. */
  app.post("/bino/c/:id/act/:i/:n", async (c) => {
    const id = c.req.param("id");
    const i = idOf(c.req.param("i"));
    const n = idOf(c.req.param("n"));
    const conv = CONV.test(id) ? await bino.get(id) : undefined;
    const a = conv && i !== undefined && n !== undefined ? await bino.act(id, i, n) : undefined;
    if (conv && i !== undefined && n !== undefined && a && isPackAct(a)) {
      // A pack's: what its card's form says now, carried out by the pack in the background.
      const form = await c.req.parseBody();
      const back = `${convHref(id, first(form.dock) === "1")}#act-${i}-${n}`;
      if (a.done || a.sending) return c.redirect(back, 303);
      const said: Record<string, string> = {};
      for (const [name, v] of Object.entries(form).slice(0, 40)) if (typeof v === "string" && name !== "dock" && name !== "view" && /^[a-z][a-z0-9_]{0,31}$/.test(name)) said[name] = v.replace(/\r\n?/g, "\n").slice(0, 4000);
      const key = `${id}:${i}:${n}`;
      const k = deps.packAct?.(a.kind);
      if (!k) {
        await bino.setAct(id, i, n, { error: "The app it's for isn't on here now." });
        return c.redirect(back, 303);
      }
      keptForms.delete(key);
      await bino.setAct(id, i, n, { sending: true, error: undefined });
      void k.run(said, a.fields).then(async (r) => {
        if (r.ok) await bino.setAct(id, i, n, { sending: false, done: { at: Date.now(), text: r.done, ...(r.href ? { href: r.href } : {}) } });
        else {
          keptForms.set(key, said);
          await bino.setAct(id, i, n, { sending: false, error: r.error });
        }
      });
      return c.redirect(back, 303);
    }
    return c.notFound();
  });
  app.post("/bino/memory/:id/forget", async (c) => {
    const id = c.req.param("id");
    if (/^[\w-]{1,80}$/.test(id)) await bino.memory.forget(id);
    deps.hub?.publish(["bino"]);
    return c.redirect("/bino", 303);
  });
  return app;
}
