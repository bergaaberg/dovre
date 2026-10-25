/**
 * Bino's conversations: kept in memory, the last few in a store (locally data/bino.json, hosted the
 * Durable Object's own SQLite: what was said and proposed, nothing else), answered in the
 * background so a page never waits on the model. A reply publishes on the hub; the page fills
 * itself in. Hosted, pages reach this engine through the Durable Object (src/hosted/hub.ts), so
 * the `Bino` they see may answer asynchronously.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { type Act, type ActSpec, fenceOf, splitActs } from "./acts.ts";
import { type Plan, splitReply, systemOf, transcriptOf } from "./context.ts";
import { type BinoMemory, scopeOf } from "./memory.ts";
import type { Route } from "./route.ts";

export type Msg = { role: "user" | "assistant"; text: string; at: number; plan?: Plan; /** The list item the plan was added as. */ added?: number; /** What Bino proposes to do (src/packs/core/assistant/bino/acts.ts). */ acts?: Act[]; /** What I was looking at when I asked from the pane (src/packs/core/assistant/bino/view.ts). */ view?: string; cost?: number };
export type Conv = { id: string; title: string; at: number; /** The list item it's about, when it started from one. */ todo?: number; /** The app (a pack's id) it's about, when it started on one of its pages: its memory scope. */ app?: string; msgs: Msg[]; thinking: boolean; error?: string };

/** Where the last few conversations are kept between restarts. */
export type ConvStore = { load(): Conv[]; save(keep: Conv[]): void };

type P<T> = T | Promise<T>;
export type StartOpts = { todo?: number; view?: string; app?: string; /** What Bino knows right now, when the caller gathered it (hosted: the Worker, for the Durable Object). */ context?: string };

export const MAX_SAY = 8000;
const KEEP = 30;
const ON_DISK = 12;

/** Bino as pages see it: the engine here, or hosted the Durable Object's, asked over a fetch. */
export type Bino = {
  route: Route;
  memory: BinoMemory;
  /** What Bino sees, for its page's header. */
  sees?: string;
  list(): P<Conv[]>;
  get(id: string): P<Conv | undefined>;
  /** A new conversation, answered in the background. */
  start(text: string, o?: StartOpts): P<Conv>;
  /** Another message in one; false while Bino is still answering the last. */
  say(id: string, text: string, o?: { view?: string; context?: string }): P<boolean>;
  /** Marks a plan as added to the list. */
  added(id: string, index: number, todo: number): P<void>;
  /** An act Bino proposed: how it stands (sending, done, refused). */
  act(id: string, index: number, n: number): P<Act | undefined>;
  setAct(id: string, index: number, n: number, patch: Partial<Pick<Act, "done" | "sending" | "error">>): P<void>;
};

/** The engine itself: answers at once from memory. */
export type Engine = Pick<Bino, "route" | "memory" | "sees"> & {
  list(): Conv[];
  get(id: string): Conv | undefined;
  start(text: string, o?: StartOpts): Conv;
  say(id: string, text: string, o?: { view?: string; context?: string }): boolean;
  added(id: string, index: number, todo: number): void;
  act(id: string, index: number, n: number): Act | undefined;
  setAct(id: string, index: number, n: number, patch: Partial<Pick<Act, "done" | "sending" | "error">>): void;
  /** Resolves when nothing is being answered (tests). */
  idle(): Promise<void>;
};

/** data/bino.json: written whole, through a temporary file. */
export function fileStore(file: string): ConvStore {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as Conv[];
      } catch {
        return [];
      }
    },
    save(keep) {
      try {
        writeFileSync(`${file}.tmp`, JSON.stringify(keep));
        renameSync(`${file}.tmp`, file);
      } catch {}
    },
  };
}

export function createBino(o: {
  route: Route;
  memory: BinoMemory;
  /** What Bino knows right now; `given` is what the caller gathered, when it did. */
  context: (c: Conv, given?: string) => Promise<string>;
  onChange?: (c: Conv) => void;
  /** data/bino.json locally (a shorthand for fileStore). */
  file?: string;
  store?: ConvStore;
  /** Whether Bino may propose Teams messages and dev tasks (not hosted: nothing there sends them). */
  acts?: boolean;
  /** The packs' acts on now (src/packs/registry.ts actsFrom): told to Bino, and its blocks checked against them. */
  kinds?: () => ActSpec[];
  sees?: string;
  now?: () => number;
  log?: (line: string) => void;
}): Engine {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const convs = new Map<string, Conv>();
  const busy = new Set<Promise<void>>();
  const store = o.store ?? (o.file ? fileStore(o.file) : undefined);
  /** What the caller gathered for the answer it asked for: in memory only, for that one answer. */
  const given = new Map<string, string>();
  for (const c of store?.load() ?? []) if (c && typeof c.id === "string" && Array.isArray(c.msgs)) {
      // A send cut off by a restart: say so rather than look stuck.
      for (const a of c.msgs.flatMap((m) => m.acts ?? [])) if (a.sending) Object.assign(a, { sending: false, error: "Dovre restarted while this was sending: check the chat before sending again." });
      // …and an answer cut off by one.
      const cut = c.msgs.at(-1)?.role === "user" && !c.error;
      convs.set(c.id, { ...c, thinking: false, ...(cut ? { error: "Bino was interrupted (Dovre restarted) before answering: ask again." } : {}) });
    }
  const save = () => {
    if (!store) return;
    store.save([...convs.values()].sort((a, b) => b.at - a.at).slice(0, ON_DISK).map(({ thinking: _t, ...c }) => c as Conv));
  };
  const changed = (c: Conv) => {
    c.at = now();
    save();
    o.onChange?.(c);
  };
  const trim = () => {
    const old = [...convs.values()].sort((a, b) => b.at - a.at).slice(KEEP);
    for (const c of old) convs.delete(c.id);
  };

  /** A message as Bino hears it again: its own proposals as it wrote them, never what I changed or sent. */
  const said = (m: Msg) => ({ role: m.role, text: [m.view ? `[Looking at ${m.view}]` : "", m.text, ...(m.acts ?? []).map(fenceOf)].filter(Boolean).join("\n\n") });

  function answer(c: Conv) {
    const ask = o.route.ask;
    if (!o.route.ready || !ask) {
      given.delete(c.id);
      c.error = o.route.why ?? "Bino can't answer here.";
      changed(c);
      return;
    }
    c.thinking = true;
    c.error = undefined;
    changed(c);
    const job = (async () => {
      try {
        const context = await o.context(c, given.get(c.id));
        given.delete(c.id);
        const kinds = o.acts === false ? [] : (o.kinds?.() ?? []);
        const system = systemOf(context, await o.memory.prompt(c.app ? scopeOf(c.app) : undefined).catch(() => ""), { acts: o.acts ?? true, kinds });
        const { text, cost } = await ask({ system, user: transcriptOf(c.msgs.map(said)) });
        const { text: noPlan, plan } = splitReply(text);
        const { text: shown, acts } = splitActs(noPlan, kinds);
        c.msgs.push({ role: "assistant", text: shown || (plan ? "Here's a breakdown:" : acts.length ? "Here it is:" : "…"), at: now(), cost, ...(plan ? { plan } : {}), ...(acts.length ? { acts } : {}) });
      } catch (e) {
        c.error = `Bino didn't answer: ${String((e as Error).message ?? e).slice(0, 300)}`;
      }
      c.thinking = false;
      changed(c);
      // Memory, after the reply is out: only what was said, with the cheap model.
      if (!c.error && o.memory.available) {
        try {
          const r = await o.memory.reflect(
            c.msgs.map(({ role, text }) => ({ role, text })),
            async ({ system, user }) => (await ask({ system, user, model: o.route.reflectModel })).text,
            `bino:${c.id}`,
            c.app ? scopeOf(c.app) : undefined,
          );
          if (r) log(`bino memory: ${r.applied} applied, ${r.rejected} refused, ${r.dropped} malformed`);
        } catch (e) {
          log(`bino memory: reflect failed: ${String((e as Error).message ?? e).slice(0, 200)}`);
        }
      }
    })();
    busy.add(job);
    void job.finally(() => busy.delete(job));
  }

  const clean = (t: string) => t.replace(/\r\n?/g, "\n").trim().slice(0, MAX_SAY);
  return {
    route: o.route,
    memory: o.memory,
    sees: o.sees,
    list: () => [...convs.values()].sort((a, b) => b.at - a.at),
    get: (id) => convs.get(id),
    start(text, opts = {}) {
      const said = clean(text);
      const c: Conv = { id: randomUUID(), title: said.split("\n")[0]!.slice(0, 80) || "A conversation", at: now(), todo: opts.todo, ...(opts.app ? { app: opts.app } : {}), msgs: [{ role: "user", text: said, at: now(), ...(opts.view ? { view: opts.view } : {}) }], thinking: false };
      convs.set(c.id, c);
      trim();
      if (opts.context !== undefined) given.set(c.id, opts.context);
      answer(c);
      return c;
    },
    say(id, text, opts = {}) {
      const c = convs.get(id);
      const said = clean(text);
      if (!c || c.thinking || !said) return false;
      c.msgs.push({ role: "user", text: said, at: now(), ...(opts.view ? { view: opts.view } : {}) });
      if (opts.context !== undefined) given.set(c.id, opts.context);
      answer(c);
      return true;
    },
    added(id, index, todo) {
      const c = convs.get(id);
      const m = c?.msgs[index];
      if (c && m?.plan) {
        m.added = todo;
        changed(c);
      }
    },
    act: (id, index, n) => convs.get(id)?.msgs[index]?.acts?.[n],
    setAct(id, index, n, patch) {
      const c = convs.get(id);
      const a = c?.msgs[index]?.acts?.[n];
      if (!c || !a) return;
      Object.assign(a, patch);
      changed(c);
    },
    async idle() {
      while (busy.size) await Promise.all([...busy]);
    },
  };
}
