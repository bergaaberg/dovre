/**
 * Bino carries on after the climb (#94): the setup chat. It opens with a fixed line (no model call),
 * the user names what else they work with, and Bino proposes packs for it, one card each. What a
 * card offers comes from where the pack stands when it's drawn: Add (from dovre-packs), switch it on,
 * its settings page for a key (never a key in chat), or its own setup. Below the messages, a summary
 * of what's set up and what's left, read from state, so it's right even after the turns run out.
 *
 * Small and cheap: a fixed prompt, the catalogue as compact data, and a stop after MAX_CARRY_TURNS
 * messages or MAX_CARRY_COST dollars, whichever comes first.
 */
import { html } from "hono/html";
import { ACT_FENCE, type Act, type LayoutAct, type PackInAct } from "./acts.ts";
import { type Arrangement, arranged, columnsOf, holds, phoneOf, placementOf, statsShown } from "../../../../arrange.ts";
import type { Conv } from "./bino.ts";
import type { CarryPack } from "../../../../routes/carry.ts";
import { Confirm, type Html, Notice } from "../../../../ui/kit.ts";
import { Ago, safeUrl } from "../../../../pages/parts.ts";

/** Most messages from the user in one setup chat (#94 settled 12, to adjust after use). */
export const MAX_CARRY_TURNS = 12;
/** Most a setup chat spends, in dollars: a guess, to adjust after use. */
export const MAX_CARRY_COST = 0.5;
export const CARRY_TITLE = "Setting up with Bino";

const one = (s: string, max = 140) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** Why a setup chat takes no more messages, or undefined while it does. */
export function carrySpent(c: Conv): string | undefined {
  const turns = c.msgs.filter((m) => m.role === "user").length;
  if (turns >= MAX_CARRY_TURNS) return `That's as far as this chat goes: ${MAX_CARRY_TURNS} messages.`;
  const cost = c.msgs.reduce((n, m) => n + (m.cost ?? 0), 0);
  if (cost >= MAX_CARRY_COST) return "That's as far as this chat goes: it has used what a setup chat may.";
  return undefined;
}

/** What Bino is told in a setup chat, with each message: how to go about it, and every pack as one line. */
export function carryBrief(packs: CarryPack[], arr?: Arrangement): string {
  const row = (p: CarryPack) => `- ${p.id}: ${one(p.name, 40)}${p.what ? `: ${one(p.what)}` : ""}`;
  const group = (title: string, ps: CarryPack[], tail: (p: CarryPack) => string = () => "") => (ps.length ? `${title}\n${ps.map((p) => row(p) + tail(p)).join("\n")}` : "");
  const of = (st: CarryPack["state"]) => packs.filter((p) => p.state === st);
  const runs = (p: CarryPack) => (p.runs === "local-only" ? " (only on the user's own machine)" : p.runs === "hosted-only" ? " (only hosted)" : "");
  return [
    `# This chat: carrying on after the climb

The user has just finished Dovre's first run: their role, where their code lives, and the packs suggested from that. Your job here is the long tail: they tell you what else they work with, and you bring in the packs for it. Keep each reply to a line or two.

- When they name a tool or a kind of work, match it to the packs below and propose each match as its own block at the end of your reply:

\`\`\`${ACT_FENCE}
{"kind": "pack", "id": "the pack's id from the list"}
\`\`\`

  Only ids from the list. Say in a few words why each fits. When nothing fits, say so plainly, and never invent a pack.
- The card does the right thing for where the pack stands: adds it, switches it on, or links to its settings. You don't need to explain how.
- Never ask for a key, token or password, and never repeat one. A pack that needs one says so on its card, and its settings page takes it from the user's secret store.
- Packs with a setup of their own are listed below this chat, each with a button. Point to them; don't walk through their steps yourself.
- A propose-nothing reply is fine: a question, or "that's covered by …".
- This chat stops after ${MAX_CARRY_TURNS} messages from the user. When they seem done, say so and point at what's left below.`,
    "## Packs",
    group("On:", of("on"), (p) => (p.left ? ` (its own setup has ${p.left} step${p.left === 1 ? "" : "s"} left)` : "")),
    group("Here, switched off by the user:", of("hidden")),
    group("Here, but can't run yet:", of("off"), (p) => (p.why ? ` (${one(p.why, 100)})` : "")),
    group("Being added:", of("adding")),
    group("In dovre-packs, to add:", of("add"), runs),
    arr ? layoutBrief(arr) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The layout part of the brief (#94): how to propose one, and what's here to arrange, as it is now. */
function layoutBrief(a: Arrangement): string {
  const place = (c: Arrangement["cards"][number]) => (c.col === "off" ? "hidden" : c.col);
  return [
    `## Layout

Once the packs are settled, or when they ask, propose one arrangement of Today, the phone's tabs and Stats, from their role and what they've told you: what they look at first goes first.

\`\`\`${ACT_FENCE}
{"kind": "layout", "left": ["card ids, top first"], "right": ["…"], "off": ["cards to hide"], "phone": ["up to three page hrefs"], "stats": ["stat ids to show first"]}
\`\`\`

Every part is optional: leave out what should stay as it is. Cards you don't name keep their column, after the ones you do. Only ids from the lists below. One layout block in a reply at most.`,
    a.cards.length ? `Today's cards (id: name, where now):\n${a.cards.map((c) => `- ${c.id}: ${one(c.label, 60)} (${place(c)})`).join("\n")}` : "",
    a.pages.length ? `Pages for the phone's bar (Today is always first, then up to three):\n${a.pages.map((x) => `- ${x.href}: ${one(x.title, 40)}${a.tabs.includes(x.href) ? " (a tab now)" : ""}`).join("\n")}` : "",
    a.stats.length ? `Stats' panels (id: name, from where, shown or hidden):\n${a.stats.map((x) => `- ${x.id}: ${one(x.label, 60)}, ${one(x.from, 30)} (${x.show ? "shown" : "hidden"})`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

type CardCtx = { dock?: boolean; /** Where the card posts. */ at: string };
const top = (dock?: boolean) => (dock ? html` target="_top"` : "");
const dockField = (dock?: boolean) => (dock ? html`<input type="hidden" name="dock" value="1">` : "");
/** A button that starts a pack's own setup conversation (#420), in the pane when this one is there. */
const setupButton = (p: CarryPack, dock: boolean | undefined, primary = true) =>
  html`<form method="post" action="/bino/new">${dockField(dock)}<input type="hidden" name="setup" value="${p.id}"><button type="submit"${primary ? html` class="primary"` : html` class="sm"`} data-busy="Starting">Set up ${p.name}</button></form>`;

/**
 * A pack Bino proposes (#94), as it stands now: Add, switch it on, its settings, its setup, or a line
 * saying it's on. One Dovre doesn't have here or in dovre-packs isn't drawn.
 */
export function packInCard(id: string, a: PackInAct & Act, p: CarryPack | undefined, o: CardCtx): Html {
  if (a.done) return html`<div class="bino-plan done" id="${id}"><p>${a.done.text} <span class="t3">· ${Ago(a.done.at)}</span></p>${a.done.href ? html`<div class="buttons"><a href="${safeUrl(a.done.href)}"${top(o.dock)}>Open its page</a></div>` : ""}</div>`;
  if (!p) return html``;
  const head = html`<p class="bino-plan-h">${p.state === "add" ? `Add ${p.name}` : p.name}</p>${p.what ? html`<p>${p.what}</p>` : ""}`;
  const err = a.error ? Notice({ tone: "bad", children: html`<strong>Not done.</strong> ${a.error}` }) : "";
  if (p.state === "add") {
    const runs = p.runs === "local-only" ? html`<p class="hint">It runs only on your own machine.</p>` : p.runs === "hosted-only" ? html`<p class="hint">It runs only hosted.</p>` : "";
    return html`<div class="bino-plan" id="${id}">${head}${err}${runs}${p.why ? html`<p class="hint">${p.why}</p>` : ""}<div class="buttons">${Confirm({ action: o.at, fields: o.dock ? { dock: "1" } : {}, label: "Add", kind: "packs.add", question: `Add ${p.name} from dovre-packs?` })}<span class="hint">Nothing changes before you press.</span></div></div>`;
  }
  if (p.state === "adding") return html`<div class="bino-plan done" id="${id}">${head}<p>Being added${p.why ? `: ${p.why}` : "."}</p>${p.href ? html`<div class="buttons"><a href="${safeUrl(p.href)}"${top(o.dock)}>Open the PR</a></div>` : ""}</div>`;
  if (p.state === "hidden")
    return html`<form method="post" action="${o.at}" class="bino-plan" id="${id}">${dockField(o.dock)}${head}${err}<p>It's here, switched off.</p><div class="buttons"><button type="submit" class="primary" data-busy="Switching">Switch it on</button><span class="hint">Settings → Layout switches it off again.</span></div></form>`;
  if (p.state === "off")
    return html`<div class="bino-plan" id="${id}">${head}<p>It can't run yet${p.why ? `: ${p.why}` : "."}</p><div class="buttons"><a class="btn primary" href="/settings/packs/${p.id}"${top(o.dock)}>Open its settings</a><span class="hint">A key goes there, from your secret store, never in chat.</span></div></div>`;
  return html`<div class="bino-plan done" id="${id}">${head}<p>It's on.${p.left ? ` Its own setup has ${p.left} step${p.left === 1 ? "" : "s"} left.` : ""}</p>${p.left ? html`<div class="buttons">${setupButton(p, o.dock)}</div>` : ""}</div>`;
}

const names = (xs: string[], max = 8) => (xs.length > max ? `${xs.slice(0, max).join(" · ")} and ${xs.length - max} more` : xs.join(" · "));

/**
 * Today, arranged (#94): the arrangement Bino proposes, applied to what's here now and shown by name,
 * one press to put it in place through Layout's own route; once done, Undo puts back what it changed.
 */
export function layoutCard(id: string, a: LayoutAct & Act, arr: Arrangement | undefined, o: CardCtx): Html {
  if (a.done) {
    const undo = a.was ? html`<form method="post" action="${o.at}/undo">${dockField(o.dock)}<button type="submit" class="sm" data-busy="Undoing">Undo</button></form>` : "";
    return html`<div class="bino-plan done" id="${id}"><p>${a.done.text} <span class="t3">· ${Ago(a.done.at)}</span></p>${a.error ? Notice({ tone: "bad", children: html`<strong>Not undone.</strong> ${a.error}` }) : ""}<div class="buttons">${undo}<a href="/settings/layout"${top(o.dock)}>Settings → Layout</a></div></div>`;
  }
  if (!arr) return html``;
  const next = arranged(arr, a);
  const same = holds(arr, placementOf(next, a));
  const cols = columnsOf(next);
  const row = (label: string, xs: string[]) => html`<p><span class="t3">${label}</span> ${xs.length ? names(xs) : "nothing"}</p>`;
  const cardsToo = !!(a.left || a.right || a.off);
  return html`<form method="post" action="${o.at}" class="bino-plan" id="${id}">${dockField(o.dock)}
<p class="bino-plan-h">Today, arranged</p>
${a.error ? Notice({ tone: "bad", children: html`<strong>Not changed.</strong> ${a.error}` }) : ""}
${cardsToo ? html`${row("Left:", cols.left)}${row("Right:", cols.right)}${cols.off.length ? row("Hidden:", cols.off) : ""}` : ""}
${a.phone ? row("Phone:", phoneOf(next)) : ""}
${a.stats ? row("Stats, first:", statsShown(next)) : ""}
<div class="buttons">${same ? html`<span class="hint">It's arranged like this already.</span>` : html`<button type="submit" class="primary" data-busy="Arranging">Use it</button><span class="hint">Nothing changes before you press. Settings → Layout changes it after.</span>`}</div>
</form>`;
}

/** Below a setup chat: what's set up, and what's left with a way to each, read from state; then why it stops, once it has. */
export function carrySummary(c: Conv, packs: CarryPack[], dock?: boolean): Html {
  const mine = packs.filter((p) => !p.own);
  const set = mine.filter((p) => p.state === "on" && !p.left);
  const left = [
    ...packs.filter((p) => p.state === "on" && p.left).map((p) => html`<li><span><b>${p.name}</b> · its setup, ${p.left} step${p.left === 1 ? "" : "s"}</span>${setupButton(p, dock, false)}</li>`),
    ...mine.filter((p) => p.state === "off").map((p) => html`<li><span><b>${p.name}</b> · ${p.why ?? "can't run yet"}</span><a href="/settings/packs/${p.id}"${top(dock)}>Its settings</a></li>`),
    ...packs.filter((p) => p.state === "adding").map((p) => html`<li><span><b>${p.name}</b> · ${p.why ?? "being added"}</span>${p.href ? html`<a href="${safeUrl(p.href)}"${top(dock)}>The PR</a>` : html`<a href="/packs#add-${p.id}"${top(dock)}>Packs</a>`}</li>`),
  ];
  const spent = carrySpent(c);
  return html`<div class="bino-setup" id="bino-carry"><div class="bino-plan done"><p class="bino-plan-h">Where it stands</p>
<p>${set.length ? html`Set up: ${set.map((p, i) => html`${i ? ", " : ""}${p.name}`)}.` : "Nothing of yours is on yet."}</p>
${left.length ? html`<p class="bino-left-h">Left:</p><ul class="bino-left">${left}</ul>` : html`<p class="t3">Nothing left.</p>`}
</div>${spent ? Notice({ tone: "warn", children: html`${spent} What's left is above. <a href="/packs"${top(dock)}>Packs</a> has the rest.` }) : ""}</div>`;
}
