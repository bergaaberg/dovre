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
import { MAX_SAY, MAX_TITLE } from "./bino.ts";
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
import { currentTz, dtf } from "../../../../when.ts";

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

/** A gap this long between two messages gets a line with the time. */
const QUIET = 60 * 60_000;
/** The same speaker within this long: one group, the name said once. */
const GROUP = 5 * 60_000;

const clockOf = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

function message(c: Conv, m: Msg, i: number, target?: Todo, ax?: ActCtx, prev?: Msg): Html {
  const grouped = prev?.role === m.role && m.at - prev.at < GROUP;
  if (m.role === "user") return html`<li class="bino-msg you${grouped ? " cont" : ""}" data-stop="1" data-stop-label="${m.text.slice(0, 120)}">${grouped ? "" : html`<p class="bino-who">You <span class="t3">${Ago(m.at)}</span></p>`}<div class="bino-text">${markdown(m.text)}</div></li>`;
  const last = i === c.msgs.length - 1;
  // Asking again for an answer whose plan was added, or whose act went out, would leave those behind.
  const redo = last && !c.thinking && m.added === undefined && !(m.acts ?? []).some((a) => a.done || a.sending);
  const tools = html`<div class="bino-msg-f"><button type="button" class="ghost" data-copy-msg title="Copy this answer">Copy</button>${redo ? html`<form method="post" action="/bino/c/${c.id}/retry" data-inplace>${ax?.dock ? html`<input type="hidden" name="dock" value="1">` : ""}<button type="submit" class="ghost" title="Ask for this answer again">Retry</button></form>` : ""}</div>`;
  return html`<li class="bino-msg bino" data-stop="2"><p class="bino-who">Bino <span class="t3">${Ago(m.at)}${m.cost ? ` · $${m.cost.toFixed(3)}` : ""}${m.looked?.length ? ` · looked up ${m.looked.join("; ")}` : ""}</span></p><div class="bino-text">${markdown(m.text)}</div>${m.plan ? planCard(c, i, m.plan, m, target, ax) : ""}${ax ? (m.acts ?? []).map((a, n) => actCard(c, i, n, a, ax)) : ""}${tools}</li>`;
}

/** The messages: grouped by speaker, a line with the time after a long quiet. */
function thread(c: Conv, target?: Todo, ax?: ActCtx): Html {
  return html`<ol class="bino-msgs" data-follow>${c.msgs.map((m, i) => {
    const prev = c.msgs[i - 1];
    const gap = prev && m.at - prev.at >= QUIET ? html`<li class="bino-gap" aria-hidden="true"><span data-at="${m.at}" data-ago title="${clockOf(m.at)} UTC">${clockOf(m.at)}</span></li>` : "";
    return html`${gap}${message(c, m, i, target, ax, prev)}`;
  })}</ol>`;
}

/** The box Bino is talked to in: one field, the send button in its own footer. Enter sends, Shift+Enter is a new line, ↑ in an empty box brings back what I last sent (src/ui/app.js.ts). */
function composer(o: { action: string; label: string; placeholder: string; button: string; busy: string; extra?: Html; dock?: boolean }): Html {
  return html`<form method="post" action="${o.action}" class="bino-compose${o.dock ? " dock-compose" : ""}" data-ctrl-enter data-chat>${o.dock ? DOCK_FIELD : ""}<textarea name="text" rows="${o.dock ? 1 : 3}" maxlength="${MAX_SAY}" required aria-label="${o.label}" placeholder="${o.placeholder}"></textarea>
<div class="bino-compose-f"><span class="hint">Enter sends · Shift+Enter new line · ↑ last message</span><button type="submit" class="primary" data-busy="${o.busy}">${o.button}</button></div>${o.extra ?? ""}</form>`;
}

/** While Bino answers: dots, what it's doing, and Stop (Esc or s, src/ui/app.js.ts); once stopped or failed, a line saying so and Ask again. */
function answering(c: Conv, dock: boolean): Html {
  const dockField = dock ? html`<input type="hidden" name="dock" value="1">` : "";
  const again = html`<form method="post" action="/bino/c/${c.id}/retry" data-inplace>${dockField}<button type="submit" class="ghost">Ask again</button></form>`;
  const asked = c.msgs.at(-1)?.role === "user";
  if (c.stopped && !c.thinking) return html`<div class="bino-after"><p class="notes">You stopped this answer. Ask again, or say something else.</p>${asked ? again : ""}</div>`;
  if (!c.thinking) return c.error && asked ? html`<div class="bino-after">${again}</div>` : html``;
  return html`<form method="post" action="/bino/c/${c.id}/stop" class="bino-thinking" aria-live="polite" data-inplace>${dockField}<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span> <span>${c.looking ? `Bino is looking up ${c.looking}…` : "Bino is thinking…"}</span> <button type="submit" class="ghost" data-bino-stop title="Stop (Esc or s)">Stop</button></form>`;
}

const cantAnswer = (b: Bino) => Notice({ tone: "warn", children: b.route.why ?? "Bino can't answer here." });

/** Where Bino answers from, as a tag in the header: the harness and its model. */
const binoTag = (b: Bino) => (b.route.via === "claude" ? harnessTag("claude", b.route.model) : "");
/** A pack's face beside Bino's header (the dock, where it usually is, isn't on Bino's pages): at work while Bino answers. */
const binoFace = (frame: Frame, thinking = false) => frame.face?.({ place: "mini", thinking }) ?? "";

/** The day a time falls on in my timezone, as 2026-10-29. */
const dayIn = (at: number, tz: string) => dtf("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/** The sidebar's groups: pinned first, then by how long ago, in my timezone. */
export function groupsOf(convs: Conv[], now: number, tz: string): { label: string; convs: Conv[] }[] {
  const today = Date.parse(dayIn(now, tz));
  const label = (at: number) => {
    const days = Math.round((today - Date.parse(dayIn(at, tz))) / 86_400_000);
    return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "This week" : days < 31 ? "This month" : "Earlier";
  };
  const out: { label: string; convs: Conv[] }[] = [];
  const add = (l: string, c: Conv) => {
    const g = out.find((x) => x.label === l);
    if (g) g.convs.push(c);
    else out.push({ label: l, convs: [c] });
  };
  for (const c of convs) if (c.pinned) add("Pinned", c);
  for (const c of convs) if (!c.pinned) add(label(c.at), c);
  return out;
}

/** Whether a conversation says this, in its title or anything said in it. */
export const saysIt = (c: Conv, q: string) => {
  const n = q.toLowerCase();
  return c.title.toLowerCase().includes(n) || c.msgs.some((m) => m.text.toLowerCase().includes(n));
};

/** What the workspace around a page needs: the conversations, my list, the packs' apps. */
export type Ws = { convs: Conv[]; todos: Todo[]; apps: ViewApp[]; q?: string; now?: number; tz?: string };

/** One conversation in the sidebar: its link, and a menu to rename, pin or delete it. */
function navItem(c: Conv, current: string | undefined, back: string): Html {
  const on = c.id === current;
  const backField = html`<input type="hidden" name="back" value="${back}">`;
  return html`<li class="bino-ci${on ? " on" : ""}" data-conv="${c.id}" data-title="${c.title.toLowerCase()}"><a href="/bino/c/${c.id}"${on ? html` aria-current="page"` : ""}><span class="bino-conv-t">${c.title}</span><span class="t3">${c.pinned ? "Pinned · " : ""}${Ago(c.at)}${c.thinking ? " · thinking" : ""}</span></a>
<details class="bino-ci-m" id="cm-${c.id}"><summary class="dock-i" title="Rename, pin or delete" aria-label="More for this chat">⋯</summary><div class="bino-ci-menu">
<form method="post" action="/bino/c/${c.id}/rename" class="bino-rename" data-inplace>${backField}<input type="text" name="title" value="${c.title}" maxlength="${MAX_TITLE}" required aria-label="New title"><button type="submit">Rename</button></form>
<form method="post" action="/bino/c/${c.id}/pin" data-inplace>${backField}<input type="hidden" name="on" value="${c.pinned ? "0" : "1"}"><button type="submit" class="ghost">${c.pinned ? "Unpin" : "Pin to the top"}</button></form>
${Confirm({ kind: "bino.delete", action: `/bino/c/${c.id}/delete`, fields: { back }, label: "Delete", question: "Delete this chat? It can't be brought back.", danger: true })}
</div></details></li>`;
}

/** The conversations: a new one, search, and every one grouped by date. */
function binoNav(ws: Ws, current?: string): Html {
  const q = ws.q ?? "";
  const back = current ? `/bino/c/${current}` : "/bino";
  const convs = q ? ws.convs.filter((c) => saysIt(c, q)) : ws.convs;
  const groups = groupsOf(convs, ws.now ?? Date.now(), ws.tz ?? currentTz());
  return html`<nav class="bino-nav" aria-label="Conversations">
<div class="bino-nav-h"><a class="btn primary" href="/bino" data-bino-new title="New chat (n)">New chat</a></div>
<form method="get" action="${back}" class="bino-find" role="search"><input type="search" name="q" value="${q}" maxlength="200" placeholder="Search chats" aria-label="Search conversations" data-conv-filter></form>
<div data-live id="bino-nav"><div class="bino-nav-s" id="bino-nav-s" data-keep-scroll>${q ? html`<p class="bino-found t3">${convs.length ? `${convs.length} with «${q}»` : `None with «${q}»`} · <a href="${back}">Show all</a></p>` : ""}${
    groups.length
      ? groups.map((g) => html`<section class="bino-group"><h2 class="bino-starts-h">${g.label}</h2><ul class="bino-convs">${g.convs.map((c) => navItem(c, current, back))}</ul></section>`)
      : q ? "" : html`<p class="notes">None yet. What you start shows up here.</p>`
  }</div></div></nav>`;
}

/** Beside the chat: what Bino sees, the open items on my list to break down, and what it remembers. */
async function binoSide(b: Bino, ws: Ws, c?: Conv, target?: Todo): Promise<Html> {
  const memories = await b.memory.list().catch(() => []);
  const open = ws.todos.filter((t) => t.parent === null && t.state !== "done").slice(0, 6);
  const app = c?.app ? ws.apps.find((a) => a.id === c.app) : undefined;
  const from = c ? [...c.msgs].reverse().find((m) => m.view)?.view : undefined;
  const sees = Panel({
    title: "What Bino sees",
    children: html`<p class="bino-sees">${b.sees ?? "My list and pull requests"}.${ws.apps.length ? html` Your apps: ${ws.apps.map((a, i) => html`${i ? ", " : ""}${a.name}`)}.` : ""} It changes nothing by itself.</p>${
      c && (app || from || target)
        ? html`<dl class="facts">${target ? html`<dt>About</dt><dd><a href="/todo#t-${target.id}">${target.title}</a></dd>` : ""}${app ? html`<dt>App</dt><dd>${app.name}</dd>` : ""}${from ? html`<dt>Asked from</dt><dd>${from}</dd>` : ""}</dl>`
        : ""
    }`,
  });
  const list = Panel({
    title: "My list",
    meta: String(open.length),
    children: open.length
      ? html`<form method="post" action="/bino/new" class="bino-todos"><ul class="bino-convs">${open.map((t) => html`<li><button type="submit" class="ghost bino-todo" name="todo" value="${t.id}" title="Start a chat to break this down"><span class="bino-conv-t">${t.title}</span><span class="t3">Break down with Bino</span></button></li>`)}</ul></form>`
      : html`<p class="notes">Nothing open on your list.</p>`,
  });
  const remembered = Panel({
    title: "What Bino remembers",
    meta: b.memory.available ? String(memories.length) : "off",
    children: !b.memory.available
      ? html`<p class="notes">${b.memory.why}</p>`
      : memories.length
        ? html`<ul class="bino-mems">${memories.map((m) => html`<li><span>${m.scope.startsWith("app:") ? html`<span class="tag">${m.scope.slice(4)}</span> ` : ""}${m.text}</span> ${Confirm({ kind: "bino.forget", action: `/bino/memory/${m.id}/forget`, label: "Forget", question: "Forget this?" })}</li>`)}</ul>`
        : html`<p class="notes">Nothing yet. Bino keeps a few short facts from your conversations, never secrets. You can make it forget any of them here.</p>`,
  });
  return html`<aside class="bino-side"><div data-live id="bino-side">${sees}${b.route.ready ? list : ""}${remembered}</div></aside>`;
}

/** The workspace: the conversations at the left, the chat in the middle, what Bino sees at the right. */
const workspace = (nav: Html, main: Html, side: Html) => html`<div class="bino-ws">${nav}<section class="bino-main">${main}</section>${side}</div>`;

/** One conversation; the messages sit in a live region, the box to answer in outside it. */
export async function convPage(frame: Frame, b: Bino, c: Conv, ws: Ws, target?: Todo, ax?: ActCtx): Promise<Html> {
  const main = html`<div class="bino-thread"><div data-live id="bino-conv">${thread(c, target, ax)}
${c.error ? Notice({ tone: "bad", children: c.error }) : ""}
${answering(c, false)}</div>
${b.route.ready ? composer({ action: `/bino/c/${c.id}/say`, label: "Your answer", placeholder: "Answer, or ask for a breakdown", button: "Send", busy: "Sending" }) : cantAnswer(b)}</div>`;
  const body = html`${PageHeader({ title: c.title, crumbs: [{ href: "/bino", label: "Bino" }], actions: html`${binoTag(b)}${binoFace(frame, c.thinking)}` })}
${workspace(binoNav({ ...ws, tz: ws.tz ?? frame.tz }, c.id), main, await binoSide(b, ws, c, target))}`;
  return shell({ title: `${c.title} · Bino`, frame, current: "/bino", body, head: html`<meta name="u-topics" content="bino bino:${c.id}">` });
}

/** Ready-made openings: whole questions about what Bino can see. */
const STARTERS = ["What should I do first today?", "Group and tidy what's on my list", "What's waiting on me?"];

/** A new chat: a box for anything and the openings, beside the conversations and what Bino sees. */
export async function binoPage(frame: Frame, b: Bino, ws: Ws): Promise<Html> {
  const starts = html`<div class="bino-starts"><p class="bino-starts-h">Or start from</p><div class="bino-chips">${STARTERS.map((q) => html`<button type="submit" class="bino-chip" name="q" value="${q}" formnovalidate>${q}</button>`)}</div></div>`;
  const start = b.route.ready ? composer({ action: "/bino/new", label: "What's on your mind?", placeholder: "What's on your mind? Something to think through, group or break down.", button: "Talk it through", busy: "Starting", extra: starts }) : cantAnswer(b);
  const body = html`${PageHeader({ title: "Bino", sub: "Ask about your work, or think something through. It changes nothing by itself.", actions: html`${binoTag(b)}${binoFace(frame, ws.convs.some((x) => x.thinking))}` })}
${workspace(binoNav({ ...ws, tz: ws.tz ?? frame.tz }), start, await binoSide(b, ws))}`;
  return shell({ title: "Bino · Dovre", frame, current: "/bino", body, head: html`<meta name="u-topics" content="bino">` });
}

/** In the pane: back to the conversation there, and the page I'm on, filled in as I send (src/ui/app.js.ts). */
const DOCK_FIELD = html`<input type="hidden" name="dock" value="1"><input type="hidden" name="view" value="" data-view>`;

/** The pane's header: the conversation's title, the other recent ones, a new one, out to the full page, and minimise. */
function dockBar(title: string, o: { full: string; fresh?: boolean; others?: Conv[] }): Html {
  const others = o.others ?? [];
  const recent = others.length
    ? html`<details class="dock-recent"><summary class="dock-i" title="Other chats" aria-label="Other chats">▾</summary><ul class="dock-menu">${others.map((x) => html`<li><a href="/bino/dock/c/${x.id}"><span class="bino-conv-t">${x.title}</span><span class="t3">${Ago(x.at)}${x.thinking ? " · thinking" : ""}</span></a></li>`)}</ul></details>`
    : "";
  return html`<header class="dock-h"><h1 title="${title}">${title}</h1>${recent}${o.fresh ? html`<a class="dock-i" href="/bino/dock" title="New chat" aria-label="New chat">+</a>` : ""}<a class="dock-l" href="${o.full}" target="_top" title="Open as a page">Page ↗</a><button type="button" class="dock-i ghost" data-dock-close title="Minimise (Esc)" aria-label="Minimise">–</button></header>`;
}

/** The pane's first view: the last few conversations, and the box to ask in (about the page I'm on, or anything) at the bottom. */
export async function binoDockPage(b: Bino): Promise<Html> {
  const convs = (await b.list()).slice(0, 8);
  const body = html`${dockBar("Bino", { full: "/bino" })}
<div class="dock-b" id="dock-scroll"><div data-live id="bino-list">${
    convs.length
      ? html`<p class="bino-starts-h">Recent</p><ul class="bino-convs">${convs.map((c) => html`<li><a href="/bino/dock/c/${c.id}"><span class="bino-conv-t">${c.title}</span><span class="t3">${Ago(c.at)}${c.thinking ? " · thinking" : ""}</span></a></li>`)}</ul>`
      : html`<p class="notes">Ask about the page you're on, or anything. Bino sees names and states, and changes nothing by itself.</p>`
  }</div></div>
${b.route.ready ? composer({ action: "/bino/new", label: "Ask Bino", placeholder: "Ask about this page, or anything", button: "Ask", busy: "Asking", dock: true }) : html`<div class="dock-b">${cantAnswer(b)}</div>`}`;
  return dockShell({ title: "Bino", body, head: html`<meta name="u-topics" content="bino">` });
}

/** One conversation in the pane: the thread scrolls, the box stays at the bottom. */
export function binoDockConvPage(b: Bino, c: Conv, ax: ActCtx, target?: Todo, others: Conv[] = []): Html {
  const body = html`${dockBar(c.title, { fresh: true, full: `/bino/c/${c.id}`, others })}
<div class="dock-b" id="dock-scroll"><div data-live id="bino-conv">${thread(c, target, ax)}
${c.error ? Notice({ tone: "bad", children: c.error }) : ""}
${answering(c, true)}</div></div>
${b.route.ready ? composer({ action: `/bino/c/${c.id}/say`, label: "Your answer", placeholder: "Answer, or ask about this page", button: "Send", busy: "Sending", dock: true }) : cantAnswer(b)}`;
  return dockShell({ title: `${c.title} · Bino`, body, head: html`<meta name="u-topics" content="bino:${c.id}">` });
}

const first = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? (v.find((x) => typeof x === "string") ?? "") : "");
const all = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => (typeof x === "string" ? x : ""));
const idOf = (s: string) => (/^\d{1,9}$/.test(s) ? Number(s) : undefined);
const CONV = /^[0-9a-f-]{36}$/;
/** The workspace's pages, the only places a sidebar form goes back to. */
const BACK = /^\/bino(\/c\/[0-9a-f-]{36})?$/;

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
  const viewIn = async (form: Record<string, unknown>) => (first(form.dock) === "1" ? (await viewOf(first(form.view).slice(0, 500), deps.peek?.(), deps.apps?.())) || undefined : undefined);
  /** The app the page I asked from belongs to, if it's one of the packs'. */
  const appIn = (form: Record<string, unknown>) => {
    const path = first(form.dock) === "1" ? first(form.view) : "";
    if (!path.startsWith("/") || path.startsWith("//")) return undefined;
    const seg = path.slice(1).split(/[/?#]/)[0]!.toLowerCase();
    return deps.apps?.().find((a) => a.id === seg)?.id;
  };
  const known = async () => (deps.context ? { context: await deps.context() } : {});

  /** What the workspace shows around a page: every conversation, my list, the apps; `q` narrows the conversations. */
  const wsOf = async (q: string | undefined): Promise<Ws> => ({ convs: await bino.list(), todos: await listTodos(db).catch(() => []), apps: deps.apps?.() ?? [], q: (q ?? "").trim().slice(0, 200) });
  /** Where a sidebar's form goes back to: the workspace page it was on. */
  const backOf = (form: Record<string, unknown>, gone?: string) => {
    const b = first(form.back);
    return BACK.test(b) && b !== `/bino/c/${gone}` ? b : "/bino";
  };

  app.get("/bino", async (c) => c.html(await binoPage((await deps.page()).frame, bino, await wsOf(c.req.query("q")))));
  app.post("/bino/new", async (c) => {
    const form = await c.req.parseBody();
    const todo = idOf(first(form.todo));
    const item = todo !== undefined ? await getTodo(db, todo) : undefined;
    const text = first(form.text) || first(form.q) || first(form.prompt) || (item ? `Help me group and break this down: ${item.title}${item.notes ? `\n\n${item.notes}` : ""}` : "");
    if (!text.trim() || !bino.route.ready) return c.redirect(first(form.dock) === "1" ? "/bino/dock" : "/bino", 303);
    const conv = await bino.start(text, { todo: item ? (item.parent ?? item.id) : undefined, view: await viewIn(form), app: appIn(form), ...(await known()) });
    return c.redirect(convHref(conv.id, first(form.dock) === "1"), 303);
  });
  app.get("/bino/c/:id", async (c) => {
    const conv = CONV.test(c.req.param("id")) ? await bino.get(c.req.param("id")) : undefined;
    if (!conv) return c.notFound();
    const target = conv.todo !== undefined ? await getTodo(db, conv.todo) : undefined;
    return c.html(await convPage((await deps.page()).frame, bino, conv, await wsOf(c.req.query("q")), target, ax()));
  });
  app.post("/bino/c/:id/rename", async (c) => {
    const id = c.req.param("id");
    if (!CONV.test(id) || !(await bino.get(id))) return c.notFound();
    const form = await c.req.parseBody();
    await bino.rename(id, first(form.title));
    return c.redirect(backOf(form), 303);
  });
  app.post("/bino/c/:id/pin", async (c) => {
    const id = c.req.param("id");
    if (!CONV.test(id) || !(await bino.get(id))) return c.notFound();
    const form = await c.req.parseBody();
    await bino.pin(id, first(form.on) === "1");
    return c.redirect(backOf(form), 303);
  });
  /** Delete: gone for good, an answer being written stopped first. */
  app.post("/bino/c/:id/delete", async (c) => {
    const id = c.req.param("id");
    if (!CONV.test(id)) return c.notFound();
    const form = await c.req.parseBody();
    await bino.remove(id);
    return c.redirect(backOf(form, id), 303);
  });
  app.post("/bino/c/:id/say", async (c) => {
    const id = c.req.param("id");
    if (!CONV.test(id) || !(await bino.get(id))) return c.notFound();
    const form = await c.req.parseBody();
    await bino.say(id, first(form.text), { view: await viewIn(form), ...(await known()) });
    return c.redirect(convHref(id, first(form.dock) === "1"), 303);
  });
  /** Stop: the answer being written is cancelled; what I said stays, to ask again. */
  app.post("/bino/c/:id/stop", async (c) => {
    const id = c.req.param("id");
    if (!CONV.test(id) || !(await bino.get(id))) return c.notFound();
    const form = await c.req.parseBody();
    await bino.stop(id);
    return c.redirect(convHref(id, first(form.dock) === "1"), 303);
  });
  /** Retry: the last answer asked for again (or one that was stopped or failed). */
  app.post("/bino/c/:id/retry", async (c) => {
    const id = c.req.param("id");
    if (!CONV.test(id) || !(await bino.get(id))) return c.notFound();
    const form = await c.req.parseBody();
    await bino.retry(id, await known());
    return c.redirect(convHref(id, first(form.dock) === "1"), 303);
  });
  app.get("/bino/dock", async (c) => c.html(await binoDockPage(bino)));
  app.get("/bino/dock/c/:id", async (c) => {
    const conv = CONV.test(c.req.param("id")) ? await bino.get(c.req.param("id")) : undefined;
    if (!conv) return c.redirect("/bino/dock", 303);
    const target = conv.todo !== undefined ? await getTodo(db, conv.todo) : undefined;
    const others = (await bino.list()).filter((x) => x.id !== conv.id).slice(0, 8);
    return c.html(binoDockConvPage(bino, conv, ax(true), target, others));
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
