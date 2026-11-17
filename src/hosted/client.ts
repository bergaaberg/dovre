/**
 * The Worker's side of the hub (src/hosted/hub.ts): publish goes to the Durable Object, a page's
 * /live socket and /events stream are the object's, and Bino is asked there. Publishes are fetches the Worker must
 * not drop when its request ends, so they're kept until worker.ts hands them to waitUntil.
 */
import type { Bino, Conv } from "../packs/core/assistant/bino/bino.ts";
import type { BinoMemory } from "../packs/core/assistant/bino/memory.ts";
import type { Route } from "../packs/core/assistant/bino/route.ts";
import type { Hub } from "../live.ts";
import { currentViewer } from "../viewer.ts";
import type { Call } from "../bridge/wire.ts";
import type { CheckJob } from "../reviews/check.ts";
import type { Note, Rung } from "../notify.ts";
import { type Audience, type BinoOp, type MacAnswer, type MacView, OWN_HEADER, type PagesView, type ReceivedDay, type RingCall, VIEWER_HEADER, type Viewer } from "./hub.ts";

type Stub = { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
/** A Durable Object namespace binding, as much of it as this uses. */
export type HubNamespace = { idFromName(name: string): unknown; get(id: unknown): Stub };

export type HubClient = Hub & {
  /** A page's event stream: the object's, for this person. */
  events(v?: Viewer): Promise<Response>;
  bino(op: BinoOp): Promise<unknown>;
  /** The agent's check of my review, run in the object; `topic` is published when it's done. Rejects when it didn't start. */
  reviewCheck(job: CheckJob, topic: string): Promise<void>;
  /**
   * A gather finished at `at`: pages hear when (their "Synced"), and "snapshot" if it changed
   * anything. `who`: it was that person's own (#538), so only their pages hear; without, the
   * instance's, which the pages drawn from a person's own don't hear (#539).
   */
  gathered(at: number, changed: boolean, who?: string): void;
  /** Streams of needs a gather found (#551), once they're worked out: the object rings what's new in each. */
  ring(calls: Promise<RingCall[]>): void;
  /** Notes to ring now, as they are (a pack's ring, Settings' test). */
  notes(notes: Note[], to?: Audience): void;
  /** What rang lately (Settings → Notifications). */
  rung(): Promise<Rung[]>;
  /** Publishes still on their way (worker.ts waits for them after answering). */
  drain(): Promise<void>;
  /** A page's live socket (H5): its upgrade, handed to the object as it came, named for this person. */
  live(req: Request, v?: Viewer): Promise<Response>;
  /** How many pages listen, and for how many people (Settings → About). */
  pages(): Promise<PagesView>;
  /** A machine's bridge (WP-N10): its socket's upgrade, handed to the object as the worker named it. */
  bridge(req: Request): Promise<Response>;
  /** The machines: each online or last seen, and its metadata. */
  mac(): Promise<MacView>;
  /** What machines sent here (#145), per day and kind. */
  sent(): Promise<ReceivedDay[]>;
  /** A call of a machine's desk, answered within `ms`; without `machine`, the one online. */
  call(c: Call, ms?: number, machine?: string): Promise<MacAnswer>;
  /** A machine unpaired: shut out until `until`, its socket closed now. */
  revoke(machine: string, until: number): Promise<void>;
};

const BASE = "https://hub.internal";

/** The headers that name a listener's person to the object: set here alone, whatever the request carried. */
function named(from: Headers | undefined, v: Viewer | undefined): Headers {
  const h = new Headers(from);
  h.delete(VIEWER_HEADER);
  h.delete(OWN_HEADER);
  const who = v?.who?.trim().toLowerCase();
  if (who) {
    h.set(VIEWER_HEADER, who);
    if (v?.own) h.set(OWN_HEADER, "1");
  }
  return h;
}

export function hubClient(ns: HubNamespace): HubClient {
  const stub = () => ns.get(ns.idFromName("hub"));
  const pending = new Set<Promise<unknown>>();
  const keep = (p: Promise<unknown>) => {
    const q = p.catch((e) => console.error(`hub: ${(e as Error)?.message ?? e}`)).finally(() => pending.delete(q));
    pending.add(q);
  };
  return {
    publish(topics) {
      if (topics.length) keep(stub().fetch(`${BASE}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topics }) }));
    },
    gathered(at, changed, who) {
      const to = who?.trim() ? { for: who.trim().toLowerCase() } : { shared: true };
      keep(stub().fetch(`${BASE}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topics: changed ? ["snapshot"] : [], synced: at, ...to }) }));
    },
    ring(calls) {
      keep(
        calls.then((c) => {
          if (c.length) return stub().fetch(`${BASE}/ring`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ calls: c }) });
        }),
      );
    },
    notes(notes, to) {
      if (notes.length) keep(stub().fetch(`${BASE}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes, ...to }) }));
    },
    async rung() {
      const r = await stub().fetch(`${BASE}/rung`);
      return r.ok ? ((await r.json()) as Rung[]) : [];
    },
    // Pages subscribe to the object, never to an isolate.
    subscribe: () => () => {},
    size: () => 0,
    notifiers: () => 0,
    // A response from another object has immutable headers: re-wrapped, so the app's middleware can add its own.
    events: async (v) => {
      const r = await stub().fetch(`${BASE}/events`, { headers: named(undefined, v) });
      return new Response(r.body, { status: r.status, headers: new Headers(r.headers) });
    },
    async bino(op) {
      const res = await stub().fetch(`${BASE}/bino`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) });
      if (!res.ok) throw new Error(`Bino's hub answered ${res.status}`);
      return res.json();
    },
    async reviewCheck(job, topic) {
      const res = await stub().fetch(`${BASE}/review/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job, topic }) });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!res.ok || !b.ok) throw new Error(res.ok ? "the hub has no model to ask" : `the hub answered ${res.status}`);
    },
    async drain() {
      while (pending.size) await Promise.all([...pending]);
    },
    // A socket's upgrade answer can't be re-wrapped: it goes back as the object gave it.
    bridge: (req) => stub().fetch(new Request(`${BASE}/bridge`, req)),
    live: (req, v) => stub().fetch(new Request(`${BASE}/live`, new Request(req, { headers: named(req.headers, v) }))),
    async pages() {
      const res = await stub().fetch(`${BASE}/pages`);
      if (!res.ok) throw new Error(`The hub answered ${res.status}`);
      return (await res.json()) as PagesView;
    },
    async mac() {
      const res = await stub().fetch(`${BASE}/mac`);
      if (!res.ok) throw new Error(`The hub answered ${res.status}`);
      return (await res.json()) as MacView;
    },
    async sent() {
      const res = await stub().fetch(`${BASE}/sent`);
      if (!res.ok) throw new Error(`The hub answered ${res.status}`);
      return (await res.json()) as ReceivedDay[];
    },
    async call(c, ms, machine) {
      const res = await stub().fetch(`${BASE}/mac/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ call: c, ms, machine }) });
      return (await res.json().catch(() => ({ ok: false, error: `The hub answered ${res.status}` }))) as MacAnswer;
    },
    async revoke(machine, until) {
      const res = await stub().fetch(`${BASE}/mac/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ machine, until }) });
      if (!res.ok) throw new Error(`The hub answered ${res.status}`);
    },
  };
}

/** Bino as hosted pages see it: every call answered by the object. The route is the Worker's own copy, for ready and why. */
export function remoteBino(hub: HubClient, o: { route: Route; memory: BinoMemory; sees?: string }): Bino {
  // Whose request asks (#544): the answer's lookups run as them in the Worker, not as no one.
  const asker = () => {
    const who = currentViewer();
    return who ? { who } : {};
  };
  return {
    route: o.route,
    memory: o.memory,
    sees: o.sees,
    list: async () => (await hub.bino({ op: "list" })) as Conv[],
    get: async (id) => ((await hub.bino({ op: "get", id })) as Conv | null) ?? undefined,
    start: async (text, s = {}) => (await hub.bino({ op: "start", text, todo: s.todo, view: s.view, app: s.app, context: s.context ?? "", ...(s.setup ? { setup: s.setup } : {}), ...(s.carry ? { carry: s.carry } : {}), ...asker() })) as Conv,
    say: async (id, text, s = {}) => (await hub.bino({ op: "say", id, text, view: s.view, context: s.context ?? "", ...(s.brief ? { brief: s.brief } : {}), ...asker() })) === true,
    stop: async (id) => (await hub.bino({ op: "stop", id })) === true,
    retry: async (id, s = {}) => (await hub.bino({ op: "retry", id, context: s.context ?? "", ...(s.brief ? { brief: s.brief } : {}), ...asker() })) === true,
    rename: async (id, title) => (await hub.bino({ op: "rename", id, title })) === true,
    pin: async (id, on) => (await hub.bino({ op: "pin", id, on })) === true,
    remove: async (id) => (await hub.bino({ op: "remove", id })) === true,
    added: async (id, index, todo) => void (await hub.bino({ op: "added", id, index, todo })),
    act: async (id, index, n) => ((await hub.bino({ op: "get", id })) as Conv | null)?.msgs[index]?.acts?.[n],
    setAct: async (id, index, n, patch) => void (await hub.bino({ op: "setAct", id, index, n, patch: { ...("error" in patch ? { error: patch.error ?? null } : {}), ...("done" in patch ? { done: patch.done ?? null } : {}), ...("was" in patch ? { was: patch.was ?? null } : {}) } })),
  };
}
