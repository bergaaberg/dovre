/**
 * A pack's own setup page (#418, epic #386), at /setup/<id>: the steps its manifest's `onboard`
 * declares, one at a time. The pack draws each step's body (`Pack.setup`); core draws the frame
 * around it, so every pack's setup feels the same: the climb's scene with the pack's flag, "Setting
 * up X", the step's title and "1 of 3", Back, the dots, Next or Done, and Later. Each step is a
 * form that saves and moves on, so it works without script.
 */
import { html } from "hono/html";
import type { Frame } from "../html.ts";
import type { OnboardStep } from "../packs/types.ts";
import { climbArt, type Flag } from "../ui/climb.ts";
import { type Child, Confirm, type Html, Item, List, Panel, Pill } from "../ui/kit.ts";
import { SETUP_JS_PATH } from "../ui/setup.js.ts";
import { MARK } from "../ui/splash.ts";
import { climbDoc } from "./welcome.ts";

export type SetupView = {
  look?: Frame["look"];
  flags: Flag[];
  pack: { id: string; name: string };
  steps: OnboardStep[];
  /** The step shown, by index; `steps.length` is the end ("That's it"). */
  at: number;
  /** The pack's body for the step, boxed. */
  body?: Html;
  /** The body's inputs are the step's form (`SetupStep.form`). */
  form?: boolean;
  /** Next waits, and why (`SetupStep.wait`). */
  wait?: string;
  /** Seconds until the step draws itself again, in place (`SetupStep.refresh`). */
  refresh?: number;
  /** The step's main button, where Next goes (`SetupStep.go`), already checked. */
  go?: { action: string; label: string; question: string; kind?: string };
  /** `go` presses itself again (`SetupStep.carry`). */
  carry?: boolean;
  /** What the last Next was refused for. */
  error?: string;
  /** At the end: the next pack whose setup isn't finished. */
  next?: { id: string; name: string };
};

/**
 * A step's main button as the pack asked for it (`SetupStep.go`), or none: it posts to a path on
 * this app (never another site), says itself in a short label, and names a write kind of the pack's own.
 */
export function setupGo(pack: string, go: unknown): SetupView["go"] {
  if (!go || typeof go !== "object") return undefined;
  const g = go as Record<string, unknown>;
  const action = typeof g.action === "string" ? g.action : "";
  const label = typeof g.label === "string" ? g.label.trim().slice(0, 60) : "";
  if (!/^\/(?![/\\])[\w/.~?=&%-]*$/.test(action) || !label) return undefined;
  const question = typeof g.question === "string" && g.question.trim() ? g.question.trim().slice(0, 300) : `${label}?`;
  const kind = typeof g.kind === "string" && g.kind.startsWith(`${pack}.`) ? g.kind : undefined;
  return { action, label, question, ...(kind ? { kind } : {}) };
}

const arrow = html`<span aria-hidden="true">→</span>`;
const later = html`<a class="climb-link" href="/">Later</a>`;

export function setupPage(v: SetupView) {
  const n = v.steps.length;
  const href = (i: number) => `/setup/${v.pack.id}?at=${v.steps[i]!.id}`;
  const head = html`<div class="su-head"><span class="climb-mark">${MARK}Setting up ${v.pack.name}</span>${v.at < n ? later : ""}</div>`;
  const body =
    v.at >= n
      ? html`${head}<div class="climb-eyebrow">${v.pack.name} · set</div><h2>That's it.</h2><p class="climb-lede">${v.pack.name} is set up. Run this again from Packs if anything changes.</p>${
          v.next
            ? html`<div class="climb-row"><a class="climb-go" href="/setup/${v.next.id}">Next: ${v.next.name} ${arrow}</a><a class="climb-link" href="/">Today</a><a class="climb-link" href="${href(0)}">Run it again</a></div>`
            : html`<div class="climb-row"><a class="climb-go" href="/">Back to Today ${arrow}</a><a class="climb-link" href="${href(0)}">Run it again</a></div>`
        }`
      : stepBody(v, head, href);
  return climbDoc({ title: `Setting up ${v.pack.name} · Dovre`, look: v.look, scene: climbArt("summit", v.flags), body, refresh: v.at < n ? v.refresh : undefined, script: SETUP_JS_PATH, page: "su-page" });
}

function stepBody(v: SetupView, head: Html, href: (i: number) => string) {
  const n = v.steps.length;
  const step = v.steps[v.at]!;
  const last = v.at === n - 1;
  const back = v.at ? html`<a class="climb-link" href="${href(v.at - 1)}">Back</a>` : html`<a class="climb-link" href="/">Today</a>`;
  const dots = html`<span class="su-dots" aria-label="${`Step ${v.at + 1} of ${n}`}">${v.steps.map((_, k) => html`<i class="${k === v.at ? "su-on" : k < v.at ? "su-past" : ""}"></i>`)}</span>`;
  const next = html`<button type="submit" class="climb-go"${v.wait ? " disabled" : ""}>${last ? "Done" : "Next"} ${arrow}</button>`;
  // The step's own main button stands where Next goes; its form is its own, so the foot sits outside Next's.
  const go = v.go ? html`<div class="su-go"${v.carry ? html` data-carry="${v.go.label}"` : ""}>${Confirm({ action: v.go.action, label: v.go.label, question: v.go.question, kind: v.go.kind })}</div>` : "";
  const foot = html`<div class="su-foot">${back}${dots}${v.go ? go : next}</div>`;
  const notes = html`${v.wait ? html`<p class="su-note">${v.wait}</p>` : ""}${v.error ? html`<p class="su-note" role="alert">${v.error}</p>` : ""}`;
  const title = html`<div><div class="climb-eyebrow">${v.pack.name} · ${v.at + 1} of ${n}</div><h2>${step.title}</h2></div>`;
  const action = `/setup/${v.pack.id}/next`;
  const hidden = html`<input type="hidden" name="step" value="${step.id}">`;
  // A form step's inputs go with Next; any other body keeps its own forms (a Confirm), apart from Next's.
  if (v.go) return html`${head}${title}<div class="su-body">${v.body ?? ""}</div>${notes}${foot}`;
  return v.form
    ? html`${head}${title}<form method="post" action="${action}">${hidden}<div class="su-body">${v.body ?? ""}</div>${notes}${foot}</form>`
    : html`${head}${title}<div class="su-body">${v.body ?? ""}</div>${notes}<form method="post" action="${action}">${hidden}${foot}</form>`;
}

/** A pack on Today's strip: its setup isn't finished. */
export type SetupRow = { id: string; name: string; /** Its first step's title. */ what: string; left: number; steps: number; /** It doesn't work until it's done. */ required?: boolean };

/** Today's strip: the packs whose own setup isn't finished, each to its page. */
export function setupStrip(rows: SetupRow[]): Child {
  if (!rows.length) return "";
  return Panel({
    id: "setup",
    title: rows.length === 1 ? "A pack wants a minute" : "A few packs want a minute each",
    children: List(
      rows.map((r) =>
        Item({
          href: `/setup/${r.id}`,
          title: html`<strong>${r.name}</strong>`,
          line: r.required ? html`${r.what} · needs it to work` : r.what,
          trail: Pill({ tone: r.required ? "warn" : "accent", children: r.left === r.steps ? `${r.steps} step${r.steps === 1 ? "" : "s"}` : `${r.left} of ${r.steps} left` }),
        }),
      ),
    ),
  });
}
