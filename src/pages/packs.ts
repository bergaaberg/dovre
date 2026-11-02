/**
 * Packs: every pack this instance lists, on or off here and why, how its refreshes and cron runs
 * went, and its settings, a secret one only as set or missing (never its value).
 */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import { binoOf, hooksOf, type Off, type Refreshes, type RefreshState, requiresOf } from "../packs/registry.ts";
import type { Copy } from "../packs/copies.ts";
import type { Available } from "../packs/releases.ts";
import type { Pack, PackManifest, PackSetting } from "../packs/types.ts";
import { type Child, Confirm, Empty, Item, KeyValues, List, Notice, PageHeader, Panel, Pill, Post } from "../ui/kit.ts";
import { Ago } from "./parts.ts";
import { apiText, parseApi } from "../packs/api.ts";

/** A pack's own version, as dovre-packs releases it (x.y.z). */
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export type PacksView = { on: Pack[]; off: Off[]; env: Record<string, string | undefined>; hosted: boolean; refreshes?: Refreshes; now?: number; /** Ids of Dovre's own packs. */ core?: string[]; /** Local: the packs copied from dovre-packs, against its checkout (src/packs/copies.ts). */ copies?: Map<string, Copy>; canRestart?: boolean; /** Packs switched off here (Settings → Layout's list, the same switch). */ hidden?: string[]; /** Off with a switched-off pack it requires (#326): its id → that pack's id. */ held?: Map<string, string>; /** Hosted (#362): newer releases from dovre-packs' tags, when last read (src/packs/releases.ts). */ releases?: { at: number; available: Map<string, Available>; error?: string } };

const WHERE = { any: "here and hosted", "local-only": "on a machine only", "hosted-only": "hosted only" } as const;

const every = (ms: number) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`);

function refreshLine(c: Pack, r: RefreshState | undefined, hosted: boolean) {
  if (!c.refresh) return html`<span class="t3">none (answers from what it has)</span>`;
  const cadence = `every ${every(c.manifest.everyMs ?? 300_000)}`;
  const last = r?.since !== undefined
    ? Pill({ tone: "accent", children: "running" })
    : r?.at === undefined
      ? html`<span class="t3">not yet${hosted ? " in this isolate" : ""}</span>`
      : r.error
        ? html`${Pill({ tone: "bad", children: "failed" })} ${Ago(r.at)} <span class="t2">${r.error}</span>`
        : html`${Pill({ tone: "ok", children: "ok" })} ${Ago(r.at)}${r.ms !== undefined ? html` <span class="t3">· took ${r.ms < 1000 ? `${r.ms} ms` : `${(r.ms / 1000).toFixed(1)} s`}</span>` : ""}`;
  return html`${cadence} · ${last}`;
}

function cronLine(m: PackManifest, c: Pack | undefined, r: RefreshState | undefined) {
  const crons = Array.isArray(m.crons) ? m.crons.filter((x) => typeof x === "string") : [];
  if (!c?.scheduled && !crons.length) return undefined;
  const ran = r?.cronAt === undefined ? "" : r.cronError ? html` · ${Pill({ tone: "bad", children: "failed" })} ${Ago(r.cronAt)} <span class="t2">${r.cronError}</span>` : html` · last ran ${Ago(r.cronAt)}`;
  return html`${crons.length ? crons.map((x, i) => html`${i ? ", " : ""}<code>${x}</code>`) : html`<span class="t3">any trigger</span>`}${ran}`;
}

const short = (c: string | null) => (c ? c.slice(0, 7) : "?");
const files = (f: string[]) => (f.length > 4 ? `${f.slice(0, 4).join(", ")} and ${f.length - 4} more` : f.join(", "));

/** Where a copied pack came from and how it stands against the dovre-packs checkout. */
function copyLine(c: Copy) {
  const s = c.state;
  if (!s.tracked) return html`<span class="t3">copied before .pack.json; <code>pnpm packs track ${c.id}</code> to follow it</span>`;
  const from = html`${s.version ? html`${s.version} from ` : ""}${c.source ?? "unknown source"} @ <code>${short(c.commit)}</code>`;
  const parts: Child[] = [];
  if (s.gone) parts.push(Pill({ tone: "warn", children: "gone upstream" }));
  else if (s.upstream.length) parts.push(html`${Pill({ tone: "accent", children: s.newest ? `${s.newest} out` : "newer upstream" })}${s.behind ? ` ${s.behind} commit${s.behind === 1 ? "" : "s"}` : ""} <span class="t2">${files(s.upstream)}</span>`);
  else parts.push(Pill({ tone: "ok", children: "up to date" }));
  if (s.tag && !s.version && !s.upstream.length) parts.push(html`<span class="t3">version not recorded; an update records it</span>`);
  if (s.edited.length) parts.push(html`<span class="t2">edited here: ${files(s.edited)}</span>`);
  return html`${from} · ${parts.map((p, i) => html`${i ? " · " : ""}${p}`)}`;
}

/** An update's progress, its result, and the Update button when there's something to take. */
function copyJob(c: Copy, v: PacksView) {
  const j = c.job;
  const job = !j
    ? ""
    : j.state === "running"
      ? html`<p>${Pill({ tone: "accent", children: "updating" })} <span class="t2">${j.step}</span></p>`
      : j.state === "done"
        ? html`<p>${Pill({ tone: "ok", children: "updated" })} ${j.step}${j.changes?.length ? html` <span class="t3">(${j.changes.map((x) => `${x.how} ${x.file}`).join(", ")})</span>` : ""}</p>${v.canRestart ? Post({ action: "/settings/restart", label: "Restart Dovre" }) : ""}`
        : html`<p>${Pill({ tone: "bad", children: "not updated" })} <span class="t2">${j.step}</span></p>${j.out ? html`<details><summary class="t2">Output</summary><pre>${j.out}</pre></details>` : ""}`;
  const notes = c.state.notes?.length && c.state.upstream.length
    ? html`<details><summary class="t2">What changed${c.state.version ? ` since ${c.state.version}` : ` in ${c.state.newest}`}</summary>${List(c.state.notes.flatMap((n) => n.lines.map((l) => Item({ title: l, trail: n.version }))))}</details>`
    : "";
  const can = !v.hosted && c.state.tracked && !c.state.gone && c.state.upstream.length > 0 && j?.state !== "running";
  const button = can
    ? Confirm({
        action: `/packs/${encodeURIComponent(c.id)}/update`,
        label: c.state.newest ? `Update to ${c.state.newest}` : "Update",
        kind: "packs.update",
        question: html`Take ${c.state.newest ? html`${c.id} ${c.state.newest}` : html`dovre-packs' newer ${c.id}`} into <code>${c.into}</code>? ${c.state.edited.length ? "Your edits are merged in; a conflict changes nothing. " : ""}Then the instance's typecheck and tests run, and the files go back as they were if either fails.`,
      })
    : "";
  return html`${notes}${job}${button}`;
}

/** Hosted: a newer release of a bundled pack, and whether this core can run it. */
const releaseLine = (a: Available) =>
  html`${Pill({ tone: "accent", children: `${a.version} available` })}${a.needsCore ? html` <span class="t2">needs core API ${a.api}: update Dovre first</span>` : ""}`;

/** What it changed, and how to take it: in the instance repo, then a deploy (the Worker can't rewrite itself). */
const releaseNotes = (id: string, a: Available) =>
  html`${a.notes.length ? html`<details><summary class="t2">What changed in ${a.version}</summary>${List(a.notes.flatMap((n) => n.lines.map((l) => Item({ title: l, trail: n.version }))))}</details>` : ""}<p class="t3">Take it in the instance repo with <code>pnpm packs update ${id}</code>, then deploy.</p>`;

/** A setting: its label and key, set or missing; a non-secret one's value beside it. */
function settingItem(s: PackSetting, env: PacksView["env"]) {
  const v = env[s.key]?.trim();
  const state = v ? Pill({ tone: "ok", children: "set" }) : Pill({ tone: s.required ? "bad" : undefined, children: s.required ? "missing, needed" : "not set" });
  const shown = v && !s.secret ? html` <code>${v.length > 80 ? `${v.slice(0, 80)}…` : v}</code>` : "";
  return Item({ title: html`${s.label} ${state}`, line: html`<code>${s.key}</code>${s.secret ? " · secret" : ""}${shown}`, clamp: s.help });
}

/** Local editor for a pack's manifest settings (never renders existing secret values). */
function settingsForm(id: string, settings: PackSetting[], env: PacksView["env"]) {
  return html`<form method="post" action="/packs/${encodeURIComponent(id)}/settings">
  <div class="fields aligned">${settings.map((s) => {
    const v = env[s.key]?.trim();
    return s.secret
      ? html`<label class="field"><span class="label">${s.label} (<code>${s.key}</code>)</span><input type="password" name="${s.key}" value="" placeholder="${v ? "(set — leave blank to keep)" : s.help ?? ""}" maxlength="2000" spellcheck="false" autocomplete="off">${v ? html`<label class="check"><input type="checkbox" name="clear.${s.key}" value="1"> Clear saved secret</label>` : ""}${s.help ? html`<span class="hint">${s.help}</span>` : ""}</label>`
      : html`<label class="field"><span class="label">${s.label} (<code>${s.key}</code>)</span><input type="text" name="${s.key}" value="${v ?? ""}" placeholder="${s.help ?? ""}" maxlength="2000" spellcheck="false">${s.help ? html`<span class="hint">${s.help}</span>` : ""}</label>`;
  })}</div>
  <div class="buttons"><button type="submit" class="primary" data-busy="Saving">Save settings</button></div>
</form>`;
}

/** The settings a pack's manifest lists, a valid key each. */
export const manifestSettings = (m: PackManifest | undefined): PackSetting[] => (Array.isArray(m?.settings) ? m.settings.filter((s) => s && typeof s.key === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(s.key)) : []);

/** Settings → Packs → a pack: its manifest's settings, set or missing, and (on a machine) the form that keeps them in `.dev.vars`. */
export function manifestPanel(id: string, settings: PackSetting[], env: PacksView["env"], hosted: boolean, session = false) {
  return Panel({
    title: "Its settings",
    id: "manifest",
    meta: hosted ? "set as the Worker's vars and secrets" : session ? "kept in memory for this session" : "kept in .dev.vars",
    children: html`${List(settings.map((s) => settingItem(s, env)))}${hosted ? "" : settingsForm(id, settings, env)}`,
  });
}

function packPanel(m: PackManifest | undefined, id: string, name: string, o: { pack?: Pack; why?: string }, v: PacksView) {
  const r = v.refreshes?.get(id);
  const settings = manifestSettings(m);
  const pairs: [Child, Child][] = [];
  // One switch per pack (#271): a pack that can run is on or off here; one that can't says why.
  const by = v.held?.get(id);
  const hidden = !!o.pack && (!!v.hidden?.includes(id) || (!!by && by !== id));
  // Off with a pack it requires: its own switch can't turn it on, that pack's can.
  const heldBy = !!o.pack && !!by && by !== id ? (v.on.find((c) => c.manifest.id === by)?.manifest.name ?? by) : undefined;
  const on = !!o.pack && !hidden;
  if (o.why) pairs.push(["Off", o.why]);
  if (heldBy) pairs.push(["Off", `needs ${heldBy}, which is switched off here`]);
  else if (hidden) pairs.push(["Off", "switched off here"]);
  if (typeof m?.version === "string" && SEMVER.test(m.version)) pairs.push(["Version", `${m.version} · needs core API ${apiText(parseApi(m.api) ?? { major: 0, minor: 0 })}`]);
  if (m) pairs.push(["Runs", `${WHERE[m.execution ?? "any"] ?? m.execution} · ${m.domain}${v.core?.includes(id) ? " · Dovre's own" : ""}`]);
  if (o.pack) {
    pairs.push(["Answers", hooksOf(o.pack).join(", ") || "nothing yet"]);
    pairs.push(["Bino hears", binoOf(o.pack)]);
    pairs.push(["Refresh", refreshLine(o.pack, r, v.hosted)]);
  }
  const cron = m && cronLine(m, o.pack, r);
  if (cron) pairs.push(["Cron", cron]);
  if (m?.requiredBindings?.length) pairs.push(["Bindings", m.requiredBindings.join(", ")]);
  if (m?.requiredBinaries?.length) pairs.push(["Needs on PATH", m.requiredBinaries.join(", ")]);
  const requires = requiresOf(m);
  if (requires.length) pairs.push(["Requires", requires.map((r) => v.on.find((c) => c.manifest.id === r)?.manifest.name ?? v.off.find((x) => x.id === r)?.name ?? r).join(", ")]);
  const copy = v.copies?.get(id);
  if (copy) pairs.push(["Copy", copyLine(copy)]);
  const out = v.releases?.available.get(id);
  if (out) pairs.push(["Release", releaseLine(out)]);
  return Panel({
    id: `pack-${id}`,
    title: name,
    meta: id,
    actions: html`${on ? Pill({ tone: "ok", children: "on" }) : Pill({ tone: "warn", children: "off" })}${o.pack && !heldBy ? Post({ action: `/packs/${encodeURIComponent(id)}/switch`, fields: { on: on ? "" : "1" }, label: on ? "Turn off" : "Turn on" }) : ""}`,
    children: html`${m?.description ? html`<p class="t2">${m.description}</p>` : ""}${KeyValues(pairs)}${settings.length ? List(settings.map((s) => settingItem(s, v.env))) : ""}${copy ? copyJob(copy, v) : ""}${out ? releaseNotes(id, out) : ""}${settings.length ? html`<p class="t2"><a href="/settings/packs/${encodeURIComponent(id)}">Change them on Settings</a></p>` : ""}`,
  });
}

/** The packs on and off, the fun ones (domain "fun") or the rest. */
const panels = (v: PacksView, fun: boolean) =>
  html`${v.on.filter((c) => (c.manifest.domain === "fun") === fun).map((c) => packPanel(c.manifest, c.manifest.id, c.manifest.name, { pack: c }, v))}${v.off.filter((o) => (o.manifest?.domain === "fun") === fun).map((o) => packPanel(o.manifest, o.id, o.name, { why: o.why }, v))}`;

export function packsPage(frame: Frame, v: PacksView) {
  const hidden = v.on.filter((c) => v.hidden?.includes(c.manifest.id) || v.held?.has(c.manifest.id)).length;
  const body = html`${PageHeader({ title: "Packs", sub: `${v.on.length - hidden} on, ${v.off.length + hidden} off · ${v.hosted ? "hosted" : "this machine"}. Each is one app Dovre works with, listed in this instance's config, or one of Dovre's own.` })}
<div data-live id="packs">
${v.hosted && v.releases ? html`<p class="t3">${v.releases.error ? html`Couldn't read dovre-packs' releases: ${v.releases.error}` : html`Checked dovre-packs for newer releases ${Ago(v.releases.at)}${v.releases.available.size ? "" : ": none"}.`}</p>` : ""}
${v.on.length || v.off.length
  ? html`${panels(v, false)}${v.on.some((c) => c.manifest.domain === "fun") || v.off.some((o) => o.manifest?.domain === "fun") ? html`<p class="eyebrow">Fun</p><p class="t2">For the fun of it: nothing in Dovre needs these.</p>${panels(v, true)}` : ""}`
  : Panel({ children: Empty({ title: "No packs here", children: html`<p class="t2">${v.hosted ? "This Worker bundles none." : "PACKS lists none on this machine."}</p>` }) })}
</div>`;
  return shell({ title: "Packs · Dovre", frame, current: "/packs", body, head: html`<meta name="u-topics" content="packs">` });
}
