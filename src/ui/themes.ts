/**
 * The themes and accents, each written once (Settings → Look). Everything else is read from here:
 * the ids a saved Layout may hold (src/layout.ts), the picker's names (src/pages/layout.ts), the
 * stylesheet's blocks and swatches (src/ui/style.ts) and the browser bar's colour (src/html.ts).
 * Adding a theme is one entry in `DEFS`; test/contrast.test.ts then checks it without listing it.
 *
 * A theme is its scheme and the palette tokens it changes: a light one sits on morning's
 * (`:root`), a dark one on night's. Text, accents and status pass WCAG AA on every surface (ink and
 * ink-2 7:1), and --c1/--c2 pass the dataviz validator on each --surface. ok, warn and bad mean
 * status only, in every theme.
 */
export type Scheme = "light" | "dark";
export type Tokens = Record<string, string>;
export type ThemeDef = {
  id: string;
  /** Its name in the picker ("Birch"), and what it's like, quieter beside it ("cool light"). */
  label: string;
  about: string;
  scheme: Scheme;
  /** The tokens it sets on top of its scheme's. */
  tokens: Tokens;
};

/** Morning in the cabin: oat and cream, espresso ink, warm stone (PLAN WP-M2). `:root`'s palette. */
const MORNING: Tokens = {
  "--bg": "#f8f4ee", "--sky": "#efe7db", "--surface": "#fffdfa", "--surface-2": "#f8f3ed", "--hover": "#f1ebe2",
  "--ink": "#2a1d14", "--ink-2": "#54453a", "--ink-3": "#65564a",
  "--line": "#e9e1d5", "--line-2": "#d6cabb",
  // A control's own edge (inputs, selects, checkboxes, radio cards): 3:1 on every surface, WCAG 1.4.11.
  // --line-2 stays for dividers and for buttons, which their label identifies.
  "--control": "#8d7f72",
  "--accent": "#1d5c88", "--accent-ink": "#ffffff", "--accent-soft": "#e3edf5", "--accent-line": "#b9cfe0",
  // The f / F hint letters: an overlay, not a status, so a colour of their own (Vimium's yellow).
  "--hint": "#ffd84a", "--hint-ink": "#1f1700", "--hint-line": "#b8930c",
  "--ok": "#3d7230", "--ok-soft": "#e6efdf",
  "--warn": "#965800", "--warn-soft": "#faf0db",
  "--bad": "#ad1f3b", "--bad-soft": "#f9e3e7",
  // Chart series (src/ui/chart.ts), checked with the dataviz validator on --surface: identity, not status.
  "--c1": "#2a78d6", "--c2": "#eb6834", "--s3": "#1baf7a", "--s4": "#eda100", "--s5": "#e87ba4",
  // The blue ramp (heatmaps, ordered outcomes): h1 faintest, h6 strongest on this surface.
  "--h1": "#cde2fb", "--h2": "#9ec5f4", "--h3": "#6da7ec", "--h4": "#3987e5", "--h5": "#256abf", "--h6": "#184f95",
  "--ridge-farthest": "#ebe2d5", "--ridge-far": "#d8cbb9", "--ridge-near": "#ab9883", "--ridge-deep": "#8c7864", "--ridge-edge": "#6e5c4b",
  "--snow": "#fffdfa", "--night": "#e3d8c8", "--star": "#fffdfa", "--flag-bot": "#ab9c8e", "--sun": "var(--accent)",
  "--shadow": "0 1px 2px rgb(42 29 20 / .05), 0 10px 30px -18px rgb(42 29 20 / .2)",
};

/** Night in the mountains: blue-black sky, moonlit snow. Under the system's dark, and under every dark theme. */
const NIGHT: Tokens = {
  "--bg": "#0a1117", "--sky": "#0e1922", "--surface": "#111c25", "--surface-2": "#15222c", "--hover": "#1a2833",
  "--ink": "#e6ecf0", "--ink-2": "#b2bec7", "--ink-3": "#8c9aa5",
  "--line": "#1f2e39", "--line-2": "#2c3d4a", "--control": "#667581",
  "--accent": "#84b9df", "--accent-ink": "#07131c", "--accent-soft": "#15293a", "--accent-line": "#2a4a63",
  "--hint": "#f4cc3f", "--hint-ink": "#1a1300", "--hint-line": "#8a6d00",
  "--ok": "#8cc37a", "--ok-soft": "#15261a",
  "--warn": "#e5b65c", "--warn-soft": "#2a2113",
  "--bad": "#f2828f", "--bad-soft": "#2f161c",
  "--c1": "#3987e5", "--c2": "#d95926", "--s3": "#199e70", "--s4": "#c98500", "--s5": "#d55181",
  "--h1": "#103b73", "--h2": "#184f95", "--h3": "#256abf", "--h4": "#3987e5", "--h5": "#6da7ec", "--h6": "#9ec5f4",
  "--ridge-farthest": "#101c26", "--ridge-far": "#172633", "--ridge-near": "#253a4a", "--ridge-deep": "#162533", "--ridge-edge": "#5a7a90",
  "--snow": "#c9d7e1", "--night": "#060d14", "--star": "#dce7ef", "--flag-bot": "#4f6576", "--sun": "#c9d7e1",
  "--shadow": "0 1px 0 rgb(255 255 255 / .02) inset, 0 14px 40px -24px rgb(0 0 0 / .8)",
};

/** What each scheme's themes start from. */
export const BASE: Record<Scheme, Tokens> = { light: MORNING, dark: NIGHT };

const DEFS = {
  light: { label: "Light", about: "cabin", scheme: "light", tokens: {} },
  dark: { label: "Dark", about: "night", scheme: "dark", tokens: {} },
  /* birch bark: cool white and grey, slate ink */
  birch: {
    label: "Birch",
    about: "cool light",
    scheme: "light",
    tokens: {
      "--bg": "#f2f4f7", "--sky": "#e6ebf0", "--surface": "#ffffff", "--surface-2": "#f6f8fa", "--hover": "#eceff3",
      "--ink": "#16202a", "--ink-2": "#3b4753", "--ink-3": "#56626e",
      "--line": "#e1e6eb", "--line-2": "#c9d1d9", "--control": "#7a848f",
      "--accent": "#1d5c88", "--accent-ink": "#ffffff", "--accent-soft": "#e3edf5", "--accent-line": "#b9cfe0",
      "--ok": "#2f6b29", "--ok-soft": "#e4efe0", "--warn": "#8a5200", "--warn-soft": "#f8eedb", "--bad": "#ab1d39", "--bad-soft": "#f8e2e6",
      "--ridge-farthest": "#e4e9ee", "--ridge-far": "#ccd5dd", "--ridge-near": "#94a3b0", "--ridge-deep": "#758593", "--ridge-edge": "#5a6976",
      "--snow": "#ffffff", "--night": "#dbe2e8", "--star": "#ffffff", "--flag-bot": "#9aa6b1",
      "--shadow": "0 1px 2px rgb(22 32 42 / .05), 0 10px 30px -18px rgb(22 32 42 / .2)",
    },
  },
  /* polar night: true black for OLED screens, the night's ink */
  polar: {
    label: "Polar",
    about: "black",
    scheme: "dark",
    tokens: {
      "--bg": "#000000", "--sky": "#05080b", "--surface": "#0b0f13", "--surface-2": "#10161b", "--hover": "#161d23",
      "--ink": "#eef2f5", "--ink-2": "#b8c2ca", "--ink-3": "#8e9aa4",
      "--line": "#1b2229", "--line-2": "#29323a", "--control": "#626c75",
      "--accent-soft": "#10202d", "--accent-line": "#24425a",
      "--ok-soft": "#122015", "--warn-soft": "#241c10", "--bad-soft": "#2a1318",
      "--ridge-farthest": "#070b0f", "--ridge-far": "#0d151c", "--ridge-near": "#1a2833", "--ridge-deep": "#0e1820", "--ridge-edge": "#4a6578",
      "--night": "#000000",
    },
  },
  /* ember: the stove at night, warm brown-black and firelit ink */
  ember: {
    label: "Ember",
    about: "warm dark",
    scheme: "dark",
    tokens: {
      "--bg": "#15100c", "--sky": "#1b140f", "--surface": "#1f1712", "--surface-2": "#251c16", "--hover": "#2c221b",
      "--ink": "#f2e9e0", "--ink-2": "#cdbdae", "--ink-3": "#a89786",
      "--line": "#33271f", "--line-2": "#45362b", "--control": "#7e6e60",
      "--accent": "#8fc0e2", "--accent-ink": "#0b141b", "--accent-soft": "color-mix(in srgb, #8fc0e2 16%, #1f1712)", "--accent-line": "color-mix(in srgb, #8fc0e2 34%, #1f1712)",
      "--ok": "#93c781", "--ok-soft": "#1c2617", "--warn": "#e8bb62", "--warn-soft": "#2e2213", "--bad": "#f4899a", "--bad-soft": "#33181c",
      "--ridge-farthest": "#1d1611", "--ridge-far": "#2a1f17", "--ridge-near": "#3f2f23", "--ridge-deep": "#261c15", "--ridge-edge": "#8a6e57",
      "--snow": "#e9d9c8", "--night": "#0e0a07", "--star": "#f2e2cf", "--flag-bot": "#6d5847", "--sun": "#e9d9c8",
      "--shadow": "0 1px 0 rgb(255 240 220 / .02) inset, 0 14px 40px -24px rgb(0 0 0 / .8)",
    },
  },
} satisfies Record<string, Omit<ThemeDef, "id">>;

export type ThemeId = keyof typeof DEFS;
export const THEME_IDS = Object.keys(DEFS) as ThemeId[];
export const THEMES: ThemeDef[] = THEME_IDS.map((id) => ({ id, ...DEFS[id] }));

/** An accent: its colour and the ink on it, and how much of it its soft fill and its line take from the surface, per scheme. */
type AccentIn = { c: string; ink: string; soft: number; line: number };
export type AccentDef = { id: string; label: string; about: string } & Record<Scheme, AccentIn>;

/** Fjord's blue is the default: the schemes' own --accent tokens, so it has no block. */
export const FJORD = { label: "Fjord", about: "blue" };
/** The others, each checked against ok, warn and bad with the dataviz validator in both schemes (PLAN WP-N5). */
const ACCENT_DEFS = {
  heather: { label: "Heather", about: "violet", light: { c: "#6a4c9c", ink: "#ffffff", soft: 13, line: 32 }, dark: { c: "#a99cf0", ink: "#07131c", soft: 16, line: 34 } },
  glacier: { label: "Glacier", about: "ice blue", light: { c: "#0e6a8f", ink: "#ffffff", soft: 12, line: 30 }, dark: { c: "#5fc0e8", ink: "#07131c", soft: 16, line: 34 } },
} satisfies Record<string, Omit<AccentDef, "id">>;

export type AccentId = keyof typeof ACCENT_DEFS;
export const ACCENT_IDS = Object.keys(ACCENT_DEFS) as AccentId[];
export const ACCENTS: AccentDef[] = ACCENT_IDS.map((id) => ({ id, ...ACCENT_DEFS[id] }));

/** A theme's whole palette: its scheme's tokens with its own on top. */
export const paletteOf = (t: Pick<ThemeDef, "scheme" | "tokens">): Tokens => ({ ...BASE[t.scheme], ...t.tokens });

/** Each theme's --sky, for the browser's bar. */
export const SKY: Record<string, string> = Object.fromEntries(THEMES.map((t) => [t.id, paletteOf(t)["--sky"]!]));

const decls = (t: Tokens) => Object.entries(t).map(([k, v]) => `${k}: ${v};`).join(" ");
/** An accent's four tokens on a surface: its soft fill and line are mixed from it. */
const accentDecls = (a: AccentIn, surface: string) => decls({ "--accent": a.c, "--accent-ink": a.ink, "--accent-soft": `color-mix(in srgb, ${a.c} ${a.soft}%, ${surface})`, "--accent-line": `color-mix(in srgb, ${a.c} ${a.line}%, ${surface})` });
const accentRules = (selector: string, scheme: Scheme, surface: string) => ACCENTS.map((a) => `${selector}[data-accent="${a.id}"] { ${accentDecls(a[scheme], surface)} }`).join("\n");

/** Morning's palette, for `:root`. */
export const MORNING_CSS = decls(MORNING);

/** A picked theme's block and its accents; a dark one carries night's tokens whole, so it never leans on the system's. */
export function themeRules(t: ThemeDef): string {
  const sel = `:root[data-theme="${t.id}"]`;
  const all = paletteOf(t);
  const own = t.scheme === "dark" ? all : t.tokens;
  const body = Object.keys(own).length ? `\n  ${decls(own)}` : "";
  return `${sel} {\n  color-scheme: ${t.scheme};${body}\n}\n${accentRules(sel, t.scheme, all["--surface"]!)}`;
}

/**
 * Every rule that makes the schemes: the accents on morning, night under the system's dark when no
 * theme is picked, then each theme's own block. (light's block comes before dark's and the others';
 * each is as specific as the next, so the order among them doesn't matter.)
 */
export const THEME_CSS = [
  accentRules(":root", "light", MORNING["--surface"]!),
  `@media (prefers-color-scheme: dark) {\n:root:not([data-theme]) {\n  ${decls(NIGHT)}\n}\n${accentRules(":root:not([data-theme])", "dark", NIGHT["--surface"]!)}\n}`,
  ...THEMES.map(themeRules),
].join("\n");

/** The picker's swatches: a theme as its page, ink and accent; an accent as its colour. */
const swatch = (t: ThemeDef) => {
  const p = paletteOf(t);
  return `.sw-${t.id} { --sw-bg: ${p["--bg"]}; --sw-ink: ${p["--ink"]}; --sw-accent: ${p["--accent"]}; }`;
};
export const SWATCH_CSS = [
  `.sw-system { --sw-ink: ${MORNING["--ink"]}; --sw-accent: ${MORNING["--accent"]}; background: linear-gradient(135deg, ${MORNING["--bg"]} 50%, ${NIGHT["--bg"]} 50%); }`,
  ...THEMES.map(swatch),
  `.sw-accent { width: 20px; height: 20px; border-radius: 50%; background: var(--sw-accent); }`,
  `.sw-fjord { --sw-accent: ${MORNING["--accent"]}; }`,
  ...ACCENTS.map((a) => `.sw-${a.id} { --sw-accent: ${a.light.c}; }`),
].join("\n");

/** The swatch rule for one theme (a pack's is written beside its block). */
export const swatchRule = swatch;

/** One of core's own themes by id, or undefined: what the pages without packs' styles may wear (first run). */
export const coreTheme = (id: string | undefined): ThemeId | undefined => (id && Object.hasOwn(DEFS, id) ? (id as ThemeId) : undefined);

// ── Themes a pack offers (Pack.themes, pack API 2.4) ──

/** What a pack's theme may set: the palette's colours. The shadow stays its scheme's. */
export const THEME_TOKENS = Object.keys(MORNING).filter((k) => k !== "--shadow");
/** A pack's theme in a saved Layout and on <html>: `<pack>-<its id>`. Core's own have no hyphen. */
export const PACK_THEME_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const OWN_ID = /^[a-z][a-z0-9]{0,23}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const words = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.trim().length <= max && !/[\u0000-\u001f]/.test(v) ? v.trim() : undefined);

/**
 * A pack's offer as a theme, or why not. Tokens only: names from the palette, values `#rrggbb`,
 * so nothing a pack writes reaches a selector. Then the whole palette (its scheme's with its own
 * on top) must pass the same contrast check as core's themes, with each accent too.
 */
export function packTheme(pack: { id: string; name: string }, raw: unknown, fails: (palette: Tokens, scheme: Scheme, label: string) => string[]): { theme: ThemeDef } | { why: string } {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (!v) return { why: "a theme is an object" };
  if (typeof v.id !== "string" || !OWN_ID.test(v.id)) return { why: `a theme's id is a lowercase word (${JSON.stringify(v.id) ?? "none"})` };
  const label = words(v.label, 32);
  if (!label) return { why: `${v.id}: needs a label, at most 32 characters` };
  const about = v.about === undefined ? `from ${pack.name}` : words(v.about, 40);
  if (!about) return { why: `${v.id}: its about is at most 40 characters` };
  if (v.scheme !== "light" && v.scheme !== "dark") return { why: `${v.id}: its scheme is "light" or "dark"` };
  if (!v.tokens || typeof v.tokens !== "object" || Array.isArray(v.tokens)) return { why: `${v.id}: needs tokens` };
  const tokens: Tokens = {};
  for (const [k, val] of Object.entries(v.tokens as Record<string, unknown>).slice(0, 200)) {
    if (!THEME_TOKENS.includes(k)) return { why: `${v.id}: ${k.slice(0, 40)} isn't a palette token` };
    if (typeof val !== "string" || !HEX.test(val)) return { why: `${v.id}: ${k} must be a colour like #1a2b3c` };
    tokens[k] = val.toLowerCase();
  }
  if (!Object.keys(tokens).length) return { why: `${v.id}: sets no tokens` };
  const theme: ThemeDef = { id: `${pack.id}-${v.id}`, label, about, scheme: v.scheme, tokens };
  const bad = fails(paletteOf(theme), theme.scheme, v.id);
  if (bad.length) return { why: `${bad.slice(0, 3).join("; ")}${bad.length > 3 ? `; and ${bad.length - 3} more` : ""}` };
  return { theme };
}
