/**
 * What's switched on, and how (WP-A23): each pane's switch and its main options. Set on Settings
 * (and on the first-run page), kept in the settings table under "config" as KEY → value, the same
 * keys `.dev.vars` takes. `.dev.vars` and the environment still win: a key set there shows as fixed.
 * Read once at start (src/index.ts), so a change applies on restart.
 *
 * An off pane is gone from the side menu, search and Today, its pages are 404, and its background
 * work never starts.
 */
import type { D1 } from "./db.ts";
import type { Env } from "./env.ts";
import { viaOf } from "./packs/core/assistant/bino/route.ts";
import { summariesVia } from "./tools.ts";

export type Choice = { value: string; label: string };
/** A setting: a choice (the first is the default), a number, or text matching `pattern`. `placeholder` shows the default. */
export type Field =
  | { key: string; label: string; hint?: string; placeholder?: string; kind: "choice"; choices: Choice[] }
  | { key: string; label: string; hint?: string; placeholder?: string; kind: "number"; min: number; max: number }
  | { key: string; label: string; hint?: string; placeholder?: string; kind: "text"; pattern: RegExp };

export const PANE_IDS = ["bino", "terminal", "docker", "stats", "reviews", "summaries", "lab"] as const;
export type PaneId = (typeof PANE_IDS)[number];

/** What this machine has: a pane that needs something missing can't run, whatever its switch says. */
export type Found = { claude: boolean; omp: boolean; /** omp's Copilot profile is set up (src/ai/omp.ts). Unset: as `omp`. */ copilot?: boolean; /** Copilot CLI (`copilot`) is here. */ copilotCli?: boolean; agy?: boolean; codex?: boolean; pwsh?: boolean; db?: boolean; terminals: boolean; /** This is Windows: Docker (WSL) needs it. Unset: yes, for tests and old callers. */ windows?: boolean; /** Unix socket for Docker Engine on macOS/Linux. */ dockerSocket?: string };

export type Pane = {
  id: PaneId;
  name: string;
  what: string;
  /** The switch: `off` when off; when on, one of `on` (more than one: picked under "Through"). */
  key: string;
  on: Choice[];
  options: Field[];
};

const ON: Choice[] = [{ value: "on", label: "On" }];
/** Comma-separated names: letters, digits, . _ - only. */
const LIST = /^[\w.\-]+(\s*,\s*[\w.\-]+)*$/;

export const PANES: Pane[] = [
  {
    id: "bino",
    name: "Bino",
    what: "The assistant: scoped memory, repo context (Topo), and plan proposals; it proposes, you click",
    key: "BINO_VIA",
    on: [
      { value: "claude", label: "Claude Code" },
      { value: "omp", label: "Copilot (omp)" },
      { value: "copilot", label: "Copilot CLI" },
      { value: "agy", label: "Antigravity (agy): keeps its tools" },
      { value: "codex", label: "Codex: keeps its tools, read-only" },
      { value: "api-key", label: "Direct API Key (cheap model recommended)" },
      { value: "cf-gateway", label: "Cloudflare AI Gateway" },
      { value: "openrouter", label: "OpenRouter" },
    ],
    options: [],
  },
  { id: "terminal", name: "Terminal", what: "Shells and agent CLIs in a checkout, inside Dovre", key: "TERMINAL", on: ON, options: [] },
  { id: "docker", name: "Docker", what: "Containers on Docker Engine: start, stop, restart and logs", key: "DOCKER", on: ON, options: [] },
  { id: "stats", name: "Stats", what: "Twelve weeks of PRs, reviews and agent spend", key: "STATS", on: ON, options: [] },
  { id: "reviews", name: "Agent reviews", what: "Review a PR, or assess a review on yours, with an agent skill (REVIEW_SKILL, TRIAGE_SKILL)", key: "REVIEWS", on: ON, options: [] },
  {
    id: "summaries",
    name: "AI summaries",
    what: "A short summary on each PR and deploy, from the PR's own text",
    key: "SUMMARIES",
    on: [{ value: "claude", label: "Claude (Haiku)" }, { value: "omp", label: "Copilot (omp)" }, { value: "copilot", label: "Copilot CLI" }, { value: "agy", label: "Antigravity (agy): keeps its tools" }, { value: "codex", label: "Codex: keeps its tools, read-only" }],
    options: [],
  },
  { id: "lab", name: "Lab", what: "Prototypes and pages kept in data/lab", key: "LAB", on: ON, options: [] },
];

/** The settings that aren't a pane: where things are, and who I work with. */
export const GENERAL: Field[] = [
  { key: "REPO_OWNERS", label: "Owners to track", hint: "Orgs and users on the host, comma-separated; the first is where short names (repo#12) belong", kind: "text", pattern: LIST, placeholder: "my-org, my-user" },
  { key: "CODE_DIR", label: "Code folder", hint: "Your checkouts sit right in it (<folder>/<repo>)", kind: "text", pattern: /^[^"<>|?*\r\n]{1,260}$/ },
  { key: "TEAM", label: "Your team on GHE", hint: "The team's slug, for grouping work by the people in it", kind: "text", pattern: /^[\w.\-]{1,100}$/, placeholder: "my-team" },
  { key: "FORM_REPOS", label: "Repos with their own issue forms", hint: "comma-separated", kind: "text", pattern: LIST, placeholder: "forms-repo" },
  { key: "AGENT_HARNESSES", label: "Agent CLIs to use", hint: "comma-separated, of claude, omp, copilot, agy, codex; empty: every one found here. Bino and summaries pick their own", kind: "text", pattern: /^(claude|omp|copilot|agy|codex)(\s*,\s*(claude|omp|copilot|agy|codex))*$/i, placeholder: "claude, codex" },
  { key: "SORTING_REPOS", label: "Repos where work is planned", hint: "comma-separated; dev tasks go under their issues", kind: "text", pattern: LIST, placeholder: "intake" },
  { key: "GREETING", label: "Greeting language", hint: "en (Good morning) or no (God morgen)", kind: "choice", choices: [{ value: "en", label: "English" }, { value: "no", label: "Norsk" }] },
  { key: "TZ_NAME", label: "Timezone", hint: "An IANA timezone name (e.g. Europe/Oslo). Empty or invalid: this machine's own zone (UTC when hosted)", kind: "text", pattern: /^[A-Za-z0-9_+\/-]{1,64}$/, placeholder: "this machine's zone" },
];

export const paneOf = (id: PaneId) => PANES.find((p) => p.id === id)!;

/** Each pane as it is now: wanted (its switch), running (it can run here too), how, and why not. */
export type PaneState = { id: PaneId; wanted: boolean; on: boolean; via?: string; why?: string };

/** A switch that isn't "off" (or no/false/0) is on. */
const isOff = (v: string | undefined) => /^(off|no|false|0)$/i.test((v ?? "").trim());

export function panesOf(env: Partial<Env> & Record<string, unknown>, f: Found): Record<PaneId, PaneState> {
  const v = env as Record<string, string | undefined>;
  const simple = (id: PaneId, key: string, can: boolean, why: string): PaneState => {
    const wanted = !isOff(v[key]);
    return { id, wanted, on: wanted && can, why: wanted && !can ? why : undefined };
  };
  const windows = f.windows !== false;
  const copilot = f.copilot ?? f.omp;
  const noCopilot = f.omp ? "Copilot through omp isn't set up yet: see Setup." : "Needs omp (`omp` on the PATH).";
  const cli = !!f.copilotCli;
  const binoVia = viaOf(v.ASSISTANT_VIA ?? v.BINO_VIA, f.claude, f.omp, cli, !!f.agy);
  const hasDirectKey = !!(v.ASSISTANT_API_KEY || v.ANTHROPIC_API_KEY || v.OPENAI_API_KEY || v.GEMINI_API_KEY);
  const hasOpenRouter = !!(v.OPENROUTER_API_KEY || v.ASSISTANT_API_KEY);
  const binoCan =
    binoVia === "claude"
      ? f.claude
      : binoVia === "omp"
        ? copilot
        : binoVia === "copilot"
          ? cli
          : binoVia === "agy"
            ? !!f.agy
            : binoVia === "codex"
              ? !!f.codex
              : binoVia === "api-key"
                ? hasDirectKey
                : binoVia === "openrouter"
                  ? hasOpenRouter
                  : binoVia === "cf-gateway"
                    ? !!(v.CF_ACCOUNT_ID && v.CF_AIG_TOKEN)
                    : false;
  const noCli = "Needs Copilot CLI (`copilot` on the PATH, or COPILOT_BIN).";
  const noAgy = "Needs agy (`agy` on the PATH, or AGY_BIN).";
  const noCodex = "Needs Codex (`codex` on the PATH, or CODEX_BIN).";
  const noApiKey = "Needs ASSISTANT_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) in .dev.vars.";
  const noOpenRouter = "Needs OPENROUTER_API_KEY in .dev.vars.";
  const noGateway = "Needs CF_ACCOUNT_ID and CF_AIG_TOKEN in .dev.vars.";
  const sumVia = summariesVia(v.SUMMARIES, f.claude, f.omp, cli, !!f.agy);
  const sumCan = sumVia === "claude" ? f.claude : sumVia === "omp" ? copilot : sumVia === "copilot" ? cli : sumVia === "agy" ? !!f.agy : sumVia === "codex" ? !!f.codex : false;
  return {
    bino: {
      id: "bino",
      wanted: binoVia !== "off",
      on: binoCan,
      via: binoVia,
      why:
        binoVia !== "off" && !binoCan
          ? binoVia === "claude"
            ? "Needs Claude Code (`claude` on the PATH)."
            : binoVia === "copilot"
              ? noCli
              : binoVia === "agy"
                ? noAgy
                : binoVia === "codex"
                  ? noCodex
                  : binoVia === "api-key"
                    ? noApiKey
                    : binoVia === "openrouter"
                      ? noOpenRouter
                      : binoVia === "cf-gateway"
                        ? noGateway
                        : noCopilot
          : undefined,
    },
    terminal: simple("terminal", "TERMINAL", f.terminals, "Needs the launcher built (go build -o ../bin/dovre . in launcher/, or scripts/install.ps1)."),
    docker: simple("docker", "DOCKER", windows || !!f.dockerSocket, windows ? "Windows only: Docker Engine runs in a WSL distro of its own." : "No Docker Engine socket found (looked in ~/.docker/run/docker.sock, ~/.orbstack/run/docker.sock, ~/.colima/default/docker.sock, /var/run/docker.sock)."),
    stats: simple("stats", "STATS", true, ""),
    reviews: simple("reviews", "REVIEWS", f.claude || f.omp, "Needs an agent CLI: Claude Code or omp."),
    summaries: { id: "summaries", wanted: sumVia !== "off", on: sumCan, via: sumVia, why: sumVia !== "off" && !sumCan ? (sumVia === "claude" ? "Needs Claude Code (`claude` on the PATH)." : sumVia === "copilot" ? noCli : sumVia === "agy" ? noAgy : sumVia === "codex" ? noCodex : noCopilot) : undefined },
    lab: simple("lab", "LAB", true, ""),
  };
}

/** Which panes run, for the app (src/app.ts): only `false` hides one, so tests and old callers see everything. */
export type PanesOn = Partial<Record<PaneId, boolean>>;
export const runningOf = (p: Record<PaneId, PaneState>): PanesOn => Object.fromEntries(PANE_IDS.map((id) => [id, p[id].on]));

// ── Kept in the settings table ──

export type Config = Record<string, string>;
const KEYS = new Set([...PANES.flatMap((p) => [p.key, ...p.options.map((o) => o.key)]), ...GENERAL.map((g) => g.key), "SETUP_DONE"]);

export async function loadConfig(db: D1): Promise<Config> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'config'").first<{ value: string }>();
  try {
    const v = JSON.parse(row?.value ?? "{}");
    // Only keys this file knows, as strings: an old or edited row can't set anything else.
    return Object.fromEntries(Object.entries(v && typeof v === "object" ? v : {}).filter(([k, x]) => KEYS.has(k) && typeof x === "string")) as Config;
  } catch {
    return {};
  }
}

export async function saveConfig(db: D1, c: Config): Promise<void> {
  const clean = Object.fromEntries(Object.entries(c).filter(([k, x]) => KEYS.has(k) && typeof x === "string"));
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES ('config', ?, ?)").bind(JSON.stringify(clean), new Date().toISOString()).run();
}

const fieldValue = (f: Field, raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (f.kind === "choice") return f.choices.some((c) => c.value === s) ? s : undefined;
  if (f.kind === "number") return /^\d{1,4}$/.test(s) && Number(s) >= f.min && Number(s) <= f.max ? s : s === "" ? "" : undefined;
  return s === "" || f.pattern.test(s) ? s : undefined;
};

/**
 * A posted Settings form as config: `on.<pane>` is the switch, `via.<pane>` the route, options by
 * key. Fixed keys (set in .dev.vars or the environment) are left as they were; a value that isn't
 * one of the field's is refused, with what was wrong. An empty field means "the default".
 */
export function configFromForm(form: Record<string, unknown>, was: Config, fixed: Set<string>, opts: { panes?: boolean; general?: boolean } = {}): { config: Config; bad: string[] } {
  const next: Config = { ...was };
  const bad: string[] = [];
  const put = (key: string, value: string | undefined, label: string) => {
    if (fixed.has(key)) return;
    if (value === undefined) bad.push(label);
    else if (value === "") delete next[key];
    else next[key] = value;
  };
  for (const p of opts.panes ? PANES : []) {
    const on = form[`on.${p.id}`] !== undefined;
    const via = typeof form[`via.${p.id}`] === "string" ? String(form[`via.${p.id}`]) : p.on[0]!.value;
    put(p.key, !on ? "off" : p.on.some((c) => c.value === via) ? via : undefined, p.name);
    for (const o of p.options) if (o.key in form) put(o.key, fieldValue(o, form[o.key]), `${p.name}: ${o.label}`);
  }
  if (opts.general) for (const g of GENERAL) if (g.key in form) put(g.key, fieldValue(g, form[g.key]), g.label);
  return { config: next, bad };
}
