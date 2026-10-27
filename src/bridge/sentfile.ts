/**
 * The bridge's own record of what it sent home (#145): sent.jsonl in its data folder, one JSON
 * line a call and one a kind of frame an hour (src/sent.ts). Calls are written as they happen;
 * frames are counted in memory and written every few minutes and on stop, so a line may repeat
 * an hour and a kind: a reader sums them. Lines older than KEEP_DAYS go on start.
 * `dovre bridge sent` (launcher/sent.go) prints it.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAY_MS, KEEP_DAYS, type Ledger, parseLines, tally } from "../sent.ts";

export const SENT_FILE = "sent.jsonl";
/** Past this, the oldest half goes too. */
const MAX_BYTES = 4 << 20;

export type FileLedger = Ledger & { flush(): void; stop(): void };

export function fileLedger(file: string, o: { now?: () => number; flushMs?: number } = {}): FileLedger {
  const now = o.now ?? Date.now;
  prune(file, now());
  const frames = tally();
  const write = (lines: object[]) => {
    if (!lines.length) return;
    try {
      appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
    } catch {}
  };
  const flush = () => write(frames.take());
  const timer = setInterval(flush, o.flushMs ?? 5 * 60_000);
  timer.unref?.();
  return {
    call: (c) => write([{ k: "call", ...c }]),
    frame: (host, kind, bytes, at) => frames.add(host, kind, bytes, at ?? now()),
    flush,
    stop() {
      clearInterval(timer);
      flush();
    },
  };
}

/** Lines older than KEEP_DAYS, or a file grown past MAX_BYTES, trimmed (rewritten whole, then swapped in). */
export function prune(file: string, now = Date.now()) {
  if (!existsSync(file)) return;
  try {
    const text = readFileSync(file, "utf8");
    const since = now - KEEP_DAYS * DAY_MS;
    let lines = parseLines(text).filter((l) => (l.k === "call" ? l.at : l.hour) >= since);
    let out = lines.map((l) => JSON.stringify(l)).join("\n");
    if (out.length > MAX_BYTES) {
      lines = lines.slice(Math.floor(lines.length / 2));
      out = lines.map((l) => JSON.stringify(l)).join("\n");
    }
    const next = out ? out + "\n" : "";
    if (next === text) return;
    writeFileSync(file + ".tmp", next, { mode: 0o600 });
    renameSync(file + ".tmp", file);
  } catch {}
}

/** The file's lines, read back. */
export const readSent = (file: string) => {
  try {
    return parseLines(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
};

/** Where a bridge on this machine keeps its record: as the launcher's BridgeHome (launcher/bridge.go) says, then a checkout's. */
export function sentFiles(o: { env: Record<string, string | undefined>; home: string; platform: string; checkout: string }): string[] {
  const cfg = o.env.DOVRE_BRIDGE_HOME?.trim()
    ? o.env.DOVRE_BRIDGE_HOME.trim()
    : o.platform === "darwin"
      ? join(o.home, "Library", "Application Support", "dovre")
      : o.platform === "win32"
        ? join(o.env.APPDATA ?? join(o.home, "AppData", "Roaming"), "dovre")
        : join(o.env.XDG_CONFIG_HOME?.trim() || join(o.home, ".config"), "dovre");
  return [join(cfg, "bridge-data", SENT_FILE), join(o.checkout, "data", "bridge", SENT_FILE)];
}
