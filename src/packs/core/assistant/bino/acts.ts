/**
 * What Bino may propose to do: a dev task or a pack act. Bino acts on nothing;
 * a proposal is a card I change or confirm with one click. A task opens the normal
 * preview, whose Create is the confirm. Pack acts go through the pack's `act` hook.
 */

export const ACT_FENCE = "bino-act";
export const MAX_ACTS = 3;
export const MAX_TO = 120;
export const MAX_TEXT = 4000;
export const MAX_TITLE = 255;
export const MAX_BODY = 8000;

export type TaskAct = { kind: "task"; parent: string; repo: string; title: string; body: string };
/** A pack's (src/packs/types.ts ActKind): kind `<pack>.<kind>`, its fields as checked. */
export type PackAct = { kind: `${string}.${string}`; fields: Record<string, string> };
export type Act = (TaskAct | PackAct) & {
  /** Done (a pack's): when, what the card says, and where to see it. */
  done?: { at: number; text: string; href?: string };
  sending?: boolean;
  error?: string;
};

/** A kind of act a pack offers, as Bino is told it and its block is checked (registry actsFrom). */
export type ActSpec = { kind: string; /** The pack's name. */ app: string; when: string; fields: { name: string; about: string; required: boolean; max: number; text: boolean }[] };

export const isPackAct = (a: Act): a is PackAct & Act => a.kind.includes(".");

const line = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
const para = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, "").trim().slice(0, max) : "");

/** One proposal from Bino's block, checked field by field; null when it isn't a usable one. `kinds`: the packs' on now. */
export function actOf(raw: unknown, kinds: ActSpec[] = []): Act | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const spec = typeof r.kind === "string" && r.kind.includes(".") ? kinds.find((k) => k.kind === r.kind) : undefined;
  if (spec) {
    const fields: Record<string, string> = {};
    for (const f of spec.fields) {
      const given = Object.hasOwn(r, f.name) ? r[f.name] : undefined;
      const v = f.text ? para(given, f.max) : line(given, f.max);
      if (v) fields[f.name] = v;
      else if (f.required) return null;
    }
    return { kind: spec.kind as PackAct["kind"], fields };
  }
  if (r.kind === "task") {
    const title = line(r.title, MAX_TITLE);
    return title ? { kind: "task", parent: line(r.parent, 200), repo: line(r.repo, 200), title, body: para(r.body, MAX_BODY) } : null;
  }
  return null;
}

/** Bino's reply without its act blocks, and the acts (at most MAX_ACTS usable ones). */
export function splitActs(reply: string, kinds: ActSpec[] = []): { text: string; acts: Act[] } {
  const re = new RegExp("```" + ACT_FENCE + "\\s*\\n([\\s\\S]*?)\\n?```", "g");
  const acts: Act[] = [];
  for (const m of reply.matchAll(re)) {
    try {
      const a = actOf(JSON.parse(m[1]!), kinds);
      if (a && acts.length < MAX_ACTS) acts.push(a);
    } catch {}
  }
  return { text: reply.replace(re, "").trim(), acts };
}

/** An act as Bino wrote it, for Bino's own transcript (never what I changed or sent). */
export function fenceOf(a: Act): string {
  const { done: _d, sending: _g, error: _e, ...rest } = a;
  const plain = isPackAct(a) ? { kind: a.kind, ...a.fields } : rest;
  return `\`\`\`${ACT_FENCE}\n${JSON.stringify(plain)}\n\`\`\`${a.done ? " (done)" : ""}`;
}

/** Lower case, accents off, Norwegian letters spelled out, so "Ase" finds "Åse" and "Bjorn" finds "Bjørn". */
export function fold(s: string): string {
  return s.toLowerCase().replace(/ø/g, "o").replace(/æ/g, "ae").normalize("NFD").replace(/\p{M}/gu, "");
}

type Named = { id: string; name: string; kind: string };

/**
 * The chats that fit who Bino named, best first: every word of `to` has to start a word of the
 * chat's name (or sit inside it, scoring less). A one-on-one beats a group at the same score, and
 * otherwise the order stays as given (newest first).
 */
export function chatsFor<T extends Named>(to: string, chats: T[]): T[] {
  const want = fold(to).split(/[\s,;]+/).filter((w) => w && w !== "and" && w !== "og" && w !== "&");
  if (!want.length) return [];
  const scored: { c: T; score: number; i: number }[] = [];
  chats.forEach((c, i) => {
    const name = fold(c.name);
    const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    let score = name === want.join(" ") ? 100 : 0;
    for (const w of want) {
      if (words.some((x) => x.startsWith(w))) score += 10;
      else if (name.includes(w)) score += 3;
      else return;
    }
    if (c.kind === "oneOnOne") score += 1;
    scored.push({ c, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.c);
}
