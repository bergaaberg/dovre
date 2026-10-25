/**
 * Reads agy (Antigravity CLI) session state from ~/.gemini/antigravity-cli/ (PLAN D12, WP-G4).
 * Reads history.jsonl and brain/<conversation-id>/ transcripts.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoOf } from "../format.ts";
import type { Session } from "./claude.ts";

export type AgyOpts = {
  now?: number;
  maxRecent?: number;
};

export function defaultAgyDir(): string {
  return process.env.AGY_DIR || process.env.AGY_HOME || join(homedir(), ".gemini", "antigravity-cli");
}

export type HistoryEntry = {
  conversationId: string;
  workspace?: string;
  timestamp?: number;
  display?: string;
  /** A slash command (/quit, /model): it moves the time, but isn't a prompt. */
  command?: boolean;
};

export function parseHistoryLine(line: string): HistoryEntry | undefined {
  if (!line || !line.trim()) return undefined;
  try {
    const j = JSON.parse(line.trim());
    if (typeof j.conversationId === "string" && j.conversationId) {
      return {
        conversationId: j.conversationId,
        workspace: typeof j.workspace === "string" ? j.workspace : undefined,
        timestamp: typeof j.timestamp === "number" ? j.timestamp : undefined,
        display: typeof j.display === "string" ? j.display : undefined,
        command: j.type === "slash_command" || (typeof j.display === "string" && /^\/\w+\s*$/.test(j.display)),
      };
    }
  } catch {}
  return undefined;
}

export function loadAgySessions(root = defaultAgyDir(), opts: AgyOpts = {}): { live: Session[]; recent: Session[] } {
  const historyFile = join(root, "history.jsonl");
  if (!existsSync(historyFile)) return { live: [], recent: [] };

  // Title: the first prompt; last prompt: the newest. Slash commands only move lastAt.
  const byId = new Map<string, { workspace?: string; lastAt: number; first?: { at: number; text: string }; last?: { at: number; text: string } }>();

  try {
    const text = readFileSync(historyFile, "utf8");
    for (const line of text.split("\n")) {
      const entry = parseHistoryLine(line);
      if (!entry) continue;
      const at = entry.timestamp ?? 0;
      const info = byId.get(entry.conversationId) ?? { lastAt: 0 };
      if (at >= info.lastAt) {
        info.lastAt = at;
        info.workspace = entry.workspace ?? info.workspace;
      }
      if (entry.display && !entry.command) {
        if (!info.first || at < info.first.at) info.first = { at, text: entry.display };
        if (!info.last || at >= info.last.at) info.last = { at, text: entry.display };
      }
      byId.set(entry.conversationId, info);
    }
  } catch {
    return { live: [], recent: [] };
  }

  const recent: Session[] = [];
  const max = opts.maxRecent ?? 50;

  for (const [id, info] of byId.entries()) {
    const cwd = info.workspace;
    // Dovre's own summary and Bino calls through agy (src/ai/llm.ts) aren't sessions.
    if (cwd && /[\\/]dovre-llm-agy$/.test(cwd)) continue;
    const title = info.first ? info.first.text.slice(0, 200).replace(/\r?\n/g, " ") : undefined;

    recent.push({
      sessionId: id,
      harness: "agy",
      live: false,
      cwd,
      repo: repoOf(cwd),
      title,
      lastPrompt: info.last?.text,
      lastAt: info.lastAt ? new Date(info.lastAt).toISOString() : undefined,
      prs: [],
      subagentsRunning: 0,
    });
  }

  // Sort newest first
  recent.sort((a, b) => (b.lastAt ? Date.parse(b.lastAt) : 0) - (a.lastAt ? Date.parse(a.lastAt) : 0));

  return {
    live: [],
    recent: recent.slice(0, max),
  };
}
