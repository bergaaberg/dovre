/**
 * The agents desk, hosted (PLAN D24, WP-N10, H7): the machines', over the bridge. What lists draw
 * comes from the hub's kept metadata (fetched again at most every couple of seconds, before a page
 * is drawn: src/worker.ts), every machine's merged; a session's conversation and every action are
 * calls down to the machine the session or run is on, answered for that one request. A new session
 * starts on the machine the form names, or the one online. A machine offline: the lists show what
 * it last said, a session's page its metadata without the conversation, and actions say it's
 * offline. Never empty.
 *
 * Each person sees only the machines they paired, and those nobody did (Team T4: the hub knows who
 * paired each, src/hosted/hub.ts; the request says who's looking, src/viewer.ts). Everything here
 * goes through `machines()`, and every call names a machine that person sees: another's sessions,
 * runs and actions are as if they weren't there.
 */
import type { Desk, DeskView, Done, MachineStatus } from "../agents/desk.ts";
import { HARNESSES, type HarnessId, type Run } from "../agents/runner.ts";
import type { HubClient } from "../hosted/client.ts";
import type { MacView, MachineView } from "../hosted/hub.ts";
import type { Session } from "../sources/claude.ts";
import { currentViewer, sees } from "../viewer.ts";
import { LEGACY_MACHINE, type Call } from "./wire.ts";

export type RemoteDesk = Desk & {
  /** Reads the hub's view of the machines again, unless it did a moment ago. */
  refresh(): Promise<void>;
  /** The models the machines online found in a harness's config (#238), without its default; none: the fixed list stays. */
  foundModels(id: HarnessId): { value: string; label: string }[];
};

type Sessions = { live: Session[]; recent: Session[] };
const EMPTY: Sessions = { live: [], recent: [] };
/** A page waits this long for what a machine says, then draws what it last said. */
const READ_MS = 4000;

/** How a machine is named on pages: the one from before several is "Mac"; else its own name. */
export const machineName = (m: Pick<MachineView, "id" | "name">) => (m.id === LEGACY_MACHINE ? "Mac" : m.name || `machine ${m.id.slice(0, 6)}`);

export function remoteDesk(hub: Pick<HubClient, "mac" | "call">, o: { ttlMs?: number; now?: () => number } = {}): RemoteDesk {
  const ttl = o.ttlMs ?? 2000;
  const now = o.now ?? Date.now;
  let last: MacView | undefined;
  let at = 0;
  let inflight: Promise<void> | undefined;
  /** Which machine each session and run is on, from what they last said. */
  let owner = new Map<string, string>();

  /** The machines the person looking may see. */
  const machines = () => (last?.machines ?? []).filter((m) => sees(currentViewer(), m.owner));
  const online = () => machines().filter((m) => m.online);
  const several = () => machines().length > 1;

  /** A call to `machine` (else the one online), only ever one this person sees: the hub would pick any. */
  const call = async (machine: string | undefined, c: Call, ms?: number): Promise<unknown> => {
    const on = online();
    const to = machine ?? (on.length === 1 ? on[0]!.id : undefined);
    if (!to) throw new Error(on.length ? "Say which machine." : "No machine is online.");
    if (!machines().some((m) => m.id === to)) throw new Error("That machine isn't paired.");
    const a = await hub.call(c, ms, to);
    if (!a.ok) {
      // It went offline, or never was: lists should know at once.
      if (a.offline) at = 0;
      throw new Error(a.error);
    }
    return a.value;
  };
  /** An action changed what lists show: the next page reads the hub again. */
  const acted = <T>(p: Promise<T>) => p.finally(() => (at = 0));
  /** The machine a session or run is on; else, with only one machine online, that one. */
  const whose = (id: string): string | undefined => owner.get(id) ?? (online().length === 1 ? online()[0]!.id : undefined);
  const stateSessions = (m: MachineView) => (m.state?.sessions as Sessions | undefined) ?? EMPTY;
  const tag = <T extends object>(x: T, m: MachineView): T => (several() ? { ...x, machine: machineName(m) } : x);
  const page = (sid: string) => `/agents/s/${sid}`;
  /** Asks each machine online in turn, until one has it. */
  const firstOf = async <T>(ask: (machine: string) => Promise<T | undefined>): Promise<T | undefined> => {
    for (const m of online()) {
      const v = await ask(m.id).catch(() => undefined);
      if (v) return v;
    }
    return undefined;
  };

  return {
    refresh() {
      if (now() - at < ttl) return Promise.resolve();
      return (inflight ??= hub
        .mac()
        .then((v) => {
          last = v;
          at = now();
          const next = new Map<string, string>();
          for (const m of v.machines) {
            const s = stateSessions(m);
            for (const x of [...s.live, ...s.recent]) if (x?.sessionId) next.set(x.sessionId, m.id);
            for (const r of (m.state?.runs ?? []) as Run[]) for (const k of [r.id, r.sessionId, r.resumed]) if (k) next.set(k, m.id);
          }
          owner = next;
        })
        .catch(() => {})
        .finally(() => (inflight = undefined)));
    },
    view(): DeskView {
      const all = machines();
      const on = online();
      const seen = Math.max(0, ...all.map((m) => m.seen ?? 0)) || undefined;
      const sessions = all.length ? { live: all.flatMap((m) => stateSessions(m).live.map((x) => tag(x, m))), recent: all.flatMap((m) => stateSessions(m).recent.map((x) => tag(x, m))) } : undefined;
      return {
        remote: true,
        here: on.length > 0,
        online: on.length > 0,
        seen,
        machines: all.map((m): MachineStatus => ({ id: m.id, name: machineName(m), online: m.online, seen: m.seen })),
        harnesses: [...new Set(on.flatMap((m) => m.state?.harnesses ?? []))].filter((h): h is HarnessId => (HARNESSES as readonly string[]).includes(h)),
        runs: all.flatMap((m) => ((m.state?.runs ?? []) as Run[]).map((r) => tag(r, m))),
        workDir: on[0]?.state?.workDir ?? "",
        sessions,
        // Sandbox runs: offered when a machine online can start one (the machine says why not, if the picked one can't).
        ...(on.some((m) => m.state?.sandbox) ? { sandbox: { ok: true as const } } : {}),
      };
    },
    foundModels(id) {
      const seen = new Set<string>();
      return online().flatMap((m) => m.state?.models?.[id] ?? []).filter((x) => x.value !== "" && !seen.has(x.value) && !!seen.add(x.value));
    },
    machineOf(id) {
      const m = machines().find((x) => x.id === owner.get(id));
      return m ? { id: m.id, name: machineName(m), online: m.online, seen: m.seen } : undefined;
    },
    async repos(machine) {
      const ask = (id: string) => call(id, { op: "repos" }, READ_MS).then((v) => (Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : []));
      // One machine asked by name: not answering is an error, not an empty folder (auto runs tell them apart).
      if (machine) return ask(machine);
      return [...new Set((await Promise.all(online().map((m) => ask(m.id).catch(() => [] as string[])))).flat())].sort();
    },
    run: (id) => {
      const m = whose(id);
      const ask = (machine: string) => call(machine, { op: "run", id }, READ_MS).then((v) => (v as Run | null) ?? undefined);
      return (m ? ask(m).catch(() => undefined) : firstOf(ask)) as Promise<Run | undefined>;
    },
    async session(sid) {
      const m = whose(sid);
      const ask = async (machine: string) => ((await call(machine, { op: "session", sid }, READ_MS)) as Awaited<ReturnType<Desk["session"]>> | null) ?? undefined;
      try {
        const v = m ? await ask(m) : await firstOf(ask);
        if (v) return v;
        if (!m) throw new Error("not found");
        return undefined;
      } catch {
        // Offline (or slow): the session as its machine last listed it, without the conversation.
        const all = machines();
        const s = all.flatMap((x) => [...stateSessions(x).live, ...stateSessions(x).recent]).find((x) => x.sessionId === sid);
        const run = all.flatMap((x) => (x.state?.runs ?? []) as Run[]).find((r) => r.sessionId === sid);
        return s || run ? { session: s, turns: run ? [{ role: "user" as const, text: run.prompt }] : [], run, queued: [], discardable: false } : undefined;
      }
    },
    start: (f) => {
      const on = online();
      const machine = typeof f.machine === "string" && f.machine ? f.machine : on.length === 1 ? on[0]!.id : undefined;
      if (!machine) return Promise.resolve({ error: on.length ? "Pick the machine to run it on." : "No machine is online." });
      if (!machines().some((m) => m.id === machine)) return Promise.resolve({ error: "That machine isn't paired." });
      return acted(call(machine, { op: "start", repo: f.repo, prompt: f.prompt, harness: f.harness, mode: f.mode, model: f.model, effort: f.effort, sandbox: f.sandbox === "on" || f.sandbox === true, ...(f.caps ? { caps: f.caps } : {}), ...(typeof f.also === "string" && f.also ? { also: f.also } : {}) }).then((v) => v as { to: string; run?: string } | { error: string }, (e) => ({ error: (e as Error).message })));
    },
    reply: (sid, f) => acted(call(whose(sid), { op: "reply", sid, prompt: f.prompt, mode: f.mode, model: f.model, effort: f.effort, copy: f.copy === "on" || f.copy === true }).then((v) => v as Done, (e) => ({ to: page(sid), flash: (e as Error).message }))),
    answer: (sid, form) => acted(call(whose(sid), { op: "answer", sid, form }).then((v) => v as Done, (e) => ({ to: page(sid), flash: (e as Error).message }))),
    allow: (sid, f) => acted(call(whose(sid), { op: "allow", sid, specs: f.specs, mode: f.mode, model: f.model, effort: f.effort }).then((v) => v as Done, (e) => ({ to: page(sid), flash: (e as Error).message }))),
    dequeue: (sid, id) => acted(call(whose(sid), { op: "dequeue", sid, id }).then(() => {}, () => {})),
    stop: (sid) => acted(call(whose(sid), { op: "stop", sid }).then(() => {}, () => {})),
    stopRun: (id) => acted(call(whose(id), { op: "stopRun", id }).then(() => {}, () => {})),
    discard: (sid) => acted(call(whose(sid), { op: "discard", sid }).then((v) => v as { cleared: string[] } | { flash: string }, (e) => ({ flash: (e as Error).message }))),
    discardRun: (id) => acted(call(whose(id), { op: "discardRun", id }).then((v) => v as { cleared: string[] }, () => ({ cleared: [] }))),
    pushSandbox: (id) => acted(call(whose(id), { op: "pushSandbox", id }, 25_000).then((v) => v as { repo: string; branch: string; head: string } | { error: string }, (e) => ({ error: (e as Error).message }))),
    landed: (id, pr) => acted(call(whose(id), { op: "landed", id, pr: { number: pr.number, url: pr.url } }).then(() => {}, () => {})),
    // Every machine online clears its own.
    clear: () =>
      acted(
        Promise.all(online().map((m) => call(m.id, { op: "clear" }).then((v) => (v as { cleared: string[] }).cleared ?? [], () => [] as string[]))).then((all) => ({ cleared: all.flat() })),
      ),
  };
}
