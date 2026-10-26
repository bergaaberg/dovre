/** Settings → Writes (dovre#104): which kinds of write take one click instead of asking twice. */
import { html } from "hono/html";
import { type Clicks, WRITES } from "../writes.ts";
import { type Html, Panel } from "../ui/kit.ts";

export function writesPanel(chosen: Map<string, Clicks>): Html {
  const groups = [...new Set(WRITES.map((w) => w.group))];
  return Panel({
    title: "Writes",
    id: "writes",
    children: html`<p class="notes">Every write asks twice unless you tick it here. Either way it re-checks first and goes in the actions log. Deleting and ending things always ask.</p>
<form method="post" action="/settings/writes" class="writes">${groups.map(
      (g) => html`<fieldset><legend>${g}</legend>${WRITES.filter((w) => w.group === g).map((w) =>
        w.floor
          ? html`<label class="write-row t3"><input type="checkbox" disabled> ${w.label} <span class="hint">always asks</span></label>`
          : html`<label class="write-row"><input type="checkbox" name="once" value="${w.kind}"${chosen.get(w.kind) === "once" ? " checked" : ""}> ${w.label}</label>`,
      )}</fieldset>`,
    )}<p><button type="submit" class="sm">Save: ticked ones take one click</button></p></form>`,
  });
}
