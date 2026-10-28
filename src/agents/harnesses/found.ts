/**
 * Models found in each CLI's own config (#238), offered in place of the fixed `*_MODELS` lists when
 * there are any. Read on the machine that runs the turns: only the local server turns this on
 * (`useFoundModels`), so a hosted web server never reads its own home. Cached, so a form never waits.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { HarnessId } from "../runner.ts";

export type Model = { value: string; label: string };

/** What `--model` takes, as the harnesses check it. */
const MODEL = /^[\w./:@-]{1,100}$/;
/** omp's thinking levels, written after the model in its roles; the effort is picked apart from the model. */
const LEVEL = /:(?:off|minimal|low|medium|high|xhigh)$/;
const MAX = 20;

/** omp's `provider/model` as a label: the model, then where it comes from. */
const ompLabel = (v: string) => {
  const i = v.indexOf("/");
  return i > 0 ? `${v.slice(i + 1)} (${v.slice(0, i)})` : v;
};

/** The models in omp's `modelRoles` (config.yml), its default role first, each once without its thinking level. */
export function ompModelsIn(text: string): Model[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return [];
  }
  const roles = doc && typeof doc === "object" ? (doc as { modelRoles?: unknown }).modelRoles : undefined;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return [];
  const r = roles as Record<string, unknown>;
  const order = ["default", ...Object.keys(r).filter((k) => k !== "default")];
  const out: Model[] = [];
  for (const k of order) {
    const v = typeof r[k] === "string" ? r[k].trim().replace(LEVEL, "") : "";
    if (MODEL.test(v) && !v.startsWith("-") && !out.some((m) => m.value === v)) out.push({ value: v, label: ompLabel(v) });
  }
  return out.slice(0, MAX);
}

/** The models in Codex's config.toml: `model` at the top and in each `[profiles.<name>]`. */
export function codexModelsIn(text: string): Model[] {
  const out: Model[] = [];
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]*)\]\s*(?:#.*)?$/.exec(line);
    if (head) {
      section = head[1]!.trim();
      continue;
    }
    if (section && !/^profiles\.[\w-]+$/.test(section)) continue;
    const m = /^\s*model\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line) ?? /^\s*model\s*=\s*'([^']*)'\s*(?:#.*)?$/.exec(line);
    const v = m?.[1]?.trim() ?? "";
    if (MODEL.test(v) && !v.startsWith("-") && !out.some((x) => x.value === v)) out.push({ value: v, label: v });
  }
  return out.slice(0, MAX);
}

/** Where each CLI keeps the config its models are read from, and how. */
export const configsOf = (home = homedir(), env: { CODEX_HOME?: string } = process.env): Partial<Record<HarnessId, { file: string; read: (text: string) => Model[] }>> => ({
  omp: { file: join(home, ".omp", "agent", "config.yml"), read: ompModelsIn },
  codex: { file: join(env.CODEX_HOME || join(home, ".codex"), "config.toml"), read: codexModelsIn },
});

/** A reader of the found models per harness: each file read again only once it changed, checked at most every `ms`. */
export function foundModels(o: { home?: string; env?: { CODEX_HOME?: string }; ms?: number; now?: () => number } = {}): (id: HarnessId) => Model[] {
  const configs = configsOf(o.home, o.env);
  const now = o.now ?? Date.now;
  const ms = o.ms ?? 30_000;
  const cache = new Map<HarnessId, { at: number; mtime: number; models: Model[] }>();
  return (id) => {
    const c = configs[id];
    if (!c) return [];
    const hit = cache.get(id);
    if (hit && now() - hit.at < ms) return hit.models;
    let mtime = -1;
    let models: Model[] = [];
    try {
      mtime = statSync(c.file).mtimeMs;
      models = hit?.mtime === mtime ? hit.models : c.read(readFileSync(c.file, "utf8"));
    } catch {
      // No config, or one that can't be read: the fixed list stays.
    }
    cache.set(id, { at: now(), mtime, models });
    return models;
  };
}
