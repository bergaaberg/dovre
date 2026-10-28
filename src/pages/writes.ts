/** Settings → Writes (dovre#104): which kinds of write ask twice instead of taking one click. */
import { html } from "hono/html";
import { type Clicks, WRITES, type WriteKind } from "../writes.ts";
import { type Html, Panel } from "../ui/kit.ts";

export function writesPanel(chosen: Map<string, Clicks>, kinds: WriteKind[] = WRITES): Html {
  const groups = [...new Set(kinds.map((w) => w.group))];
  return Panel({
    title: "Writes",
    id: "writes",
    children: html`<p class="notes">Every write takes one click unless you tick it here to ask twice. Either way it re-checks first and goes in the actions log.</p>
<form method="post" action="/settings/writes" class="writes">${groups.map(
      (g) => html`<fieldset><legend>${g}</legend>${kinds.filter((w) => w.group === g).map(
        (w) => html`<label class="write-row"><input type="checkbox" name="twice" value="${w.kind}"${chosen.get(w.kind) === "twice" ? " checked" : ""}> ${w.label}</label>`,
      )}</fieldset>`,
    )}<p><button type="submit" class="sm">Save: ticked ones ask twice</button></p></form>`,
  });
}
