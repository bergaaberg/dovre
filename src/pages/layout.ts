/**
 * Settings → Look (light or dark, the accent, font, text size, line height, Bino's button) and
 * Settings → Layout (the phone's tabs, Today's cards, Stats' panels, the feed's sources, packs shown),
 * both kept as one Layout (src/layout.ts). Each form posts its `part`, and the other part stays as it was.
 */
import { html } from "hono/html";
import type { Layout } from "../layout.ts";
import { type Html, Panel } from "../ui/kit.ts";

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
  /** What /stats can show: id, name, where it's from, shown or not, its order. */
  stats: { id: string; label: string; from: string; show: boolean; order: number }[];
  /** This machine can open a link in the default browser (local, src/open-link.ts). */
  opener?: boolean;
};

type Opt = { value: string; label: string };
/** Look's choices: the key in Layout, its label, and its options (the default's value is ""). */
export const LOOK: { key: "theme" | "accent" | "font" | "textSize" | "lineHeight" | "binoButton"; label: string; choices: Opt[] }[] = [
  { key: "theme", label: "Theme", choices: [{ value: "", label: "As the system" }, { value: "light", label: "Light (cabin)" }, { value: "dark", label: "Dark (night)" }, { value: "birch", label: "Birch (cool light)" }, { value: "polar", label: "Polar (black)" }, { value: "ember", label: "Ember (warm dark)" }] },
  { key: "accent", label: "Accent", choices: [{ value: "", label: "Fjord (blue)" }, { value: "heather", label: "Heather (violet)" }, { value: "glacier", label: "Glacier (ice blue)" }] },
  { key: "font", label: "Font", choices: [{ value: "", label: "Nordwand Mono" }, { value: "sans", label: "Sans (system)" }, { value: "serif", label: "Serif (system)" }] },
  { key: "textSize", label: "Text size", choices: [{ value: "small", label: "Small" }, { value: "", label: "Default" }, { value: "large", label: "Large" }, { value: "larger", label: "Larger" }] },
  { key: "lineHeight", label: "Line height", choices: [{ value: "tight", label: "Tight" }, { value: "", label: "Default" }, { value: "loose", label: "Loose" }] },
  { key: "binoButton", label: "Bino's button", choices: [{ value: "", label: "The face a pack draws, when there is one" }, { value: "icon", label: "The assistant icon" }] },
];
export const LOOK_KEYS = LOOK.map((l) => l.key);

export const STATS_RANGES: Opt[] = [{ value: "", label: "12 weeks" }, { value: "4", label: "4 weeks" }, { value: "26", label: "26 weeks" }, { value: "14d", label: "14 days" }, { value: "28d", label: "28 days" }];
export const statsRange = (l: Layout) => (l.statsDays ? `${l.statsDays}d` : l.statsWeeks ? String(l.statsWeeks) : "");

const COLS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "off", label: "Hidden" },
] as const;

const pick = (name: string, label: string, value: string | undefined, choices: Opt[]) =>
  html`<label class="field"><span class="label">${label}</span><select name="${name}">${choices.map((o) => html`<option value="${o.value}"${(value ?? "") === o.value ? html` selected` : ""}>${o.label}</option>`)}</select></label>`;

const reset = (part: "look" | "layout") => html`<form method="post" action="/settings/layout/reset"><input type="hidden" name="part" value="${part}"><button type="submit" class="sm">Back to defaults</button></form>`;

/** What each of Look's choices shows beside its name: the theme or accent as a swatch, a font or size as a sample. */
const SAMPLE: Record<string, (value: string) => Html | ""> = {
  theme: (v) => html`<span class="sw sw-theme sw-${v || "system"}" aria-hidden="true"></span>`,
  accent: (v) => html`<span class="sw sw-accent sw-${v || "fjord"}" aria-hidden="true"></span>`,
  font: (v) => html`<span class="sample font-${v || "mono"}" aria-hidden="true">Aa</span>`,
  textSize: (v) => html`<span class="sample size-${v || "default"}" aria-hidden="true">A</span>`,
  lineHeight: (v) => html`<span class="sample lh lh-${v || "default"}" aria-hidden="true"><i></i><i></i><i></i></span>`,
  binoButton: () => "",
};

/** One of Look's settings as a row of choices you can see, a radio each (the form saves on change). */
function choices(key: (typeof LOOK)[number]["key"], label: string, value: string | undefined, opts: Opt[]) {
  const now = value ?? "";
  const sample = SAMPLE[key] ?? (() => "");
  // "Light (cabin)": the name, then what it's like, quieter.
  const parts = (l: string) => /^(.*?) \((.*)\)$/.exec(l)?.slice(1) ?? [l, ""];
  return html`<fieldset class="choices${key === "textSize" || key === "lineHeight" ? " seg" : ""}" id="look-${key}"><legend class="label">${label}</legend><div class="choice-row">${opts.map((o) => {
    const [name, about] = parts(o.label);
    return html`<label class="choice"><input type="radio" class="sr-only" name="${key}" value="${o.value}"${now === o.value ? html` checked` : ""}>${sample(o.value)}<span class="choice-name">${name}${about ? html` <span class="t3">${about}</span>` : ""}</span></label>`;
  })}</div></fieldset>`;
}

export function lookPanel(l: Layout) {
  return Panel({
    id: "look",
    title: "Look",
    meta: "saves as you change it",
    actions: reset("look"),
    children: html`<form method="post" action="/settings/layout" data-autosave class="look"><input type="hidden" name="part" value="look">
${LOOK.map((o) => choices(o.key, o.label, l[o.key], o.choices))}
<noscript><div class="buttons"><button type="submit" class="primary">Save</button></div></noscript>
</form>`,
  });
}

export function layoutPanel(v: LayoutView) {
  const tab = (i: number) =>
    html`<label class="field"><span class="label">Tab ${i + 2}</span><select name="tab${i + 1}"><option value="">None</option>${v.pages.map((p) => html`<option value="${p.href}"${v.tabs[i] === p.href ? html` selected` : ""}>${p.title}</option>`)}</select></label>`;
  const card = (c: LayoutView["cards"][number]) =>
    html`<div class="layout-row"><span>${c.label}</span><select name="col:${c.id}" aria-label="${c.label}: column">${COLS.map((o) => html`<option value="${o.value}"${c.col === o.value ? html` selected` : ""}>${o.label}</option>`)}</select><input type="number" name="order:${c.id}" min="0" max="999" value="${c.order}" aria-label="${c.label}: order"></div>`;
  const stat = (x: LayoutView["stats"][number]) =>
    html`<div class="layout-row"><span>${x.label} <span class="t3">${x.from}</span></span><select name="stat:${x.id}" aria-label="${x.label}: shown"><option value="on"${x.show ? html` selected` : ""}>Shown</option><option value="off"${x.show ? "" : html` selected`}>Hidden</option></select><input type="number" name="statorder:${x.id}" min="0" max="999" value="${x.order}" aria-label="${x.label}: order"></div>`;
  const off = (list: string[] | undefined, id: string) => !!list?.includes(id);
  const form = html`<form method="post" action="/settings/layout" data-autosave><input type="hidden" name="part" value="layout">
<div class="field" id="tabs"><span class="label">On the phone</span><span class="hint">The bar at the foot: Today, then up to three pages, then More.</span></div>
<div class="fields">${[0, 1, 2].map(tab)}</div>
${v.opener ? html`<div class="fields" id="links">${pick("links", "Links to other sites", v.layout.links, [{ value: "", label: "In the browser the app was installed from" }, { value: "default", label: "In your default browser" }])}</div>` : ""}
${v.cards.length
  ? html`<div class="field" id="cards"><span class="label">Today's cards</span><span class="hint">Each in a column, lowest number first; hidden ones aren't drawn.</span></div>
<div class="layout-rows">${v.cards.map(card)}</div>`
  : ""}
${v.stats.length
  ? html`<div class="field" id="stats"><span class="label">Stats</span><span class="hint">What the Stats page shows, lowest number first, and how far back its charts reach, by week or by day.</span></div>
<div class="fields">${pick("statsWeeks", "Range on Stats", statsRange(v.layout), STATS_RANGES)}</div>
<div class="layout-rows">${v.stats.map(stat)}</div>`
  : ""}
${v.feeds.length
  ? html`<div class="field" id="feed"><span class="label">What's happening</span><fieldset>${v.feeds.map((f) => html`<label class="check"><input type="checkbox" name="feed" value="${f.id}"${off(v.layout.feedOff, f.id) ? "" : html` checked`}> ${f.name}</label><br>`)}</fieldset><span class="hint">The apps whose events reach the feed.</span></div>`
  : ""}
${v.packs.length
  ? html`<div class="field" id="packs-shown"><span class="label">Packs shown</span><fieldset>${v.packs.map((c) => html`<label class="check"><input type="checkbox" name="pack" value="${c.id}"${off(v.layout.packsOff, c.id) ? "" : html` checked`}> ${c.name}</label><br>`)}</fieldset><span class="hint">A hidden pack leaves the menu, Today, the feed, search and Bino, its pages answer 404, and it stops refreshing. <a href="/packs">Packs</a> lists them all.</span></div>`
  : ""}
<noscript><div class="buttons"><button type="submit" class="primary">Save</button></div></noscript>
</form>`;
  return Panel({
    id: "layout",
    title: "Layout",
    meta: "saves as you change it",
    actions: reset("layout"),
    children: form,
  });
}
