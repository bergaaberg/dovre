/** Settings: what was found on this machine, what rings as a desktop notification, how often, and what rang lately. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import { type Choice, type Field, GENERAL, PANES, type PaneId, type PaneState } from "../config.ts";
import { currentTz } from "../when.ts";
import { type Policy, RING_KINDS, type Rung } from "../notify.ts";
import { Empty, type Html, Item, List, Notice, PageHeader, Panel, Pill } from "../ui/kit.ts";
import { Ago } from "./parts.ts";

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
};
export type SetupLine = { name: string; on: boolean; what: string; fix?: string };

export function setupLines(f: SetupFacts): SetupLine[] {
  const windows = (f.platform ?? process.platform) === "win32";
  return [
    { name: "GHE", on: true, what: `${f.ghe.host}, org ${f.ghe.org}, signed in as ${f.ghe.login}` },
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
  ];
}

/**
 * One setting as a form field; a key set in .dev.vars or the environment shows, fixed. `pick`: known
 * values to choose from instead of typing (my GHE teams), with "None" first.
 */
export function fieldInput(f: Field, value: string | undefined, fixed: boolean, pick?: Choice[]) {
  const dis = fixed ? html` disabled` : "";
  const picks = pick?.length ? [...pick, ...(value && !pick.some((c) => c.value === value) ? [{ value, label: value }] : [])] : undefined;
  const input = picks
    ? html`<select name="${f.key}"${dis}><option value="">None</option>${picks.map((c) => html`<option value="${c.value}"${value === c.value ? html` selected` : ""}>${c.label}</option>`)}</select>`
    : f.kind === "choice"
      ? html`<select name="${f.key}"${dis}>${f.choices.map((c) => html`<option value="${c.value}"${(value ?? f.choices[0]!.value) === c.value ? html` selected` : ""}>${c.label}</option>`)}</select>`
      : f.kind === "number"
        ? html`<input type="number" name="${f.key}" min="${f.min}" max="${f.max}" value="${value ?? ""}" placeholder="${f.placeholder ?? ""}"${dis}>`
        : html`<input type="text" name="${f.key}" value="${value ?? ""}" placeholder="${f.placeholder ?? ""}" maxlength="260" spellcheck="false"${dis}>`;
  return html`<label class="field"><span class="label">${f.label}</span>${input}${fixed ? html`<span class="hint">Set in .dev.vars (${f.key})</span>` : f.hint ? html`<span class="hint">${f.hint}</span>` : ""}</label>`;
}

export type PanesView = { panes: Record<PaneId, PaneState>; values: Record<string, string | undefined>; fixed: Set<string> };

/** Each pane's switch, its route where it has more than one, and its main options. */
export function paneSets(v: PanesView) {
  return PANES.map((p) => {
    const st = v.panes[p.id];
    const fixed = v.fixed.has(p.key);
    const via = p.on.length > 1 ? html`<label class="field"><span class="label">Through</span><select name="via.${p.id}"${fixed ? html` disabled` : ""}>${p.on.map((c) => html`<option value="${c.value}"${st.via === c.value ? html` selected` : ""}>${c.label}</option>`)}</select></label>` : "";
    const opts = p.options.map((o) => fieldInput(o, v.values[o.key], v.fixed.has(o.key)));
    return html`<fieldset class="pane-set" id="pane-${p.id}"><legend><label class="check"><input type="checkbox" name="on.${p.id}" value="on"${st.wanted ? html` checked` : ""}${fixed ? html` disabled` : ""}> <strong>${p.name}</strong></label>${st.wanted && !st.on ? html` <span class="pane-why">${st.why ?? "Can't run here."}</span>` : ""}${fixed ? html` <span class="t3">Set in .dev.vars (${p.key})</span>` : ""}</legend>
<p class="pane-what">${p.what}</p>${via || opts.length ? html`<div class="fields">${via}${opts}</div>` : ""}</fieldset>`;
  });
}

function panesPanel(v: PanesView, canRestart: boolean) {
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

function workPanel(v: PanesView, canRestart: boolean, teams?: Choice[]) {
  return Panel({
    title: "Work",
    id: "work",
    children: html`<form method="post" action="/settings/work">
<div class="fields">${GENERAL.map((g) => fieldInput(g, v.values[g.key], v.fixed.has(g.key), g.key === "TEAM" ? teams : undefined))}</div>
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
    meta: `${lines.filter((l) => l.on).length} of ${lines.length} on`,
    flush: true,
    children: List(
      lines.map((l) =>
        Item({
          lead: html`<span class="dot${l.on ? " ok" : ""}" role="img" aria-label="${l.on ? "on" : "off"}"></span>`,
          title: html`<strong>${l.name}</strong>`,
          line: l.what,
          more: l.fix,
          quiet: !l.on,
        }),
      ),
    ),
  });
}

function appPanel(info: { version: string; startedAt: number } | undefined, canRestart: boolean, tz = currentTz()) {
  return Panel({
    title: "The app",
    children: html`<dl class="kv"><dt>Version</dt><dd>${info?.version ?? "?"}</dd><dt>Running since</dt><dd>${info ? html`${new Date(info.startedAt).toLocaleString("en-GB", { timeZone: tz })} (${Ago(info.startedAt)})` : "?"}</dd>
<dt>Open it</dt><dd>${process.platform === "win32" ? html`<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>, the Start menu, or <code>dovre</code> in a terminal. It starts at login.` : html`<code>pnpm start</code> in Dovre's folder, then this address, or the installed app. It doesn't start at login here yet.`}</dd></dl>
<div class="buttons"><button type="button" id="install" class="primary" hidden>Install Dovre as an app</button>${
      canRestart ? html`<form method="post" action="/settings/restart"><button type="submit">Restart Dovre</button></form>` : ""
    }</div>
<p class="notes">Installed, Dovre gets its own window and icon, and notifications carry its name. No install button? Then it's installed already, or use the browser's <em>Install app</em> icon in the address bar (Edge or Chrome).</p>`,
  });
}

export function settingsPage(frame: Frame, opts: { /** The packs' kinds of notification, after the core's. */ rings?: { kind: string; label: string; hint?: string }[]; /** The packs' own panels (`settings`), each under its name. */ packs?: { id: string; name: string; body: Html }[]; policy: Policy; log: Rung[]; saved?: boolean; info?: { version: string; startedAt: number }; canRestart?: boolean; setup?: SetupLine[]; panes?: PanesView; /** What the panes or work form refused. */ bad?: string[]; /** Saved, and this server (started then) is making way for a new one. */ restarting?: number; /** My GHE teams, to pick from. */ teams?: Choice[]; /** Settings → Layout (src/pages/layout.ts). */ layout?: Html }) {
  const p = opts.policy;
  const form = html`<form method="post" action="/settings/notify">
<div class="field"><span class="label">Ring for</span><fieldset>${[...RING_KINDS, ...(opts.rings ?? [])].map(
    (k) => html`<label class="check"><input type="checkbox" name="kind" value="${k.kind}"${p.kinds[k.kind] !== false ? html` checked` : ""}> ${k.label}${k.hint ? html` <span class="t3">· ${k.hint}</span>` : ""}</label><br>`,
  )}</fieldset></div>
<div class="fields">
<label class="field"><span class="label">A long agent turn is at least</span><input type="number" name="longTurnMin" min="0" max="240" value="${p.longTurnMin}"><span class="hint">minutes. Ordinary replies never ring.</span></label>
<label class="field"><span class="label">Bundle what follows for</span><input type="number" name="bundleSec" min="0" max="600" value="${p.bundleSec}"><span class="hint">seconds after a notification: the rest come as one. 0 rings each.</span></label>
</div>
<div class="field"><label class="check"><input type="checkbox" name="workHoursOnly" value="on"${p.workHoursOnly ? html` checked` : ""}> Only on weekdays, 08:00–17:00</label><span class="hint">Outside those hours nothing rings; Dovre still shows it.</span></div>
<div class="buttons"><button type="submit" class="primary">Save</button></div>
</form>`;
  const log = opts.log.length
    ? List(
        opts.log.map((n) =>
          Item({
            title: html`<strong>${n.title}</strong>${n.held ? Pill({ children: "held: quiet hours" }) : n.kind === "bundle" ? Pill({ children: "bundled" }) : ""}`,
            line: n.body,
            trail: Ago(n.at),
            quiet: !!n.held,
          }),
        ),
      )
    : Empty({ title: "Nothing has rung since Dovre started" });
  const body = html`${PageHeader({ title: "Settings", sub: undefined })}
${opts.saved ? (opts.restarting ? restartingNote(opts.restarting, "/settings", "Saved. Dovre is starting again with it.") : Notice({ tone: "ok", children: "Saved." })) : ""}
${opts.bad?.length ? Notice({ tone: "bad", children: html`Not saved: ${opts.bad.join(", ")} ${opts.bad.length > 1 ? "aren't values they take" : "isn't a value it takes"}.` }) : ""}
${appPanel(opts.info, !!opts.canRestart, frame.tz ?? currentTz())}
${opts.layout ?? ""}
${opts.setup ? setupPanel(opts.setup) : ""}
${opts.panes ? panesPanel(opts.panes, !!opts.canRestart) : ""}
${opts.panes ? workPanel(opts.panes, !!opts.canRestart, opts.teams) : ""}
${(opts.packs ?? []).map((x) => Panel({ title: x.name, id: `pack-${x.id}`, children: x.body }))}
${Panel({ title: "Notifications", children: html`<p class="notes">They come as Windows toasts. Allow them in this window instead and it shows them itself, only when you're not looking at it. <span id="bell-note"></span></p><p><button id="bell" class="sm" type="button" hidden>Show them from this window</button></p>${form}` })}
${Panel({
  title: "Rang lately",
  meta: String(opts.log.length),
  actions: html`<form method="post" action="/settings/notify/test"><button type="submit" class="sm">Send a test</button></form>`,
  children: html`<div data-live id="rang">${log}</div>`,
})}`;
  return shell({ title: "Settings · Dovre", frame, current: "/settings", body });
}
