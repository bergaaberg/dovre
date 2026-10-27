/** Settings → Look and layout (src/layout.ts): light or dark, the accent, the phone's tabs, Today's cards, the feed's sources, packs shown. */
import { html } from "hono/html";
import type { Layout } from "../layout.ts";
import { Panel } from "../ui/kit.ts";

export type LayoutView = {
  layout: Layout;
  /** The menu's pages, as tabs may pick them (Today is always first). */
  pages: { href: string; title: string }[];
  /** The tabs as they are now, after Today. */
  tabs: string[];
  /** Today's cards: id, name, where it sits now. */
  cards: { id: string; label: string; col: "left" | "right" | "off"; order: number }[];
  /** Packs that give the feed events. */
  feeds: { id: string; name: string }[];
  packs: { id: string; name: string }[];
};

const COLS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "off", label: "Hidden" },
] as const;

export function layoutPanel(v: LayoutView) {
  const tab = (i: number) =>
    html`<label class="field"><span class="label">Tab ${i + 2}</span><select name="tab${i + 1}"><option value="">None</option>${v.pages.map((p) => html`<option value="${p.href}"${v.tabs[i] === p.href ? html` selected` : ""}>${p.title}</option>`)}</select></label>`;
  const card = (c: LayoutView["cards"][number]) =>
    html`<div class="layout-row"><span>${c.label}</span><select name="col:${c.id}" aria-label="${c.label}: column">${COLS.map((o) => html`<option value="${o.value}"${c.col === o.value ? html` selected` : ""}>${o.label}</option>`)}</select><input type="number" name="order:${c.id}" min="0" max="999" value="${c.order}" aria-label="${c.label}: order"></div>`;
  const off = (list: string[] | undefined, id: string) => !!list?.includes(id);
  const pick = (name: string, label: string, value: string | undefined, choices: { value: string; label: string }[]) =>
    html`<label class="field"><span class="label">${label}</span><select name="${name}">${choices.map((o) => html`<option value="${o.value}"${(value ?? "") === o.value ? html` selected` : ""}>${o.label}</option>`)}</select></label>`;
  const form = html`<form method="post" action="/settings/layout">
<div class="fields">${pick("theme", "Theme", v.layout.theme, [{ value: "", label: "As the system" }, { value: "light", label: "Light (cabin)" }, { value: "dark", label: "Dark (night)" }, { value: "birch", label: "Birch (cool light)" }, { value: "polar", label: "Polar (black)" }, { value: "ember", label: "Ember (warm dark)" }])}${pick("accent", "Accent", v.layout.accent, [{ value: "", label: "Fjord (blue)" }, { value: "heather", label: "Heather (violet)" }, { value: "glacier", label: "Glacier (ice blue)" }])}${pick("binoButton", "Bino's button", v.layout.binoButton, [{ value: "", label: "My avatar, when there is one" }, { value: "icon", label: "The assistant icon" }])}</div>
<div class="field"><span class="label">On the phone</span><span class="hint">The bar at the foot: Today, then up to three pages, then More.</span></div>
<div class="fields">${[0, 1, 2].map(tab)}</div>
${v.cards.length
  ? html`<div class="field"><span class="label">Today's cards</span><span class="hint">Each in a column, lowest number first; hidden ones aren't drawn.</span></div>
<div class="layout-rows">${v.cards.map(card)}</div>`
  : ""}
${v.feeds.length
  ? html`<div class="field"><span class="label">What's happening</span><fieldset>${v.feeds.map((f) => html`<label class="check"><input type="checkbox" name="feed" value="${f.id}"${off(v.layout.feedOff, f.id) ? "" : html` checked`}> ${f.name}</label><br>`)}</fieldset><span class="hint">The apps whose events reach the feed.</span></div>`
  : ""}
${v.packs.length
  ? html`<div class="field"><span class="label">Packs shown</span><fieldset>${v.packs.map((c) => html`<label class="check"><input type="checkbox" name="pack" value="${c.id}"${off(v.layout.packsOff, c.id) ? "" : html` checked`}> ${c.name}</label><br>`)}</fieldset><span class="hint">A hidden pack leaves the menu, Today, the feed, search and Bino, its pages answer 404, and it stops refreshing. <a href="/packs">Packs</a> lists them all.</span></div>`
  : ""}
<div class="buttons"><button type="submit" class="primary">Save</button></div>
</form>`;
  return Panel({
    id: "layout",
    title: "Look and layout",
    meta: "applies at once",
    actions: html`<form method="post" action="/settings/layout/reset"><button type="submit" class="sm">Back to defaults</button></form>`,
    children: form,
  });
}
