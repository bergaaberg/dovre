/**
 * Dovre's own settings, for Bino (#185): found by what I call them, never carried in the prompt,
 * so it stays the same size however many settings and packs there are. Bino gets a setting's id,
 * what it is now and the values it takes, and proposes a `setting` card with them
 * (src/packs/core/assistant/bino/acts.ts). A setting that isn't changed from a card comes back as
 * where its page is, without its value: Work's and a pack's own can say more than Bino should hear.
 */
import { SETTINGS_KIND } from "./acts.ts";
import type { LookupSpec } from "./lookups.ts";
import { AREAS, changeLabel, choicesOf, findRows, type SettingRow } from "../../../../pages/settings.ts";
import type { SettingsApi } from "../../../../routes/settings.ts";

export const SETTINGS_LOOKUP: LookupSpec = {
  kind: SETTINGS_KIND,
  app: "Dovre",
  when: "Find one of Dovre's own settings by what the user calls it (text size, theme, what rings, quiet hours, a pack on or off, a shortcut, whether a write asks twice): its id, what it is now, and the values it takes. Look a setting up before you propose changing it.",
  fields: [{ name: "q", about: "a word or two, like: text size", required: true, max: 80 }],
};

/** Most settings one lookup tells of. */
const MAX_ROWS = 12;

const quoted = (v: string) => JSON.stringify(v);

function lineOf(r: SettingRow): string {
  const head = `- id ${quoted(r.id)}: ${r.label} (${AREAS.find((a) => a.id === r.area)?.title ?? r.area}).`;
  const c = r.change;
  if (!c) return `${head} Not changed from a card: the user changes it on its page, ${r.href}. Proposed as a setting, its card is a link there.`;
  if (c.kind === "number") return `${head} Now ${c.value}. Takes a whole number from ${c.min ?? 0} to ${c.max ?? "any"}.`;
  if (c.kind === "hours") return `${head} Now ${quoted(c.value || "none")} (${changeLabel(c, c.value)}). Takes from one hour to another, 0 to 23, like "22-7" (across midnight is fine), or "none".`;
  // A switch is said as on and off, which is how its card reads them.
  const said = (v: string) => (c.kind === "switch" ? quoted(changeLabel(c, v).toLowerCase()) : `${quoted(v)} (${changeLabel(c, v)})`);
  const loose = choicesOf(c).filter((x) => c.loosens?.(x.value));
  return `${head} Now ${said(c.value)}. Takes: ${choicesOf(c).map((x) => said(x.value)).join(", ")}.${loose.length ? ` To ${loose.map((x) => quoted(x.value)).join(" or ")} loosens a guard: the user is asked twice.` : ""}`;
}

/** The settings that go by `q`: those a card can change first, a dozen at most. */
export async function findSettings(api: Pick<SettingsApi, "rows">, args: Record<string, string>): Promise<{ text: string; error?: boolean }> {
  let rows: SettingRow[];
  try {
    rows = await api.rows();
  } catch {
    return { text: "Dovre's settings can't be read right now.", error: true };
  }
  const q = (args.q ?? "").slice(0, 80);
  let found = findRows(rows, q);
  // Every word found nothing: any of them, so "bigger letters" still finds text size.
  if (!found.length) {
    const words = q.split(/\s+/).filter((w) => w.length > 2);
    found = rows.filter((r) => words.some((w) => findRows([r], w).length));
  }
  if (!found.length) return { text: `No setting goes by ${quoted(q)}. Try one plain word; the user can also search on Settings (/settings).` };
  const shown = [...found.filter((r) => r.change), ...found.filter((r) => !r.change)].slice(0, MAX_ROWS);
  return { text: `${shown.map(lineOf).join("\n")}${found.length > shown.length ? `\n(${found.length - shown.length} more: ask with a narrower word.)` : ""}` };
}
