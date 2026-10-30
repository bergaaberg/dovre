/** Auto review on a PR's page (#326): its level now and every round's, as a fact row. */
import { html } from "hono/html";
import type { Html } from "../../../ui/kit.ts";
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
