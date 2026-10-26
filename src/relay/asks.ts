/**
 * Questions an MCP server puts to me through the relay (`dovre relay -- <server>`, launcher/
 * relay.go), or a pack through `ctx.ask` (a database CLI asking before it opens production), for a client (omp) that can't
 * ask. The relay hands the question here and waits; I answer it on any page (the bar at the top),
 * and only there, so the model never answers it.
 *
 * Forms are read narrowly: one required field with a few named choices (deny/allow), or a
 * yes/no. Anything else can only be declined. The first choice listed is the safe one (a careful server
 * lists deny first); every other choice needs a second click.
 */
import { randomUUID } from "node:crypto";

export type Choice = { value: string; safe: boolean };
export type AskView = { id: string; server: string; message: string; field?: string; choices: Choice[]; at: number };
export type Answer = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

type Ask = AskView & { answer?: Answer; seen: number; waiters: Set<(a: Answer | undefined) => void> };

const MAX_MESSAGE = 2000;
const plain = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, max) : "");

/** The one field and its choices, when the form is the kind that can be answered with a button. */
export function choicesOf(schema: unknown): { field?: string; choices: Choice[] } {
  const s = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
  const props = s.properties && typeof s.properties === "object" ? (s.properties as Record<string, Record<string, unknown>>) : {};
  const names = Object.keys(props);
  if (names.length !== 1) return { choices: [] };
  const field = names[0]!;
  const p = props[field] ?? {};
  if (Array.isArray(p.enum) && p.enum.length >= 1 && p.enum.length <= 6 && p.enum.every((v) => typeof v === "string" && v.length <= 40))
    return { field, choices: (p.enum as string[]).map((value, i) => ({ value, safe: i === 0 })) };
  if (p.type === "boolean") return { field, choices: [{ value: "false", safe: true }, { value: "true", safe: false }] };
  return { choices: [] };
}

export type Asks = {
  put(q: { server: unknown; message: unknown; schema: unknown }): AskView;
  /** Waits up to `ms` for the answer; "gone" when there's no such question (answered long ago, or dropped). */
  wait(id: string, ms: number): Promise<{ state: "waiting" } | { state: "answered"; answer: Answer } | { state: "gone" }>;
  answer(id: string, a: { choice?: string; decline?: boolean }): AskView | undefined;
  list(): AskView[];
};

export function createAsks(opts: { now?: () => number; onChange?: (q?: AskView) => void; staleMs?: number } = {}): Asks {
  const now = opts.now ?? Date.now;
  const asks = new Map<string, Ask>();
  const view = ({ id, server, message, field, choices, at }: Ask): AskView => ({ id, server, message, field, choices, at });
  // A question whose relay stopped asking (the agent session ended) goes away by itself.
  const sweep = () => {
    for (const [id, q] of asks) if (now() - q.seen > (opts.staleMs ?? 60_000)) asks.delete(id), opts.onChange?.();
  };
  return {
    put(q) {
      sweep();
      const { field, choices } = choicesOf(q.schema);
      const a: Ask = { id: randomUUID(), server: plain(q.server, 40) || "an MCP server", message: plain(q.message, MAX_MESSAGE), field, choices, at: now(), seen: now(), waiters: new Set() };
      asks.set(a.id, a);
      opts.onChange?.(view(a));
      return view(a);
    },
    async wait(id, ms) {
      const q = asks.get(id);
      if (!q) return { state: "gone" };
      q.seen = now();
      const got = q.answer ?? (await new Promise<Answer | undefined>((res) => {
        const t = setTimeout(() => (q.waiters.delete(res), res(undefined)), ms);
        q.waiters.add((a) => (clearTimeout(t), res(a)));
      }));
      q.seen = now();
      if (!got) return { state: "waiting" };
      asks.delete(id);
      return { state: "answered", answer: got };
    },
    answer(id, a) {
      const q = asks.get(id);
      if (!q || q.answer) return undefined;
      let answer: Answer;
      if (a.decline) answer = { action: "decline" };
      else {
        const c = q.choices.find((x) => x.value === a.choice);
        if (!c || !q.field) return undefined;
        answer = { action: "accept", content: { [q.field]: q.field && q.choices.length === 2 && q.choices[1]!.value === "true" ? c.value === "true" : c.value } };
      }
      q.answer = answer;
      for (const w of q.waiters) w(answer);
      q.waiters.clear();
      opts.onChange?.();
      return view(q);
    },
    list() {
      sweep();
      return [...asks.values()].filter((q) => !q.answer).map(view);
    },
  };
}

/**
 * An MCP host's elicitation handler that asks me in the bar and waits for the answer (up to
 * `maxMs`; unanswered, or dropped, is cancel, which a careful server reads as no).
 */
export function askInBar(asks: Asks, server: string, maxMs = 10 * 60_000, now: () => number = Date.now, /** Told each question's id as it goes in the bar. */ onPut?: (id: string) => void) {
  return async (message: string, schema: unknown): Promise<Answer> => {
    const q = asks.put({ server, message, schema });
    onPut?.(q.id);
    const until = now() + maxMs;
    while (now() < until) {
      const r = await asks.wait(q.id, Math.min(25_000, Math.max(1, until - now())));
      if (r.state === "answered") return r.answer;
      if (r.state === "gone") break;
    }
    return { action: "cancel" };
  };
}
