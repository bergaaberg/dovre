/** Auto review on a PR's page (#326, #555): its level now and every round's, and its findings with what I can say about each, as fact rows. */
import { html } from "hono/html";
import { type FindingStatus, gates } from "../../../reviews/finding.ts";
import { Confirm, type Html, Item, List, Notice, type Tone } from "../../../ui/kit.ts";
import type { Decision } from "./decide.ts";
import type { Finding } from "./findings.ts";
import type { PrRow, PrState } from "./store.ts";

const STATE: Record<PrState, string> = {
  reviewing: "being reviewed",
  fixing: "a fix session is on it",
  "waiting-ci": "waiting for CI",
  merging: "merging",
  merged: "merged",
  closed: "closed",
  yours: "handed to you",
};

/** "Level 4 of 5 · round 2 · being reviewed", then the levels so far: "1 → 3 → 4". */
export function levelFact(r: PrRow): [string, Html] {
  const state = r.why ? `${STATE[r.state]}: ${r.why}` : STATE[r.state];
  if (r.level === null) return ["Auto review", html`Waiting for its first review · ${state}`];
  const history = r.levels.map((l) => l.level).join(" → ");
  return ["Auto review", html`Level ${r.level} of 5 · round ${r.round} · ${state}${r.levels.length > 1 ? html`<br />Levels so far: ${history}` : ""}`];
}

/** Where the PR page posts what I say about a finding. */
export const DECIDE_HREF = "/autoreview/finding";

const STANDS: Record<FindingStatus, string> = { open: "open", "force-fix": "you said fix it", "force-ignore": "you said ignore it", fixed: "fixed", merged: "folded into another" };
const ASK: Record<Decision, { label: string; question: string }> = {
  "force-fix": { label: "Fix it", question: "It holds the PR back until it's fixed, and a fix session starts for it on the PR's branch." },
  "force-ignore": { label: "Ignore it", question: "It stops holding the PR back, and isn't posted again when a later review raises it. With nothing else in the way, the PR can go on to merge." },
  open: { label: "Undo", question: "It's open again, as the reviewer reported it." },
};

/**
 * What I can say about a finding now: one that already holds the PR back needs no "Fix it". My
 * own line comment has no reviewer's word to go back to: it's fix it or ignore it.
 */
const choices = (f: Finding): Decision[] =>
  f.asker
    ? f.status === "force-fix" ? ["force-ignore"] : f.status === "force-ignore" ? ["force-fix"] : []
    : f.status === "open" ? (gates(f) ? ["force-ignore"] : ["force-fix", "force-ignore"]) : f.status === "force-fix" || f.status === "force-ignore" ? ["open"] : [];

/**
 * "Findings" on the PR's page: each one a review still stands by, the ones holding the PR back
 * first, with what I can say about it; then how many are fixed. `live`: the PR is still in the
 * loop, so the buttons show. `flash`: what the last click did. Undefined without any finding.
 */
export function findingsFact(list: Finding[], o: { repo: string; number: number; live: boolean; flash?: { ok: boolean; message: string } }): [string, Html] | undefined {
  const standing = list.filter((f) => f.status === "open" || f.status === "force-fix" || f.status === "force-ignore").sort((a, b) => Number(gates(b)) - Number(gates(a)));
  const fixed = list.filter((f) => f.status === "fixed").length;
  if (!standing.length && !fixed && !o.flash) return undefined;
  const tone = (f: Finding): Tone => (gates(f) ? "warn" : "neutral");
  const rows = standing.map((f) =>
    Item({
      lead: f.asker ? "asked" : f.severity,
      leadTone: tone(f),
      title: f.title,
      line: `${f.path}:${f.startLine ? `${f.startLine}-` : ""}${f.line} · ${f.asker ? `${f.asker}'s comment · ` : ""}${STANDS[f.status]}${gates(f) ? ", holds the PR back" : ""}${f.raised > 1 ? ` · raised by ${f.raised} reviews` : ""}`,
      quiet: f.status === "force-ignore",
      trail: o.live
        ? choices(f).map((to) => Confirm({ kind: "autoreview.decide", action: DECIDE_HREF, fields: { repo: o.repo, number: String(o.number), id: f.id, to }, label: ASK[to].label, question: ASK[to].question }))
        : "",
    }),
  );
  return [
    "Findings",
    html`${o.flash ? Notice({ tone: o.flash.ok ? "ok" : "warn", children: o.flash.message }) : ""}${rows.length ? List(rows) : ""}${fixed ? html`${fixed} fixed${rows.length ? "" : ", none standing"}.` : ""}`,
  ];
}
