/**
 * The themes packs offer (`Pack.themes`, pack API 2.4), read once at load: each checked and turned
 * into a theme of core's own kind (src/ui/themes.ts), or left out with the reason in the pack's log.
 * A pack gives tokens, never CSS: core writes the block, so no pack selector reaches `:root`.
 */
import { accentFails, paletteFails } from "../ui/contrast.ts";
import { ACCENTS, coreTheme, packTheme, type Scheme, swatchRule, type ThemeDef, themeRules, type Tokens } from "../ui/themes.ts";
import type { Pack } from "./types.ts";

/** At most this many a pack: the picker is one row of choices. */
const MOST = 8;

/** What a palette fails: text, edges and marks, then each accent as text on its surfaces. */
export const themeFails = (palette: Tokens, scheme: Scheme, label: string): string[] => [...paletteFails(palette, label), ...ACCENTS.flatMap((a) => accentFails(palette, a[scheme].c, `${label}/${a.id}`))];

/** Each pack's themes that pass, by pack id; a refused one is logged, and so is an id another pack took first. */
export function themesFrom(packs: Pack[], log: (id: string, line: string) => void): Map<string, ThemeDef[]> {
  const out = new Map<string, ThemeDef[]>();
  const taken = new Set<string>();
  for (const c of packs) {
    const id = c.manifest.id;
    let offered: unknown;
    try {
      offered = c.themes;
    } catch {
      offered = undefined;
    }
    if (offered === undefined) continue;
    if (!Array.isArray(offered)) {
      log(id, "themes: not a list, left out");
      continue;
    }
    if (offered.length > MOST) log(id, `themes: ${offered.length} offered, the first ${MOST} read`);
    const mine: ThemeDef[] = [];
    for (const raw of offered.slice(0, MOST)) {
      const r = packTheme({ id, name: c.manifest.name }, raw, themeFails);
      if ("why" in r) log(id, `themes: left out: ${r.why}`);
      else if (coreTheme(r.theme.id) || taken.has(r.theme.id)) log(id, `themes: ${r.theme.id} is already a theme, left out`);
      else {
        taken.add(r.theme.id);
        mine.push(r.theme);
      }
    }
    if (mine.length) out.set(id, mine);
  }
  return out;
}

/** The stylesheet for these themes: each one's block, its accents and its swatch. */
export const themesCss = (themes: ThemeDef[]): string => themes.map((t) => `${themeRules(t)}\n${swatchRule(t)}`).join("\n");
