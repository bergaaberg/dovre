/**
 * The pack contract's version, "major.minor" (#360). A pack's manifest names the oldest core API
 * it works with; a core of that major and at least that minor runs it. The old integer `api: 1`
 * reads as "1.0". docs/ARCHITECTURE.md lists what each minor added.
 *
 * Since 1.24 (#473) the contract is what `src/pack.ts` exports (`dovre/pack.ts`), not only
 * `types.ts`: a name added there is a minor, one removed or changed is a major.
 */
import { PACK_API, type Pack } from "./types.ts";

type ApiVersion = { major: number; minor: number };

/** "1.5" or 1 (= 1.0) as numbers; null for anything else. */
export function parseApi(v: unknown): ApiVersion | null {
  const s = typeof v === "number" ? (Number.isInteger(v) && v >= 0 ? `${v}.0` : "") : typeof v === "string" ? v.trim() : "";
  const m = s.match(/^(\d{1,4})(?:\.(\d{1,4}))?$/);
  return m ? { major: Number(m[1]), minor: Number(m[2] ?? 0) } : null;
}

export const apiText = (v: ApiVersion) => `${v.major}.${v.minor}`;

/** Why a pack needing `need` can't run on a core speaking `have`, or null when it can. */
export function apiGap(need: unknown, have: string = PACK_API): string | null {
  const n = parseApi(need);
  const h = parseApi(have)!;
  if (!n) return `its api ${JSON.stringify(need) ?? "?"} isn't a version like ${have}`;
  if (n.major !== h.major) return `written for pack contract ${n.major}, this Dovre speaks ${h.major}: ${n.major < h.major ? "update the pack" : "update Dovre first"}`;
  if (n.minor > h.minor) return `needs core API ${apiText(n)}, this is ${apiText(h)}`;
  return null;
}

/** Orders two API versions (-1, 0, 1); an unreadable one sorts first. */
export function apiCompare(a: unknown, b: unknown): number {
  const x = parseApi(a);
  const y = parseApi(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  return Math.sign(x.major - y.major || x.minor - y.minor);
}

/**
 * One thing a minor added, and how a pack is seen using it (#482): `has` looks at the pack as
 * loaded (a manifest field, a hook), `text` at its files, `door` and `testing` at the names it
 * imports from `dovre/pack.ts` and `dovre/pack-testing.ts`.
 */
export type ApiUse = { name: string; has?: (pack: Pack) => boolean; text?: RegExp; door?: string; testing?: string };

const plain = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `ctx.<member>`, or `<member>` taken out of `ctx` by name. */
const ctx = (member: string): ApiUse => ({ name: `ctx.${member}`, text: new RegExp(`\\bctx\\.${member}\\b|\\{[^{}]*\\b${member}\\b[^{}]*\\}\\s*=\\s*ctx\\b`) });
/** A call on what `ctx.forge()` answers. */
const forge = (member: string): ApiUse => ({ name: `forge().${member}`, text: new RegExp(`\\bforge(?:\\(\\))?[?!]?\\.${member}\\(`) });
/** A slot by name, filled or hosted. */
const slot = (name: string): ApiUse => ({ name: `slot ${name}`, text: new RegExp(`["'\`]${plain(name)}["'\`]`) });
/** A share read with `ctx.required(id, name)`. */
const share = (name: string): ApiUse => ({ name: `share ${name}`, text: new RegExp(`\\brequired\\(\\s*[^,()]+,\\s*["']${name}["']\\s*\\)`) });
const has = (name: string, test: (pack: Pack) => unknown): ApiUse => ({ name, has: (pack) => !!test(pack) });
const text = (name: string, re: RegExp): ApiUse => ({ name, text: re });
const door = (names: string): ApiUse[] => names.split(/\s+/).filter(Boolean).map((name) => ({ name, door: name }));
const testing = (names: string): ApiUse[] => names.split(/\s+/).filter(Boolean).map((name) => ({ name, testing: name }));

/**
 * What each minor added, as far as a pack can be seen using it: docs/ARCHITECTURE.md's table as
 * data (test/docs.test.ts holds the two together). `assertApi` (src/packs/floor.ts) reads a pack
 * against it and fails on a name newer than its manifest's `api`. Text matching is crude on purpose:
 * it catches the forgotten bump. Not seen: `forge().file` at a commit (1.2), a `propose` with
 * `files` and a setup step's `refresh` (1.17), a pack's own share read by a name that isn't a
 * literal in the call (1.38), `refresh`'s `soon` and `agent` (1.40), and what a pack only reads off a type.
 */
export const API_1: Record<string, ApiUse[]> = {
  "1.1": [has("Pack.files", (p) => p.files && Object.keys(p.files).length)],
  "1.2": [slot("pr.file")],
  "1.3": [has("a file with wasm: true", (p) => Object.values(p.files ?? {}).some((f) => f.wasm))],
  "1.4": [text("dovreFiles", /\bdovreFiles\b/), text("pre.code[data-lang]", /\[data-lang\b/)],
  "1.5": [text("code[data-tex]", /\[data-tex\b/)],
  "1.6": [has("manifest.version", (p) => p.manifest.version)],
  "1.7": [ctx("checkouts"), ctx("checkout")],
  "1.8": [text("a stat's bars", /\bbars:\s*[[\w(]/), text("partialLast", /\bpartialLast\b/), text("refresh's asked", /\{\s*asked\s*\}|\.asked\b/)],
  "1.9": [slot("pr.agent"), slot("review.draft")],
  "1.10": [slot("ai.summary")],
  "1.11": [has("manifest.uses", (p) => p.manifest.uses?.length), ctx("refs"), share("list")],
  "1.12": [share("agent")],
  "1.13": [ctx("pageOn"), slot("pr.stack")],
  "1.14": [
    has("manifest.roles", (p) => p.manifest.roles?.length),
    has("manifest.answers", (p) => p.manifest.answers?.length),
    has("manifest.markers", (p) => p.manifest.markers?.length),
    has("manifest.onboard", (p) => p.manifest.onboard),
  ],
  "1.15": [has("a setting's choices", (p) => p.manifest.settings?.some((s) => s.choices))],
  "1.16": [has("Pack.setup", (p) => p.setup), ctx("setupDone")],
  "1.17": [],
  "1.18": [has("manifest.via", (p) => p.manifest.via)],
  "1.19": [text("a setup step's go", /\bgo:\s*\{/), text("a setup step's carry", /\bcarry:\s/)],
  "1.20": [forge("untriaged")],
  "1.21": [forge("pr"), forge("dir")],
  "1.22": [has("manifest.ai", (p) => p.manifest.ai), ctx("ai"), ctx("complete")],
  "1.23": [has("manifest.ai.agent", (p) => p.manifest.ai?.agent), ctx("agent")],
  "1.24": [text("dovre/pack.ts", /["']dovre\/pack(?:-testing)?\.ts["']/)],
  "1.25": [ctx("logged"), ...door("PackLogged")],
  "1.26": [ctx("run"), ctx("onPath"), ctx("dir"), has("manifest.binaries", (p) => p.manifest.binaries?.length), ...door("PackRan PackRunOpts")],
  "1.27": [
    ...door("App AppEnv Changelog D1 D1Statement Deploy EveryRepo Forge ForgeCan ForgeDecl ForgeWork Issue IssueSets Move Need Note PackProposal Pr PrRef Proposal Proposed"),
    ...door("Reading Snapshot byPerson deploySummaryKey hashOf hourAt inFiles later needsOf prSummaryKey strictOrigin throttle"),
    ...testing("openDb"),
  ],
  "1.28": testing("ON_JS activePacks apiGap assertStyled createWorker ingestToken resetWhen setWhen testForge testList testPage"),
  "1.29": door("format"),
  "1.30": door("ColumnChart D1Value FunnelDiagram HBars Heatmap IconName Page SankeyChart StackedBar chart within"),
  "1.31": [ctx("viewer"), ...testing("keptLookups")],
  "1.32": [forge("owns"), ...door("owners")],
  "1.33": [ctx("store"), ...door("PackKv PackStore")],
  "1.34": [has("manifest.ai.mcp", (p) => p.manifest.ai?.mcp), ctx("mcp"), ...door("PackMcp PackMcpAsk PackMcpCall PackMcpCan PackMcpResult PackMcpSetup")],
  "1.35": [has("Pack.migrations", (p) => p.migrations?.length), ...testing("assertTables")],
  "1.36": [has("a setting's namesKeys", (p) => p.manifest.settings?.some((s) => s.namesKeys))],
  "1.37": testing("assertApi apiOver"),
  "1.38": [text("a pack's own share in ctx.required", /\brequired\(\s*[^,()]+,\s*["'](?!(?:agent|list|auto)["'])[\w.-]+["']\s*\)/)],
  "1.39": [has("manifest.hosts", (p) => p.manifest.hosts?.length), ctx("fillOwn"), text("another pack's place in slots", /(?<!\?\s*)["'](?!(?:application|text|image|audio|video|font|multipart|message|model)\/)[a-z][a-z0-9-]*\/[a-z][a-z0-9.-]*["']\s*:\s*(?![\s"'`\d[{])/)],
  "1.40": [ctx("soon"), ...testing("soonOf")],
  "1.41": [],
};

/**
 * What each minor of this major added, in the same shape; `API_1` above is 1.x's, kept as the
 * record 2.0 started from (docs/PACK-API-1.md) and as what the floor's tests read. A 2.0 pack may
 * use all of it, so 2.x starts empty: the first minor adds `"2.1": [...]`.
 */
export const API_ADDED: Record<string, ApiUse[]> = {
  "2.1": [has("Pack.server", (p) => p.server), ctx("call"), ...door("PackServer PackCalled"), ...testing("serverOf")],
  "2.2": [has("Pack.isolated", (p) => p.isolated)],
  "2.3": [has("manifest.replaces", (p) => p.manifest.replaces?.length)],
  "2.4": [has("Pack.themes", (p) => p.themes?.length), ...door("PackTheme THEME_TOKENS"), ...testing("assertThemes")],
  "2.5": [has("a setting's default", (p) => p.manifest.settings?.some((s) => s.default !== undefined)), has("a setting's kind: number", (p) => p.manifest.settings?.some((s) => s.kind === "number"))],
  "2.6": [forge("shipped"), ...door("ForgeShipped")],
};
