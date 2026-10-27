/**
 * Two pasted texts compared (dovre#105): a unified patch, the shape git and GHE give, so the diff
 * viewer draws it like any other. JSON on both sides can be compared as data: keys sorted, laid out
 * the same way, so only what differs shows. Pure; nothing is kept.
 */

/** Each side's size limit, and how much work the line match may do (lines × lines). */
export const MAX_TEXT = 512 * 1024;
const MAX_CELLS = 4_000_000;
const CONTEXT = 3;

/** JSON with its keys sorted at every level, two-space indented; undefined when it isn't JSON. */
export function canonicalJson(text: string): string | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x;
  return `${JSON.stringify(sort(v), null, 2)}\n`;
}

type Op = { kind: " " | "-" | "+"; text: string };

/** The lines of each side, matched (longest common subsequence) after the shared start and end are set aside. */
function lineOps(a: string[], b: string[]): Op[] | undefined {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  if ((x.length + 1) * (y.length + 1) > MAX_CELLS) return undefined;
  const w = y.length + 1;
  const L = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
  const ops: Op[] = a.slice(0, start).map((text) => ({ kind: " ", text }));
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      ops.push({ kind: " ", text: x[i++]! });
      j++;
    } else if (j >= y.length || (i < x.length && L[(i + 1) * w + j]! >= L[i * w + j + 1]!)) ops.push({ kind: "-", text: x[i++]! });
    else ops.push({ kind: "+", text: y[j++]! });
  }
  for (const text of a.slice(a.length - end)) ops.push({ kind: " ", text });
  return ops;
}

const linesOf = (t: string) => {
  const l = t.replace(/\r\n?/g, "\n").split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
};

export type Compared = { ok: true; patch: string; additions: number; deletions: number } | { ok: false; error: string };

/** A unified patch from `a` to `b`, three lines of context around each change. */
export function comparePatch(a: string, b: string): Compared {
  if (a.length > MAX_TEXT || b.length > MAX_TEXT) return { ok: false, error: `Each side can be ${MAX_TEXT / 1024} KB at most.` };
  const ops = lineOps(linesOf(a), linesOf(b));
  if (!ops) return { ok: false, error: "Too many changed lines to match up. Compare smaller pieces." };
  // Hunks: each change with its context, joined when their context touches.
  const changed = ops.flatMap((o, k) => (o.kind === " " ? [] : [k]));
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const from = Math.max(0, k - CONTEXT);
    const to = Math.min(ops.length, k + CONTEXT + 1);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }
  // Line numbers where each op starts, on both sides.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(n);
    if (op.kind !== "+") o++;
    if (op.kind !== "-") n++;
  }
  const out: string[] = [];
  for (const [from, to] of hunks) {
    const part = ops.slice(from, to);
    const olds = part.filter((p) => p.kind !== "+").length;
    const news = part.filter((p) => p.kind !== "-").length;
    out.push(`@@ -${olds ? oldAt[from] : oldAt[from]! - 1},${olds} +${news ? newAt[from] : newAt[from]! - 1},${news} @@`);
    for (const p of part) out.push(p.kind + p.text);
  }
  return { ok: true, patch: out.join("\n"), additions: ops.filter((p) => p.kind === "+").length, deletions: ops.filter((p) => p.kind === "-").length };
}
