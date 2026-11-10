/**
 * Packs: every pack this instance lists, on or off here and why, how its refreshes and cron runs
 * went, and its settings, a secret one only as set or missing (never its value).
 */
import { type KeyState, STORES } from "../secretrefs.ts";
import { html } from "hono/html";
import { AGENT_MINUTES, type AiGrant, MAX_DAY_USD, MAX_RUN_USD, MAX_TURNS } from "../packs/ai.ts";
import { type Frame, shell } from "../html.ts";
import { hooksOf } from "../packs/hooks.ts";
import { binoOf, type Off, type Refreshes, type RefreshState, requiresOf } from "../packs/registry.ts";
import type { Copy, ToAdd } from "../packs/copies.ts";
import type { Available } from "../packs/releases.ts";
import type { Pack, PackAgentWhere, PackAiAsk, PackManifest, PackSetting } from "../packs/types.ts";
import { type Child, Confirm, Empty, Item, KeyValues, List, Notice, PageHeader, Panel, Pill, Post } from "../ui/kit.ts";
import { Ago, safeUrl } from "./parts.ts";
import { apiText, parseApi } from "../packs/api.ts";
import { namedKeys } from "../packs/env.ts";

/** A pack's own version, as dovre-packs releases it (x.y.z). */
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** A secret setting's store, or why it can't be read. */
type KeyLookup = (key: string) => KeyState | undefined;

type PacksView = { /** The forge's name ("GitHub"): the packs `via: "forge"` are listed under it (#432). */ forge?: string; /** Packs with a setup page (#418): its id → whether steps are left. */ setups?: Map<string, boolean>; on: Pack[]; off: Off[]; env: Record<string, string | undefined>; /** Settings a pack read that aren't its own (#475), by its id: names only. */ alsoReads?: (id: string) => string[]; hosted: boolean; refreshes?: Refreshes; now?: number; /** Ids of Dovre's own packs. */ core?: string[]; /** Local: the packs copied from dovre-packs, against its checkout (src/packs/copies.ts). */ copies?: Map<string, Copy>; canRestart?: boolean; /** Packs switched off here (Settings → Layout's list, the same switch). */ hidden?: string[]; /** Off with a switched-off pack it requires (#326): its id → that pack's id. */ held?: Map<string, string>; /** Hosted (#362): newer releases from dovre-packs' tags, when last read (src/packs/releases.ts). */ releases?: { at: number; available: Map<string, Available>; error?: string }; /** dovre-packs' packs this instance doesn't list (#88), and locally the folder Add writes into. */ toAdd?: { packs: ToAdd[]; into?: string }; /** Where each secret setting's key came from, or why it can't be read (#416, hosted #428). */ keys?: KeyLookup };

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

/** A setting: its label and key, set or missing; a non-secret one's value beside it; a secret one's store, or why it can't be read. */
function settingItem(s: PackSetting, env: PacksView["env"], keys?: KeyLookup) {
  const v = env[s.key]?.trim();
  const k = s.secret ? keys?.(s.key) : undefined;
  const unread = k && "unread" in k ? k.unread : undefined;
  const state = unread
    ? Pill({ tone: "bad", children: "can't read the key" })
    : v
      ? Pill({ tone: "ok", children: "set" })
      : Pill({ tone: s.required ? "bad" : undefined, children: s.required ? "missing, needed" : "not set" });
  const label = s.choices?.find((c) => c.value === v)?.label;
  const shown = v && !s.secret ? (label ? html` ${label}` : html` <code>${v.length > 80 ? `${v.slice(0, 80)}…` : v}</code>`) : "";
  const from = k && "from" in k ? ` · from ${STORES[k.from]}` : "";
  return Item({ title: html`${s.label} ${state}`, line: html`<code>${s.key}</code>${s.secret ? " · secret" : ""}${from}${shown}`, clamp: unread ?? s.help });
}

/** What a secret field takes (#416). */
const KEY_HINT = "The key, or where it lives: op://…, an Azure Key Vault URL, an AWS ARN or aws://…, projects/…/secrets/…, bw://…. A pasted key goes to the Keychain.";

/** Local editor for a pack's manifest settings (never renders existing secret values). */
function settingsForm(id: string, settings: PackSetting[], env: PacksView["env"]) {
  return html`<form method="post" action="/packs/${encodeURIComponent(id)}/settings">
  <div class="fields aligned">${settings.map((s) => {
    const v = env[s.key]?.trim();
    if (s.choices)
      return html`<label class="field"><span class="label">${s.label} (<code>${s.key}</code>)</span><select name="${s.key}"><option value=""${v ? "" : " selected"}>Its default</option>${s.choices.map((c) => html`<option value="${c.value}"${v === c.value ? " selected" : ""}>${c.label}</option>`)}</select>${s.help ? html`<span class="hint">${s.help}</span>` : ""}</label>`;
    return s.secret
      ? html`<label class="field"><span class="label">${s.label} (<code>${s.key}</code>)</span><input type="password" name="${s.key}" value="" placeholder="${v ? "(set — leave blank to keep)" : s.help ?? ""}" maxlength="2000" spellcheck="false" autocomplete="off">${v ? html`<label class="check"><input type="checkbox" name="clear.${s.key}" value="1"> Clear saved secret</label>` : ""}<span class="hint">${s.help ? html`${s.help} ` : ""}${KEY_HINT}</span></label>`
      : html`<label class="field"><span class="label">${s.label} (<code>${s.key}</code>)</span><input type="text" name="${s.key}" value="${v ?? ""}" placeholder="${s.help ?? ""}" maxlength="2000" spellcheck="false">${s.help ? html`<span class="hint">${s.help}</span>` : ""}</label>`;
  })}</div>
  <div class="buttons"><button type="submit" class="primary" data-busy="Saving">Save settings</button></div>
</form>`;
}

/** The settings a pack's manifest lists, a valid key each. */
export const manifestSettings = (m: PackManifest | undefined): PackSetting[] =>
  Array.isArray(m?.settings) ? m.settings.filter((s) => s && typeof s.key === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(s.key)).map((s) => withChoices(s)) : [];

/** Its choices after the checks (API 1.15): a value of letters, digits and . _ : - each once, a one-line label, 20 at most; none for a secret. */
function withChoices(s: PackSetting): PackSetting {
  const { choices, ...rest } = s;
  if (!Array.isArray(choices) || s.secret) return rest;
  const seen = new Set<string>();
  const ok = choices
    .filter((c) => c && typeof c.value === "string" && /^[\w.:-]{1,64}$/.test(c.value) && typeof c.label === "string" && !seen.has(c.value) && !!seen.add(c.value))
    .map((c) => ({ value: c.value, label: c.label.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80) || c.value }))
    .slice(0, 20);
  return ok.length ? { ...rest, choices: ok } : rest;
}

/** Settings → Packs → a pack: its manifest's settings, set or missing, and (on a machine) the form that keeps them in `.dev.vars`. */
export function manifestPanel(id: string, settings: PackSetting[], env: PacksView["env"], hosted: boolean, session = false, keys?: KeyLookup) {
  // Read again: any of its keys from a store (#416).
  const stored = settings.some((s) => s.secret && keys?.(s.key));
  return Panel({
    title: "Its settings",
    id: "manifest",
    meta: hosted ? "set as the Worker's vars and secrets" : session ? "kept in memory for this session" : "kept in .dev.vars",
    children: html`${List(settings.map((s) => settingItem(s, env, keys)))}${stored ? html`<form method="post" action="/packs/${encodeURIComponent(id)}/keys"><div class="buttons"><button type="submit" data-busy="Reading">Read the keys again</button></div></form>` : ""}${hosted ? "" : settingsForm(id, settings, env)}`,
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
  if (m?.binaries?.length) pairs.push(["May run", m.binaries.join(", ")]);
  const named = m ? namedKeys(m, v.env) : [];
  if (named.length) pairs.push(["Reads by name", named.join(", ")]);
  const also = v.alsoReads?.(id) ?? [];
  if (also.length) pairs.push(["Also reads", also.join(", ")]);
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
    actions: html`${on && v.setups?.has(id) ? html`<a class="btn sm ghost" href="/setup/${encodeURIComponent(id)}">${v.setups.get(id) ? "Set up" : "Set up again"}</a>` : ""}${on ? Pill({ tone: "ok", children: "on" }) : Pill({ tone: "warn", children: "off" })}${o.pack && !heldBy ? Post({ action: `/packs/${encodeURIComponent(id)}/switch`, fields: { on: on ? "" : "1" }, label: on ? "Turn off" : "Turn on" }) : ""}`,
    children: html`${m?.description ? html`<p class="t2">${m.description}</p>` : ""}${KeyValues(pairs)}${settings.length ? List(settings.map((s) => settingItem(s, v.env, v.keys))) : ""}${copy ? copyJob(copy, v) : ""}${out ? releaseNotes(id, out) : ""}${settings.length ? html`<p class="t2"><a href="/settings/packs/${encodeURIComponent(id)}">Change them on Settings</a></p>` : ""}`,
  });
}

/** Which group a pack is listed in: the fun ones (domain "fun"), the forge's (#432), or the rest. */
type Group = "fun" | "forge" | "rest";
const groupOf = (m: PackManifest | undefined): Group => (m?.domain === "fun" ? "fun" : m?.via === "forge" ? "forge" : "rest");

/** The packs on and off in one group. */
const panels = (v: PacksView, g: Group) =>
  html`${v.on.filter((c) => groupOf(c.manifest) === g).map((c) => packPanel(c.manifest, c.manifest.id, c.manifest.name, { pack: c }, v))}${v.off.filter((o) => groupOf(o.manifest) === g).map((o) => packPanel(o.manifest, o.id, o.name, { why: o.why }, v))}`;

const has = (v: PacksView, g: Group) => v.on.some((c) => groupOf(c.manifest) === g) || v.off.some((o) => groupOf(o.manifest) === g);

/** One pack to add: what it is, where it runs, and (on a machine) Add and how it went. */
function addItem(p: ToAdd, v: PacksView, into: string | undefined) {
  const cant = v.hosted ? p.execution === "local-only" : p.execution === "hosted-only";
  const j = p.job;
  const job = !j
    ? ""
    : j.state === "running"
      ? html`<p>${Pill({ tone: "accent", children: "adding" })} <span class="t2">${j.step}</span></p>`
      : j.state === "done"
        ? html`<p>${Pill({ tone: "ok", children: v.hosted ? "PR opened" : "added" })} ${j.url ? html`<a href="${safeUrl(j.url)}">${j.url.replace(/^https:\/\/[^/]+\//, "")}</a> · ` : ""}${j.step}</p>${!v.hosted && v.canRestart ? Post({ action: "/settings/restart", label: "Restart Dovre" }) : ""}`
        : html`<p>${Pill({ tone: "bad", children: "not added" })} <span class="t2">${j.step}</span></p>${j.out ? html`<details><summary class="t2">Output</summary><pre>${j.out}</pre></details>` : ""}`;
  const can = !!into && !p.needsCore && !cant && j?.state !== "running" && j?.state !== "done";
  const question = v.hosted
    ? html`Open a PR on <code>${into}</code> that adds ${p.name}${p.version ? ` ${p.version}` : ""} from dovre-packs to its packs.ts? It loads once you merge it and deploy.`
    : html`Copy ${p.name}${p.version ? ` ${p.version}` : ""} from dovre-packs into <code>${into}</code> and list it in its packs.ts? Then the instance's typecheck and tests run, and it's taken out again if either fails.`;
  const how = can
    ? Confirm({ action: `/packs/${encodeURIComponent(p.id)}/add`, label: v.hosted ? "Add (opens a PR)" : "Add", kind: "packs.add", question })
    : v.hosted && !into && !cant
      ? html`<p class="t3">Add it in the instance repo with <code>pnpm packs add ${p.id}</code>, then deploy.</p>`
      : "";
  const notes: Child[] = [];
  if (p.needsCore) notes.push(html`<span class="t2">needs core API ${p.api}: update Dovre first</span>`);
  if (cant) notes.push(html`<span class="t2">runs ${WHERE[p.execution]}</span>`);
  return Item({
    id: `add-${p.id}`,
    title: html`${p.name} ${p.version ? Pill({ children: p.version }) : Pill({ tone: "warn", children: "no release yet" })}`,
    line: html`<code>${p.id}</code> · ${WHERE[p.execution]} · ${p.domain}${notes.map((n) => html` · ${n}`)}`,
    clamp: p.description || undefined,
    more: html`${job}${how}`,
  });
}

/** dovre-packs' packs this instance doesn't list yet (#88). */
function addPanel(v: PacksView) {
  const t = v.toAdd;
  if (!t?.packs.length) return "";
  return Panel({
    id: "add",
    title: "Add from dovre-packs",
    meta: `${t.packs.length} not here`,
    children: html`${v.hosted
      ? t.into
        ? html`<p class="t2">Add opens a PR on <code>${t.into}</code>; merge it and deploy to load the pack.</p>`
        : html`<p class="t2">Set the var <code>INSTANCE_REPO</code> (the instance's <code>owner/name</code>, one of the owners') and give the GitHub token contents and pull-request write on it, to add from here.</p>`
      : t.into
        ? html`<p class="t2">Added packs go into <code>${t.into}</code>.</p>`
        : html`<p class="t2">PACKS lists no instance folder with a packs.ts, so there's nowhere to add a pack.</p>`}${List(t.packs.map((p) => addItem(p, v, t.into)))}`,
  });
}

export function packsPage(frame: Frame, v: PacksView) {
  const hidden = v.on.filter((c) => v.hidden?.includes(c.manifest.id) || v.held?.has(c.manifest.id)).length;
  const body = html`${PageHeader({ title: "Packs", sub: `${v.on.length - hidden} on, ${v.off.length + hidden} off · ${v.hosted ? "hosted" : "this machine"}. Each is one app Dovre works with, listed in this instance's config, or one of Dovre's own.`, actions: html`<a class="btn sm ghost" href="/welcome?at=role">Suggest packs again</a>` })}
<div data-live id="packs">
${v.hosted && v.releases ? html`<p class="t3">${v.releases.error ? html`Couldn't read dovre-packs' releases: ${v.releases.error}` : html`Checked dovre-packs for newer releases ${Ago(v.releases.at)}${v.releases.available.size ? "" : ": none"}.`}</p>` : ""}
${v.on.length || v.off.length
  ? html`${panels(v, "rest")}${has(v, "forge") ? html`<p class="eyebrow">${v.forge ?? "The forge"}</p><p class="t2">Read and written through ${v.forge ?? "the forge"}, each with its own switch.</p>${panels(v, "forge")}` : ""}${has(v, "fun") ? html`<p class="eyebrow">Fun</p><p class="t2">For the fun of it: nothing in Dovre needs these.</p>${panels(v, "fun")}` : ""}`
  : Panel({ children: Empty({ title: "No packs here", children: html`<p class="t2">${v.hosted ? "This Worker bundles none." : "PACKS lists none on this machine."}</p>` }) })}
${addPanel(v)}
</div>`;
  return shell({ title: "Packs · Dovre", frame, current: "/packs", body, head: html`<meta name="u-topics" content="packs">` });
}

/** What a pack may ask the model (#466): what it wants and why, my grant, and today's spend. */
const PLACES: Record<PackAgentWhere, { label: string; hint: string }> = {
  read: { label: "Read", hint: "Plan mode in its checkout: it reads, it changes nothing." },
  sandbox: { label: "Sandbox", hint: "A fresh clone in a container, host-only network: it may edit and commit there. Its commits reach the forge only as a draft PR you confirm." },
};

const sel = (on: boolean) => (on ? " selected" : "");
const tick = (on: boolean) => (on ? " checked" : "");

export function aiPanel(id: string, o: { ask: PackAiAsk; grant: AiGrant; spent: number; route?: string; hosted: boolean; /** Agents can run here. */ agents: boolean; /** Claude Code is here, for MCP calls. */ mcp: boolean }) {
  const g = o.grant;
  const a = o.ask.agent;
  const m = o.ask.mcp;
  const mcpWrites = Object.keys(m?.writes ?? {});
  const mcpState = !m || o.hosted ? "" : g.mcp ? `MCP calls: allowed${o.mcp ? "" : ", but Claude Code isn't on this machine"}.` : "MCP calls: not allowed.";
  const mcpField = m
    ? html`<div class="field"><span class="label">MCP calls</span><label class="check"><input type="checkbox" name="mcp" value="on"${tick(g.mcp)}> To <code>${m.server.name}</code></label><span class="hint">Through Claude Code's sign-in to ${m.server.url}: only the tools named above, with exactly the arguments the pack gives. Each job counts against the day's dollars.</span></div>`
    : "";
  const mcpWhy = m ? html`<p class="notes">MCP calls to <code>${m.server.name}</code>${m.reads?.length ? html`, reading with ${m.reads.join(", ")}` : ""}${mcpWrites.length ? html`, writing with ${mcpWrites.join(", ")}` : ""}. Why: ${m.why}</p>` : "";
  const state = o.hosted
    ? "Not hosted yet: packs ask a model only on a machine."
    : g.level === "off"
      ? "Not allowed."
      : g.level === "agent"
        ? `Allowed: agent turns${g.where.length ? ` (${g.where.join(" and ")})` : ", but nowhere to run yet"}, ${g.size === "any" ? "any size" : "the small model only"}.${o.agents ? "" : " Agents can't run here."}`
        : !o.route
          ? "No model here for packs: Settings → Work → Model for packs."
          : `Allowed: text, ${g.size === "any" ? "any size" : "the small model only"}, through ${o.route}.`;
  const why = html`${o.ask.text ? html`<p class="notes">Text: a prompt in, text out, no tools and no files. Why: ${o.ask.text.why}</p>` : ""}${a ? html`<p class="notes">Agent turns in your repos (${a.where.join(", ")}). Why: ${a.why}</p>` : ""}`;
  const agentFields = a
    ? html`<div class="field"><span class="label">Where</span>${a.where.map((w) => html`<label class="check"><input type="checkbox" name="where_${w}" value="on"${tick(g.where.includes(w))}> ${PLACES[w].label}</label><span class="hint">${PLACES[w].hint}</span>`)}</div>
    <label class="field"><span class="label">Repos</span><select name="reposAll"><option value="named"${sel(g.repos !== "mine")}>Only these</option><option value="mine"${sel(g.repos === "mine")}>All of mine</option></select><input type="text" name="repos" value="${g.repos === "mine" ? "" : g.repos.join(", ")}" placeholder="owner/name, owner/name" maxlength="2000" spellcheck="false"><span class="hint">Repos outside your owners are refused either way.</span></label>
    ${a.tools?.length ? html`<div class="field"><span class="label">Other packs' tools</span>${a.tools.map((t) => html`<label class="check"><input type="checkbox" name="tool_${t}" value="on"${tick(g.tools.includes(t))}> <code>${t}</code></label>`)}<span class="hint">Its own tools it always has. A tool that asks for approval is refused: nobody is there to answer.</span></div>` : ""}
    <label class="field"><span class="label">Dollars a run</span><input type="number" name="runUsd" min="0.01" max="${MAX_RUN_USD}" step="0.01" value="${g.runUsd}"><span class="hint">Held against the day's dollars while it runs.</span></label>
    <label class="field"><span class="label">Turns a run</span><input type="number" name="turns" min="1" max="${MAX_TURNS}" step="1" value="${g.turns}"><span class="hint">And at most ${AGENT_MINUTES} minutes.</span></label>`
    : "";
  return Panel({
    title: "AI",
    id: "ai",
    meta: g.level === "off" && !g.mcp ? "off" : `$${o.spent.toFixed(2)} of $${g.dayUsd.toFixed(2)} today`,
    children: html`${why}${mcpWhy}<p class="t2">${o.ask.text || a || !mcpState ? state : ""} ${mcpState}</p>${o.hosted
      ? ""
      : html`<form method="post" action="/settings/packs/${encodeURIComponent(id)}/ai">
  <div class="fields aligned">
    ${o.ask.text || a ? html`<label class="field"><span class="label">May ask</span><select name="level"><option value="off"${sel(g.level === "off")}>Nothing</option>${o.ask.text ? html`<option value="text"${sel(g.level === "text")}>Text</option>` : ""}${a ? html`<option value="agent"${sel(g.level === "agent")}>${o.ask.text ? "Text and agent turns" : "Agent turns"}</option>` : ""}</select></label>
    <label class="field"><span class="label">Model</span><select name="size"><option value="small"${sel(g.size === "small")}>The small one only</option><option value="any"${sel(g.size === "any")}>Any it asks for</option></select><span class="hint">Small is Haiku through Claude Code; other routes use their own model. Agent turns are Claude Code: Haiku, or Sonnet for large.</span></label>` : ""}
    <label class="field"><span class="label">Dollars a day</span><input type="number" name="dayUsd" min="0" max="${MAX_DAY_USD}" step="0.01" value="${g.dayUsd}"><span class="hint">Once they're spent, it can't ask again until tomorrow. Copilot routes cost $0 here.</span></label>
    ${agentFields}
    ${mcpField}
  </div>
  <div class="buttons"><button type="submit" class="primary" data-busy="Saving">Save</button></div>
</form>`}`,
  });
}
