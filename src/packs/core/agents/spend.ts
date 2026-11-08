/**
 * Agent spend per day, from the transcripts on this machine, read without touching them:
 * - Claude Code (`~/.claude/projects/<cwd>/<session>.jsonl`): `cost-state` lines carry the session's
 *   running total (it goes on across a resume) and no time; a rise is put on the day of the line
 *   before it that has one.
 * - omp (`~/.omp/agent/sessions/<cwd>/<time>_<id>.jsonl`, and each profile's): each assistant
 *   message has its own cost and time. omp runs on Copilot, so its cost is the list price.
 * Only numbers come out: a file's lines are read for their cost and time, nothing else is kept.
 * Files are read as streams (no long stall) and only again when their size or time changes.
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { currentTz, dtf, osloDay } from "../../../when.ts";
import type { PackStat } from "../../types.ts";

export type SpendDay = { day: string; claude: number; omp: number; sessions: number };

export { osloDay };

const TS = /"timestamp":"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/;

/** One Claude Code transcript's lines: cost per day. */
export function claudeCostDays(lines: Iterable<string>, tz = currentTz()): Map<string, number> {
  const out = new Map<string, number>();
  let last: string | undefined;
  let prev = 0;
  for (const line of lines) {
    if (line.includes('"type":"cost-state"')) {
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const total = Number(j.totalCostUSD);
      if (!Number.isFinite(total)) continue;
      // A total that fell started counting again.
      const rise = total >= prev ? total - prev : total;
      prev = total;
      const when = last ?? (Number.isFinite(j.startTime) ? new Date(j.startTime).toISOString() : undefined);
      if (rise > 0 && when) out.set(osloDay(when, tz), (out.get(osloDay(when, tz)) ?? 0) + rise);
      continue;
    }
    const i = line.lastIndexOf('"timestamp":"');
    if (i >= 0) {
      const m = TS.exec(line.slice(i, i + 50));
      if (m) last = m[1];
    }
  }
  return out;
}

/** One omp session's lines: cost per day, from each assistant message's usage. */
export function ompCostDays(lines: Iterable<string>, tz = currentTz()): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) {
    if (!line.includes('"role":"assistant"') || !line.includes('"usage"')) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const cost = Number(j.message?.usage?.cost?.total);
    const at = j.timestamp ?? j.message?.timestamp;
    if (!Number.isFinite(cost) || cost <= 0 || !at) continue;
    const d = osloDay(at, tz);
    out.set(d, (out.get(d) ?? 0) + cost);
  }
  return out;
}

async function* linesOf(file: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}
async function collect(file: string): Promise<string[]> {
  // Only the lines either reader looks at: cost lines, and the short stretch where a time is.
  const keep: string[] = [];
  for await (const line of linesOf(file)) {
    if (line.includes('"type":"cost-state"') || line.includes('"role":"assistant"')) keep.push(line.includes('"type":"cost-state"') || line.includes('"usage"') ? line : "");
    else {
      const i = line.lastIndexOf('"timestamp":"');
      if (i >= 0) keep.push(line.slice(i, i + 50));
    }
  }
  return keep;
}

type Kept = { size: number; mtime: number; kind: "claude" | "omp"; days: Map<string, number> };

/** Transcript files changed in the last `days`, under Claude Code's projects and omp's session folders. */
function filesOf(claudeDir: string | undefined, ompDirs: string[], since: number): { file: string; kind: "claude" | "omp" }[] {
  const out: { file: string; kind: "claude" | "omp" }[] = [];
  const walk = (root: string, kind: "claude" | "omp") => {
    if (!existsSync(root)) return;
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      let names: string[];
      try {
        names = readdirSync(join(root, d.name));
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        const file = join(root, d.name, n);
        try {
          if (statSync(file).mtimeMs >= since) out.push({ file, kind });
        } catch {}
      }
    }
  };
  if (claudeDir) walk(join(claudeDir, "projects"), "claude");
  for (const d of ompDirs) walk(join(d, "sessions"), "omp");
  return out;
}

export type Spend = { days(): Promise<SpendDay[]>; /** Days known already, without reading (fixtures). */ known?(): SpendDay[] | undefined };

export function createSpend(o: { claudeDir?: string; ompDirs?: string[]; days?: number; now?: () => number }): Spend {
  const now = o.now ?? Date.now;
  const span = o.days ?? 42;
  const kept = new Map<string, Kept>();
  return {
    async days() {
      const since = now() - span * 86400e3;
      const files = filesOf(o.claudeDir, o.ompDirs ?? [], since);
      for (const { file, kind } of files) {
        let st;
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        const k = kept.get(file);
        if (k && k.size === st.size && k.mtime === st.mtimeMs) continue;
        try {
          const lines = await collect(file);
          kept.set(file, { size: st.size, mtime: st.mtimeMs, kind, days: kind === "claude" ? claudeCostDays(lines) : ompCostDays(lines) });
        } catch {}
      }
      const live = new Set(files.map((f) => f.file));
      for (const f of kept.keys()) if (!live.has(f)) kept.delete(f);
      const byDay = new Map<string, SpendDay>();
      for (let t = since; t <= now(); t += 86400e3) byDay.set(osloDay(t), { day: osloDay(t), claude: 0, omp: 0, sessions: 0 });
      byDay.set(osloDay(now()), byDay.get(osloDay(now())) ?? { day: osloDay(now()), claude: 0, omp: 0, sessions: 0 });
      for (const k of kept.values())
        for (const [day, cost] of k.days) {
          const d = byDay.get(day);
          if (!d) continue;
          d[k.kind] += cost;
          d.sessions++;
        }
      return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
    },
  };
}

/** Spend kept for /stats: read again when Stats asks and it's older than ten minutes, never awaited. */
export function spendKeeper(spend: Spend, o: { now?: () => number; onChange?: () => void } = {}) {
  const now = o.now ?? Date.now;
  let days: SpendDay[] | undefined;
  let at = 0;
  let reading = false;
  return {
    days: () => spend.known?.() ?? days,
    read(force = false) {
      if (reading || (!force && now() - at <= 10 * 60e3)) return;
      reading = true;
      spend.days().then(
        (d) => {
          days = d;
          at = now();
        },
        () => {},
      ).finally(() => {
        reading = false;
        o.onChange?.();
      });
    },
  };
}

const total = (d: SpendDay) => d.claude + d.omp;
const dayLabel = (key: string, o: Intl.DateTimeFormatOptions) => dtf("en-GB", { timeZone: "UTC", ...o }).format(Date.parse(`${key}T12:00:00Z`));

/** Agent spend on /stats: the last seven days against the seven before, and per day over 30. */
export function spendStats(spend: SpendDay[] | undefined): PackStat[] {
  const empty = "Reading transcripts…";
  if (!spend?.length)
    return [
      { id: "spend-7d", title: "Agent spend, 7 days", unit: "money", value: undefined, empty },
      { id: "spend-daily", title: "Agent spend per day", unit: "money", labels: [], series: [], empty },
    ];
  const last7 = spend.slice(-7).reduce((a, d) => a + total(d), 0);
  const prev7 = spend.slice(-14, -7).reduce((a, d) => a + total(d), 0);
  const money = (n: number) => (n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);
  const days = spend.slice(-30);
  return [
    { id: "spend-7d", title: "Agent spend, 7 days", unit: "money", value: last7, note: `${money(prev7)} the 7 days before`, trend: spend.slice(-30).map(total) },
    {
      id: "spend-daily",
      title: "Agent spend per day",
      meta: "omp at list price",
      unit: "money",
      stacked: true,
      partialLast: true,
      labels: days.map((d) => dayLabel(d.day, { day: "numeric", month: "short" })),
      tips: days.map((d) => `${dayLabel(d.day, { weekday: "short", day: "numeric", month: "short" })} · ${d.sessions} ${d.sessions === 1 ? "session" : "sessions"}`),
      series: [{ name: "Claude Code", values: days.map((d) => d.claude) }, { name: "omp", values: days.map((d) => d.omp) }],
    },
  ];
}
