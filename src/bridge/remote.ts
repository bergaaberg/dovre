/**
 * The agents desk, hosted (PLAN D24, WP-N10): the Mac's, over the bridge. What lists draw comes
 * from the hub's kept metadata (fetched again at most every couple of seconds, before a page is
 * drawn: src/worker.ts); a session's conversation and every action are calls down to the Mac,
 * answered for that one request. The Mac offline: the lists show what it last said, a session's
 * page its metadata without the conversation, and actions say it's offline. Never empty.
 */
import type { Desk, DeskView, Done } from "../agents/desk.ts";
import { HARNESSES, type HarnessId, type Run } from "../agents/runner.ts";
import type { HubClient } from "../hosted/client.ts";
import type { MacView } from "../hosted/hub.ts";
import type { Session } from "../sources/claude.ts";
import type { Call } from "./wire.ts";

export type RemoteDesk = Desk & {
  /** Reads the hub's view of the Mac again, unless it did a moment ago. */
  refresh(): Promise<void>;
};

const EMPTY = { live: [] as Session[], recent: [] as Session[] };
/** A page waits this long for what the Mac says, then draws what it last said. */
const READ_MS = 4000;

export function remoteDesk(hub: Pick<HubClient, "mac" | "call">, o: { ttlMs?: number; now?: () => number } = {}): RemoteDesk {
  const ttl = o.ttlMs ?? 2000;
  const now = o.now ?? Date.now;
  let last: MacView | undefined;
  let at = 0;
  let inflight: Promise<void> | undefined;

  const call = async (c: Call, ms?: number): Promise<unknown> => {
    const a = await hub.call(c, ms);
    if (!a.ok) {
      // It went offline, or never was: lists should know at once.
      if (a.offline) at = 0;
      throw new Error(a.error);
    }
    return a.value;
  };
  /** An action changed what lists show: the next page reads the hub again. */
  const acted = <T>(p: Promise<T>) => p.finally(() => (at = 0));
  const sessions = () => (last?.state?.sessions as typeof EMPTY | undefined) ?? EMPTY;
  const page = (sid: string) => `/agents/s/${sid}`;

  return {
    refresh() {
      if (now() - at < ttl) return Promise.resolve();
      return (inflight ??= hub
        .mac()
        .then((v) => {
          last = v;
          at = now();
        })
        .catch(() => {})
        .finally(() => (inflight = undefined)));
    },
    view(): DeskView {
      const s = last?.state;
      return {
        remote: true,
        here: !!last?.online,
        online: !!last?.online,
        seen: last?.seen,
        harnesses: (s?.harnesses ?? []).filter((h): h is HarnessId => (HARNESSES as readonly string[]).includes(h)),
        runs: (s?.runs ?? []) as Run[],
        workDir: s?.workDir ?? "",
        sessions: s ? sessions() : undefined,
      };
    },
    repos: () => call({ op: "repos" }, READ_MS).then((v) => (Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : []), () => []),
    run: (id) => call({ op: "run", id }, READ_MS).then((v) => (v as Run | null) ?? undefined, () => undefined),
    async session(sid) {
      try {
        return ((await call({ op: "session", sid }, READ_MS)) as Awaited<ReturnType<Desk["session"]>> | null) ?? undefined;
      } catch {
        // Offline (or slow): the session as the Mac last listed it, without the conversation.
        const s = [...sessions().live, ...sessions().recent].find((x) => x.sessionId === sid);
        const run = (last?.state?.runs as Run[] | undefined)?.find((r) => r.sessionId === sid);
        return s || run ? { session: s, turns: run ? [{ role: "user" as const, text: run.prompt }] : [], run, queued: [], discardable: false } : undefined;
      }
    },
    start: (f) => acted(call({ op: "start", repo: f.repo, prompt: f.prompt, harness: f.harness, mode: f.mode, model: f.model }).then((v) => v as { to: string } | { error: string }, (e) => ({ error: (e as Error).message }))),
    reply: (sid, f) => acted(call({ op: "reply", sid, prompt: f.prompt, mode: f.mode, model: f.model }).then((v) => v as Done, (e) => ({ to: page(sid), flash: (e as Error).message }))),
    answer: (sid, form) => acted(call({ op: "answer", sid, form }).then((v) => v as Done, (e) => ({ to: page(sid), flash: (e as Error).message }))),
    allow: (sid, f) => acted(call({ op: "allow", sid, specs: f.specs, mode: f.mode, model: f.model }).then((v) => v as Done, (e) => ({ to: page(sid), flash: (e as Error).message }))),
    dequeue: (sid, id) => acted(call({ op: "dequeue", sid, id }).then(() => {}, () => {})),
    stop: (sid) => acted(call({ op: "stop", sid }).then(() => {}, () => {})),
    stopRun: (id) => acted(call({ op: "stopRun", id }).then(() => {}, () => {})),
    discard: (sid) => acted(call({ op: "discard", sid }).then((v) => v as { cleared: string[] } | { flash: string }, (e) => ({ flash: (e as Error).message }))),
    discardRun: (id) => acted(call({ op: "discardRun", id }).then((v) => v as { cleared: string[] }, () => ({ cleared: [] }))),
    clear: () => acted(call({ op: "clear" }).then((v) => v as { cleared: string[] }, () => ({ cleared: [] }))),
  };
}
