/**
 * What Bino may propose to do: a dev task, a setting of Dovre's, or an act a pack offers (Teams: a
 * message). Bino acts on nothing; a proposal is a card I change, then press
 * (src/packs/core/assistant/bino/routes.ts). A task opens the normal preview, whose Create is the
 * confirm; a setting goes through its own Settings route; a pack's act goes through its `run`.
 * What I change before pressing stays out of Bino's conversation: Bino's transcript holds the
 * block as Bino wrote it, and that it was done.
 */

export const ACT_FENCE = "bino-act";
export const MAX_ACTS = 3;
export const MAX_TITLE = 255;
export const MAX_BODY = 8000;
/** The lookup that finds one of Dovre's settings (src/packs/core/assistant/bino/settings.ts): where it's offered, Bino may propose a `setting`. */
export const SETTINGS_KIND = "dovre.settings";

type TaskAct = { kind: "task"; parent: string; repo: string; title: string; body: string };
/** A bug in Dovre itself (#384): its card opens /bug filled in; nothing is filed from the card. */
type BugAct = { kind: "bug"; title: string; body: string; page: string };
/**
 * A setting of Dovre's (#185): its id in the settings catalogue (src/pages/settings.ts) and the
 * value proposed. Only its shape is checked here; the catalogue says whether there is such a
 * setting and whether it takes that value, when the card is drawn and again when it's pressed.
 */
export type SettingAct = { kind: "setting"; id: string; to: string; /** What it was before its card changed it: what Undo puts back. Never told to Bino. */ was?: string };
/**
 * A pack to bring in (#94): its id, here or in dovre-packs. What its card offers (Add, switch it on,
 * its settings, its setup) is read from where that pack stands when the card is drawn.
 */
export type PackInAct = { kind: "pack"; id: string };
/**
 * Today, arranged (#94): each column's cards in order, cards to hide, the phone's tabs and the
 * Stats panels to show first. A part left out stays as it is; the ids are checked against what's
 * here when the card is drawn and again when it's pressed (src/arrange.ts).
 */
export type LayoutAct = { kind: "layout"; left?: string[]; right?: string[]; off?: string[]; phone?: string[]; stats?: string[]; /** The parts it changed, as they were (a Placement as JSON): what Undo puts back. Never told to Bino. */ was?: string };
/** A pack's (src/packs/types.ts ActKind): kind `<pack>.<kind>`, its fields as checked. */
export type PackAct = { kind: `${string}.${string}`; fields: Record<string, string> };
export type Act = (TaskAct | BugAct | SettingAct | PackInAct | LayoutAct | PackAct) & {
  /** Done (a pack's, a setting's): when, what the card says, and where to see it. */
  done?: { at: number; text: string; href?: string };
  sending?: boolean;
  error?: string;
};

/** A kind of act a pack offers, as Bino is told it and its block is checked (registry actsFrom). */
export type ActSpec = { kind: string; /** The pack's name. */ app: string; when: string; fields: { name: string; about: string; required: boolean; max: number; text: boolean }[] };

export const isPackAct = (a: Act): a is PackAct & Act => a.kind.includes(".");

/** Ids as src/layout.ts takes them: a card's, a page's href, a stat's. */
const CARD = /^[a-z][a-z0-9-]{0,64}$/;
const HREF = /^\/[\w\-/]{0,80}$/;
const STAT = /^[a-z][a-z0-9-]{0,64}(:[a-z][a-z0-9-]{0,40})?$/;
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
  if (r.kind === "bug") {
    const title = line(r.title, 200);
    const page = line(r.page, 300);
    return title ? { kind: "bug", title, body: para(r.body, 6000), page: page.startsWith("/") && !page.startsWith("//") ? page : "" } : null;
  }
  if (r.kind === "setting") {
    const id = line(r.id, 120);
    // A switch may come as true or false, a number as one.
    const to = typeof r.to === "boolean" ? (r.to ? "on" : "off") : typeof r.to === "number" && Number.isFinite(r.to) ? String(r.to) : line(r.to, 200);
    return /^[a-z][\w.:-]*$/i.test(id) ? { kind: "setting", id, to } : null;
  }
  if (r.kind === "layout") {
    const list = (v: unknown, ok: RegExp, max: number) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && ok.test(x)))].slice(0, max) : []);
    const parts = { left: list(r.left, CARD, 40), right: list(r.right, CARD, 40), off: list(r.off, CARD, 40), phone: list(r.phone, HREF, 3), stats: list(r.stats, STAT, 40) };
    const some = Object.fromEntries(Object.entries(parts).filter(([, v]) => v.length));
    return Object.keys(some).length ? { kind: "layout", ...some } : null;
  }
  if (r.kind === "pack") {
    const id = line(r.id, 40).toLowerCase();
    return /^[a-z][a-z0-9-]{0,31}$/.test(id) ? { kind: "pack", id } : null;
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
  const { done: _d, sending: _g, error: _e, was: _w, ...rest } = a as Act & { was?: string };
  const plain = isPackAct(a) ? { kind: a.kind, ...a.fields } : rest;
  return `\`\`\`${ACT_FENCE}\n${JSON.stringify(plain)}\n\`\`\`${a.done ? " (done)" : ""}`;
}
