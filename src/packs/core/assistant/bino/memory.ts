/**
 * What Bino remembers about me, through memlet (github.com/bergaaberg/memlet, an optional
 * dependency: it's private, so a colleague's install skips it and Bino talks without memory).
 * Scopes: "operator" (me), and one per app ("app:shop"): what I tell Bino in a conversation
 * about the shop stays with the shop, and a conversation about it recalls both. The table is
 * migrations/0006_memlet.sql.
 *
 * Every conversation reads all of it (it's small: one-sentence facts, a few hundred at most), and
 * after each reply a cheap model proposes changes that memlet checks before applying: no secrets,
 * no duplicates, at most three new ones at a time. Only what the user and Bino said goes in,
 * never anything a tool or a page brought along. I see the list on /bino and can delete any of it.
 */
import type { D1 } from "../../../../db.ts";

export type Memory = { id: string; text: string; kind: string; updated_at: string; /** "operator", or "app:<pack id>". */ scope: string };

export const OPERATOR = "operator";
/** The memory scope for an app (a pack's id); anything else is the operator's. */
export const scopeOf = (app: string | undefined) => (app && /^[a-z][a-z0-9-]{0,39}$/.test(app) ? `app:${app}` : OPERATOR);
export type Said = { role: "user" | "assistant"; text: string };

export type BinoMemory = {
  available: boolean;
  /** Why there's no memory, when there isn't. */
  why?: string;
  /** The memories as a block for the system prompt ("" when there are none): mine, and the app's when it's about one. */
  prompt(scope?: string): Promise<string>;
  /** Every scope's, mine first. */
  list(): Promise<Memory[]>;
  forget(id: string): Promise<boolean>;
  /** After a reply: propose and apply changes from what was said, in its scope (mine by default). */
  reflect(turns: Said[], complete: (p: { system: string; user: string }) => Promise<string>, source: string, scope?: string): Promise<{ applied: number; rejected: number; dropped: number } | undefined>;
};

type Memlet = typeof import("memlet");

/** No memory: Bino talks, remembers nothing. */
export const noMemory = (why: string): BinoMemory => ({
  available: false,
  why,
  prompt: async () => "",
  list: async () => [],
  forget: async () => false,
  reflect: async () => undefined,
});

/** `load`: how to get memlet (tests pass their own; a failing load means no memory). */
export async function loadMemory(db: D1, opts: { load?: () => Promise<Memlet>; scope?: string } = {}): Promise<BinoMemory> {
  let m: Memlet;
  try {
    m = await (opts.load ?? (() => import("memlet")))();
  } catch {
    return noMemory("memlet isn't installed (it's a private package): Bino talks, but doesn't remember.");
  }
  const stores = new Map<string, ReturnType<Memlet["memlet"]>>();
  const storeOf = (scope: string) => {
    let st = stores.get(scope);
    if (!st) stores.set(scope, (st = m.memlet(m.fromD1(db as never), { scope })));
    return st;
  };
  const me = opts.scope ?? OPERATOR;
  const block = async (scope: string) => {
    const { memories, omitted } = await storeOf(scope).recall();
    return memories.length ? m.toPrompt(memories, { omitted }) : "";
  };
  return {
    available: true,
    async prompt(scope) {
      const mine = await block(me);
      if (!scope || scope === me) return mine;
      const app = await block(scope);
      return [mine, app && `About ${scope.replace(/^app:/, "the app ")}:\n${app}`].filter(Boolean).join("\n\n");
    },
    async list() {
      const scopes = (await db.prepare("SELECT DISTINCT scope FROM memlet_memories").all<{ scope: string }>()).results.map((r) => r.scope);
      const order = [me, ...scopes.filter((x) => x !== me).sort()];
      const all = await Promise.all(order.map((scope) => storeOf(scope).list()));
      return all.flat().map(({ id, text, kind, updated_at, scope }) => ({ id, text, kind, updated_at, scope }));
    },
    async forget(id) {
      const row = await db.prepare("SELECT scope FROM memlet_memories WHERE id = ?").bind(id).first<{ scope: string }>();
      return row ? storeOf(row.scope).forget(id) : false;
    },
    async reflect(turns, complete, source, scope) {
      // Only what was said: memlet's own rule, kept here too.
      const said = turns.filter((t) => (t.role === "user" || t.role === "assistant") && t.text.trim()).map((t) => ({ role: t.role, text: t.text }));
      if (!said.some((t) => t.role === "user")) return undefined;
      const at = scope ?? me;
      const subject = at === me ? "the user, who uses Dovre" : `the user's app ${at.replace(/^app:/, "")}, as the user describes it`;
      const r = await m.reflect(storeOf(at), said, complete, { subject, source });
      return { applied: r.applied.length, rejected: r.rejected.length, dropped: r.dropped };
    },
  };
}

/** Memory that's still loading (the Worker builds its app synchronously): no memory until it's there. */
export function memoryLater(p: Promise<BinoMemory>): BinoMemory & { ready: Promise<void> } {
  let m: BinoMemory = noMemory("Bino's memory is still loading.");
  const ready = p.then((x) => void (m = x)).catch(() => {});
  return {
    ready,
    get available() {
      return m.available;
    },
    get why() {
      return m.why;
    },
    prompt: (scope) => m.prompt(scope),
    list: () => m.list(),
    forget: (id) => m.forget(id),
    reflect: (turns, complete, source, scope) => m.reflect(turns, complete, source, scope),
  };
}
