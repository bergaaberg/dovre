/** Settings → Keys (dovre#87): how far j/k scroll, and which groups of shortcuts are on. */
import { html } from "hono/html";
import { KEY_GROUPS, type KeyPrefs, SCROLL_STEPS } from "../keys.ts";
import { type Html, Panel } from "../ui/kit.ts";

export function keysPanel(k: KeyPrefs, perPerson: boolean): Html {
  return Panel({
    title: "Keys",
    id: "keys",
    children: html`<p class="notes">The shortcuts that work without Ctrl (press ? on any page to see them).${perPerson ? " These are yours only." : ""} Ctrl K, ? and Esc always work.</p>
<form method="post" action="/settings/keys" class="writes">
<label class="field"><span class="label">j / k scroll</span><select name="scroll">${SCROLL_STEPS.map((s) => html`<option value="${s.px}"${s.px === k.scroll ? " selected" : ""}>${s.label}</option>`)}</select></label>
<fieldset><legend>On</legend>${KEY_GROUPS.map((g) => html`<label class="write-row"><input type="checkbox" name="on" value="${g.id}"${k.off.includes(g.id) ? "" : " checked"}> ${g.label} <span class="hint">${g.keys}</span></label>`)}</fieldset>
<p><button type="submit" class="sm">Save keys</button></p></form>`,
  });
}
