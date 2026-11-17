/**
 * Bino's pages: /bino (conversations, and what Bino remembers), /bino/c/<id> (one conversation).
 * A message posts and comes straight back; Bino's reply fills in over the hub. A plan Bino
 * proposes shows as a card whose fields can be changed; nothing reaches my list before "Add".
 * Bino's text is model output: rendered through the kit's markdown, which escapes.
 *
 * What Bino proposes to do (src/packs/core/assistant/bino/acts.ts) shows as a filled-in card too: a
 * dev task goes to the normal preview, whose Create is the confirm; a pack's act (Teams: a message)
 * is drawn and carried out by its pack, behind a second click unless it's one-click; a setting of
 * Dovre's (#185) shows what it is now and what it would become, and its press goes through that
 * setting's own Settings route, with Undo on the line that says what changed.
 *
 * The pane (/bino/dock…, framed by every other page like a pack's dock): the same conversations,
 * small. What I ask from it carries the page I'm on, which src/packs/core/assistant/bino/view.ts turns into names and
 * states (a private page only by name).
 */
import { Hono } from "hono";
import { html } from "hono/html";
import { ACT_FENCE, type Act, type PackAct as PackActOf, type SettingAct, isPackAct } from "./acts.ts";
import { CARRY_TITLE, carryBrief, carrySpent, carrySummary, layoutCard, packInCard } from "./carry.ts";
import { type Arrangement, arranged, placementFrom, placementOf } from "../../../../arrange.ts";
import { LOOKUP_FENCE } from "./lookups.ts";
import type { PackAct } from "../../../registry.ts";
import type { Bino, Conv, Msg } from "./bino.ts";
import { MAX_SAY, MAX_TITLE, SETUP_PACK } from "./bino.ts";
import { MAX_STEPS, PLAN_FENCE, type Plan, planOf } from "./context.ts";
import { type ViewApp, viewOf } from "./view.ts";
import type { AppEnv, Env } from "../../../../env.ts";
import type { Snapshot } from "../../../../gather.ts";
import { dockShell, type Frame, shell } from "../../../../html.ts";
import type { Hub } from "../../../../live.ts";
import { Confirm, type Html, Notice, PageHeader, Panel } from "../../../../ui/kit.ts";
import { markdown } from "../../../../ui/markdown.ts";
import type { ListItem, ListShare } from "../../../types.ts";
import { Ago, harnessTag, safeUrl } from "../../../../pages/parts.ts";
import { changeLabel, changeTo, choicesOf, type SettingRow } from "../../../../pages/settings.ts";
import { spanHours } from "../../../../quiet.ts";
import type { SettingsApi } from "../../../../routes/settings.ts";
import type { DrawnStep, SetupApi, SetupState } from "../../../../routes/welcome.ts";
import type { CarryApi, CarryPack } from "../../../../routes/carry.ts";
import { strictOrigin } from "../../../../strict.ts";
import { currentTz, dtf } from "../../../../when.ts";

const LABEL: Record<string, string> = { doing: "Doing", next: "Next", waiting: "Waiting" };
type Todo = ListItem;
const OPEN_STATES = ["doing", "next", "waiting"] as const;
/** Where an item on My list is shown (its pack's `href`), or the list itself before one's known. */
const itemHref = (ax: ActCtx | undefined, id: number) => ax?.listHref?.(id) ?? "/todo";

function planCard(c: Conv, i: number, plan: Plan, m: Msg, target?: Todo, ax?: ActCtx): Html {
  if (m.added) return html`<div class="bino-plan done"><p>Added to your list. <a href="${itemHref(ax, m.added)}"${out(ax)}>Open it</a></p></div>`;
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
type ActCtx = { org: string; /** Where an item on My list is shown (its pack's `href`). */ listHref?: (id: number) => string; /** In the pane: forms that lead to a full page open it there. */ dock?: boolean; /** A pack's act by its kind, when that pack is on (src/packs/registry.ts actsFrom). */ packAct?: (kind: string) => PackAct | undefined; /** What I typed in a pack act's card that was refused, by card. */ keptForms?: Map<string, Record<string, string>>; /** Dovre's settings as they are now, by id, when the conversation proposes one (#185). */ settings?: Map<string, SettingRow>; /** A setup conversation's pack setup as it stands (#420). */ setup?: SetupShown; /** Every pack as it stands, when the conversation carries on after the climb or proposes a pack (#94). */ carry?: CarryPack[]; /** What Layout can arrange now, when the conversation proposes a layout (#94). */ layout?: Arrangement };
/** A pack's setup in its conversation (#420), as it stands now: the step to show, drawn by the pack, and what the last Next was refused for. */
export type SetupShown = SetupState & { step?: DrawnStep; error?: string };
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

/** A bug in Dovre (#384): the card opens /bug filled in, where it's sent. */
function bugCard(i: number, n: number, a: Act & { kind: "bug" }, ax: ActCtx): Html {
  return html`<form method="get" action="/bug" class="bino-plan" id="act-${i}-${n}"${out(ax)}>
<p class="bino-plan-h">A bug report for Dovre</p>
<input type="hidden" name="from" value="${a.page}">
<label class="field"><span class="label">Title</span><input type="text" name="title" value="${a.title}" maxlength="200" required></label>
<label class="field"><span class="label">What happened</span><textarea name="what" rows="5">\n${a.body}</textarea></label>
<div class="buttons"><button type="submit" class="primary">Report it</button><span class="hint">Opens the bug form: nothing is sent before you press there.</span></div>
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

/** Quiet hours on a card: from and until, each an hour, or "—" in both for none. The press puts them together; one end alone isn't taken. */
function hoursField(label: string, now: string, at: { from: number; to: number } | undefined): Html {
  const pick = (name: string, said: string, v: number | undefined) =>
    html`<select name="${name}" aria-label="${label}: ${said}"><option value=""${v === undefined ? html` selected` : ""}>—</option>${Array.from({ length: 24 }, (_, h) => html`<option value="${h}"${h === v ? html` selected` : ""}>${String(h).padStart(2, "0")}:00</option>`)}</select>`;
  return html`<p class="bino-set"><span>${now}</span><span aria-hidden="true">→</span>${pick("from", "from", at?.from)}<span aria-hidden="true">–</span>${pick("till", "until", at?.to)}</p>`;
}

/**
 * A setting of Dovre's (#185): what it is now and what it would become, changed with the card's own
 * field first if Bino guessed wrong. Its press goes to the core, which sends the setting's own
 * route its form. A setting that isn't changed from a card (a secret, who gets in, what agents may
 * do) is a link to its page and nothing else; one Dovre doesn't have here isn't drawn.
 */
function settingCard(c: Conv, i: number, n: number, a: SettingAct & Act, ax: ActCtx): Html {
  const id = `act-${i}-${n}`;
  const row = ax.settings?.get(a.id);
  const at = `/bino/c/${c.id}/act/${i}/${n}`;
  const twice = (question: string, button: string, name: string) => html`<details class="confirm"><summary>${button}…</summary><div class="confirm-body"><p>${question}</p><input type="hidden" name="twice" value="1"><button type="submit" class="primary" data-busy="${name}">${button}</button></div></details>`;
  if (a.done) {
    // Undo puts back what it was, through the same route; back to one click for a write is asked again.
    const back = a.was !== undefined && row?.change && changeTo(row.change, a.was) !== null && row.change.value !== a.was ? row.change : undefined;
    const undo = back ? html`<form method="post" action="${at}/undo">${ax.dock ? DOCK_FIELD : ""}${back.loosens?.(a.was!) ? twice("That lets this write through on one click again.", "Undo", "Undoing") : html`<button type="submit" class="sm" data-busy="Undoing">Undo</button>`}</form>` : "";
    return html`<div class="bino-plan done" id="${id}"><p>${a.done.text} <span class="t3">· ${Ago(a.done.at)}</span></p>${a.error ? Notice({ tone: "bad", children: html`<strong>Not undone.</strong> ${a.error}` }) : ""}<div class="buttons">${undo}${a.done.href ? html`<a href="${safeUrl(a.done.href)}"${out(ax)}>Open its page</a>` : ""}</div></div>`;
  }
  if (!row) return html``;
  if (!row.change) return html`<div class="bino-plan" id="${id}"><p class="bino-plan-h">${row.label}</p><p>${row.now ? html`Now: ${row.now}. ` : ""}This one is only changed on its own page. <a href="${safeUrl(row.href)}"${out(ax)}>Open it</a></p></div>`;
  const ch = row.change;
  const to = changeTo(ch, a.to);
  const now = changeLabel(ch, ch.value) || "not set";
  // A write's clicks are shown as proposed, not picked: to one click is the looser way, and asked again.
  const fixed = !!ch.loosens && to !== null;
  const field =
    fixed
      ? html`<input type="hidden" name="to" value="${to}"><p class="bino-set"><span>${now}</span><span aria-hidden="true">→</span><strong>${changeLabel(ch, to)}</strong></p>`
      : ch.kind === "hours"
        ? hoursField(row.label, now, spanHours(to ?? ch.value))
      : ch.kind === "number"
        ? html`<p class="bino-set"><span>${now}</span><span aria-hidden="true">→</span><input type="number" name="to" min="${ch.min ?? ""}" max="${ch.max ?? ""}" value="${to ?? ch.value}" required aria-label="${row.label}: change to"></p>`
        : html`<p class="bino-set"><span>${now}</span><span aria-hidden="true">→</span><select name="to" aria-label="${row.label}: change to">${choicesOf(ch).map((x) => html`<option value="${x.value}"${x.value === (to ?? ch.value) ? html` selected` : ""}>${x.label}</option>`)}</select></p>`;
  const press = fixed && ch.loosens!(to) ? twice("That lets this write through on one click.", "Change", "Changing") : html`<button type="submit" class="primary" data-busy="Changing">Change</button>`;
  const hint = to === null ? "Bino's suggestion isn't a value it takes: pick one." : to === ch.value ? "It's this already." : "Nothing changes before you press.";
  return html`<form method="post" action="${at}" class="bino-plan" id="${id}">${ax.dock ? DOCK_FIELD : ""}
<p class="bino-plan-h">${row.label}</p>
${a.error ? Notice({ tone: "bad", children: html`<strong>Not changed.</strong> ${a.error}` }) : ""}
${field}
<div class="buttons">${press}<span class="hint">${hint}</span></div>
</form>`;
}

function actCard(c: Conv, i: number, n: number, a: Act, ax: ActCtx): Html {
  if (isPackAct(a)) return packCard(c, i, n, a, ax);
  if (a.kind === "setting") return settingCard(c, i, n, a, ax);
  if (a.kind === "layout") return layoutCard(`act-${i}-${n}`, a, ax.layout, { dock: ax.dock, at: `/bino/c/${c.id}/act/${i}/${n}` });
  if (a.kind === "pack") return ax.carry ? packInCard(`act-${i}-${n}`, a, ax.carry.find((p) => p.id === a.id), { dock: ax.dock, at: `/bino/c/${c.id}/act/${i}/${n}` }) : html``;
  // One of a kind that's gone (an old conversation's Teams message, from before Teams was a pack): not drawn.
  if (a.kind === "bug") return bugCard(i, n, a, ax);
  if (a.kind !== "task") return html``;
  return taskCard(i, n, a, ax);
}

/** A step the pane doesn't carry yet (#420): one running a job (it draws itself again), or whose writes are forms of its own, which come back to its page. */
const ownPage = (d: DrawnStep) => !!(d.refresh || d.go || d.carry || (!d.form && /<form[\s>]/i.test(String(d.body))));

/**
 * The bottom of a setup conversation (#420): a done line per finished step, then the step to show
 * as a card (the pack's own body; Next saves it as the page's Next does), or "That's it". Always
 * drawn from what the pack saved, never from the transcript, so it's the current state wherever I left it.
 */
function setupBlock(c: Conv, s: SetupShown, ax: ActCtx): Html {
  const n = s.steps.length;
  const page = (step?: string) => `/setup/${s.pack.id}${step ? `?at=${step}` : ""}`;
  const done = s.steps.filter((x) => s.done.includes(x.id));
  const lines = done.length ? html`<ul class="bino-done">${done.map((x) => html`<li><span aria-hidden="true">✓</span> ${x.title}</li>`)}</ul>` : "";
  if (s.at >= n) {
    const next = s.next
      ? html`<form method="post" action="/bino/new">${ax.dock ? html`<input type="hidden" name="dock" value="1">` : ""}<input type="hidden" name="setup" value="${s.next.id}"><button type="submit" class="primary" data-busy="Starting">Next: ${s.next.name}</button></form>`
      : "";
    return html`<div class="bino-setup" id="bino-setup">${lines}<div class="bino-plan done"><p><strong>That's it.</strong> ${s.pack.name} is set up.</p><div class="buttons">${next}<a href="${page()}"${out(ax)}>Run it again on its page</a></div></div></div>`;
  }
  const step = s.steps[s.at]!;
  const head = html`<p class="bino-plan-h">Setting up ${s.pack.name} · ${s.at + 1} of ${n}</p><p class="bino-step-t">${step.title}</p>`;
  const d = s.step;
  if (!d || ownPage(d))
    return html`<div class="bino-setup" id="bino-setup">${lines}<div class="bino-plan">${head}<p>This one ${d?.refresh || d?.carry ? "runs for a minute" : "is done"} on its own page. I'll pick up here when it's through.</p><div class="buttons"><a class="btn primary" href="${page(step.id)}"${out(ax)}>Open it on its page</a></div></div></div>`;
  const last = s.at === n - 1;
  return html`<div class="bino-setup" id="bino-setup">${lines}<form method="post" action="/bino/c/${c.id}/setup${ax.dock ? "?dock=1" : ""}" class="bino-plan bino-step"><input type="hidden" name="step" value="${step.id}">
${head}
${s.error ? Notice({ tone: "bad", children: html`<strong>Not kept.</strong> ${s.error}` }) : ""}
<div class="bino-step-b">${d.body}</div>
${d.wait ? html`<p class="hint">${d.wait}</p>` : ""}
<div class="buttons"><button type="submit" class="primary" data-busy="Saving"${d.wait ? " disabled" : ""}>${last ? "Done" : "Next"}</button><a href="${page(step.id)}"${out(ax)}>Open its page</a></div>
</form></div>`;
}

/** What Bino is told of a setup with each message (#420): which step is shown and which are done, by name, never what was typed in them. */
export function setupLine(s: SetupState): string {
  const n = s.steps.length;
  if (s.at >= n) return `the chat's setup of ${s.pack.name} is finished`;
  const done = s.steps.filter((x) => s.done.includes(x.id)).map((x) => `"${x.title}"`);
  return `setting up ${s.pack.name} in this chat: step ${s.at + 1} of ${n} ("${s.steps[s.at]!.title}") is shown${done.length ? `, done: ${done.join(", ")}` : ""}`;
}

/** Bino's fixed opening line for a setup (#420): how many steps, and that it's there for questions. */
function setupOpening(s: SetupState): string {
  const n = s.steps.length;
  const left = n - s.done.length;
  if (!left) return `${s.pack.name} is set up already. Its steps are on its page if you want to run one again.`;
  const count = left === n ? `${n} step${n === 1 ? "" : "s"}` : `${left} of ${n} steps left`;
  return `Setting up ${s.pack.name}: ${count}. Each one is below, as on its page. Ask me anything about it along the way.`;
}

/** What looks like a key or token, kept out of a setup conversation (#420): known prefixes, or a long run of letters and digits. */
const KEYLIKE = /\b(?:sk-[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|lin_(?:api|oauth)_\w{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,})|\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{32,}\b/;
export const looksLikeKey = (t: string) => KEYLIKE.test(t);

/** A gap this long between two messages gets a line with the time. */
const QUIET = 60 * 60_000;
/** The same speaker within this long: one group, the name said once. */
const GROUP = 5 * 60_000;

const clockOf = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

function message(c: Conv, m: Msg, i: number, target?: Todo, ax?: ActCtx, prev?: Msg): Html {
  const grouped = prev?.role === m.role && m.at - prev.at < GROUP;
  if (m.role === "user") return html`<li class="bino-msg you${grouped ? " cont" : ""}" data-stop="1" data-stop-label="${m.text.slice(0, 120)}" title="${clockOf(m.at)} UTC"><div class="bino-text">${markdown(m.text)}</div></li>`;
  const last = i === c.msgs.length - 1;
  // Asking again for an answer whose plan was added, or whose act went out, would leave those behind.
  const redo = last && !c.thinking && c.msgs[i - 1]?.role === "user" && m.added === undefined && !(m.acts ?? []).some((a) => a.done || a.sending);
  const tools = html`<span class="bino-tools"><button type="button" class="ghost" data-copy-msg title="Copy this answer">Copy</button>${redo ? html`<form method="post" action="/bino/c/${c.id}/retry" data-inplace>${ax?.dock ? html`<input type="hidden" name="dock" value="1">` : ""}<button type="submit" class="ghost" title="Ask for this answer again">Retry</button></form>` : ""}</span>`;
  const meta = html`<span class="bino-meta">${Ago(m.at)}${m.cost ? ` · $${m.cost.toFixed(3)}` : ""}${m.looked?.length ? ` · looked up ${m.looked.join("; ")}` : ""}</span>`;
  return html`<li class="bino-msg bino" data-stop="2"><div class="bino-text">${markdown(m.text)}</div>${m.plan ? planCard(c, i, m.plan, m, target, ax) : ""}${ax ? (m.acts ?? []).map((a, n) => actCard(c, i, n, a, ax)) : ""}<div class="bino-msg-f">${meta}${tools}</div></li>`;
}

const OPENS = [PLAN_FENCE, ACT_FENCE, LOOKUP_FENCE].map((f) => "```" + f);

/** The answer so far as it's shown: without Bino's own blocks (a plan, an act, a lookup), which come once it's done, nor the start of one. */
export function draftShown(t: string): string {
  let out = "";
  let rest = t;
  for (;;) {
    const at = OPENS.map((f) => rest.indexOf(f)).filter((i) => i >= 0);
    if (!at.length) break;
    const i = Math.min(...at);
    out += rest.slice(0, i);
    const close = rest.indexOf("\n```", i + 3);
    if (close < 0) return out.trimEnd();
    rest = rest.slice(close + 4);
  }
  // A last line that may be one beginning ("`", "```bino-p").
  const tail = rest.slice(rest.lastIndexOf("\n") + 1);
  if (tail && OPENS.some((f) => f.startsWith(tail.trimStart()))) rest = rest.slice(0, rest.length - tail.length);
  return (out + rest).trimEnd();
}

/** The messages: grouped by speaker, a line with the time after a long quiet; while Bino writes, its answer so far. */
function thread(c: Conv, target?: Todo, ax?: ActCtx): Html {
  return html`<ol class="bino-msgs" data-follow>${c.msgs.map((m, i) => {
    const prev = c.msgs[i - 1];
    const gap = prev && m.at - prev.at >= QUIET ? html`<li class="bino-gap" aria-hidden="true"><span data-at="${m.at}" data-ago title="${clockOf(m.at)} UTC">${clockOf(m.at)}</span></li>` : "";
    return html`${gap}${message(c, m, i, target, ax, prev)}`;
  })}${draftItem(c)}</ol>`;
}

/** Bino's answer so far, while it writes (empty otherwise): the page swaps only this as it grows (GET /bino/c/:id/draft). */
function draftItem(c: Conv): Html | "" {
  const draft = c.thinking && c.draft ? draftShown(c.draft) : "";
  return draft ? html`<li class="bino-msg bino writing" id="bino-draft" data-stop="2"><div class="bino-text">${markdown(draft)}</div></li>` : "";
}

/** What the page swaps while Bino writes: the answer so far and the line with Stop. Nothing once it's done (the page then swaps whole). */
function draftFragment(c: Conv, dock: boolean): Html | "" {
  return c.thinking ? html`${draftItem(c)}${answering(c, dock)}` : "";
}

/** The box Bino is talked to in: one field, the send button in its own footer. Enter sends, Shift+Enter is a new line, ↑ in an empty box brings back what I last sent (src/ui/app.js.ts). */
function composer(o: { action: string; label: string; placeholder: string; button: string; busy: string; extra?: Html; dock?: boolean; id?: string }): Html {
  return html`<form method="post" action="${o.action}"${o.id ? html` id="${o.id}"` : ""} class="bino-compose${o.dock ? " dock-compose" : ""}" data-ctrl-enter data-chat>${o.dock ? DOCK_FIELD : ""}<textarea name="text" rows="${o.dock ? 1 : 3}" maxlength="${MAX_SAY}" required aria-label="${o.label}" placeholder="${o.placeholder}"></textarea>
<div class="bino-compose-f"><span class="hint">Enter sends · Shift+Enter new line · ↑ last message</span><button type="submit" class="primary" data-busy="${o.busy}">${o.button}</button></div>${o.extra ?? ""}</form>`;
}

/** While Bino answers: dots, what it's doing, and Stop (Esc or s, src/ui/app.js.ts); once stopped or failed, a line saying so and Ask again. */
function answering(c: Conv, dock: boolean): Html {
  const dockField = dock ? html`<input type="hidden" name="dock" value="1">` : "";
  const again = html`<form method="post" action="/bino/c/${c.id}/retry" data-inplace>${dockField}<button type="submit" class="ghost">Ask again</button></form>`;
  const asked = c.msgs.at(-1)?.role === "user";
  if (c.stopped && !c.thinking) return html`<div class="bino-after"><p class="notes">You stopped this answer. Ask again, or say something else.</p>${asked ? again : ""}</div>`;
  if (!c.thinking) return c.error && asked ? html`<div class="bino-after">${again}</div>` : html``;
  // Once the answer shows, the dots go: the line keeps only Stop.
  const writing = !c.looking && !!c.draft;
  return html`<form method="post" action="/bino/c/${c.id}/stop" class="bino-thinking${writing ? " writing" : ""}" id="bino-status" aria-live="polite" data-inplace>${dockField}${writing ? "" : html`<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span> `}<span>${c.looking ? `Bino is looking up ${c.looking}…` : writing ? "Writing…" : "Bino is thinking…"}</span> <button type="submit" class="ghost" data-bino-stop title="Stop (Esc or s)">Stop</button></form>`;
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
const saysIt = (c: Conv, q: string) => {
  const n = q.toLowerCase();
  return c.title.toLowerCase().includes(n) || c.msgs.some((m) => m.text.toLowerCase().includes(n));
};

/** What the workspace around a page needs: the conversations, my list, the packs' apps. */
export type Ws = { convs: Conv[]; todos: Todo[]; /** Where an item on My list is shown; unset: no list here. */ listHref?: (id: number) => string; apps: ViewApp[]; q?: string; now?: number; tz?: string };

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
        ? html`<dl class="facts">${target ? html`<dt>About</dt><dd><a href="${ws.listHref?.(target.id) ?? "/todo"}">${target.title}</a></dd>` : ""}${app ? html`<dt>App</dt><dd>${app.name}</dd>` : ""}${from ? html`<dt>Asked from</dt><dd>${from}</dd>` : ""}</dl>`
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
  return html`<aside class="bino-side"><div data-live id="bino-side">${sees}${b.route.ready && ws.listHref ? list : ""}${remembered}</div></aside>`;
}

/** On a narrow screen the conversations and the side are drawers: these open them (src/ui/app.js.ts). */
const PANES = html`<button type="button" class="ghost bino-pane-b" data-bino-pane="nav" aria-expanded="false" title="Your chats">Chats</button><button type="button" class="ghost bino-pane-b" data-bino-pane="side" aria-expanded="false" title="What Bino sees and remembers">Details</button>`;

/** The workspace, filling the screen: the conversations at the left, the chat in the middle (only it scrolls, the box stays at its foot), what Bino sees at the right. */
const workspace = (nav: Html, main: Html, side: Html) => html`<div class="bino-ws">${nav}<section class="bino-main">${main}</section>${side}</div>`;

/** One conversation; the messages sit in a live region, the box to answer in outside it. */
/** Below the messages: a setup's step (#420), and a message that wasn't sent, with why. */
const below = (c: Conv, ax?: ActCtx, refused?: Html) => html`${ax?.setup ? setupBlock(c, ax.setup, ax) : ""}${c.carry && ax?.carry ? carrySummary(c, ax.carry, ax.dock) : ""}${refused ? Notice({ tone: "warn", children: refused }) : ""}`;
/** Whether the box to answer in is drawn: Bino answers here, and a setup chat (#94) has turns left. */
const answers = (b: Bino, c: Conv) => b.route.ready && !(c.carry && carrySpent(c));
/** A page's topics: a setup conversation's also changes when its pack's setup does; a setup chat's (#94) when the packs do. */
const topicsOf = (c: Conv, base: string) => (c.setup ? `${base} ${c.setup}` : c.carry ? `${base} packs` : base);

async function convPage(frame: Frame, b: Bino, c: Conv, ws: Ws, target?: Todo, ax?: ActCtx, refused?: Html): Promise<Html> {
  const main = html`<div class="bino-thread"><div class="bino-scroll" id="bino-scroll" data-scroller><div data-live id="bino-conv">${thread(c, target, ax)}
${c.error ? Notice({ tone: "bad", children: c.error }) : ""}
${answering(c, false)}${below(c, ax, refused)}</div></div>
${answers(b, c) ? composer({ action: `/bino/c/${c.id}/say`, label: "Your answer", placeholder: c.carry ? "What else do you work with?" : "Answer, or ask for a breakdown", button: "Send", busy: "Sending" }) : b.route.ready ? "" : cantAnswer(b)}</div>`;
  const body = html`${PageHeader({ title: c.title, crumbs: [{ href: "/bino", label: "Bino" }], actions: html`${PANES}${binoTag(b)}${binoFace(frame, c.thinking)}` })}
${workspace(binoNav({ ...ws, tz: ws.tz ?? frame.tz }, c.id), main, await binoSide(b, ws, c, target))}`;
  return shell({ title: `${c.title} · Bino`, frame, current: "/bino", body, head: html`<meta name="u-topics" content="${topicsOf(c, `bino bino:${c.id}`)}">` });
}

/** Ready-made openings: whole questions about what Bino can see. */
const STARTERS = ["What should I do first today?", "Group and tidy what's on my list", "What's waiting on me?"];
/** In the pane, where it opens beside a page: that page first. */
const DOCK_STARTERS = ["What matters on this page?", ...STARTERS.slice(0, 2)];

/** A new chat: a box for anything and the openings, beside the conversations and what Bino sees. */
async function binoPage(frame: Frame, b: Bino, ws: Ws): Promise<Html> {
  const starts = html`<div class="bino-starts"><p class="bino-starts-h">Or start from</p><div class="bino-chips">${STARTERS.map((q) => html`<button type="submit" class="bino-chip" name="q" value="${q}" formnovalidate>${q}</button>`)}</div></div>`;
  const start = b.route.ready ? composer({ action: "/bino/new", label: "What's on your mind?", placeholder: "What's on your mind? Something to think through, group or break down.", button: "Talk it through", busy: "Starting", extra: starts }) : cantAnswer(b);
  const body = html`${PageHeader({ title: "Bino", sub: "Ask about your work, or think something through. It changes nothing by itself.", actions: html`${PANES}${binoTag(b)}${binoFace(frame, ws.convs.some((x) => x.thinking))}` })}
${workspace(binoNav({ ...ws, tz: ws.tz ?? frame.tz }), start, await binoSide(b, ws))}`;
  return shell({ title: "Bino · Dovre", frame, current: "/bino", body, head: html`<meta name="u-topics" content="bino">` });
}

/** In the pane: back to the conversation there, and the page I'm on, filled in as I send (src/ui/app.js.ts). */
const DOCK_FIELD = html`<input type="hidden" name="dock" value="1"><input type="hidden" name="view" value="" data-view>`;

/** The pane's header: the conversation's title, the other recent ones, a new one, bigger or smaller, out to the full page, and minimise. */
function dockBar(title: string, o: { full: string; fresh?: boolean; others?: Conv[] }): Html {
  const others = o.others ?? [];
  const recent = others.length
    ? html`<details class="dock-recent"><summary class="dock-i" title="Other chats" aria-label="Other chats">▾</summary><ul class="dock-menu">${others.map((x) => html`<li><a href="/bino/dock/c/${x.id}"><span class="bino-conv-t">${x.title}</span><span class="t3">${Ago(x.at)}${x.thinking ? " · thinking" : ""}</span></a></li>`)}</ul></details>`
    : "";
  return html`<header class="dock-h"><h1 title="${title}">${title}</h1>${recent}${o.fresh ? html`<a class="dock-i" href="/bino/dock" title="New chat" aria-label="New chat">+</a>` : ""}<button type="button" class="dock-i ghost" data-dock-wide title="Bigger or smaller" aria-label="Bigger or smaller">⤢</button><a class="dock-i" href="${o.full}" target="_top" title="Open as a page" aria-label="Open as a page">↗</a><button type="button" class="dock-i ghost" data-dock-close title="Minimise (Esc)" aria-label="Minimise">–</button></header>`;
}

/** The pane's first view: the last few conversations, and the box to ask in (about the page I'm on, or anything) at the bottom. */
/** The packs' stylesheet and scripts, for a pane to draw what a pack draws on a page (math, diagrams in an answer). */
export type DockAssets = { styles?: string[]; scripts?: string[] };

async function binoDockPage(b: Bino, assets: DockAssets = {}): Promise<Html> {
  const convs = (await b.list()).slice(0, 8);
  const body = html`${dockBar("Bino", { full: "/bino" })}
<div class="dock-b" id="dock-scroll"><div data-live id="bino-list">${
    convs.length
      ? html`<p class="bino-starts-h">Recent</p><ul class="bino-convs">${convs.map((c) => html`<li><a href="/bino/dock/c/${c.id}"><span class="bino-conv-t">${c.title}</span><span class="t3">${Ago(c.at)}${c.thinking ? " · thinking" : ""}</span></a></li>`)}</ul>`
      : html`<p class="notes">Ask about the page you're on, or anything. Bino sees names and states, and changes nothing by itself.</p>`
  }</div>${b.route.ready ? html`<p class="bino-starts-h">Start from</p><div class="bino-chips">${DOCK_STARTERS.map((q) => html`<button type="submit" class="bino-chip" form="dock-new" name="q" value="${q}" formnovalidate>${q}</button>`)}</div>` : ""}</div>
${b.route.ready ? composer({ action: "/bino/new", label: "Ask Bino", placeholder: "Ask about this page, or anything", button: "Ask", busy: "Asking", dock: true, id: "dock-new" }) : html`<div class="dock-b">${cantAnswer(b)}</div>`}`;
  return dockShell({ title: "Bino", body, head: html`<meta name="u-topics" content="bino">`, ...assets });
}

/** One conversation in the pane: the thread scrolls, the box stays at the bottom. */
function binoDockConvPage(b: Bino, c: Conv, ax: ActCtx, target?: Todo, others: Conv[] = [], assets: DockAssets = {}, look?: Frame["look"], refused?: Html): Html {
  const body = html`${dockBar(c.title, { fresh: true, full: `/bino/c/${c.id}`, others })}
<div class="dock-b" id="dock-scroll"><div data-live id="bino-conv">${thread(c, target, ax)}
${c.error ? Notice({ tone: "bad", children: c.error }) : ""}
${answering(c, true)}${below(c, ax, refused)}</div></div>
${answers(b, c) ? composer({ action: `/bino/c/${c.id}/say`, label: "Your answer", placeholder: c.carry ? "What else do you work with?" : "Answer, or ask about this page", button: "Send", busy: "Sending", dock: true }) : b.route.ready ? "" : cantAnswer(b)}`;
  return dockShell({ title: `${c.title} · Bino`, body, head: html`<meta name="u-topics" content="${topicsOf(c, `bino:${c.id}`)}">`, ...assets, look });
}

const first = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? (v.find((x) => typeof x === "string") ?? "") : "");
const all = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => (typeof x === "string" ? x : ""));
/** The request's execution context where there is one (a Worker); Hono throws for none. */
const ctxOf = (c: { executionCtx: unknown }): unknown => {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
};
const idOf = (s: string) => (/^\d{1,9}$/.test(s) ? Number(s) : undefined);
const CONV = /^[0-9a-f-]{36}$/;
/** The workspace's pages, the only places a sidebar form goes back to. */
const BACK = /^\/bino(\/c\/[0-9a-f-]{36})?$/;

/** The plan as the card's form says it now: the same checks as Bino's own block. */
function planFromForm(form: Record<string, unknown>): Plan | null {
  const titles = all(form.step_title);
  const states = all(form.step_state);
  const dues = all(form.step_due);
  return planOf({ title: first(form.title), notes: first(form.notes), steps: titles.map((title, i) => ({ title, state: states[i], due: dues[i] || undefined })) });
}

export function createBinoRoutes(env: Pick<Env, "DB" | "GHE_ORG">, deps: {
  bino: Bino;
  page: () => Promise<{ frame: Frame }>;
  hub?: Pick<Hub, "publish">;
  /** The newest gathered snapshot, for what a page I ask from shows. */
  peek?: () => Snapshot | undefined;
  /** What Bino knows right now, sent with each message when Bino answers elsewhere (hosted: the Durable Object). */
  context?: () => Promise<string>;
  /** The packs' apps: a conversation started on one of their pages is about that app (its memory scope). */
  apps?: () => ViewApp[];
  /** A pack's act by its kind, when that pack is on. */
  packAct?: (kind: string) => PackAct | undefined;
  /** My list, while a pack shares it (#393). */
  list?: () => ListShare | undefined;
  /** Dovre's settings (#185): a setting card's row, and the one way to change it. */
  settings?: SettingsApi;
  /** The packs' own setups (#420): a setup conversation's step, and its Next. */
  setup?: SetupApi;
  /** Carrying on after the climb (#94): the packs as they stand, the opening line, and Add. */
  carry?: CarryApi;
  /** The packs' stylesheet and scripts, which the pane loads like a pack's dock page. */
  assets?: DockAssets;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { bino } = deps;
  /** What I wrote in a pack act's card that was refused: in memory only, to try again with. */
  const keptForms = new Map<string, Record<string, string>>();
  const list = () => deps.list?.();
  const getTodo = async (id: number) => list()?.get(id).catch(() => undefined);
  /** What the cards of `conv` need; the settings only when it proposes one. */
  const ax = async (conv: Conv, dock = false, setupError?: string): Promise<ActCtx> => {
    const proposes = deps.settings && conv.msgs.some((m) => m.acts?.some((a) => a.kind === "setting"));
    const settings = proposes ? new Map((await deps.settings!.rows().catch(() => [])).map((r) => [r.id, r])) : undefined;
    const packsToo = deps.carry && (conv.carry || conv.msgs.some((m) => m.acts?.some((a) => a.kind === "pack")));
    const carry = packsToo ? await deps.carry!.packs().catch(() => undefined) : undefined;
    const arranges = deps.settings && conv.msgs.some((m) => m.acts?.some((a) => a.kind === "layout"));
    const layout = arranges ? await deps.settings!.arrangement().catch(() => undefined) : undefined;
    return { org: env.GHE_ORG, dock, packAct: deps.packAct, keptForms, listHref: list()?.href, settings, setup: await setupOf(conv, setupError), ...(carry ? { carry } : {}), ...(layout ? { layout } : {}) };
  };
  /** A setup conversation's pack setup now, with its step drawn (#420); none once that pack's setup is gone. */
  const setupOf = async (conv: Conv, error?: string): Promise<SetupShown | undefined> => {
    const st = conv.setup && deps.setup ? await deps.setup.state(conv.setup).catch(() => undefined) : undefined;
    if (!st) return undefined;
    const at = st.steps[st.at];
    const step = at ? await deps.setup!.draw(st.pack.id, at.id).catch(() => undefined) : undefined;
    return { ...st, ...(step ? { step } : {}), ...(error ? { error } : {}) };
  };
  /** A conversation's page, or its pane: what the GETs answer, and a refused post in its own answer (hosted, a redirect's GET can land on another isolate). */
  const convAnswer = async (c: { req: { query(k: string): string | undefined }; html(h: Html | Promise<Html>, status?: 200 | 422): Response | Promise<Response> }, conv: Conv, dock: boolean, o: { status?: 200 | 422; setupError?: string; refused?: Html } = {}) => {
    const target = conv.todo !== undefined ? await getTodo(conv.todo) : undefined;
    const cx = await ax(conv, dock, o.setupError);
    if (!dock) return c.html(await convPage((await deps.page()).frame, bino, conv, await wsOf(c.req.query("q")), target, cx, o.refused), o.status ?? 200);
    const others = (await bino.list()).filter((x) => x.id !== conv.id).slice(0, 8);
    // A conversation that proposes a setting says how Dovre looks now: its card may just have changed it, and the page around the pane takes it on.
    const look = cx.settings ? await deps.page().then((p) => p.frame.look ?? {}, () => undefined) : undefined;
    return c.html(binoDockConvPage(bino, conv, cx, target, others, deps.assets, look, o.refused), o.status ?? 200);
  };
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
  /** What a setup chat (#94) tells Bino with each message: how to go about it, and the packs as they stand. */
  const briefOf = async (conv: Conv) => (conv.carry && deps.carry ? carryBrief(await deps.carry.packs().catch(() => []), await deps.settings?.arrangement().catch(() => undefined)) : undefined);

  /** What the workspace shows around a page: every conversation, my list, the apps; `q` narrows the conversations. */
  const wsOf = async (q: string | undefined): Promise<Ws> => ({ convs: await bino.list(), todos: (await list()?.items().catch(() => [])) ?? [], listHref: list()?.href, apps: deps.apps?.() ?? [], q: (q ?? "").trim().slice(0, 200) });
  /** Where a sidebar's form goes back to: the workspace page it was on. */
  const backOf = (form: Record<string, unknown>, gone?: string) => {
    const b = first(form.back);
    return BACK.test(b) && b !== `/bino/c/${gone}` ? b : "/bino";
  };

  app.get("/bino", async (c) => c.html(await binoPage((await deps.page()).frame, bino, await wsOf(c.req.query("q")))));
  app.post("/bino/new", async (c) => {
    const form = await c.req.parseBody();
    // A pack's setup (#420): Bino's fixed opening, no model call; the steps are drawn below it.
    const setup = first(form.setup);
    if (setup) {
      const st = SETUP_PACK.test(setup) && deps.setup && bino.route.ready ? await deps.setup.state(setup) : undefined;
      if (!st) return c.redirect(first(form.dock) === "1" ? "/bino/dock" : "/bino", 303);
      const conv = await bino.start(setupOpening(st), { setup: { pack: st.pack.id, title: `Setting up ${st.pack.name}` } });
      return c.redirect(convHref(conv.id, first(form.dock) === "1"), 303);
    }
    // Carrying on after the climb (#94): Bino's fixed opening, no model call; what's set up and what's left below it.
    if (first(form.carry) === "1") {
      if (!deps.carry || !bino.route.ready) return c.redirect("/bino", 303);
      const conv = await bino.start(deps.carry.opening(), { carry: { title: CARRY_TITLE } });
      return c.redirect(convHref(conv.id, first(form.dock) === "1"), 303);
    }
    const todo = idOf(first(form.todo));
    const item = todo !== undefined ? await getTodo(todo) : undefined;
    const text = first(form.text) || first(form.q) || first(form.prompt) || (item ? `Help me group and break this down: ${item.title}${item.notes ? `\n\n${item.notes}` : ""}` : "");
    if (!text.trim() || !bino.route.ready) return c.redirect(first(form.dock) === "1" ? "/bino/dock" : "/bino", 303);
    const conv = await bino.start(text, { todo: item ? (item.parent ?? item.id) : undefined, view: await viewIn(form), app: appIn(form), ...(await known()) });
    return c.redirect(convHref(conv.id, first(form.dock) === "1"), 303);
  });
  app.get("/bino/c/:id", async (c) => {
    const conv = CONV.test(c.req.param("id")) ? await bino.get(c.req.param("id")) : undefined;
    if (!conv) return c.notFound();
    return convAnswer(c, conv, false);
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
    const dock = first(form.dock) === "1";
    const conv = (await bino.get(id))!;
    let view = await viewIn(form);
    if (conv.setup) {
      // A key never reaches the model, nor the conversation: it's said where keys go, and nothing is kept.
      if (looksLikeKey(first(form.text))) return convAnswer(c, conv, dock, { status: 422, refused: html`<strong>Not sent: that looks like a key.</strong> Keys don't go in chat. Set it on <a href="/settings/packs/${conv.setup}"${dock ? html` target="_top"` : ""}>its pack's settings</a>, from your secret store.` });
      const st = await deps.setup?.state(conv.setup).catch(() => undefined);
      if (st) view = [view, setupLine(st)].filter(Boolean).join("; ");
    }
    let brief: string | undefined;
    if (conv.carry) {
      if (looksLikeKey(first(form.text))) return convAnswer(c, conv, dock, { status: 422, refused: html`<strong>Not sent: that looks like a key.</strong> Keys don't go in chat. Each pack takes its own on <a href="/settings/packs"${dock ? html` target="_top"` : ""}>Settings → Packs</a>, from your secret store.` });
      const spent = carrySpent(conv);
      if (spent) return convAnswer(c, conv, dock, { status: 422, refused: html`<strong>Not sent.</strong> ${spent} Start a new chat for anything else.` });
      brief = await briefOf(conv);
    }
    await bino.say(id, first(form.text), { view, ...(await known()), ...(brief ? { brief } : {}) });
    return c.redirect(convHref(id, dock), 303);
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
    const conv = (await bino.get(id))!;
    const brief = await briefOf(conv);
    await bino.retry(id, { ...(await known()), ...(brief ? { brief } : {}) });
    return c.redirect(convHref(id, first(form.dock) === "1"), 303);
  });
  // While Bino writes: only the answer so far and its Stop line, for the open page to swap in (src/ui/app.js.ts draftSwap).
  app.get("/bino/c/:id/draft", async (c) => {
    const conv = CONV.test(c.req.param("id")) ? await bino.get(c.req.param("id")) : undefined;
    if (!conv) return c.body(null, 404);
    c.header("cache-control", "no-store");
    return c.html(draftFragment(conv, c.req.query("dock") === "1"));
  });
  app.get("/bino/dock", async (c) => c.html(await binoDockPage(bino, deps.assets)));
  app.get("/bino/dock/c/:id", async (c) => {
    const conv = CONV.test(c.req.param("id")) ? await bino.get(c.req.param("id")) : undefined;
    if (!conv) return c.redirect("/bino/dock", 303);
    return convAnswer(c, conv, true);
  });
  /** Next on a setup conversation's step (#420): saved as the setup page's Next saves it, then the conversation again, at its next step. */
  app.post("/bino/c/:id/setup", strictOrigin, async (c) => {
    const id = c.req.param("id");
    const conv = CONV.test(id) ? await bino.get(id) : undefined;
    if (!conv?.setup || !deps.setup) return c.notFound();
    const dock = c.req.query("dock") === "1";
    const form = await c.req.parseBody({ all: true });
    const r = await deps.setup.next(conv.setup, first(form.step), form);
    if (r.ok) return c.redirect(`${convHref(id, dock)}#bino-setup`, 303);
    return convAnswer(c, conv, dock, { status: 422, setupError: r.error });
  });
  /** The card's "Add these to my list": exactly what its form says, once. */
  app.post("/bino/c/:id/plan/:i", async (c) => {
    const id = c.req.param("id");
    const conv = CONV.test(id) ? await bino.get(id) : undefined;
    const i = idOf(c.req.param("i"));
    const m = conv && i !== undefined ? conv.msgs[i] : undefined;
    if (!conv || i === undefined || !m?.plan) return c.notFound();
    const to = list();
    if (m.added) return c.redirect(to?.href(m.added) ?? "/todo", 303);
    if (!to) return c.redirect(`/bino/c/${id}`, 303);
    const form = await c.req.parseBody({ all: true });
    const plan = planFromForm(form);
    if (!plan) return c.redirect(`/bino/c/${id}`, 303);
    const targetId = idOf(first(form.target));
    const target = targetId !== undefined && targetId === conv.todo ? await getTodo(targetId) : undefined;
    const parent = target && target.parent === null ? target : await to.add({ title: plan.title, notes: plan.notes });
    if (!parent) return c.redirect(`/bino/c/${id}`, 303);
    for (const s of plan.steps) await to.add({ title: s.title, parent: parent.id, state: s.state, due: s.due });
    await bino.added(id, i, parent.id);
    deps.hub?.publish(["snapshot"]);
    return c.redirect(to.href(parent.id), 303);
  });
  /** A pack's act from Bino's card: what the card says now, carried out by the pack in the background. */
  app.post("/bino/c/:id/act/:i/:n", strictOrigin, async (c) => {
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
    if (conv && i !== undefined && n !== undefined && a?.kind === "pack" && deps.carry) {
      // A pack to bring in (#94): what its card offers for where it stands now, checked again here.
      const form = await c.req.parseBody();
      const back = `${convHref(id, first(form.dock) === "1")}#act-${i}-${n}`;
      if (a.done) return c.redirect(back, 303);
      const p = (await deps.carry.packs()).find((x) => x.id === a.id);
      if (p?.state === "add") {
        const r = await deps.carry.add(p.id, { waitUntil: (w) => (ctxOf(c) as { waitUntil?: (p: Promise<unknown>) => void } | undefined)?.waitUntil?.(w) });
        await bino.setAct(id, i, n, r.ok ? { error: undefined, done: { at: Date.now(), text: r.text, href: r.href } } : { error: r.why });
        deps.hub?.publish(["packs"]);
      } else if (p?.state === "hidden" && deps.settings) {
        const r = await deps.settings.change(c.req.raw, `pack.${p.id}`, "on", "Bino", { env: c.env, ctx: ctxOf(c) });
        await bino.setAct(id, i, n, r.ok ? { error: undefined, done: { at: Date.now(), text: `${p.name} is on.`, href: r.href } } : { error: r.why });
      }
      // Anything else (on already, can't run yet, being added): the card shows where it stands.
      return c.redirect(back, 303);
    }
    if (conv && i !== undefined && n !== undefined && a?.kind === "layout" && deps.settings) {
      // Today, arranged (#94): the proposal applied to what's here now, put in place through Layout's own route.
      const form = await c.req.parseBody();
      const back = `${convHref(id, first(form.dock) === "1")}#act-${i}-${n}`;
      if (a.done) return c.redirect(back, 303);
      const to = placementOf(arranged(await deps.settings.arrangement(), a), a);
      const r = await deps.settings.arrange(c.req.raw, to, "Bino", { env: c.env, ctx: ctxOf(c) });
      await bino.setAct(id, i, n, r.ok ? { error: undefined, was: JSON.stringify(r.was), done: { at: Date.now(), text: "Today is arranged as the card said.", href: r.href } } : { error: r.why });
      return c.redirect(back, 303);
    }
    if (conv && i !== undefined && n !== undefined && a?.kind === "setting" && deps.settings) {
      // A setting's: the value its card says now, through that setting's own route (the same checks answer).
      const form = await c.req.parseBody();
      const back = `${convHref(id, first(form.dock) === "1")}#act-${i}-${n}`;
      if (a.done) return c.redirect(back, 303);
      const r = await deps.settings.change(c.req.raw, a.id, typeof form.to === "string" ? form.to.slice(0, 200) : typeof form.from === "string" && typeof form.till === "string" ? (form.from || form.till ? `${form.from.slice(0, 2)}-${form.till.slice(0, 2)}` : "") : a.to, "Bino", { twice: form.twice === "1", env: c.env, ctx: ctxOf(c) });
      await bino.setAct(id, i, n, r.ok ? { error: undefined, was: r.was, done: { at: Date.now(), text: r.text, href: r.href } } : { error: r.why });
      return c.redirect(back, 303);
    }
    return c.notFound();
  });
  /** Undo on a setting card's done line: what it was before, back through the same route; the card proposes again. */
  app.post("/bino/c/:id/act/:i/:n/undo", async (c) => {
    const id = c.req.param("id");
    const i = idOf(c.req.param("i"));
    const n = idOf(c.req.param("n"));
    const a = CONV.test(id) && i !== undefined && n !== undefined ? await bino.act(id, i, n) : undefined;
    if (i === undefined || n === undefined || (a?.kind !== "setting" && a?.kind !== "layout") || !deps.settings) return c.notFound();
    const form = await c.req.parseBody();
    const back = `${convHref(id, first(form.dock) === "1")}#act-${i}-${n}`;
    if (!a.done || a.was === undefined) return c.redirect(back, 303);
    if (a.kind === "layout") {
      // What it changed, put back through the same route; the card proposes again.
      const was = placementFrom(a.was);
      const r = was ? await deps.settings.arrange(c.req.raw, was, "Bino (undo)", { env: c.env, ctx: ctxOf(c) }) : { ok: false as const, why: "What it was isn't kept." };
      await bino.setAct(id, i, n, r.ok ? { error: undefined, done: undefined, was: undefined } : { error: r.why });
      return c.redirect(back, 303);
    }
    const r = await deps.settings.change(c.req.raw, a.id, a.was, "Bino (undo)", { twice: form.twice === "1", env: c.env, ctx: ctxOf(c) });
    await bino.setAct(id, i, n, r.ok ? { error: undefined, done: undefined, was: undefined } : { error: r.why });
    return c.redirect(back, 303);
  });
  app.post("/bino/memory/:id/forget", async (c) => {
    const id = c.req.param("id");
    if (/^[\w-]{1,80}$/.test(id)) await bino.memory.forget(id);
    deps.hub?.publish(["bino"]);
    return c.redirect("/bino", 303);
  });
  return app;
}
