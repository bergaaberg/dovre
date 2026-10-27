/**
 * The Worker's side of the hub (src/hosted/hub.ts): publish goes to the Durable Object, a page's
 * /live socket and /events stream are the object's, and Bino is asked there. Publishes are fetches the Worker must
 * not drop when its request ends, so they're kept until worker.ts hands them to waitUntil.
 */
import type { Bino, Conv } from "../packs/core/assistant/bino/bino.ts";
import type { BinoMemory } from "../packs/core/assistant/bino/memory.ts";
import type { Route } from "../packs/core/assistant/bino/route.ts";
import type { Hub } from "../live.ts";
import type { Call } from "../bridge/wire.ts";
import type { BinoOp, MacAnswer, MacView } from "./hub.ts";

type Stub = { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
/** A Durable Object namespace binding, as much of it as this uses. */
export type HubNamespace = { idFromName(name: string): unknown; get(id: unknown): Stub };

export type HubClient = Hub & {
  /** A page's event stream: the object's. */
  events(): Promise<Response>;
  bino(op: BinoOp): Promise<unknown>;
  /** A gather finished at `at`: pages hear when (their "Synced"), and "snapshot" if it changed anything. */
  gathered(at: number, changed: boolean): void;
  /** Publishes still on their way (worker.ts waits for them after answering). */
  drain(): Promise<void>;
  /** A page's live socket (H5): its upgrade, handed to the object as it came. */
  live(req: Request): Promise<Response>;
  /** A machine's bridge (WP-N10): its socket's upgrade, handed to the object as the worker named it. */
  bridge(req: Request): Promise<Response>;
  /** The machines: each online or last seen, and its metadata. */
  mac(): Promise<MacView>;
  /** A call of a machine's desk, answered within `ms`; without `machine`, the one online. */
  call(c: Call, ms?: number, machine?: string): Promise<MacAnswer>;
  /** A machine unpaired: shut out until `until`, its socket closed now. */
  revoke(machine: string, until: number): Promise<void>;
};

const BASE = "https://hub.internal";

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
    gathered(at, changed) {
      keep(stub().fetch(`${BASE}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topics: changed ? ["snapshot"] : [], synced: at }) }));
    },
    // Pages subscribe to the object, never to an isolate.
    subscribe: () => () => {},
    size: () => 0,
    notifiers: () => 0,
    // A response from another object has immutable headers: re-wrapped, so the app's middleware can add its own.
    events: async () => {
      const r = await stub().fetch(`${BASE}/events`);
      return new Response(r.body, { status: r.status, headers: new Headers(r.headers) });
    },
    async bino(op) {
      const res = await stub().fetch(`${BASE}/bino`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) });
      if (!res.ok) throw new Error(`Bino's hub answered ${res.status}`);
      return res.json();
    },
    async drain() {
      while (pending.size) await Promise.all([...pending]);
    },
    // A socket's upgrade answer can't be re-wrapped: it goes back as the object gave it.
    bridge: (req) => stub().fetch(new Request(`${BASE}/bridge`, req)),
    live: (req) => stub().fetch(new Request(`${BASE}/live`, req)),
    async mac() {
      const res = await stub().fetch(`${BASE}/mac`);
      if (!res.ok) throw new Error(`The hub answered ${res.status}`);
      return (await res.json()) as MacView;
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
  return {
    route: o.route,
    memory: o.memory,
    sees: o.sees,
    list: async () => (await hub.bino({ op: "list" })) as Conv[],
    get: async (id) => ((await hub.bino({ op: "get", id })) as Conv | null) ?? undefined,
    start: async (text, s = {}) => (await hub.bino({ op: "start", text, todo: s.todo, view: s.view, app: s.app, context: s.context ?? "" })) as Conv,
    say: async (id, text, s = {}) => (await hub.bino({ op: "say", id, text, view: s.view, context: s.context ?? "" })) === true,
    stop: async (id) => (await hub.bino({ op: "stop", id })) === true,
    added: async (id, index, todo) => void (await hub.bino({ op: "added", id, index, todo })),
    act: async (id, index, n) => ((await hub.bino({ op: "get", id })) as Conv | null)?.msgs[index]?.acts?.[n],
    setAct: async (id, index, n, patch) => void (await hub.bino({ op: "setAct", id, index, n, patch: { error: patch.error } })),
  };
}
