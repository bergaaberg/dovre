/**
 * A pack's releases as GitHub has them (#362), for the hosted Packs page: tags `<id>@x.y.z` in
 * dovre-packs, and at the newest one the pack's CHANGELOG.md and the PACK_API its index.ts asks
 * for. Worker-safe (no node:), so it also holds the pure helpers src/packs/update.ts shares.
 * Read in the background at most once an hour; the page shows the kept answer. Applying a release
 * still happens in the instance repo (`pnpm packs update <id>`) and a deploy: a Worker can't
 * rewrite itself.
 */
import { apiCompare, apiText, parseApi } from "./api.ts";
import { PACK_API } from "./types.ts";

/** Where released packs come from: always allowed as a source (src/packs/update.ts). */
export const HOME_SOURCE = "bergaaberg/dovre-packs";

type Semver = [number, number, number];
export const semver = (v: string | null | undefined): Semver | null => {
  const m = v?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
/** Above 0 when `a` is the newer. */
export const newer = (a: Semver, b: Semver) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** A literal `api: "1.6"` (or `api: 1`) in a pack's index.ts, as "major.minor". */
export function literalApi(index: string): string | null {
  const m = index.match(/\bapi:\s*(?:"(\d+(?:\.\d+)?)"|'(\d+(?:\.\d+)?)'|(\d+)\b)/);
  const v = m && parseApi(m[1] ?? m[2] ?? Number(m[3]));
  return v ? apiText(v) : null;
}

/** A literal `version: "1.2.0"` in a pack's index.ts. */
export const literalVersion = (index: string) => index.match(/\bversion:\s*["'](\d+\.\d+\.\d+)["']/)?.[1] ?? null;

export type Notes = { version: string; lines: string[] }[];

/** A changelog's releases newer than `since` (all of them when null), newest first, each with its lines. */
export function notesOf(changelog: string, since: string | null): Notes {
  const from = semver(since);
  const out: Notes = [];
  for (const part of changelog.split(/^## /m).slice(1)) {
    const version = part.match(/^(\d+\.\d+\.\d+)\b/)?.[1];
    const v = semver(version);
    if (!v || (from && newer(v, from) <= 0)) continue;
    out.push({ version: version!, lines: part.split("\n").slice(1).map((l) => l.trim().replace(/^[-*]\s+/, "")).filter(Boolean).slice(0, 20) });
  }
  return out.slice(0, 10);
}

/** Each pack's newest release among tag names (`<id>@x.y.z`, with or without `refs/tags/`). */
export function newestOf(tags: string[]): Map<string, { tag: string; version: string }> {
  const out = new Map<string, { tag: string; version: string; v: Semver }>();
  for (const raw of tags) {
    const tag = raw.replace(/^refs\/tags\//, "");
    const m = tag.match(/^([a-z][a-z0-9-]{0,31})@(\d+\.\d+\.\d+)$/);
    const v = m && semver(m[2]);
    if (!m || !v) continue;
    const had = out.get(m[1]!);
    if (!had || newer(v, had.v) > 0) out.set(m[1]!, { tag, version: m[2]!, v });
  }
  return new Map([...out].map(([id, { tag, version }]) => [id, { tag, version }]));
}

/** Where a pack may run, as its manifest says (PackManifest.execution). */
export type Runs = "any" | "local-only" | "hosted-only";

/** A pack in dovre-packs that this instance doesn't list (#88): what it is, read from its index.ts as text, never run. */
export type Listed = {
  id: string;
  name: string;
  description: string;
  /** Its newest release; null when it has none yet (the checkout's HEAD). */
  version: string | null;
  tag: string | null;
  api: string | null;
  /** It needs a newer core than this one. */
  needsCore: boolean;
  execution: Runs;
  domain: string;
};

/** A double-quoted string literal's text (escapes and all), else a single-quoted one's. */
const strAfter = (text: string, key: string): string | undefined => {
  const m = text.match(new RegExp(`\\b${key}:\\s*(?:"((?:[^"\\\\\\n]|\\\\.)*)"|'((?:[^'\\\\\\n]|\\\\.)*)')`));
  if (!m) return undefined;
  if (m[1] !== undefined)
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1];
    }
  return m[2]!.replace(/\\(.)/g, "$1");
};

/**
 * What pack `id`'s index.ts says about it: the literals after its `id: "<id>"` (name, description,
 * domain, execution), and its version and API. Anything missing gets a plain default.
 */
export function listedOf(id: string, index: string, release: { tag: string; version: string } | null = null): Listed {
  const at = Math.max(0, index.search(new RegExp(`\\bid:\\s*["']${id}["']`)));
  const after = index.slice(at);
  const ex = strAfter(after, "execution");
  const api = literalApi(index);
  return {
    id,
    name: (strAfter(after, "name") ?? id).slice(0, 80),
    description: (strAfter(after, "description") ?? "").slice(0, 400),
    version: literalVersion(index) ?? release?.version ?? null,
    tag: release?.tag ?? null,
    api,
    needsCore: !!api && apiCompare(api, PACK_API) > 0,
    execution: ex === "local-only" || ex === "hosted-only" ? ex : "any",
    domain: (strAfter(after, "domain") ?? "general").slice(0, 40),
  };
}

/** A release newer than the pack running here. */
export type Available = {
  version: string;
  tag: string;
  /** What changed since the running version, newest first. */
  notes: Notes;
  /** The PACK_API it needs; null when its index.ts doesn't say. */
  api: string | null;
  /** It needs a newer core than this one: update Dovre first. */
  needsCore: boolean;
};

/** GET on the GitHub REST API (a path like `/repos/o/r/...`), parsed JSON. */
export type GetJson = (path: string) => Promise<unknown>;

const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

/** A file's text at a ref, through the contents API; undefined when it isn't there. */
async function fileAt(get: GetJson, source: string, path: string, ref: string): Promise<string | undefined> {
  try {
    const r = (await get(`/repos/${source}/contents/${path}?ref=${encodeURIComponent(ref)}`)) as { content?: unknown; encoding?: unknown };
    return typeof r?.content === "string" && r.encoding === "base64" ? decode(r.content) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The releases newer than each pack's own version, from `source`'s tags: one call for the tags,
 * then two for each pack with a newer one (its changelog and index.ts at that tag). A pack without
 * a version, or with no release in `source`, is left out.
 */
export async function availableFor(get: GetJson, packs: { id: string; version: string }[], source = HOME_SOURCE, tags?: Map<string, { tag: string; version: string }>): Promise<Map<string, Available>> {
  const newest = tags ?? (await newestIn(get, source));
  const out = new Map<string, Available>();
  await Promise.all(
    packs.map(async (p) => {
      const n = newest.get(p.id);
      const here = semver(p.version);
      const there = n && semver(n.version);
      if (!n || !here || !there || newer(there, here) <= 0) return;
      const [changelog, index] = await Promise.all([fileAt(get, source, `packs/${p.id}/CHANGELOG.md`, n.tag), fileAt(get, source, `packs/${p.id}/index.ts`, n.tag)]);
      const api = index ? literalApi(index) : null;
      out.set(p.id, { version: n.version, tag: n.tag, notes: changelog ? notesOf(changelog, p.version) : [], api, needsCore: !!api && apiCompare(api, PACK_API) > 0 });
    }),
  );
  return out;
}

/** Each pack's newest release in `source`, from one call for its tags. */
export async function newestIn(get: GetJson, source = HOME_SOURCE): Promise<Map<string, { tag: string; version: string }>> {
  const refs = (await get(`/repos/${source}/git/matching-refs/tags/`)) as { ref?: unknown }[];
  return newestOf((Array.isArray(refs) ? refs : []).flatMap((r) => (typeof r?.ref === "string" ? [r.ref] : [])));
}

/** The released packs not in `here` (#88), each read from its index.ts at its newest tag; one call each. */
export async function listedFor(get: GetJson, here: string[], source = HOME_SOURCE, tags?: Map<string, { tag: string; version: string }>): Promise<Listed[]> {
  const newest = tags ?? (await newestIn(get, source));
  const out = await Promise.all(
    [...newest].filter(([id]) => !here.includes(id)).map(async ([id, n]) => {
      const index = await fileAt(get, source, `packs/${id}/index.ts`, n.tag);
      return index === undefined ? undefined : listedOf(id, index, n);
    }),
  );
  return out.filter((x): x is Listed => !!x).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** How often the releases are read again. */
const RELEASES_MS = 3600_000;

/**
 * Hosted: the kept answer for the Packs page, read again in the background once an hour old.
 * `refresh()` returns the read it started (for waitUntil), or undefined when none was due.
 */
export function createReleases(o: { get: GetJson; /** Each pack listed here, on or off, and its own version. */ packs: () => { id: string; version?: unknown }[]; /** Every pack id here, Dovre's own too: the rest of dovre-packs is listed to add (#88). */ here?: () => string[]; now?: () => number; onChange?: () => void; source?: string }) {
  const now = o.now ?? Date.now;
  let kept: { at: number; available: Map<string, Available>; listed: Listed[]; error?: string } | undefined;
  let reading: Promise<void> | undefined;
  return {
    get: () => kept,
    refresh(force = false): Promise<void> | undefined {
      if (reading || (!force && kept && now() - kept.at < RELEASES_MS)) return undefined;
      const packs = o.packs().flatMap((p) => (typeof p.version === "string" && semver(p.version) ? [{ id: p.id, version: p.version }] : []));
      const here = o.here?.() ?? o.packs().map((p) => p.id);
      reading = newestIn(o.get, o.source)
        .then((tags) => Promise.all([availableFor(o.get, packs, o.source, tags), listedFor(o.get, here, o.source, tags)]))
        .then(
          ([available, listed]) => {
            kept = { at: now(), available, listed };
          },
          (e: unknown) => {
            kept = { at: now(), available: kept?.available ?? new Map(), listed: kept?.listed ?? [], error: String((e as Error)?.message ?? e).slice(0, 200) };
          },
        )
        .finally(() => {
          reading = undefined;
          o.onChange?.();
        });
      return reading;
    },
  };
}
export type Releases = ReturnType<typeof createReleases>;
