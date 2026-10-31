/**
 * Which packs run here, and the core's side of each hook (PLAN D23). Every hook is isolated: a
 * pack that throws or is slow shows as such, and never takes a page, a cron run or another pack
 * down with it.
 */
import type { Need } from "../home/needs.ts";
import { safeUrl } from "../pages/parts.ts";
import type { Html } from "../ui/kit.ts";
import type { Note } from "../notify.ts";
import type { ActSpec } from "./core/assistant/bino/acts.ts";
import { type LookupSpec, resultOf } from "./core/assistant/bino/lookups.ts";
import { type ActDone, type ActKind, type LookupKind, type Bit, type Pack, PACK_API, type PackContext, type PackManifest, type PackNote, type PackStat, type Pulse, type StatUnit, type Dock, type Glance, type Lane, type RingDecl, type SlotMap, type SlotName, type TodayCard } from "./types.ts";

/**
 * A pack that doesn't run here, and why; its manifest when it had a readable one (the Packs page
 * shows its settings). `needs`: off only because these packs it requires are, so it comes back with them.
 */
export type Off = { id: string; name: string; why: string; manifest?: PackManifest; pack?: Pack; needs?: string[] };
export type Active = { on: Pack[]; off: Off[] };

export type ActiveOpts = {
  env: Record<string, string | undefined>;
  /** The Worker's bindings (hosted); empty locally. */
  bindings?: Record<string, unknown>;
  hosted: boolean;
  /** Is this CLI on PATH (local)? */
  which?: (bin: string) => string | undefined;
};

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const OFF = /^(off|false|no|0)$/i;
/** A pack's id as its switch names it: PACK_<ID> (CRATE_<ID>, its name before WP-M4, still read). */
const envId = (id: string) => id.toUpperCase().replace(/-/g, "_");

/** Sorts packs into those that run here and those that don't, each with its reason. */
export function activePacks(packs: Pack[], opts: ActiveOpts): Active {
  const on: Pack[] = [];
  const off: Off[] = [];
  const seen = new Set<string>();
  for (const c of packs) {
    const m = c.manifest;
    const no = (why: string) => off.push({ id: m?.id ?? "?", name: m?.name ?? m?.id ?? "?", why, ...(m && typeof m === "object" ? { manifest: m } : {}) });
    if (!m || !ID.test(m.id)) no("its id isn't lowercase letters, digits and dashes");
    else if (seen.has(m.id)) no("another pack has the same id");
    else if (m.api !== PACK_API) no(`written for pack contract ${m.api ?? "?"}, this Dovre speaks ${PACK_API}`);
    else if (OFF.test((opts.env[`PACK_${envId(m.id)}`] ?? opts.env[`CRATE_${envId(m.id)}`] ?? "").trim())) no(`switched off in .dev.vars or the environment (PACK_${envId(m.id)}=off)`);
    else if (opts.hosted && m.execution === "local-only") no("runs only on a machine, not hosted");
    else if (!opts.hosted && m.execution === "hosted-only") no("runs only hosted (it needs the Worker's bindings)");
    else if (opts.hosted && m.requiredBindings?.some((b) => !(b in (opts.bindings ?? {})))) no(`missing binding ${m.requiredBindings.find((b) => !(b in (opts.bindings ?? {})))}`);
    else if (!opts.hosted && m.requiredBinaries?.some((b) => !opts.which?.(b))) no(`${m.requiredBinaries.find((b) => !opts.which?.(b))} isn't on PATH`);
    else if (m.settings?.some((s) => s.required && !opts.env[s.key]?.trim())) off.push({ id: m.id, name: m.name ?? m.id, why: `${m.settings.find((s) => s.required && !opts.env[s.key]?.trim())!.key} isn't set`, manifest: m, pack: c });
    else {
      seen.add(m.id);
      on.push(c);
      continue;
    }
    if (m && ID.test(m.id)) seen.add(m.id);
  }
  const active = { on, off };
  settleRequires(active);
  return active;
}

/** The packs a manifest requires: valid ids, each once, itself left out. */
export const requiresOf = (m: PackManifest | undefined): string[] =>
  Array.isArray(m?.requires) ? [...new Set(m.requires.filter((r): r is string => typeof r === "string" && ID.test(r) && r !== m.id))] : [];

/**
 * Packs that require others (#326), settled after any change to what's on: a pack off only for
 * its required packs (`needs`) comes back once they're all on; an on pack whose required pack
 * isn't on goes off, saying which (a chain falls together, a loop stays off); and `on` is put in
 * order, each after what it requires, the rest as they were. Changes the lists in place (the
 * refresher holds `on`). Returns the packs that came back, for the caller to start.
 */
export function settleRequires(active: Active): Pack[] {
  const back: Pack[] = [];
  for (const o of [...active.off]) {
    if (!o.needs || !o.pack) continue;
    active.off.splice(active.off.indexOf(o), 1);
    active.on.push(o.pack);
    back.push(o.pack);
  }
  const placed: Pack[] = [];
  const ids = new Set<string>();
  let rest = [...active.on];
  for (let moved = true; moved; ) {
    moved = false;
    for (const c of [...rest]) {
      if (!requiresOf(c.manifest).every((r) => ids.has(r))) continue;
      placed.push(c);
      ids.add(c.manifest.id);
      rest = rest.filter((x) => x !== c);
      moved = true;
    }
  }
  const nameOf = (id: string) => active.on.find((c) => c.manifest.id === id)?.manifest.name ?? active.off.find((o) => o.id === id)?.name;
  for (const c of rest) {
    const needs = requiresOf(c.manifest).filter((r) => !ids.has(r));
    const r = needs[0]!;
    const name = nameOf(r);
    const pending = rest.some((x) => x.manifest.id === r);
    const why = !name ? `needs the ${r} pack, which isn't installed` : pending ? `needs ${name}, which can't run either` : `needs ${name}, which is off`;
    active.off.push({ id: c.manifest.id, name: c.manifest.name, why, manifest: c.manifest, pack: c, needs });
  }
  active.on.splice(0, active.on.length, ...placed);
  return back.filter((c) => placed.includes(c));
}

/**
 * Switched off on the Packs page (Settings → Layout's list), with what requires it: for each
 * pack that's off this way, the id of the switched-off pack that holds it (itself when it's switched off).
 */
export function heldOff(on: Pack[], switchedOff: string[]): Map<string, string> {
  const held = new Map<string, string>();
  for (const c of on) {
    const id = c.manifest.id;
    if (switchedOff.includes(id)) held.set(id, id);
    else {
      const by = requiresOf(c.manifest).find((r) => held.has(r));
      if (by) held.set(id, held.get(by)!);
    }
  }
  return held;
}

/** A hook's answer within `ms`, or why not. */
export async function within<T>(ms: number, run: () => T | Promise<T>): Promise<{ ok: true; value: T } | { ok: false; why: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`took longer than ${ms} ms`)), ms);
      }),
    ]);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, why: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/** The same synchronously, for hooks that must answer from memory (nav, pages). */
export function safely<T>(run: () => T, fallback: T, onError?: (e: unknown) => void): T {
  try {
    return run();
  } catch (e) {
    onError?.(e);
    return fallback;
  }
}

/** What every pack puts in one named place on a core page; a pack that throws puts nothing there. */
export type Fill = <K extends SlotName>(name: K, arg: SlotMap[K]["arg"]) => SlotMap[K]["out"][];

export function fillOf(on: () => Pack[], ctxOf: (c: Pack) => PackContext, log: (id: string, line: string) => void): Fill {
  return (name, arg) =>
    on().flatMap((c) => {
      if (!c.slots) return [];
      const out = safely(
        () => {
          const f = c.slots!(ctxOf(c))[name];
          return f ? [f(arg)] : [];
        },
        [],
        (e) => log(c.manifest.id, `slot ${name}: ${(e as Error)?.message ?? e}`),
      );
      return out;
    });
}

const RING = /^[a-z][a-z0-9-]{0,31}$/;
const TONES = new Set(["bad", "warn", "accent", "ok", "neutral"]);
const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
const oneLine = (v: unknown, n: number) => cut(v, n).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

/**
 * The kinds of notification the packs add (manifest rings), for Settings and the policy. A kind
 * that isn't lowercase, or that the core (`taken`) or an earlier pack has, is left out and logged.
 */
export function ringsOf(on: Pack[], taken: string[], log: (id: string, line: string) => void): (RingDecl & { pack: string })[] {
  const seen = new Set(taken);
  const out: (RingDecl & { pack: string })[] = [];
  for (const c of on)
    for (const r of c.manifest.rings ?? []) {
      if (!r || !RING.test(String(r.kind)) || seen.has(r.kind)) {
        log(c.manifest.id, `ring ${String(r?.kind).slice(0, 40)}: refused (not lowercase, or another has it)`);
        continue;
      }
      seen.add(r.kind);
      out.push({ pack: c.manifest.id, kind: r.kind, label: cut(r.label, 120) || r.kind, hint: cut(r.hint, 160) || undefined, ...(r.off === true ? { off: true } : {}) });
    }
  return out;
}

/** A pack's stat after the checks: ids under the pack's, text cut, numbers finite or left out. */
export type StatOut = { id: string; pack: string; packName: string; title: string; meta?: string; unit: StatUnit; empty?: string } & (
  | { kind: "chart"; chart: "columns" | "lines"; stacked: boolean; labels: string[]; tips: string[]; series: { name: string; values: (number | undefined)[] }[] }
  | { kind: "tile"; value?: number; note?: string; trend?: (number | undefined)[] }
);

const UNITS = new Set<StatUnit>(["count", "money", "hours", "days", "percent"]);
const STAT_ID = /^[a-z][a-z0-9-]{0,40}$/;
const nums = (v: unknown, n: number) => (Array.isArray(v) ? v.slice(0, n).map(num) : []);

/**
 * Every pack's panels for /stats (PackStat), checked: at most 12 a pack, ids under the pack's
 * (`<pack>:<id>`, unique), 60 labels, two series, text cut to size. A pack that throws adds nothing and is logged.
 */
export function statsFrom(on: Pack[], ctxOf: (c: Pack) => PackContext, weeks: number, log: (id: string, line: string) => void, days?: number): StatOut[] {
  return on.flatMap((c) => {
    if (!c.stats) return [];
    const pack = c.manifest.id;
    const got = safely(() => c.stats!(ctxOf(c), days ? { weeks, days } : { weeks }), [] as PackStat[], (e) => log(pack, `stats: ${(e as Error)?.message ?? e}`));
    if (!Array.isArray(got)) return [];
    const seen = new Set<string>();
    return got.slice(0, 12).flatMap((st): StatOut[] => {
      if (!st || typeof st.id !== "string" || !STAT_ID.test(st.id) || seen.has(st.id) || typeof st.title !== "string" || !st.title.trim()) return [];
      seen.add(st.id);
      const base = { id: `${pack}:${st.id}`, pack, packName: c.manifest.name, title: st.title.slice(0, 80), meta: cut(st.meta, 80) || undefined, unit: UNITS.has(st.unit as StatUnit) ? (st.unit as StatUnit) : "count", empty: cut(st.empty, 200) || undefined };
      if ("labels" in st && Array.isArray(st.labels)) {
        const labels = st.labels.slice(0, 60).map((l) => cut(l, 24));
        const tips = labels.map((l, i) => cut(Array.isArray(st.tips) ? st.tips[i] : undefined, 80) || l);
        const series = (Array.isArray(st.series) ? st.series : []).slice(0, 2).filter((x) => x && typeof x.name === "string").map((x) => ({ name: x.name.slice(0, 40), values: nums(x.values, labels.length) }));
        return [{ ...base, kind: "chart", chart: st.chart === "lines" ? "lines" : "columns", stacked: st.stacked === true, labels, tips, series }];
      }
      if ("value" in st) return [{ ...base, kind: "tile", value: num(st.value), note: cut(st.note, 120) || undefined, trend: Array.isArray(st.trend) ? nums(st.trend, 60) : undefined }];
      return [];
    });
  });
}

/**
 * What every pack says needs me, as the core's needs: keys under the pack's id, text cut to size,
 * an href that isn't a path here or http(s) made harmless, a ring only when it's one the pack
 * declared (and `rings` kept). A pack that throws adds nothing and is logged.
 */
export function needsFrom(on: Pack[], ctxOf: (c: Pack) => PackContext, rings: { pack: string; kind: string }[], log: (id: string, line: string) => void): Need[] {
  return on.flatMap((c) => {
    if (!c.needs) return [];
    const id = c.manifest.id;
    const mine = new Set(rings.filter((r) => r.pack === id).map((r) => r.kind));
    const got = safely(() => c.needs!(ctxOf(c)), [], (e) => log(id, `needs: ${(e as Error)?.message ?? e}`));
    if (!Array.isArray(got)) return [];
    return got.slice(0, 50).flatMap((n): Need[] => {
      if (!n || typeof n.key !== "string" || typeof n.title !== "string" || !n.title.trim()) return [];
      const rank = typeof n.rank === "number" && Number.isFinite(n.rank) ? Math.max(0, Math.min(4, Math.round(n.rank))) : 2;
      return [
        {
          kind: "pack",
          pack: id,
          label: cut(n.label, 40) || c.manifest.name,
          key: `${id}:${n.key.slice(0, 200)}`,
          ring: typeof n.ring === "string" && mine.has(n.ring) ? n.ring : undefined,
          rank,
          at: typeof n.at === "number" && Number.isFinite(n.at) ? n.at : 0,
          title: n.title.slice(0, 200),
          line: cut(n.line, 300) || undefined,
          href: safeUrl(n.href),
          tone: TONES.has(n.tone) ? n.tone : "neutral",
        },
      ];
    });
  });
}

/**
 * A pack's one-off notification (`PackContext.ring`) as the core rings it: only a kind it declared
 * (and the core accepted), its text cut, its link made safe, its tag kept under its id. Else nothing.
 */
export function noteFrom(id: string, n: PackNote, rings: { pack: string; kind: string }[]): Note | undefined {
  if (!n || typeof n.kind !== "string" || !rings.some((r) => r.pack === id && r.kind === n.kind)) return undefined;
  const title = cut(n.title, 200).trim();
  if (!title || typeof n.tag !== "string" || !n.tag) return undefined;
  return { title, body: cut(n.body, 200), url: safeUrl(n.href) ?? "/", tag: `${id}:${n.tag.slice(0, 200)}`, kind: n.kind };
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(99, Math.round(v))) : 0);

/** The packs' pulses summed (`pulse`, or the old `avatar`): counts each kept to 0–99; troubles a line each, cut to size, links only to this app's paths. One that throws adds none. */
export function pulseFrom(on: Pack[], ctxOf: (c: Pack) => PackContext, log: (id: string, line: string) => void): Omit<Pulse, "busy"> {
  const out: Omit<Pulse, "busy"> = { working: 0, asking: 0, trouble: [] };
  for (const c of on) {
    const f = c.pulse ?? c.avatar;
    if (!f) continue;
    const a = safely(() => f.call(c, ctxOf(c)), undefined, (e) => log(c.manifest.id, `pulse: ${(e as Error)?.message ?? e}`));
    if (!a || typeof a !== "object") continue;
    out.working += count(a.working);
    out.asking += count(a.asking);
    if (a.onDuty === true) out.onDuty = true;
    const t = a.trouble;
    if (t && (t.level === "storm" || t.level === "fire") && typeof t.why === "string" && t.why.trim()) {
      const href = typeof t.href === "string" && t.href.startsWith("/") && !t.href.startsWith("//") && !t.href.includes("\\") ? t.href.slice(0, 200) : undefined;
      if (out.trouble.length < 5) out.trouble.push({ level: t.level, why: t.why.trim().replace(/\s+/g, " ").slice(0, 80), ...(href ? { href } : {}) });
    }
  }
  return out;
}

/** The PR links the packs' pages show (`linked`), for the gather to look up: links only, 200 at most. */
export function linkedFrom(on: Pack[], ctxOf: (c: Pack) => PackContext, log: (id: string, line: string) => void): string[] {
  const out = new Set<string>();
  for (const c of on) {
    if (!c.linked) continue;
    const got = safely(() => c.linked!(ctxOf(c)), [], (e) => log(c.manifest.id, `linked: ${(e as Error)?.message ?? e}`));
    if (!Array.isArray(got)) continue;
    for (const u of got.slice(0, 200)) if (typeof u === "string" && u.length <= 500 && /^https:\/\//.test(u)) out.add(u);
  }
  return [...out].slice(0, 200);
}

/** Each pack's `beforePage`, together, `ms` at most; one that throws or hangs only logs. */
export async function beforePages(on: Pack[], ctxOf: (c: Pack) => PackContext, log: (id: string, line: string) => void, ms = 1500): Promise<void> {
  const each = on.filter((c) => c.beforePage).map((c) =>
    Promise.resolve()
      .then(() => c.beforePage!(ctxOf(c)))
      .catch((e) => log(c.manifest.id, `beforePage: ${(e as Error)?.message ?? e}`)),
  );
  if (!each.length) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(each), new Promise<void>((res) => (t = setTimeout(res, ms)))]).finally(() => clearTimeout(t));
}

/** Each pack's bar for the top of every page (`banner`); one that throws or says nothing adds none. */
export function bannersFrom(on: Pack[], ctxOf: (c: Pack) => PackContext, path: string, log: (id: string, line: string) => void): Html[] {
  return on.flatMap((c) => {
    if (!c.banner) return [];
    const b = safely(() => c.banner!(ctxOf(c), { path }), "" as const, (e) => log(c.manifest.id, `banner: ${(e as Error)?.message ?? e}`));
    return b ? [b] : [];
  });
}

/** Each pack's panel for Settings (`settings`), with its name; one that throws or has nothing adds none. */
export function settingsFrom(on: Pack[], ctxOf: (c: Pack) => PackContext, log: (id: string, line: string) => void): { id: string; name: string; body: Html }[] {
  return on.flatMap((c) => {
    if (!c.settings) return [];
    const body = safely<Html | "">(() => c.settings!(ctxOf(c)), "", (e) => log(c.manifest.id, `settings: ${(e as Error)?.message ?? e}`));
    return body ? [{ id: c.manifest.id, name: c.manifest.name, body }] : [];
  });
}

/** What the packs call an actions-log entry ("actions.where"): the first that answers, one line of 120 at most. */
/** What a pack calls a kind of entry it logged ("actions.what": "Sent a Teams message"), cut to a line; undefined: none says. */
export function whatFrom(fill: Fill, kind: string): string | undefined {
  for (const w of fill("actions.what", { kind })) {
    const line = typeof w === "string" ? oneLine(w, 60) : "";
    if (line) return line;
  }
  return undefined;
}

export function whereFrom(fill: Fill, a: { kind: string; target: string }): string | undefined {
  for (const w of fill("actions.where", { kind: a.kind, target: a.target })) {
    const line = typeof w === "string" ? oneLine(w, 120) : "";
    if (line) return line;
  }
  return undefined;
}

/** A pack's dock as the frame draws it: its id (its pages are /<id>/dock…), the label and count cut to size. */
export type DockView = { id: string; label: string; count: number; hot: boolean; title?: string; /** Its key (one capital letter), when the pack asked for one no other dock has. */ key?: string };
export const MAX_DOCKS = 3;

/** Capitals the page's own keys already use (src/ui/app.js.ts): B is Bino's pane; F, G, H, J, K and L move about. */
export const TAKEN_KEYS = "BFGHJKL";

/** The packs' docks (`dock`), in their order, three at most; one that throws or has no label adds none. A key goes to the first dock that asks for it. */
export function docksFrom(on: Pack[], ctxOf: (c: Pack) => PackContext, log: (id: string, line: string) => void): DockView[] {
  const out: DockView[] = [];
  for (const c of on) {
    if (!c.dock || out.length >= MAX_DOCKS) continue;
    const d = safely((): Dock | undefined => c.dock!(ctxOf(c)), undefined, (e) => log(c.manifest.id, `dock: ${(e as Error)?.message ?? e}`));
    const label = cut(d?.label, 24).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    if (!d || !label) continue;
    const n = typeof d.count === "number" && Number.isFinite(d.count) ? Math.max(0, Math.min(999, Math.round(d.count))) : 0;
    const title = cut(d.title, 120).trim();
    const key = typeof d.key === "string" && /^[A-Z]$/.test(d.key) && !TAKEN_KEYS.includes(d.key) && !out.some((o) => o.key === d.key) ? d.key : undefined;
    out.push({ id: c.manifest.id, label, count: n, hot: d.hot === true && n > 0, ...(title ? { title } : {}), ...(key ? { key } : {}) });
  }
  return out;
}

/** A pack's act as Bino and its card see it: checked and cut to size, bound to the pack, each call isolated. */
export type PackAct = ActSpec & {
  pack: string;
  title: string;
  button: string;
  hint?: string;
  oneClick: boolean;
  question: string;
  /** Its inputs; "" when the pack throws (the card says it can't be done here). */
  inputs(act: Record<string, string>, kept?: Record<string, string>): Html | "";
  /** Never throws: a pack that does says it didn't go through. */
  run(form: Record<string, string>, act: Record<string, string>): Promise<ActDone>;
};
const WORD = /^[a-z][a-z0-9-]{0,31}$/;
const FIELD = /^[a-z][a-z0-9_]{0,31}$/;

/** The packs' acts (`acts`): five a pack, eight fields each, twelve in all; a bad one is left out and logged. */
export function actsFrom(on: Pack[], ctxOf: (c: Pack) => PackContext, log: (id: string, line: string) => void): PackAct[] {
  const out: PackAct[] = [];
  for (const c of on) {
    if (!c.acts) continue;
    const id = c.manifest.id;
    const say = (line: string) => log(id, line);
    const kinds = safely((): ActKind[] => c.acts!(ctxOf(c)), [], (e) => say(`acts: ${(e as Error)?.message ?? e}`));
    if (!Array.isArray(kinds)) continue;
    const seen = new Set<string>();
    for (const k of kinds.slice(0, 5)) {
      if (out.length >= 12) break;
      const fields = Array.isArray(k?.fields)
        ? k.fields
            .slice(0, 8)
            .filter((f) => FIELD.test(String(f?.name)) && f.name !== "kind")
            .map((f) => ({ name: f.name, about: oneLine(f.about, 160), required: f.required === true, max: Math.max(1, Math.min(4000, Math.round(Number(f.max) || 200))), text: f.text === true }))
        : [];
      const title = oneLine(k?.title, 80);
      const when = oneLine(k?.when, 400);
      const button = oneLine(k?.button, 30);
      if (!k || !WORD.test(String(k.kind)) || seen.has(k.kind) || !title || !when || !button || !fields.length || typeof k.inputs !== "function" || typeof k.run !== "function") {
        say(`acts: ${String(k?.kind).slice(0, 40)} left out (it needs a word for its kind, a title, when, a button, fields, inputs and run)`);
        continue;
      }
      seen.add(k.kind);
      const hint = oneLine(k.hint, 120);
      out.push({
        kind: `${id}.${k.kind}`,
        app: c.manifest.name,
        pack: id,
        title,
        when,
        fields,
        button,
        ...(hint ? { hint } : {}),
        oneClick: k.oneClick === true,
        question: oneLine(k.question, 200) || `${title}?`,
        inputs: (act, kept) => safely<Html | "">(() => k.inputs(act, kept, ctxOf(c)), "", (e) => say(`acts ${k.kind}: inputs: ${(e as Error)?.message ?? e}`)) || "",
        run: async (form, act) => {
          try {
            const r = await k.run(form, act, ctxOf(c));
            if (r?.ok === true) {
              const href = typeof r.href === "string" ? safeUrl(r.href) : undefined;
              return { ok: true, done: oneLine(r.done, 200) || "Done", ...(href ? { href } : {}) };
            }
            return { ok: false, error: oneLine(r?.ok === false ? r.error : "", 300) || "It didn't go through." };
          } catch (e) {
            say(`acts ${k.kind}: run: ${(e as Error)?.message ?? e}`);
            return { ok: false, error: `It didn't go through: ${c.manifest.name} failed (Dovre's log says why).` };
          }
        },
      });
    }
  }
  return out;
}

/** A pack's lookup as Bino sees it: checked and cut to size, bound to the pack; `run` never throws. */
export type PackLookup = LookupSpec & { pack: string; run(args: Record<string, string>): Promise<{ text: string; error?: boolean }> };
export const LOOKUP_MS = 8000;

/** The packs' lookups (`lookups`): five a pack, six fields each, sixteen in all; a bad one is left out and logged. */
export function lookupsFrom(on: Pack[], ctxOf: (c: Pack) => PackContext, log: (id: string, line: string) => void, ms = LOOKUP_MS): PackLookup[] {
  const out: PackLookup[] = [];
  for (const c of on) {
    if (!c.lookups) continue;
    const id = c.manifest.id;
    const say = (line: string) => log(id, line);
    const kinds = safely((): LookupKind[] => c.lookups!(ctxOf(c)), [], (e) => say(`lookups: ${(e as Error)?.message ?? e}`));
    if (!Array.isArray(kinds)) continue;
    const seen = new Set<string>();
    for (const k of kinds.slice(0, 5)) {
      if (out.length >= 16) break;
      const when = oneLine(k?.when, 400);
      if (!k || !WORD.test(String(k.kind)) || seen.has(k.kind) || !when || !Array.isArray(k.fields) || typeof k.run !== "function") {
        say(`lookups: ${String(k?.kind).slice(0, 40)} left out (it needs a word for its kind, when, fields and run)`);
        continue;
      }
      seen.add(k.kind);
      const fields = k.fields
        .slice(0, 6)
        .filter((f) => FIELD.test(String(f?.name)) && f.name !== "kind")
        .map((f) => ({ name: f.name, about: oneLine(f.about, 160), required: f.required === true, max: Math.max(1, Math.min(1000, Math.round(Number(f.max) || 200))) }));
      out.push({
        kind: `${id}.${k.kind}`,
        app: c.manifest.name,
        pack: id,
        when,
        fields,
        run: async (args) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error("late")), ms)));
            const text = await Promise.race([Promise.resolve().then(() => k.run(args, ctxOf(c))), late]);
            return { text: resultOf(text) || "(nothing found)" };
          } catch (e) {
            const late = (e as Error)?.message === "late";
            say(`lookups ${k.kind}: ${late ? `no answer in ${ms / 1000} s` : ((e as Error)?.message ?? e)}`);
            return { text: late ? `${c.manifest.name} didn't answer in time.` : `${c.manifest.name} couldn't look that up (Dovre's log says why).`, error: true };
          } finally {
            clearTimeout(timer);
          }
        },
      });
    }
  }
  return out;
}

/** What the packs add to Today's briefing: numbers beside the greeting, sentences, horizon rows. */
export type Briefing = { glance: Glance[]; brief: Bit[][]; lanes: Lane[] };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One bit of a pack's sentence, cut to size; a link's href made harmless, a tone only bad or warn. */
function bitOf(b: unknown): Bit | undefined {
  if (typeof b === "string") return b.slice(0, 200);
  if (!b || typeof b !== "object") return undefined;
  const o = b as Record<string, unknown>;
  const code = cut(o.code, 80);
  if (code) return { text: "", href: "", code };
  const text = cut(o.text, 80);
  if (!text) return undefined;
  return { text, href: safeUrl(typeof o.href === "string" ? o.href : ""), ...(o.tone === "bad" || o.tone === "warn" ? { tone: o.tone } : {}) };
}

/**
 * Every pack's answer to `glance`, `brief` and `lane`, cut to size: two numbers, one sentence of
 * twelve bits and one row of 200 marks each at most. A pack that throws adds nothing and is logged.
 */
export function briefingFrom(on: Pack[], ctxOf: (c: Pack) => PackContext, log: (id: string, line: string) => void): Briefing {
  const out: Briefing = { glance: [], brief: [], lanes: [] };
  const ask = <T>(c: Pack, name: string, run: () => T): T | undefined => safely(run, undefined, (e) => log(c.manifest.id, `${name}: ${(e as Error)?.message ?? e}`));
  for (const c of on) {
    const g = c.glance ? ask(c, "glance", () => c.glance!(ctxOf(c))) : undefined;
    if (Array.isArray(g))
      for (const x of g.slice(0, 2)) {
        const label = cut(x?.label, 24).trim();
        const value = num(x?.value) ?? cut(x?.value, 16);
        if (label && value !== "") out.glance.push({ label, value });
      }
    const b = c.brief ? ask(c, "brief", () => c.brief!(ctxOf(c))) : undefined;
    if (Array.isArray(b)) {
      const sentence = b.slice(0, 12).flatMap((x) => bitOf(x) ?? []);
      if (sentence.some((x) => (typeof x === "string" ? x.trim() : true))) out.brief.push(sentence);
    }
    const l = c.lane ? ask(c, "lane", () => c.lane!(ctxOf(c))) : undefined;
    if (l && typeof l === "object" && Array.isArray(l.marks)) {
      const label = cut(l.label, 16).trim() || c.manifest.name.slice(0, 16);
      const marks = l.marks.slice(0, 200).flatMap((m) => {
        const at = num(m?.at);
        return at === undefined ? [] : [{ at, size: num(m.size), live: m.live === true, title: cut(m.title, 200) }];
      });
      out.lanes.push({ label, legend: cut(l.legend, 60) || undefined, marks });
    }
  }
  return out;
}

/** Today's cards from every pack, each within the budget; a pack that fails or is slow is named. */
export async function todayCards(on: Pack[], ctxOf: (c: Pack) => PackContext, budgetMs: number): Promise<{ cards: TodayCard[]; failed: Off[] }> {
  const results = await Promise.all(on.filter((c) => c.today).map(async (c) => ({ c, r: await within(budgetMs, () => c.today!(ctxOf(c))) })));
  const cards: TodayCard[] = [];
  const failed: Off[] = [];
  for (const { c, r } of results) {
    if (r.ok) cards.push(...r.value.map((card) => ({ ...card, id: `${c.manifest.id}-${card.id}` })));
    else failed.push({ id: c.manifest.id, name: c.manifest.name, why: r.why });
  }
  return { cards: cards.sort((a, b) => (a.order ?? 100) - (b.order ?? 100)), failed };
}

/** How a pack's refreshes and cron runs went, in this process (hosted: this isolate), for the Packs page. */
export type RefreshState = { since?: number; at?: number; ms?: number; error?: string; cronAt?: number; cronError?: string };
export type Refreshes = {
  get(id: string): RefreshState | undefined;
  started(id: string, at: number): void;
  ended(id: string, at: number, error?: string): void;
  cron(id: string, at: number, error?: string): void;
};

const why = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/**
 * `changed`: told when a refresh or cron run ends differently from the one before it (its first, or
 * failing ↔ ok, or a new error), and the app publishes "packs". Not on every end: hosted, every
 * isolate refreshes every pack, and each publish reaches every open tab, which asks again.
 */
export function refreshLog(changed: () => void = () => {}): Refreshes {
  const m = new Map<string, RefreshState>();
  const of = (id: string) => m.get(id) ?? (m.set(id, {}), m.get(id)!);
  return {
    get: (id) => m.get(id),
    started(id, at) {
      of(id).since = at;
    },
    ended(id, at, error) {
      const s = of(id);
      s.ms = s.since === undefined ? undefined : at - s.since;
      s.since = undefined;
      s.at = at;
      const news = !("error" in s) || s.error !== error;
      s.error = error;
      if (news) changed();
    },
    cron(id, at, error) {
      const s = of(id);
      const news = s.cronAt === undefined || s.cronError !== error;
      s.cronAt = at;
      s.cronError = error;
      if (news) changed();
    },
  };
}

/** Calls every pack's refresh, one at a time per pack (a refresh still running is skipped). */
/** `maxMs`: a refresh running longer is given up and the next due() starts it again (hosted: a cancelled request's I/O never settles). */
/** `record`: where each refresh's start, end and failure go (the Packs page). */
export function refresher(on: Pack[], ctxOf: (c: Pack) => PackContext, log: (line: string) => void, opts: { maxMs?: number; now?: () => number; record?: Refreshes; /** Packs I've hidden (Settings → Layout): not refreshed. */ skip?: (id: string) => boolean } = {}) {
  const clock = opts.now ?? Date.now;
  const running = new Map<string, Promise<void>>();
  const startedAt = new Map<string, number>();
  const last = new Map<string, number>();
  const one = (c: Pack): Promise<void> => {
    const id = c.manifest.id;
    if (!c.refresh) return Promise.resolve();
    const was = running.get(id);
    if (was && opts.maxMs && clock() - (startedAt.get(id) ?? 0) > opts.maxMs) {
      const s = Math.round((clock() - startedAt.get(id)!) / 1000);
      log(`pack ${id}: gave up on a refresh running ${s} s`);
      opts.record?.ended(id, clock(), `gave up after ${s} s`);
      running.delete(id);
    } else if (was) return was;
    let failed: string | undefined;
    const p = Promise.resolve()
      .then(() => c.refresh!(ctxOf(c)))
      .catch((e) => {
        failed = why(e);
        log(`pack ${id}: refresh failed: ${failed}`);
      })
      .finally(() => {
        if (running.get(id) !== p) return;
        running.delete(id);
        last.set(id, clock());
        opts.record?.ended(id, clock(), failed);
      });
    running.set(id, p);
    startedAt.set(id, clock());
    opts.record?.started(id, clock());
    return p;
  };
  return {
    one,
    /** Every pack whose refresh is due (or all, with `force`). */
    due(force = false, now = Date.now()): Promise<void> {
      return Promise.all(on.filter((c) => c.refresh && !opts.skip?.(c.manifest.id) && (force || now - (last.get(c.manifest.id) ?? 0) >= (c.manifest.everyMs ?? 300_000))).map(one)).then(() => undefined);
    },
  };
}

/**
 * Starts every pack, each after what it requires; one whose init throws is taken off (`on`
 * shrinks) and named in `off`, and so is what requires it, unstarted.
 */
export async function initAll(active: Active, ctxOf: (c: Pack) => PackContext, log: (line: string) => void): Promise<void> {
  for (const c of [...active.on]) {
    if (!c.init || !active.on.includes(c)) continue;
    try {
      await c.init(ctxOf(c));
    } catch (e) {
      const why = `didn't start: ${(e as Error)?.message ?? e}`;
      log(`pack ${c.manifest.id}: ${why}`);
      active.on.splice(active.on.indexOf(c), 1);
      active.off.push({ id: c.manifest.id, name: c.manifest.name, why, manifest: c.manifest });
      settleRequires(active);
    }
  }
}

/** Which hooks a pack answers, in words, for the Packs page. */
/**
 * What a pack gives Bino and agents (#262), as /packs says it: its context (its own lines, what it
 * shows on Today, or only its name when private), what it says of its pages, its lookups, proposals and tools.
 */
export function binoOf(c: Pack): string {
  if (c.manifest.private) return `only its name: private${c.lookups ? " · lookups" : ""}${c.acts ? " · proposes acts" : ""}${c.tools ? " · tools for agents" : ""}`;
  const context = c.bino ? "its own lines" : c.glance || c.needs || c.pulse || c.avatar || c.feed ? "what it shows on Today" : "nothing";
  const pages = c.about ? "what its pages are" : c.routes ? "its pages by name only" : "";
  return [`context: ${context}`, pages, c.lookups ? "lookups" : "", c.acts ? "proposes acts" : "", c.tools ? "tools for agents" : ""].filter(Boolean).join(" · ");
}

export function hooksOf(c: Pack): string[] {
  const has: [unknown, string][] = [
    [c.routes, "pages"],
    [c.nav, "menu"],
    [c.today, "Today cards"],
    [c.glance || c.brief || c.lane, "Today's briefing"],
    [c.feed, "feed"],
    [c.finds || c.pages, "search"],
    [c.refs || c.linked, "links"],
    [c.bino || c.about, "Bino"],
    [c.slots, "core pages"],
    [c.acts, "Bino's proposals"],
    [c.settings, "Settings"],
    [c.needs, "needs"],
    [c.banner, "bar"],
    [c.dock, "dock"],
    [c.callback, "sign-in return"],
    [c.ingest, "ingest"],
    [c.pulse || c.avatar, "pulse"],
    [c.refresh || c.beforePage, "refresh"],
    [c.scheduled, "cron"],
    [c.email, "mail"],
    [c.forge, "forge"],
  ];
  return has.filter(([h]) => !!h).map(([, w]) => w);
}
