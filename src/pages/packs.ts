/**
 * Packs: every pack this instance lists, on or off here and why, how its refreshes and cron runs
 * went, and its settings, a secret one only as set or missing (never its value).
 */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import { hooksOf, type Off, type Refreshes, type RefreshState } from "../packs/registry.ts";
import type { Pack, PackManifest, PackSetting } from "../packs/types.ts";
import { type Child, Empty, Item, KeyValues, List, Notice, PageHeader, Panel, Pill } from "../ui/kit.ts";
import { Ago } from "./parts.ts";

export type PacksView = { on: Pack[]; off: Off[]; env: Record<string, string | undefined>; hosted: boolean; refreshes?: Refreshes; now?: number; /** Ids of Dovre's own packs. */ core?: string[]; saved?: string };

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

/** A setting: its label and key, set or missing; a non-secret one's value beside it. */
function settingItem(s: PackSetting, env: PacksView["env"]) {
  const v = env[s.key]?.trim();
  const state = v ? Pill({ tone: "ok", children: "set" }) : Pill({ tone: s.required ? "bad" : undefined, children: s.required ? "missing, needed" : "not set" });
  const shown = v && !s.secret ? html` <code>${v.length > 80 ? `${v.slice(0, 80)}…` : v}</code>` : "";
  return Item({ title: html`${s.label} ${state}`, line: html`<code>${s.key}</code>${s.secret ? " · secret" : ""}${shown}`, clamp: s.help });
}

/** Local editor for a pack's manifest settings (never renders existing secret values). */
function settingsForm(id: string, settings: PackSetting[], env: PacksView["env"], openByDefault: boolean) {
  return html`<details${openByDefault ? html` open` : ""}><summary class="t2">Configure in <code>.dev.vars</code></summary>
<form method="post" action="/packs/${encodeURIComponent(id)}/settings">
  <div class="fields">${settings.map((s) => {
    const v = env[s.key]?.trim();
    return s.secret
      ? html`<label class="field"><span class="label">${s.label} (<code>${s.key}</code>)</span><input type="password" name="${s.key}" value="" placeholder="${v ? "(set — leave blank to keep)" : s.help ?? ""}" maxlength="2000" spellcheck="false" autocomplete="off">${v ? html`<label class="check"><input type="checkbox" name="clear.${s.key}" value="1"> Clear saved secret</label>` : ""}${s.help ? html`<span class="hint">${s.help}</span>` : ""}</label>`
      : html`<label class="field"><span class="label">${s.label} (<code>${s.key}</code>)</span><input type="text" name="${s.key}" value="${v ?? ""}" placeholder="${s.help ?? ""}" maxlength="2000" spellcheck="false">${s.help ? html`<span class="hint">${s.help}</span>` : ""}</label>`;
  })}</div>
  <div class="buttons"><button type="submit" class="primary" data-busy="Saving">Save settings</button></div>
</form></details>`;
}

function packPanel(m: PackManifest | undefined, id: string, name: string, o: { pack?: Pack; why?: string }, v: PacksView) {
  const r = v.refreshes?.get(id);
  const settings = Array.isArray(m?.settings) ? m.settings.filter((s) => s && typeof s.key === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(s.key)) : [];
  const pairs: [Child, Child][] = [];
  if (o.why) pairs.push(["Off", o.why]);
  if (m) pairs.push(["Runs", `${WHERE[m.execution ?? "any"] ?? m.execution} · ${m.domain}${v.core?.includes(id) ? " · Dovre's own" : ""}`]);
  if (o.pack) {
    pairs.push(["Answers", hooksOf(o.pack).join(", ") || "nothing yet"]);
    pairs.push(["Refresh", refreshLine(o.pack, r, v.hosted)]);
  }
  const cron = m && cronLine(m, o.pack, r);
  if (cron) pairs.push(["Cron", cron]);
  if (m?.requiredBindings?.length) pairs.push(["Bindings", m.requiredBindings.join(", ")]);
  if (m?.requiredBinaries?.length) pairs.push(["Needs on PATH", m.requiredBinaries.join(", ")]);
  const missingSetting = !!o.why && /isn't set$/.test(o.why);
  return Panel({
    id: `pack-${id}`,
    title: name,
    meta: id,
    actions: o.pack ? Pill({ tone: "ok", children: "on" }) : Pill({ tone: "warn", children: "off" }),
    children: html`${m?.description ? html`<p class="t2">${m.description}</p>` : ""}${KeyValues(pairs)}${settings.length ? List(settings.map((s) => settingItem(s, v.env))) : ""}${!v.hosted && settings.length ? settingsForm(id, settings, v.env, missingSetting) : ""}`,
  });
}

/** The packs on and off, the fun ones (domain "fun") or the rest. */
const panels = (v: PacksView, fun: boolean) =>
  html`${v.on.filter((c) => (c.manifest.domain === "fun") === fun).map((c) => packPanel(c.manifest, c.manifest.id, c.manifest.name, { pack: c }, v))}${v.off.filter((o) => (o.manifest?.domain === "fun") === fun).map((o) => packPanel(o.manifest, o.id, o.name, { why: o.why }, v))}`;

export function packsPage(frame: Frame, v: PacksView) {
  const body = html`${PageHeader({ title: "Packs", sub: `${v.on.length} on, ${v.off.length} off · ${v.hosted ? "hosted" : "this machine"}. Each is one app Dovre works with, listed in this instance's config, or one of Dovre's own.` })}
${v.saved ? Notice({ tone: "ok", children: html`Saved settings for <strong>${v.saved}</strong>.` }) : ""}
<div data-live id="packs">
${v.on.length || v.off.length
  ? html`${panels(v, false)}${v.on.some((c) => c.manifest.domain === "fun") || v.off.some((o) => o.manifest?.domain === "fun") ? html`<p class="eyebrow">Fun</p><p class="t2">For the fun of it: nothing in Dovre needs these. Hide one on Settings → Layout.</p>${panels(v, true)}` : ""}`
  : Panel({ children: Empty({ title: "No packs here", children: html`<p class="t2">${v.hosted ? "This Worker bundles none." : "PACKS lists none on this machine."}</p>` }) })}
</div>`;
  return shell({ title: "Packs · Dovre", frame, current: "/packs", body, head: html`<meta name="u-topics" content="packs">` });
}
