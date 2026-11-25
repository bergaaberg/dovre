/** Settings (dovre#184): an overview with search and what was changed from the default, and a page for each area. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import { type Choice, type Field, GENERAL, ticked } from "../config.ts";
import { wholeIn } from "../packs/env.ts";
import { found } from "../tools.ts";
import { currentTz } from "../when.ts";
import { DEFAULT_POLICY, type Policy, RING_KINDS, type Rung } from "../notify.ts";
import { quietLabel, spanLabel, spanNow, spanOf } from "../quiet.ts";
import type { Layout } from "../layout.ts";
import { DEFAULT_KEYS, KEY_GROUPS, type KeyPrefs, SCROLL_STEPS } from "../keys.ts";
import type { Clicks, WriteKind } from "../writes.ts";
import { lookWith, STATS_RANGES, statsRange } from "./layout.ts";
import type { ThemeDef } from "../ui/themes.ts";
import type { Reg, ToolsHarness } from "../agents/mcpsetup.ts";
import { Confirm, Empty, type Html, Item, List, Notice, PageHeader, Panel, Pill, Tabs } from "../ui/kit.ts";
import { Ago, forgeName, quietFields } from "./parts.ts";

/** What this machine has, for the Setup panel: each a line saying what it does, and how to turn it on when it's off. */
export type SetupFacts = {
  ghe: { host: string; org: string; login: string };
  claude?: string;
  omp?: string;
  /** Copilot through omp: "ready", or what's missing. */
  copilot?: string;
  /** Copilot CLI's path, when it's here. */
  copilotCli?: string;
  edge?: string;
  codeDir: string;
  repos: number;
  /** Which OS's advice to give. Unset: this machine's. */
  platform?: NodeJS.Platform;
  /** PUBLIC_ORIGIN, when set (#74). */
  publicOrigin?: string;
};
/** `warn`: on, and worth keeping an eye on. */
export type SetupLine = { name: string; on: boolean; what: string; fix?: string; warn?: boolean };

export function setupLines(f: SetupFacts): SetupLine[] {
  const windows = (f.platform ?? process.platform) === "win32";
  return [
    { name: forgeName(f.ghe.host), on: true, what: `${forgeName(f.ghe.host) === f.ghe.host ? "" : `${f.ghe.host}, `}org ${f.ghe.org}, signed in as ${f.ghe.login}` },
    f.claude ? { name: "Claude Code", on: true, what: `Agents can run in it: ${f.claude}` } : { name: "Claude Code", on: false, what: "Not found", fix: "Install it (`claude` on the PATH), or set CLAUDE_BIN in .dev.vars. Without it, Bino, summaries and reviews use Copilot through omp." },
    f.omp ? { name: "omp", on: true, what: `Agents can run in it (Copilot models): ${f.omp}` } : { name: "omp", on: false, what: "Not found", fix: "Install it (`omp` on the PATH), or set OMP_BIN in .dev.vars. Copilot models need it: Bino and summaries without Claude Code." },
    f.copilotCli
      ? { name: "Copilot CLI", on: true, what: `Its sessions show on Agents; Bino and summaries can ask through it (Settings → Packs → Assistant): ${f.copilotCli}` }
      : { name: "Copilot CLI", on: false, what: "Not found", fix: `Optional. Install it (${windows ? "winget install GitHub.Copilot" : "npm install -g @github/copilot"}) for its sessions on Agents, and to give Bino and summaries a way in without Claude Code; or set COPILOT_BIN in .dev.vars.` },
    ...(f.copilot ? [f.copilot === "ready" ? { name: "Copilot", on: true, what: "Bino and summaries can use Copilot models through omp" } : { name: "Copilot", on: false, what: "Not set up", fix: f.copilot }] : []),
    ...(windows ? [f.edge ? { name: "Edge", on: true, what: "Opens Dovre as its own window" } : { name: "Edge", on: false, what: "Not found: the default browser opens it instead" }] : []),
    f.repos
      ? { name: "Code folder", on: true, what: `${f.repos} checkouts in ${f.codeDir}` }
      : { name: "Code folder", on: false, what: `No checkouts in ${f.codeDir}`, fix: "Set the code folder (Settings → Work) to the folder your repos are in. They have to sit directly in it (<folder>/<repo>), not deeper." },
    ...(f.publicOrigin ? [{ name: "Public address", on: true, warn: true, what: `Also served at ${f.publicOrigin} (PUBLIC_ORIGIN)`, fix: "Whatever reaches that address reaches the terminals and agents. Keep a sign-in in front of it (docs/REMOTE.md)." }] : []),
  ];
}

/**
 * One setting as a form field; a key set in .dev.vars or the environment shows, fixed. `pick`: known
 * values to choose from instead of typing (my GHE teams), with "None" first.
 */
export function fieldInput(f: Field, value: string | undefined, fixed: boolean, pick?: Choice[]) {
  const dis = fixed ? html` disabled` : "";
  const fixedHint = fixed ? html`<span class="hint">Set in .dev.vars (${f.key})</span>` : f.hint ? html`<span class="hint">${f.hint}</span>` : "";
  if (f.kind === "set") {
    // Each choice ticked on its own; the hidden field says the set was on the form, so none ticked is "none", not "unchanged".
    const on = ticked(f, value);
    const here = found.paths as Record<string, string | undefined> | undefined;
    const boxes = f.choices.map((c) => html`<label class="check"><input type="checkbox" name="${f.key}.${c.value}" value="on"${on.has(c.value) ? html` checked` : ""}${dis}> ${c.label}${here && !here[c.value] ? html` <span class="t3">· not found here</span>` : ""}</label><br>`);
    return html`<div class="field"><span class="label">${f.label}</span><input type="hidden" name="${f.key}" value=""><fieldset>${boxes}</fieldset>${fixedHint}</div>`;
  }
  const picks = pick?.length ? [...pick, ...(value && !pick.some((c) => c.value === value) ? [{ value, label: value }] : [])] : undefined;
  const input = picks
    ? html`<select name="${f.key}"${dis}><option value="">None</option>${picks.map((c) => html`<option value="${c.value}"${value === c.value ? html` selected` : ""}>${c.label}</option>`)}</select>`
    : f.kind === "choice"
      ? html`<select name="${f.key}"${dis}>${f.choices.map((c) => html`<option value="${c.value}"${(value ?? f.choices[0]!.value) === c.value ? html` selected` : ""}>${c.label}</option>`)}</select>`
      : f.kind === "number"
        ? html`<input type="number" name="${f.key}" min="${f.min}" max="${f.max}" value="${value ?? ""}" placeholder="${f.placeholder ?? ""}"${dis}>`
        : html`<input type="text" name="${f.key}" value="${value ?? ""}" placeholder="${f.placeholder ?? ""}" maxlength="260" spellcheck="false"${dis}>`;
  return html`<label class="field"><span class="label">${f.label}</span>${input}${fixedHint}</label>`;
}

/** The Work form: what Settings keeps, and what .dev.vars or the environment fixes. */
type PanesView = { values: Record<string, string | undefined>; fixed: Set<string> };

/** "Saved, starting again": the page waits for the new server (src/ui/app.js.ts), then opens `then`. */
export function restartingNote(started: number, then: string, text: string) {
  return html`<div data-restarting="${started}" data-then="${then}">${Notice({ tone: "ok", children: text })}</div>`;
}

/**
 * Settings → Work's "Code lives on" (#421): the instance's forge, or None. None stops the forge's
 * gather, holds the packs that go through it, and leaves its cards off Today. The climb asks it too.
 */
export function codeHostPanel(v: { forge: string; none: boolean; restart?: "automatic" | "manual" }) {
  return Panel({
    title: "Code lives on",
    id: "code-host",
    children: html`<form method="post" action="/settings/work/code-host">
<p class="t2">With None, Dovre doesn't ask ${v.forge} for anything: Today leaves out pull requests and releases, and the packs that work through ${v.forge} are off.</p>
<div class="fields aligned"><label class="field"><span class="label">Code lives on</span><select name="host"><option value="forge"${v.none ? "" : html` selected`}>${v.forge}</option><option value="none"${v.none ? html` selected` : ""}>None</option></select></label></div>
${v.restart === "manual" ? html`<p class="t2">${v.none ? `To connect ${v.forge}, select it, save, and restart Dovre.` : `Restart Dovre to set up ${v.forge}.`}</p>` : ""}
<div class="buttons"><button type="submit" class="primary" data-busy="Saving">Save</button></div>
</form>`,
  });
}

export function workPanel(v: PanesView, canRestart: boolean) {
  return Panel({
    title: "Work",
    id: "work",
    children: html`<form method="post" action="/settings/work">
<div class="fields aligned">${GENERAL.map((g) => fieldInput(g, v.values[g.key], v.fixed.has(g.key)))}</div>
<div class="buttons"><button type="submit" class="primary" data-busy="Saving">${canRestart ? "Save and restart" : "Save"}</button></div>
</form>`,
  });
}

/** Where Edge is, if it's here (it opens Dovre as an app window). */
export function edgePath(): string | undefined {
  if (process.platform !== "win32") return undefined;
  return [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter((b): b is string => !!b).map((b) => join(b, "Microsoft", "Edge", "Application", "msedge.exe")).find((p) => existsSync(p));
}

/** Settings → About (#94): Bino's setup chat, started again whenever: what else I work with, and what's left. */
export function carryPanel(): Html {
  return Panel({
    title: "Set up with Bino",
    id: "carry",
    children: html`<p class="notes">Tell Bino what else you work with. It finds the packs for it, a card each, and keeps a list of what's set up and what's left. Nothing changes before you press.</p><form method="post" action="/bino/new"><input type="hidden" name="carry" value="1"><button type="submit" class="primary" data-busy="Starting">Set up with Bino</button></form>`,
  });
}

export function setupPanel(lines: SetupLine[], title = "Setup") {
  return Panel({
    title,
    id: "setup",
    meta: `${lines.filter((l) => l.on).length} of ${lines.length} on`,
    flush: true,
    children: List(
      lines.map((l) =>
        Item({
          lead: html`<span class="dot${l.warn ? " warn" : l.on ? " ok" : ""}" role="img" aria-label="${l.on ? "on" : "off"}"></span>`,
          title: html`<strong>${l.name}</strong>`,
          line: l.what,
          more: l.fix,
          quiet: !l.on,
        }),
      ),
    ),
  });
}

/** Settings → Pack tools for agents (#172): which agent CLIs here get the packs' tools, and the button for omp and agy. */
export type AgentToolsView = {
  /** Whether any pack on offers tools now. */
  offered: boolean;
  rows: { id: "claude" | "codex" | ToolsHarness; state?: Reg }[];
  /** What the last Register said, once. */
  said?: { ok: boolean; text: string };
};

const TOOL_NAMES: Record<AgentToolsView["rows"][number]["id"], string> = { claude: "Claude Code", codex: "Codex", omp: "omp", agy: "agy" };

export function agentToolsPanel(v: AgentToolsView): Html {
  const line = (r: AgentToolsView["rows"][number]) => {
    if (r.id === "claude" || r.id === "codex") return { on: true, what: "Gets them in each turn and terminal by itself.", act: "" };
    const on = r.state === "yes";
    const what =
      r.state === "yes"
        ? "Set up: each turn and terminal gets them."
        : r.state === "stale"
          ? "Set up for an older Dovre (it moved or was updated): set it up again."
          : r.state === "unreadable"
            ? "Its MCP config isn't JSON Dovre can read."
            : "Not set up. It only reads MCP servers from its own config, so Dovre adds a \"dovre\" server there once (no secret in it).";
    const act =
      r.state === "yes"
        ? ""
        : Confirm({
            action: `/settings/agent-tools/${r.id}`,
            label: `Set up ${TOOL_NAMES[r.id]}`,
            kind: "agents.tools",
            question: r.id === "omp" ? html`Add a "dovre" server to omp's <code>mcp.json</code> (and each profile's)? Its other servers stay as they are.` : html`Run <code>agy mcp add dovre …</code>? Its other servers stay as they are.`,
          });
    return { on, what, act };
  };
  const notes = html`<p class="notes">Packs' tools (such as HTTP's <code>http_send</code>) reach the agents Dovre starts here, with a token that lasts as long as the turn or terminal.${v.rows.some((r) => r.id === "agy") ? html` agy asks before each MCP call and can't ask in a turn Dovre runs: allow the ones you want in agy's settings, e.g. <code>mcp(dovre/http_send)</code> under <code>permissions.allow</code>.` : ""}</p>`;
  return Panel({
    title: "Pack tools for agents",
    id: "agent-tools",
    meta: v.offered ? undefined : "no pack offers any now",
    children: html`${v.said ? Notice({ tone: v.said.ok ? "ok" : "bad", children: v.said.text }) : ""}${List(
      v.rows.map((r) => {
        const l = line(r);
        return Item({
          lead: html`<span class="dot${l.on ? " ok" : ""}" role="img" aria-label="${l.on ? "on" : "off"}"></span>`,
          title: html`<strong>${TOOL_NAMES[r.id]}</strong>`,
          line: l.what,
          more: l.act || undefined,
          quiet: !l.on,
        });
      }),
    )}${notes}`,
  });
}

export function appPanel(info: { version: string; startedAt: number } | undefined, canRestart: boolean, tz = currentTz()) {
  return Panel({
    title: "The app",
    id: "app",
    children: html`<dl class="kv"><dt>Version</dt><dd>${info?.version ?? "?"}</dd><dt>Running since</dt><dd>${info ? html`${new Date(info.startedAt).toLocaleString("en-GB", { timeZone: tz })} (${Ago(info.startedAt)})` : "?"}</dd>
<dt>Open it</dt><dd>${process.platform === "win32" ? html`<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>, the Start menu, or <code>dovre</code> in a terminal. It starts at login.` : html`<code>pnpm start</code> in Dovre's folder, then this address, or the installed app. It doesn't start at login here yet.`}</dd></dl>
<div class="buttons"><button type="button" id="install" class="primary" hidden>Install Dovre as an app</button>${
      canRestart ? html`<form method="post" action="/settings/restart"><button type="submit">Restart Dovre</button></form>` : ""
    }</div>
<p class="notes">Installed, Dovre gets its own window and icon, and notifications carry its name. No install button? Then it's installed already, or use the browser's <em>Install app</em> icon in the address bar (Edge or Chrome).</p>`,
  });
}

/** Is this kind on: my choice, else the default (a pack's ring that starts off is off). */
const ringOn = (p: Policy, k: { kind: string; off?: boolean }) => p.kinds[k.kind] ?? !k.off;

/** Notifications: what rings and when, and what rang lately. `rings`: the packs' kinds, after the core's. */
/** Settings → Agents: how long a turn runs before its end rings (kept with the notification policy). */
export function longTurnPanel(p: Policy) {
  return Panel({
    title: "A long turn rings",
    id: "long-turn",
    children: html`<form method="post" action="/settings/agents/long-turn"><div class="fields aligned"><label class="field"><span class="label">A long agent turn is at least</span><input type="number" name="longTurnMin" min="0" max="240" value="${p.longTurnMin}"><span class="hint">minutes. Its end rings; ordinary replies never do. What rings, and when it's quiet: <a href="/settings/notifications">Notifications</a>.</span></label></div>
<div class="buttons"><button type="submit" class="primary">Save</button></div></form>`,
  });
}

export function notifyPanels(p: Policy, log: Rung[], rings: { kind: string; label: string; hint?: string; off?: boolean }[] = [], o: { hosted?: boolean } = {}) {
  const form = html`<form method="post" action="/settings/notify">
<div class="field" id="ring-for"><span class="label">Ring for</span><fieldset>${[...RING_KINDS, ...rings].map(
    (k) => html`<label class="check"><input type="checkbox" name="kind" value="${k.kind}"${ringOn(p, k) ? html` checked` : ""}> ${k.label}${k.hint ? html` <span class="t3">· ${k.hint}</span>` : ""}</label><br>`,
  )}</fieldset></div>
<div class="fields aligned">
<label class="field" id="bundle"><span class="label">Bundle what follows for</span><input type="number" name="bundleSec" min="0" max="600" value="${p.bundleSec}"><span class="hint">seconds after a notification: the rest come as one. 0 rings each.</span></label>
</div>
${quietFields(p.quiet, "Nothing rings then; Dovre still shows it. Auto runs start nothing then too, unless they keep their own (Settings → Agents).")}
<p class="t2">How long an agent turn runs before its end rings: <a href="/settings/agents#long-turn">Settings → Agents</a>.</p>
<div class="buttons"><button type="submit" class="primary">Save</button></div>
</form>`;
  const rang = log.length
    ? List(
        log.map((n) =>
          Item({
            title: html`<strong>${n.title}</strong>${n.held ? Pill({ children: "held: quiet hours" }) : n.kind === "bundle" ? Pill({ children: "bundled" }) : ""}`,
            line: n.body,
            trail: Ago(n.at),
            quiet: !!n.held,
          }),
        ),
      )
    : Empty({ title: o.hosted ? "Nothing has rung yet" : "Nothing has rung since Dovre started" });
  return html`${Panel({ title: "Notifications", id: "notifications", children: html`<p class="notes">${o.hosted ? "An open Dovre page shows them, in a browser that allows them, only when you're not looking at it. With no Dovre page open, nothing rings." : "They come as Windows toasts. Allow them in this window instead and it shows them itself, only when you're not looking at it."} <span id="bell-note"></span></p><p><button id="bell" class="sm" type="button" hidden>${o.hosted ? "Allow them in this browser" : "Show them from this window"}</button></p>${form}` })}
${Panel({
  title: "Rang lately",
  id: "rang-lately",
  meta: String(log.length),
  actions: html`<form method="post" action="/settings/notify/test"><button type="submit" class="sm">Send a test</button></form>`,
  children: html`<div data-live id="rang">${rang}</div>`,
})}`;
}

// ── The areas, and every setting in them as a row to find ──

export const AREAS = [
  { id: "look", title: "Look", about: "Theme, accent, font, text size, line height", also: ["appearance", "colour", "color", "dark", "light"] },
  { id: "layout", title: "Layout", about: "The phone's tabs, Today's cards, Stats, the feed, packs shown", also: ["arrange", "order", "hide", "phone"] },
  { id: "notifications", title: "Notifications", about: "What rings, when, and what rang lately", also: ["ring", "toast", "alert", "quiet"] },
  { id: "writes", title: "Writes", about: "Which writes take one click instead of asking twice", also: ["confirm", "one click", "twice"] },
  { id: "keys", title: "Keys", about: "Shortcuts without Ctrl, and how far j/k scroll", also: ["keyboard", "shortcuts", "vim"] },
  { id: "work", title: "Work", about: "Where code lives, the owners to track, the code folder, your team", also: ["org", "repos", "checkouts", "team"] },
  { id: "agents", title: "Agents", about: "Which agent CLIs get the packs' tools, when a long turn rings, and auto runs' limits", also: ["mcp", "tools", "omp", "agy", "claude", "auto", "sandbox", "budget", "long turn"] },
  { id: "packs", title: "Packs", about: "Each pack's own settings", also: ["apps", "integrations", "tokens", "ingest"] },
  { id: "calls", title: "GitHub calls", about: "How much of GitHub's API quota is left, and what in Dovre used it", also: ["rate limit", "quota", "api", "usage", "403"] },
  { id: "speed", title: "Page speed", about: "How long pages take to load, the whole and each page, and how much is the server", also: ["performance", "perf", "slow", "latency", "load time", "fast"] },
  { id: "sent", title: "What Dovre sends", about: "Every call Dovre can make home, and the record of the ones it made", also: ["privacy", "telemetry", "phone home", "security", "trust", "data", "bridge"] },
  { id: "about", title: "About", about: "Version, restart, install, and what this machine has", also: ["setup", "version", "restart", "install"] },
] as const;
export type AreaId = (typeof AREAS)[number]["id"];
export const isArea = (s: string): s is AreaId => AREAS.some((a) => a.id === s);
const areaOf = (id: AreaId) => AREAS.find((a) => a.id === id)!;

/**
 * How one setting is changed by itself (#185): the values it takes, and its own route's form with
 * this one value changed. Every Settings route takes its page's whole form, so `post` writes the
 * rest of that form as it is now.
 */
export type Change = {
  /** `hours`: a span of hours, "22-7", or "" for none (quiet hours). */
  kind: "switch" | "choice" | "number" | "hours";
  /** What it is now, as its form posts it. */
  value: string;
  /** A choice's values; a switch's are "1" and "0". */
  choices?: Choice[];
  min?: number;
  max?: number;
  post(to: string): { action: string; fields: [string, string][] };
  /** Whether `to` loosens a guard (a write to one click): that's asked twice, whatever Settings says. */
  loosens?(to: string): boolean;
};
const SWITCH: Choice[] = [{ value: "1", label: "On" }, { value: "0", label: "Off" }];
export const choicesOf = (c: Change): Choice[] => (c.kind === "number" || c.kind === "hours" ? [] : (c.choices ?? SWITCH));

/**
 * `to` as this setting takes it, or null. A choice by its value, or by its label as it's shown
 * ("Dark", for "Dark (cool dark)"); a switch also by on and off; a number whole and within its bounds.
 */
export function changeTo(c: Change, to: string): string | null {
  const t = to.trim();
  if (c.kind === "number") return wholeIn(c, t) ? String(Number(t)) : null;
  if (c.kind === "hours") return spanOf(t);
  const choices = choicesOf(c);
  if (choices.some((x) => x.value === to)) return to;
  const low = t.toLowerCase();
  if (!low) return null;
  const short = (l: string) => l.replace(/\s*\(.*$/, "").toLowerCase();
  return (choices.find((x) => x.label.toLowerCase() === low) ?? choices.find((x) => short(x.label) === low))?.value ?? null;
}

/** A value of this setting as its page words it. */
export const changeLabel = (c: Change, v: string) => (c.kind === "number" ? v : c.kind === "hours" ? spanLabel(v) : (choicesOf(c).find((x) => x.value === v)?.label ?? v));

/**
 * One setting, to find: where it lives, what it's set to now, and whether that's other than the
 * default. `id` names it (`look.theme`); `change` is there only for a setting that may be changed
 * by itself from a card (#185): how Dovre looks, what it shows and when it rings. Never who gets
 * in, what leaves the machine, what agents and packs may do, or what's spent.
 */
export type SettingRow = { id: string; area: AreaId; label: string; href: string; now?: string; changed?: boolean; also?: string[]; change?: Change };

/** A pack with settings: its manifest's (set or not), and whether it has its own panel or ingest tokens. */
export type PackSettings = { id: string; name: string; on: boolean; settings: { key: string; label: string; set: boolean; /** A choice's or a number's value now, its default when unset (API 2.5). */ now?: string; /** Set to other than its default; unset: as `set`. */ changed?: boolean }[]; panel: boolean };

type RowsState = {
  layout: Layout;
  /** The packs' themes (pack API 2.4), after core's in the picker. */
  themes?: ThemeDef[];
  policy: Policy;
  /** Whether the policy is kept here (a notifier): without one its rows are only shown. */
  notifier?: boolean;
  rings: { kind: string; label: string; off?: boolean }[];
  writes: { chosen: Map<string, Clicks>; kinds: WriteKind[] };
  keys: KeyPrefs;
  panes?: PanesView & { stored: Record<string, string | undefined> };
  packs: PackSettings[];
  /** The packs on here, each with its one switch (#271). */
  switches?: { id: string; name: string }[];
  agents?: AgentToolsView["rows"];
  setup?: SetupLine[];
  canRestart?: boolean;
  /** Where code lives (#421): the forge's name, or none. */
  codeHost?: { forge: string; none: boolean };
  /** The packs whose events feed What's happening. */
  feeds?: { id: string; name: string }[];
  /** Layout's whole form as it is now, with the range or the feed's sources changed: how those are changed by themselves (#185). */
  layoutForm?: (o: { statsWeeks?: string; feedOff?: string[] }) => [string, string][];
};

const LOOK_ALSO: Record<string, string[]> = { theme: ["dark", "light", "mode", "colour", "color"], accent: ["colour", "color"], font: ["typeface", "sans", "serif", "mono"], textSize: ["font size", "zoom", "bigger", "smaller"], lineHeight: ["spacing", "leading"], binoButton: ["assistant", "avatar", "face"], motion: ["animation", "animations", "reduced motion", "movement"] };
const onOff = (on: boolean) => (on ? "On" : "Off");

export function settingRows(s: RowsState): SettingRow[] {
  const rows: SettingRow[] = [];
  const l = s.layout;
  const look = lookWith(s.themes ?? []);
  for (const o of look) {
    const v = l[o.key] ?? "";
    // Look posts all of Look: a key left out goes back to its default.
    const post = (to: string) => ({ action: "/settings/layout", fields: [["part", "look"], ...look.map((x): [string, string] => [x.key, x.key === o.key ? to : (l[x.key] ?? "")])] as [string, string][] });
    rows.push({ id: `look.${o.key}`, area: "look", label: o.label, href: "/settings/look", now: o.choices.find((c) => c.value === v)?.label, changed: v !== "", also: LOOK_ALSO[o.key], change: { kind: "choice", value: v, choices: o.choices, post } });
  }
  const range = statsRange(l);
  const form = s.layoutForm;
  rows.push(
    { id: "layout.tabs", area: "layout", label: "The phone's tabs", href: "/settings/layout#tabs", changed: l.tabs !== undefined, also: ["tab bar", "mobile", "bottom"] },
    { id: "layout.cards", area: "layout", label: "Today's cards", href: "/settings/layout#cards", changed: !!l.cards && Object.keys(l.cards).length > 0, also: ["home", "columns", "order"] },
    { id: "layout.stats", area: "layout", label: "What Stats shows", href: "/settings/layout#stats", changed: !!l.stats && Object.keys(l.stats).length > 0, also: ["charts", "panels"] },
    { id: "layout.statsRange", area: "layout", label: "Range on Stats", href: "/settings/layout#stats", now: STATS_RANGES.find((r) => r.value === range)?.label, changed: range !== "", also: ["weeks", "days"], ...(form ? { change: { kind: "choice" as const, value: range, choices: STATS_RANGES, post: (to: string) => ({ action: "/settings/layout", fields: form({ statsWeeks: to }) }) } } : {}) },
    { id: "layout.feed", area: "layout", label: "What's happening: its sources", href: "/settings/layout#feed", now: l.feedOff?.length ? `${l.feedOff.length} left out` : undefined, changed: !!l.feedOff?.length, also: ["feed", "events"] },
    { id: "layout.packs", area: "layout", label: "Packs on", href: "/settings/layout#packs-shown", now: l.packsOff?.length ? `${l.packsOff.length} off` : undefined, changed: !!l.packsOff?.length, also: ["hide", "pack", "switch", "off", "Bino", "Terminal", "Docker"] },
  );
  // Each pack's one switch: "Packs on" above says what was changed, so these don't say it again.
  for (const k of s.switches ?? []) {
    const on = !l.packsOff?.includes(k.id);
    rows.push({ id: `pack.${k.id}`, area: "layout", label: `Pack on: ${k.name}`, href: "/settings/layout#packs-shown", now: onOff(on), also: ["hide", "switch", "show", k.id], change: { kind: "switch", value: on ? "1" : "0", post: (to) => ({ action: `/packs/${encodeURIComponent(k.id)}/switch`, fields: [["on", to]] }) } });
  }
  // Each source of What's happening: "its sources" above says what was changed.
  for (const f of s.feeds ?? []) {
    const off = l.feedOff ?? [];
    const on = !off.includes(f.id);
    rows.push({ id: `layout.feed.${f.id}`, area: "layout", label: `What's happening: ${f.name}`, href: "/settings/layout#feed", now: onOff(on), also: ["feed", "events", f.id], ...(form ? { change: { kind: "switch" as const, value: on ? "1" : "0", post: (to: string) => ({ action: "/settings/layout", fields: form({ feedOff: to === "1" ? off.filter((x) => x !== f.id) : [...off, f.id] }) }) } } : {}) });
  }
  const p = s.policy;
  const kinds = [...RING_KINDS, ...s.rings];
  // Notifications posts every kind that rings, the bundle and the quiet hours.
  // `span` is quiet hours' from and to ("22-7", "" for none), `weekends` all weekend.
  const notifyForm = (o: { kind?: string; on?: boolean; bundleSec?: string; span?: string; weekends?: boolean }): [string, string][] => {
    const span = (o.span ?? spanNow(p.quiet)).split("-");
    return [
      ...kinds.filter((k) => (k.kind === o.kind ? !!o.on : ringOn(p, k))).map((k): [string, string] => ["kind", k.kind]),
      ["bundleSec", o.bundleSec ?? String(p.bundleSec)],
      ["quietFrom", span[1] !== undefined ? span[0]! : ""],
      ["quietTo", span[1] ?? ""],
      ...((o.weekends ?? !!p.quiet?.weekends) ? [["quietWeekends", "on"] as [string, string]] : []),
    ];
  };
  for (const k of kinds) {
    const on = ringOn(p, k);
    rows.push({ id: `notify.ring.${k.kind}`, area: "notifications", label: `Ring for: ${k.label}`, href: "/settings/notifications#ring-for", now: onOff(on), changed: on !== (DEFAULT_POLICY.kinds[k.kind] ?? !("off" in k && k.off === true)), also: ["ring", "notify"], ...(s.notifier ? { change: { kind: "switch" as const, value: on ? "1" : "0", post: (to: string) => ({ action: "/settings/notify", fields: notifyForm({ kind: k.kind, on: to === "1" }) }) } } : {}) });
  }
  rows.push(
    { id: "agents.longTurn", area: "agents", label: "A long agent turn is at least", href: "/settings/agents#long-turn", now: `${p.longTurnMin} min`, changed: p.longTurnMin !== DEFAULT_POLICY.longTurnMin, also: ["agent", "minutes", "notification", "ring"], ...(s.notifier ? { change: { kind: "number" as const, value: String(p.longTurnMin), min: 0, max: 240, post: (to: string) => ({ action: "/settings/agents/long-turn", fields: [["longTurnMin", to]] }) } } : {}) },
    { id: "notify.bundle", area: "notifications", label: "Bundle what follows for", href: "/settings/notifications#bundle", now: `${p.bundleSec} s`, changed: p.bundleSec !== DEFAULT_POLICY.bundleSec, also: ["group", "seconds"], ...(s.notifier ? { change: { kind: "number" as const, value: String(p.bundleSec), min: 0, max: 600, post: (to: string) => ({ action: "/settings/notify", fields: notifyForm({ bundleSec: to }) }) } } : {}) },
    { id: "notify.quiet", area: "notifications", label: "Quiet hours", href: "/settings/notifications#quiet-hours", now: quietLabel(p.quiet), changed: !!p.quiet, also: ["quiet hours", "work hours", "weekend", "night", "auto runs"], ...(s.notifier ? { change: { kind: "hours" as const, value: spanNow(p.quiet), post: (to: string) => ({ action: "/settings/notify", fields: notifyForm({ span: to }) }) } } : {}) },
    { id: "notify.quietWeekends", area: "notifications", label: "Quiet hours: all weekend", href: "/settings/notifications#quiet-hours", now: onOff(!!p.quiet?.weekends), also: ["quiet hours", "weekend", "saturday", "sunday"], ...(s.notifier ? { change: { kind: "switch" as const, value: p.quiet?.weekends ? "1" : "0", post: (to: string) => ({ action: "/settings/notify", fields: notifyForm({ weekends: to === "1" }) }) } } : {}) },
    { id: "notify.test", area: "notifications", label: "Send a test notification", href: "/settings/notifications#rang-lately", also: ["test", "rang lately"] },
  );
  const CLICKS: Choice[] = [{ value: "once", label: "One click" }, { value: "twice", label: "Asks twice" }];
  const asksTwice = (kind: string) => s.writes.chosen.get(kind) === "twice";
  for (const w of s.writes.kinds) {
    const twice = asksTwice(w.kind);
    // Writes posts the kinds that ask twice: every other kind takes one click.
    const post = (to: string) => ({ action: "/settings/writes", fields: s.writes.kinds.filter((x) => (x.kind === w.kind ? to === "twice" : asksTwice(x.kind))).map((x): [string, string] => ["twice", x.kind]) });
    rows.push({ id: `writes.${w.kind}`, area: "writes", label: w.label, href: "/settings/writes", now: twice ? "Asks twice" : "One click", changed: twice, also: [w.group, w.kind], change: { kind: "choice", value: twice ? "twice" : "once", choices: CLICKS, post, loosens: (to) => to === "once" } });
  }
  // Keys posts the scroll step and the groups that are on.
  const keysForm = (o: { scroll?: string; group?: string; on?: boolean }): [string, string][] => [["scroll", o.scroll ?? String(s.keys.scroll)], ...KEY_GROUPS.filter((g) => (g.id === o.group ? !!o.on : !s.keys.off.includes(g.id))).map((g): [string, string] => ["on", g.id])];
  rows.push({ id: "keys.scroll", area: "keys", label: "j / k scroll", href: "/settings/keys", now: SCROLL_STEPS.find((x) => x.px === s.keys.scroll)?.label, changed: s.keys.scroll !== DEFAULT_KEYS.scroll, also: ["speed", "scroll"], change: { kind: "choice", value: String(s.keys.scroll), choices: SCROLL_STEPS.map((x) => ({ value: String(x.px), label: x.label })), post: (to) => ({ action: "/settings/keys", fields: keysForm({ scroll: to }) }) } });
  for (const g of KEY_GROUPS) {
    const on = !s.keys.off.includes(g.id);
    rows.push({ id: `keys.${g.id}`, area: "keys", label: `Keys: ${g.label}`, href: "/settings/keys", now: `${onOff(on)} · ${g.keys}`, changed: !on, also: ["shortcut"], change: { kind: "switch", value: on ? "1" : "0", post: (to) => ({ action: "/settings/keys", fields: keysForm({ group: g.id, on: to === "1" }) }) } });
  }
  if (s.codeHost) rows.push({ id: "work.codeHost", area: "work", label: "Code lives on", href: "/settings/work#code-host", now: s.codeHost.none ? "None" : s.codeHost.forge, changed: s.codeHost.none, also: ["forge", "code host", "github", "gitlab", "repos", "none"] });
  if (s.panes) {
    const v = s.panes;
    const set = (key: string) => v.fixed.has(key) || (v.stored[key] ?? "") !== "";
    const shown = (key: string, now: string | undefined) => (v.fixed.has(key) ? `${now ?? ""} (.dev.vars)`.trim() : now);
    for (const g of GENERAL) rows.push({ id: `work.${g.key}`, area: "work", label: g.label, href: "/settings/work", now: shown(g.key, v.values[g.key]), changed: set(g.key), also: [g.key, g.hint ?? ""] });
  }
  for (const r of s.agents ?? []) rows.push({ id: `agents.tools.${r.id}`, area: "agents", label: `Pack tools for ${TOOL_NAMES[r.id]}`, href: "/settings/agents", now: r.id === "claude" || r.id === "codex" || r.state === "yes" ? "Set up" : "Not set up", also: ["mcp", r.id] });
  for (const k of s.packs) {
    const n = k.settings.filter((x) => x.set).length;
    const href = `/settings/packs/${encodeURIComponent(k.id)}`;
    rows.push({ id: `packs.${k.id}`, area: "packs", label: k.name, href, now: k.settings.length ? `${n} of ${k.settings.length} set${k.on ? "" : " · off"}` : k.on ? undefined : "off", changed: k.settings.some((x) => x.changed ?? x.set), also: [k.id] });
    // A pack's own settings have no `change`: core can't tell a harmless choice from the one that says where its pack sends things.
    for (const x of k.settings) rows.push({ id: `packs.${k.id}.${x.key}`, area: "packs", label: `${k.name}: ${x.label}`, href, now: x.now ?? (x.set ? "Set" : "Not set"), changed: x.changed ?? x.set, also: [x.key] });
  }
  rows.push({ id: "about.version", area: "about", label: "Version", href: "/settings/about", also: ["release", "running since"] }, { id: "about.install", area: "about", label: "Install Dovre as an app", href: "/settings/about", also: ["pwa", "window"] });
  if (s.canRestart) rows.push({ id: "about.restart", area: "about", label: "Restart Dovre", href: "/settings/about", also: ["reload", "start again"] });
  (s.setup ?? []).forEach((x, i) => rows.push({ id: `about.setup.${i}`, area: "about", label: `Setup: ${x.name}`, href: "/settings/about#setup", now: x.on ? "On" : "Off", also: [x.what] }));
  return rows;
}

/** The rows a search finds: every word in the label, the area, the value now, or what it's also called. */
export function findRows(rows: SettingRow[], q: string): SettingRow[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return rows.filter((r) => {
    const text = [r.label, areaOf(r.area).title, r.now ?? "", ...(r.also ?? [])].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** What's left after a save: saved (and maybe starting again), or what a form refused. */
export type SettingsNotes = { saved?: boolean; restarting?: number; bad?: string[]; then?: string };

function notes(n: SettingsNotes) {
  return html`${n.saved ? (n.restarting ? restartingNote(n.restarting, n.then ?? "/settings", "Saved. Dovre is starting again with it.") : Notice({ tone: "ok", children: "Saved." })) : ""}
${n.bad?.length ? Notice({ tone: "bad", children: html`Not saved: ${n.bad.join(", ")} ${n.bad.length > 1 ? "aren't values they take" : "isn't a value it takes"}.` }) : ""}`;
}

const rowItem = (r: SettingRow, withArea: boolean) =>
  Item({
    href: r.href,
    title: r.label,
    line: withArea || r.now ? html`${withArea ? areaOf(r.area).title : ""}${withArea && r.now ? " · " : ""}${r.now ?? ""}` : undefined,
    trail: r.changed ? Pill({ tone: "accent", children: "changed" }) : undefined,
  });

const areaTabs = (areas: AreaId[], current?: AreaId) => Tabs({ label: "Settings areas", items: [{ href: "/settings", label: "All", current: !current }, ...areas.map((id) => ({ href: `/settings/${id}`, label: areaOf(id).title, current: id === current }))] });

function finder(q: string) {
  return html`<form method="get" action="/settings" class="settings-find" role="search"><input type="search" name="q" value="${q}" placeholder="Find a setting: font, ring, one click…" aria-label="Find a setting" maxlength="100" spellcheck="false" autocomplete="off"><button type="submit" class="sm">Find</button></form>`;
}

/** /settings: the search, what was changed from the default, and the areas. */
export function settingsHome(frame: Frame, o: { areas: AreaId[]; rows: SettingRow[]; q?: string; notes?: SettingsNotes }) {
  const q = (o.q ?? "").trim();
  const rows = o.rows.filter((r) => o.areas.includes(r.area));
  const changed = rows.filter((r) => r.changed);
  const found = q ? findRows(rows, q) : [];
  const count = (id: AreaId) => changed.filter((r) => r.area === id).length;
  const body = html`${PageHeader({ title: "Settings", sub: "Grouped by area. Find any setting by name, or see what you changed from the default.", tabs: areaTabs(o.areas) })}
${notes(o.notes ?? {})}
${finder(q)}
${q
  ? Panel({ title: html`Found for “${q}”`, meta: String(found.length), flush: !!found.length, children: found.length ? List(found.map((r) => rowItem(r, true))) : Empty({ title: "No setting goes by that", children: html`<p class="t2">Try a shorter word, or open an area below.</p>` }) })
  : ""}
${Panel({
  title: "Areas",
  flush: true,
  children: List(o.areas.map((id) => { const a = areaOf(id); const n = count(id); return Item({ href: `/settings/${id}`, title: html`<strong>${a.title}</strong>`, line: a.about, trail: n ? Pill({ tone: "accent", children: `${n} changed` }) : undefined }); })),
})}
${Panel({ title: "Changed from the default", id: "changed", meta: String(changed.length), flush: !!changed.length, children: changed.length ? List(changed.map((r) => rowItem(r, true))) : Empty({ title: "Everything is as it came" }) })}`;
  return shell({ title: "Settings · Dovre", frame, current: "/settings", body });
}

/** /settings/<area>: its panels, under what was changed here. */
export function settingsArea(frame: Frame, area: AreaId, o: { areas: AreaId[]; rows: SettingRow[]; notes?: SettingsNotes; body: Html; title?: string; crumbs?: { href: string; label: string }[] }) {
  const a = areaOf(area);
  const changed = o.rows.filter((r) => r.area === area && r.changed);
  const here = changed.length
    ? html`<p class="settings-changed">Changed from the default: ${changed.map((r, i) => html`${i ? ", " : ""}<a href="${r.href}">${r.label}</a>${r.now ? html` <span class="t3">(${r.now})</span>` : ""}`)}</p>`
    : "";
  const body = html`${PageHeader({ title: o.title ?? a.title, sub: o.title ? undefined : a.about, crumbs: [{ href: "/settings", label: "Settings" }, ...(o.crumbs ?? [])], tabs: areaTabs(o.areas, area) })}
${notes(o.notes ?? {})}
${o.title ? "" : here}
${o.body}`;
  return shell({ title: `${o.title ?? a.title} · Settings · Dovre`, frame, current: "/settings", body });
}

/** A pack session's one Settings page (#369): the pack's settings, no other areas or crumbs. */
export function sessionSettings(frame: Frame, o: { name: string; notes?: SettingsNotes; body: Html }) {
  const body = html`${PageHeader({ title: "Settings", sub: `${o.name}, for this session only: nothing is written to disk, and it's gone when the session ends.` })}
${notes(o.notes ?? {})}
${o.body}`;
  return shell({ title: `Settings · ${o.name}`, frame, current: "/settings", body });
}

/** /settings/packs: the packs that have settings, each to its own page. */
export function packsList(packs: PackSettings[]): Html {
  return Panel({
    title: "Packs with settings",
    meta: String(packs.length),
    flush: !!packs.length,
    children: packs.length
      ? List(packs.map((k) => { const n = k.settings.filter((x) => x.set).length; return Item({ href: `/settings/packs/${encodeURIComponent(k.id)}`, title: html`<strong>${k.name}</strong>${k.on ? "" : html` ${Pill({ tone: "warn", children: "off" })}`}`, line: [k.settings.length ? `${n} of ${k.settings.length} set` : "", k.panel ? "its own settings" : ""].filter(Boolean).join(" · "), trail: n ? Pill({ tone: "accent", children: "changed" }) : undefined }); }))
      : Empty({ title: "No pack here has settings" }),
    foot: html`<a href="/packs">Packs</a> shows each one on or off, its refreshes and why.`,
  });
}
