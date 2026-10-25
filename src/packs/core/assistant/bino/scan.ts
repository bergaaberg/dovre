/**
 * Atlas scanner: discovers and parses range.yaml manifests across local checkouts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "yaml";
import { parseRange, type Range } from "./range.ts";

export type AtlasEntry = {
  repo: string;
  dir: string;
  range: Range;
};

export class AtlasScanner {
  private codeDir: string;
  private cachedAt = 0;
  private scanned = false;
  private cache = new Map<string, Range>();
  /** The folder's own name by its lowercased one: links (/code/:dir, /agents/new) need it exactly. */
  private folders = new Map<string, string>();
  private ttlMs: number;
  private now: () => number;

  constructor(codeDir: string, opts: { ttlMs?: number; now?: () => number } = {}) {
    this.codeDir = codeDir;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  scan(force = false): Map<string, Range> {
    const now = this.now();
    // The TTL holds for an empty cache too (a code folder with no manifests yet): without it,
    // every call rescans the folder synchronously, and /atlas's filter and every PR card call
    // this (WP-R6).
    if (!force && this.scanned && now - this.cachedAt < this.ttlMs) {
      return this.cache;
    }

    this.cache.clear();
    this.folders.clear();
    this.cachedAt = now;
    this.scanned = true;

    if (!existsSync(this.codeDir)) return this.cache;

    let entries: string[];
    try {
      entries = readdirSync(this.codeDir);
    } catch {
      return this.cache;
    }

    for (const name of entries) {
      const fullDir = join(this.codeDir, name);
      const yamlPath = existsSync(join(fullDir, "range.yaml"))
        ? join(fullDir, "range.yaml")
        : existsSync(join(fullDir, "range.yml"))
          ? join(fullDir, "range.yml")
          : undefined;

      if (!yamlPath) continue;

      try {
        const text = readFileSync(yamlPath, "utf8");
        const parsed = yaml.parse(text);
        const result = parseRange(parsed);
        if ("range" in result) {
          this.cache.set(name.toLowerCase(), result.range);
          this.folders.set(name.toLowerCase(), name);
        }
      } catch {}
    }

    return this.cache;
  }

  get(repoName: string): Range | undefined {
    this.scan();
    // Normalize "org/repo" or "repo"
    const short = repoName.replace(/^.*\//, "").toLowerCase();
    return this.cache.get(short);
  }

  list(): AtlasEntry[] {
    this.scan();
    const out: AtlasEntry[] = [];
    for (const [key, range] of this.cache.entries()) {
      const repo = this.folders.get(key) ?? key;
      out.push({
        repo,
        dir: join(this.codeDir, repo),
        range,
      });
    }
    return out.sort((a, b) => a.range.name.localeCompare(b.range.name));
  }
}
