/**
 * Repo atlas: schema and parser for range.yaml files (PLAN D18, WP-G6).
 * Backstage-inspired catalog describing repo tier, components, doc files, and health watches.
 */

export type RangeComponent = {
  name: string;
  owns: string[];
  rules?: string;
};

export type RangeTier = "active" | "maintained" | "scratch" | string;

export type Range = {
  name: string;
  description?: string;
  url?: string;
  tier: RangeTier;
  components: RangeComponent[];
  /** Label → repo-relative path, e.g. architecture: ARCHITECTURE.md */
  docs: Record<string, string>;
  health?: {
    workers?: string[];
    links?: string[];
  };
};

export type ParsedRange = { range: Range } | { problems: string[] };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;

const httpsOk = (u: string) => {
  try {
    const p = new URL(u).protocol;
    return p === "https:" || p === "http:";
  } catch {
    return false;
  }
};

export function parseRange(raw: unknown): ParsedRange {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { problems: ["range.yaml must be a mapping."] };
  }
  const c = raw as Record<string, unknown>;
  const problems: string[] = [];

  const name = str(c.name);
  if (!name) problems.push("name is required.");

  const tier = str(c.tier) || "active";
  const description = str(c.description) || undefined;
  const url = str(c.url) || undefined;
  if (url && !httpsOk(url)) problems.push("url must be a valid URL.");

  let components: RangeComponent[] = [];
  if (c.components !== undefined) {
    if (!Array.isArray(c.components)) {
      problems.push("components must be a list.");
    } else {
      components = c.components.map((comp: unknown, i) => {
        if (!comp || typeof comp !== "object" || Array.isArray(comp)) {
          problems.push(`component ${i} must be a mapping.`);
          return { name: `comp-${i}`, owns: [] };
        }
        const m = comp as Record<string, unknown>;
        const cname = str(m.name);
        if (!cname) problems.push(`component ${i} missing name.`);
        const owns = strArray(m.owns) ?? [];
        if (!m.owns) problems.push(`component ${i} missing owns.`);
        const rules = str(m.rules) || undefined;
        return { name: cname || `comp-${i}`, owns, rules };
      });
    }
  }

  let docs: Record<string, string> = {};
  if (c.docs !== undefined) {
    if (!c.docs || typeof c.docs !== "object" || Array.isArray(c.docs)) {
      problems.push("docs must be a mapping of label -> path.");
    } else {
      for (const [k, v] of Object.entries(c.docs as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) {
          docs[k] = v.trim();
        }
      }
    }
  }

  let health: Range["health"] = undefined;
  if (c.health !== undefined) {
    if (!c.health || typeof c.health !== "object" || Array.isArray(c.health)) {
      problems.push("health must be a mapping.");
    } else {
      const h = c.health as Record<string, unknown>;
      const workers = strArray(h.workers) ?? undefined;
      const links = strArray(h.links) ?? undefined;
      health = { workers, links };
    }
  }

  if (problems.length > 0) return { problems };

  return {
    range: {
      name,
      description,
      url,
      tier,
      components,
      docs,
      health,
    },
  };
}
