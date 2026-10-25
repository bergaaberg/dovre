/**
 * What a repo says an issue looks like, read live: its issue-form templates
 * (`.github/ISSUE_TEMPLATE/*.yml`, plus `advanced/`), the org's Issue Types and the repo's
 * labels. Nothing here is hardcoded; the templates and types change under us (Feature became
 * Story in 2026). Parsing is pure and tested; the loaders below it talk HTTP and cache.
 */
// The `yaml` lib rather than a hand parser: templates come from any repo and use quoted
// scalars, `|` block scalars, flow sequences and emoji; a subset parser gets one of those
// subtly wrong and the form silently loses a field.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import type { Ghe } from "../sources/ghe.ts";

export type FieldKind = "markdown" | "input" | "textarea" | "dropdown" | "checkboxes";

/** One field of an issue form. `value`: the text a textarea or input starts with; for markdown, the help text. */
export type Field = {
  kind: FieldKind;
  id?: string;
  label: string;
  description?: string;
  placeholder?: string;
  value?: string;
  /** Dropdown choices, or checkbox labels. */
  options: string[];
  /** Checkboxes only: which of `options` must be ticked. */
  mustTick: boolean[];
  required: boolean;
  multiple: boolean;
  /** Dropdown: the option picked to start with. */
  default?: number;
  /** Textarea: shown as a code block of this language. */
  render?: string;
};

export type Template = {
  /** Path under ISSUE_TEMPLATE ("bug.yml", "advanced/epic.yml"): the key a form names it by. */
  file: string;
  name: string;
  description: string;
  title: string;
  labels: string[];
  type?: string;
  projects: string[];
  fields: Field[];
  /** A maintainer's planning form (an epic, a story), shown after the everyday ones. */
  planning: boolean;
};

export type IssueType = { name: string; description: string; nodeId: string };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** `labels:` may be a list or one comma-separated string. */
const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(str) : typeof v === "string" ? v.split(",") : []).map((s) => s?.trim()).filter((s): s is string => !!s);

/**
 * Planning forms sort after the everyday ones. Repos mark them three ways, all counted: an
 * `advanced/` folder, a `z1-`…`z9-` file name (GitHub lists by file name), or a 🔒 in the name.
 */
export const isPlanning = (file: string, name: string) => file.startsWith("advanced/") || /^z\d/i.test(file) || /^\s*🔒/u.test(name);

/** A repo's `config.yml`: whether blank issues are allowed, and the chooser's other ways in. */
export type ChooserConfig = { blank: boolean; links: { name: string; url: string; about: string }[] };
export const OPEN_CHOOSER: ChooserConfig = { blank: true, links: [] };

export function parseConfig(text: string): ChooserConfig {
  const doc = obj(parse(text));
  const links = (Array.isArray(doc.contact_links) ? doc.contact_links : []).map(obj).map((l) => ({ name: str(l.name) ?? "", url: str(l.url) ?? "", about: str(l.about) ?? "" })).filter((l) => l.name && l.url);
  return { blank: doc.blank_issues_enabled !== false, links };
}

/** A repo with no forms and blank issues turned off takes no hand-made issues (a sorting repo a sync fills, say). */
export const takesIssues = (t: { templates: Template[]; config: ChooserConfig }) => t.templates.length > 0 || t.config.blank;

const KINDS = new Set<FieldKind>(["markdown", "input", "textarea", "dropdown", "checkboxes"]);

function field(raw: unknown): Field | null {
  const f = obj(raw);
  const kind = str(f.type) as FieldKind | undefined;
  if (!kind || !KINDS.has(kind)) return null;
  const a = obj(f.attributes);
  const required = obj(f.validations).required === true;
  const base = { kind, id: str(f.id), description: str(a.description), placeholder: str(a.placeholder), required, multiple: a.multiple === true, mustTick: [] as boolean[] };
  if (kind === "markdown") return { ...base, label: "", value: str(a.value) ?? "", options: [], required: false };
  const label = str(a.label) ?? "";
  if (kind === "checkboxes") {
    const opts = (Array.isArray(a.options) ? a.options : []).map(obj);
    return { ...base, label, options: opts.map((o) => str(o.label) ?? ""), mustTick: opts.map((o) => o.required === true) };
  }
  if (kind === "dropdown") {
    const options = (Array.isArray(a.options) ? a.options : []).map((o) => str(o) ?? "");
    const d = typeof a.default === "number" && Number.isInteger(a.default) && a.default >= 0 && a.default < options.length ? a.default : undefined;
    return { ...base, label, options, default: d };
  }
  return { ...base, label, value: str(a.value), options: [], render: kind === "textarea" ? str(a.render) : undefined };
}

/** One issue-form YAML file as a template; throws on what isn't one (a config.yml, a broken file). */
export function parseTemplate(file: string, text: string): Template {
  const doc = obj(parse(text));
  const name = str(doc.name);
  if (!name || !Array.isArray(doc.body)) throw new Error(`${file} isn't an issue form (needs name and body)`);
  const fields = doc.body.map(field).filter((f): f is Field => !!f);
  return {
    file,
    name,
    description: str(doc.description) ?? "",
    title: str(doc.title) ?? "",
    labels: list(doc.labels),
    type: str(doc.type)?.trim() || undefined,
    projects: list(doc.projects),
    fields,
    planning: isPlanning(file, name),
  };
}

/** Everyday forms first, then planning ones; within each, GitHub's order (by file name). */
export const ordered = (ts: Template[]) => [...ts].sort((a, b) => Number(a.planning) - Number(b.planning) || a.file.localeCompare(b.file));

// ── Loading (HTTP, cached) ───────────────────────────────────────────────────

type Entry = { type: string; name: string; path: string };
type Content = { content?: string; encoding?: string };

const isNotFound = (e: unknown) => /: 404\b/.test(String((e as Error)?.message ?? e));
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const DIR = ".github/ISSUE_TEMPLATE";

export type Templates = { templates: Template[]; broken: { file: string; error: string }[]; config: ChooserConfig };

/** The repo's templates, its chooser config, and the files that wouldn't parse (shown as failed, never dropped quietly). A repo without the folder has none. */
export async function loadTemplates(ghe: Ghe, repo: string): Promise<Templates> {
  const ls = async (dir: string) => {
    try {
      return await ghe.rest<Entry[]>(`/repos/${repo}/contents/${encodePath(dir)}`);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
  };
  const top = await ls(DIR);
  const files = top.filter((e) => e.type === "file").map((e) => e.name);
  if (top.some((e) => e.type === "dir" && e.name === "advanced")) files.push(...(await ls(`${DIR}/advanced`)).filter((e) => e.type === "file").map((e) => `advanced/${e.name}`));
  const forms = files.filter((f) => /\.ya?ml$/i.test(f) && !/(^|\/)config\.ya?ml$/i.test(f));
  const configFile = files.find((f) => /^config\.ya?ml$/i.test(f));
  const templates: Template[] = [];
  const broken: { file: string; error: string }[] = [];
  const read = async (file: string) => {
    const c = await ghe.rest<Content>(`/repos/${repo}/contents/${encodePath(`${DIR}/${file}`)}`);
    if (c.encoding !== "base64" || typeof c.content !== "string") throw new Error(`${file}: unexpected encoding ${c.encoding}`);
    return Buffer.from(c.content, "base64").toString("utf8");
  };
  let config = OPEN_CHOOSER;
  await Promise.all([
    ...forms.map(async (file) => {
      try {
        templates.push(parseTemplate(file, await read(file)));
      } catch (e) {
        broken.push({ file, error: String((e as Error).message ?? e) });
      }
    }),
    configFile
      ? read(configFile).then(
          (text) => void (config = parseConfig(text)),
          (e) => void broken.push({ file: configFile, error: String((e as Error).message ?? e) }),
        )
      : Promise.resolve(),
  ]);
  return { templates: ordered(templates), broken: broken.sort((a, b) => a.file.localeCompare(b.file)), config };
}

/** The org's enabled Issue Types. */
export async function loadIssueTypes(ghe: Ghe, org: string): Promise<IssueType[]> {
  const raw = await ghe.rest<{ name: string; description: string | null; node_id: string; is_enabled: boolean }[]>(`/orgs/${org}/issue-types`);
  return raw.filter((t) => t.is_enabled).map((t) => ({ name: t.name, description: t.description ?? "", nodeId: t.node_id }));
}

/** The repo's label names, so only labels that exist are offered (adding a missing one would create it). */
export async function loadLabels(ghe: Ghe, repo: string): Promise<string[]> {
  return (await ghe.rest<{ name: string }[]>(`/repos/${repo}/labels?per_page=100`)).map((l) => l.name);
}

/** `fresh`: read GHE now (before a write); otherwise what's known is answered at once. */
export type Catalog = {
  templates(repo: string, o?: { fresh?: boolean }): Promise<Templates>;
  types(o?: { fresh?: boolean }): Promise<IssueType[]>;
  labels(repo: string, o?: { fresh?: boolean }): Promise<string[]>;
};

/** A cache of loads by key, kept in memory and (with `kept`) on disk; see the function below. */
export function memoize(opts: { ttlMs?: number; now?: () => number; kept?: Kept } = {}) {
  const ttl = opts.ttlMs ?? 10 * 60e3;
  const now = opts.now ?? Date.now;
  /** `last`: the newest value that loaded, drawn while a newer one loads. */
  const memo = new Map<string, { at: number; value: Promise<unknown>; last?: { at: number; value: unknown }; loading?: boolean }>();
  const loadInto = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const value = load();
    const entry = memo.get(key);
    memo.set(key, { at: now(), value, last: entry?.last, loading: true });
    value.then(
      (v) => {
        const e = memo.get(key);
        if (e?.value !== value) return;
        e.loading = false;
        e.last = { at: now(), value: v };
        opts.kept?.set(key, e.last);
      },
      () => {
        const e = memo.get(key);
        if (e?.value !== value) return;
        // A failure isn't kept: what loaded before stays, and the next call tries again.
        if (e.last) memo.set(key, { at: e.last.at, value: Promise.resolve(e.last.value), last: e.last });
        else memo.delete(key);
      },
    );
    return value;
  };
  /**
   * A value within `ttlMs` is reused. An older one (in memory, or kept on disk from an earlier
   * run) is answered at once and loaded again in the background, so a page never waits on GHE for
   * something it has seen before. `fresh`: wait for a new load (before a write, which re-checks).
   */
  return <T>(key: string, load: () => Promise<T>, o: { fresh?: boolean } = {}): Promise<T> => {
    if (o.fresh) return loadInto(key, load);
    let hit = memo.get(key);
    if (!hit) {
      const k = opts.kept?.get(key);
      if (k) memo.set(key, (hit = { at: k.at, value: Promise.resolve(k.value), last: k }));
    }
    if (!hit) return loadInto(key, load);
    if (now() - hit.at >= ttl && !hit.loading) {
      const old = hit.last;
      const next = loadInto(key, load);
      if (old) {
        next.catch(() => undefined);
        return Promise.resolve(old.value as T);
      }
      return next;
    }
    return (hit.last && hit.loading ? Promise.resolve(hit.last.value) : hit.value) as Promise<T>;
  };
}

/** Where cached GHE answers are kept between runs. */
export type Kept = { get(key: string): { at: number; value: unknown } | undefined; set(key: string, v: { at: number; value: unknown }): void };

/** A JSON file of kept answers (data/, never committed), written a moment after the last change. Older than a week is dropped. */
export function keptFile(file: string, now: () => number = Date.now): Kept {
  let all: Record<string, { at: number; value: unknown }> = {};
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    if (doc && typeof doc === "object") all = doc;
  } catch {}
  for (const [k, v] of Object.entries(all)) if (!v || typeof v.at !== "number" || now() - v.at > 7 * 86_400_000) delete all[k];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    get: (key) => all[key],
    set(key, v) {
      all[key] = v;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          writeFileSync(`${file}.tmp`, JSON.stringify(all));
          renameSync(`${file}.tmp`, file);
        } catch (e) {
          console.error("couldn't keep the cache:", (e as Error).message);
        }
      }, 500);
      timer.unref?.();
    },
  };
}

/** The loaders behind memoize(): answered at once once known, loaded again after ~10 minutes. */
export function createCatalog(ghe: Ghe, org: string, opts: { ttlMs?: number; now?: () => number; kept?: Kept } = {}): Catalog {
  const cached = memoize(opts);
  return {
    templates: (repo, o) => cached(`t:${repo}`, () => loadTemplates(ghe, repo), o),
    types: (o) => cached(`types:${org}`, () => loadIssueTypes(ghe, org), o),
    labels: (repo, o) => cached(`l:${repo}`, () => loadLabels(ghe, repo), o),
  };
}
