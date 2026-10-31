/** Settings (dovre#184): an overview with search and what was changed from the default, and a page for each area. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import { type Choice, type Field, GENERAL, PANES, type PaneId, type PaneState, ticked } from "../config.ts";
import { found } from "../tools.ts";
import { currentTz } from "../when.ts";
import { DEFAULT_POLICY, type Policy, RING_KINDS, type Rung } from "../notify.ts";
import { quietLabel } from "../quiet.ts";
import type { Layout } from "../layout.ts";
import { DEFAULT_KEYS, KEY_GROUPS, type KeyPrefs, SCROLL_STEPS } from "../keys.ts";
import type { Clicks, WriteKind } from "../writes.ts";
import { LOOK, STATS_RANGES, statsRange } from "./layout.ts";
import type { Reg, ToolsHarness } from "../agents/mcpsetup.ts";
import { Confirm, Empty, type Html, Item, List, Notice, PageHeader, Panel, Pill, Tabs } from "../ui/kit.ts";
import { Ago, forgeName, quietFields } from "./parts.ts";

/** What this machine has, for the Setup panel: each a line saying what it does, and how to turn it on when it's off. Panes have their own panel. */
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
      ? { name: "Copilot CLI", on: true, what: `Its sessions show on Agents; Bino and summaries can ask through it (Settings → Panes): ${f.copilotCli}` }
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

export type PanesView = { panes: Record<PaneId, PaneState>; values: Record<string, string | undefined>; fixed: Set<string> };

/** Each pane's switch, its route where it has more than one, and its main options. */
export function paneSets(v: PanesView) {
  return PANES.map((p) => {
    const st = v.panes[p.id];
    const fixed = v.fixed.has(p.key);
    const via = p.on.length > 1 ? html`<label class="field"><span class="label">Through</span><select name="via.${p.id}"${fixed ? html` disabled` : ""}>${p.on.map((c) => html`<option value="${c.value}"${st.via === c.value ? html` selected` : ""}>${c.label}</option>`)}</select></label>` : "";
    const opts = p.options.map((o) => fieldInput(o, v.values[o.key], v.fixed.has(o.key)));
    // A pane whose pack is its switch (#271): how it runs here; on or off is on Packs.
    const toggle = p.pack
      ? html`<strong>${p.name}</strong> <a class="t3" href="/packs#pack-${p.pack}">On or off: Packs</a>`
      : html`<label class="check"><input type="checkbox" name="on.${p.id}" value="on"${st.wanted ? html` checked` : ""}${fixed ? html` disabled` : ""}> <strong>${p.name}</strong></label>`;
    return html`<fieldset class="pane-set" id="pane-${p.id}"><legend>${toggle}${st.wanted && !st.on ? html` <span class="pane-why">${st.why ?? "Can't run here."}</span>` : ""}${fixed ? html` <span class="t3">Set in .dev.vars (${p.key})</span>` : ""}</legend>
<p class="pane-what">${p.what}</p>${via || opts.length ? html`<div class="fields aligned">${via}${opts}</div>` : ""}</fieldset>`;
  });
}

export function panesPanel(v: PanesView, canRestart: boolean) {
  const n = PANES.filter((p) => v.panes[p.id].on).length;
  return Panel({
    title: "Panes",
    meta: `${n} of ${PANES.length} on`,
    id: "panes",
    children: html`<form method="post" action="/settings/panes">
<p class="notes">A pane that's off is gone from the menu, search and Today, and does nothing in the background. Changes apply when Dovre starts again: open terminals close, agents carry on.</p>
${paneSets(v)}
<div class="buttons"><button type="submit" class="primary" data-busy="Saving">${canRestart ? "Save and restart" : "Save"}</button></div>
</form>`,
  });
}

/** "Saved, starting again": the page waits for the new server (src/ui/app.js.ts), then opens `then`. */
export function restartingNote(started: number, then: string, text: string) {
  return html`<div data-restarting="${started}" data-then="${then}">${Notice({ tone: "ok", children: text })}</div>`;
}

export function workPanel(v: PanesView, canRestart: boolean, teams?: Choice[]) {
  return Panel({
    title: "Work",
    id: "work",
    children: html`<form method="post" action="/settings/work">
<div class="fields aligned">${GENERAL.map((g) => fieldInput(g, v.values[g.key], v.fixed.has(g.key), g.key === "TEAM" ? teams : undefined))}</div>
<div class="buttons"><button type="submit" class="primary" data-busy="Saving">${canRestart ? "Save and restart" : "Save"}</button></div>
</form>`,
  });
}

/** Where Edge is, if it's here (it opens Dovre as an app window). */
export function edgePath(): string | undefined {
  if (process.platform !== "win32") return undefined;
  return [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter((b): b is string => !!b).map((b) => join(b, "Microsoft", "Edge", "Application", "msedge.exe")).find((p) => existsSync(p));
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

export function notifyPanels(p: Policy, log: Rung[], rings: { kind: string; label: string; hint?: string; off?: boolean }[] = []) {
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
    : Empty({ title: "Nothing has rung since Dovre started" });
  return html`${Panel({ title: "Notifications", id: "notifications", children: html`<p class="notes">They come as Windows toasts. Allow them in this window instead and it shows them itself, only when you're not looking at it. <span id="bell-note"></span></p><p><button id="bell" class="sm" type="button" hidden>Show them from this window</button></p>${form}` })}
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
  { id: "panes", title: "Panes", about: "What runs here: how Bino answers, Stats, reviews, summaries, the lab (packs are switched on Packs)", also: ["features", "on", "off", "enable"] },
  { id: "work", title: "Work", about: "The owners to track, the code folder, your team", also: ["org", "repos", "checkouts", "team"] },
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

/** One setting, to find: where it lives, what it's set to now, and whether that's other than the default. */
export type SettingRow = { area: AreaId; label: string; href: string; now?: string; changed?: boolean; also?: string[] };

/** A pack with settings: its manifest's (set or not), and whether it has its own panel or ingest tokens. */
export type PackSettings = { id: string; name: string; on: boolean; settings: { key: string; label: string; set: boolean }[]; panel: boolean };

export type RowsState = {
  layout: Layout;
  policy: Policy;
  rings: { kind: string; label: string; off?: boolean }[];
  writes: { chosen: Map<string, Clicks>; kinds: WriteKind[] };
  keys: KeyPrefs;
  panes?: PanesView & { stored: Record<string, string | undefined> };
  packs: PackSettings[];
  agents?: AgentToolsView["rows"];
  setup?: SetupLine[];
  canRestart?: boolean;
};

const LOOK_ALSO: Record<string, string[]> = { theme: ["dark", "light", "mode", "colour", "color"], accent: ["colour", "color"], font: ["typeface", "sans", "serif", "mono"], textSize: ["font size", "zoom", "bigger", "smaller"], lineHeight: ["spacing", "leading"], binoButton: ["assistant", "avatar", "face"], motion: ["animation", "animations", "reduced motion", "movement"] };
const onOff = (on: boolean) => (on ? "On" : "Off");

export function settingRows(s: RowsState): SettingRow[] {
  const rows: SettingRow[] = [];
  const l = s.layout;
  for (const o of LOOK) {
    const v = l[o.key] ?? "";
    rows.push({ area: "look", label: o.label, href: "/settings/look", now: o.choices.find((c) => c.value === v)?.label, changed: v !== "", also: LOOK_ALSO[o.key] });
  }
  const range = statsRange(l);
  rows.push(
    { area: "layout", label: "The phone's tabs", href: "/settings/layout#tabs", changed: l.tabs !== undefined, also: ["tab bar", "mobile", "bottom"] },
    { area: "layout", label: "Today's cards", href: "/settings/layout#cards", changed: !!l.cards && Object.keys(l.cards).length > 0, also: ["home", "columns", "order"] },
    { area: "layout", label: "What Stats shows", href: "/settings/layout#stats", changed: !!l.stats && Object.keys(l.stats).length > 0, also: ["charts", "panels"] },
    { area: "layout", label: "Range on Stats", href: "/settings/layout#stats", now: STATS_RANGES.find((r) => r.value === range)?.label, changed: range !== "", also: ["weeks", "days"] },
    { area: "layout", label: "What's happening: its sources", href: "/settings/layout#feed", now: l.feedOff?.length ? `${l.feedOff.length} left out` : undefined, changed: !!l.feedOff?.length, also: ["feed", "events"] },
    { area: "layout", label: "Packs on", href: "/settings/layout#packs-shown", now: l.packsOff?.length ? `${l.packsOff.length} off` : undefined, changed: !!l.packsOff?.length, also: ["hide", "pack", "switch", "off", "Bino", "Terminal", "Docker"] },
  );
  const p = s.policy;
  for (const k of [...RING_KINDS, ...s.rings]) {
    const on = ringOn(p, k);
    rows.push({ area: "notifications", label: `Ring for: ${k.label}`, href: "/settings/notifications#ring-for", now: onOff(on), changed: on !== (DEFAULT_POLICY.kinds[k.kind] ?? !("off" in k && k.off === true)), also: ["ring", "notify"] });
  }
  rows.push(
    { area: "agents", label: "A long agent turn is at least", href: "/settings/agents#long-turn", now: `${p.longTurnMin} min`, changed: p.longTurnMin !== DEFAULT_POLICY.longTurnMin, also: ["agent", "minutes", "notification", "ring"] },
    { area: "notifications", label: "Bundle what follows for", href: "/settings/notifications#bundle", now: `${p.bundleSec} s`, changed: p.bundleSec !== DEFAULT_POLICY.bundleSec, also: ["group", "seconds"] },
    { area: "notifications", label: "Quiet hours", href: "/settings/notifications#quiet-hours", now: quietLabel(p.quiet), changed: !!p.quiet, also: ["quiet hours", "work hours", "weekend", "night", "auto runs"] },
    { area: "notifications", label: "Send a test notification", href: "/settings/notifications#rang-lately", also: ["test", "rang lately"] },
  );
  for (const w of s.writes.kinds) {
    const twice = s.writes.chosen.get(w.kind) === "twice";
    rows.push({ area: "writes", label: w.label, href: "/settings/writes", now: twice ? "Asks twice" : "One click", changed: twice, also: [w.group, w.kind] });
  }
  rows.push({ area: "keys", label: "j / k scroll", href: "/settings/keys", now: SCROLL_STEPS.find((x) => x.px === s.keys.scroll)?.label, changed: s.keys.scroll !== DEFAULT_KEYS.scroll, also: ["speed", "scroll"] });
  for (const g of KEY_GROUPS) {
    const on = !s.keys.off.includes(g.id);
    rows.push({ area: "keys", label: `Keys: ${g.label}`, href: "/settings/keys", now: `${onOff(on)} · ${g.keys}`, changed: !on, also: ["shortcut"] });
  }
  if (s.panes) {
    const v = s.panes;
    const set = (key: string) => v.fixed.has(key) || (v.stored[key] ?? "") !== "";
    const shown = (key: string, now: string | undefined) => (v.fixed.has(key) ? `${now ?? ""} (.dev.vars)`.trim() : now);
    for (const pane of PANES) {
      const st = v.panes[pane.id];
      const via = pane.on.length > 1 ? pane.on.find((c) => c.value === st.via)?.label : undefined;
      rows.push({ area: "panes", label: pane.name, href: `/settings/panes#pane-${pane.id}`, now: shown(pane.key, st.wanted ? (via ?? "On") : "Off"), changed: set(pane.key), also: [pane.what] });
      for (const o of pane.options) rows.push({ area: "panes", label: `${pane.name}: ${o.label}`, href: `/settings/panes#pane-${pane.id}`, now: shown(o.key, v.values[o.key]), changed: set(o.key), also: [o.key] });
    }
    for (const g of GENERAL) rows.push({ area: "work", label: g.label, href: "/settings/work", now: shown(g.key, v.values[g.key]), changed: set(g.key), also: [g.key, g.hint ?? ""] });
  }
  for (const r of s.agents ?? []) rows.push({ area: "agents", label: `Pack tools for ${TOOL_NAMES[r.id]}`, href: "/settings/agents", now: r.id === "claude" || r.id === "codex" || r.state === "yes" ? "Set up" : "Not set up", also: ["mcp", r.id] });
  for (const k of s.packs) {
    const n = k.settings.filter((x) => x.set).length;
    rows.push({ area: "packs", label: k.name, href: `/settings/packs/${encodeURIComponent(k.id)}`, now: k.settings.length ? `${n} of ${k.settings.length} set${k.on ? "" : " · off"}` : k.on ? undefined : "off", changed: n > 0, also: [k.id] });
    for (const x of k.settings) rows.push({ area: "packs", label: `${k.name}: ${x.label}`, href: `/settings/packs/${encodeURIComponent(k.id)}`, now: x.set ? "Set" : "Not set", changed: x.set, also: [x.key] });
  }
  rows.push({ area: "about", label: "Version", href: "/settings/about", also: ["release", "running since"] }, { area: "about", label: "Install Dovre as an app", href: "/settings/about", also: ["pwa", "window"] });
  if (s.canRestart) rows.push({ area: "about", label: "Restart Dovre", href: "/settings/about", also: ["reload", "start again"] });
  for (const x of s.setup ?? []) rows.push({ area: "about", label: `Setup: ${x.name}`, href: "/settings/about#setup", now: x.on ? "On" : "Off", also: [x.what] });
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
