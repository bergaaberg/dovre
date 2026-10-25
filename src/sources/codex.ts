/**
 * Codex's sessions (PLAN WP-M1), from CODEX_HOME (default ~/.codex), metadata only:
 * history.jsonl gives each session's prompts ({ session_id, ts (seconds), text }: the first is its
 * title, the newest its last prompt), and each session's rollout file
 * (sessions/YYYY/MM/DD/rollout-…-<id>.jsonl) gives its folder from its first line (session_meta:
 * { id, cwd }) and when it last moved (the file's time). Nothing else of a rollout is read: what
 * the model said and what its commands printed stay in Codex's files.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoOf } from "../format.ts";
import type { Session } from "./claude.ts";

export const defaultCodexDir = (): string => process.env.CODEX_HOME || join(homedir(), ".codex");

/** The first line of a file, at most `max` bytes of it. */
function firstLine(file: string, max = 256 * 1024): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    closeSync(fd);
  }
}

/** A rollout's id and folder from its first line: `session_meta` now, a bare header in older files. */
export function rolloutMeta(line: string): { id: string; cwd?: string; at?: string } | undefined {
  try {
    const j = JSON.parse(line);
    const p = j?.type === "session_meta" ? j.payload : j;
    if (typeof p?.id !== "string" || !p.id) return undefined;
    return { id: p.id, cwd: typeof p.cwd === "string" ? p.cwd : undefined, at: typeof p.timestamp === "string" ? p.timestamp : undefined };
  } catch {
    return undefined;
  }
}

/** The newest rollout files, newest day first: at most `max`. */
function rollouts(root: string, max: number): string[] {
  const dir = join(root, "sessions");
  const out: string[] = [];
  const desc = (d: string) => {
    try {
      return readdirSync(d).filter((n) => !n.startsWith(".")).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of desc(dir))
    for (const m of desc(join(dir, y)))
      for (const d of desc(join(dir, y, m))) {
        for (const f of desc(join(dir, y, m, d))) if (/^rollout-.*\.jsonl$/.test(f)) out.push(join(dir, y, m, d, f));
        if (out.length >= max) return out.slice(0, max);
      }
  return out;
}

export function loadCodexSessions(root = defaultCodexDir(), opts: { maxRecent?: number } = {}): { live: Session[]; recent: Session[] } {
  if (!existsSync(root)) return { live: [], recent: [] };
  const prompts = new Map<string, { first?: { at: number; text: string }; last?: { at: number; text: string } }>();
  try {
    for (const line of readFileSync(join(root, "history.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (typeof j.session_id !== "string" || typeof j.text !== "string" || !j.text.trim()) continue;
        const at = Number(j.ts ?? 0) * 1000;
        const p = prompts.get(j.session_id) ?? {};
        if (!p.first || at < p.first.at) p.first = { at, text: j.text };
        if (!p.last || at >= p.last.at) p.last = { at, text: j.text };
        prompts.set(j.session_id, p);
      } catch {}
    }
  } catch {}
  const recent: Session[] = [];
  for (const file of rollouts(root, (opts.maxRecent ?? 50) * 2)) {
    let meta: ReturnType<typeof rolloutMeta>;
    let mtime = 0;
    try {
      meta = rolloutMeta(firstLine(file));
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!meta) continue;
    // Dovre's own summary and Bino calls through Codex (src/ai/llm.ts) aren't sessions.
    if (meta.cwd && /[\\/]dovre-llm-codex$/.test(meta.cwd)) continue;
    const p = prompts.get(meta.id);
    recent.push({
      sessionId: meta.id,
      harness: "codex",
      live: false,
      cwd: meta.cwd,
      repo: repoOf(meta.cwd),
      title: p?.first?.text.slice(0, 200).replace(/\r?\n/g, " "),
      lastPrompt: p?.last?.text,
      lastAt: new Date(Math.max(mtime, p?.last?.at ?? 0)).toISOString(),
      prs: [],
      subagentsRunning: 0,
    });
  }
  recent.sort((a, b) => Date.parse(b.lastAt!) - Date.parse(a.lastAt!));
  return { live: [], recent: recent.slice(0, opts.maxRecent ?? 50) };
}
