/**
 * Desktop notifications: only for things I'd want to drop what I'm doing for, and not too many.
 *
 * - What rings is a policy (kept in settings, set on /settings): per kind on or off. Agents ring
 *   when they need me (a permission ask, a denied tool) or when a long turn ends, never for an
 *   ordinary reply. A deploy rings when a repo starts waiting, not for each newer run.
 * - Each need has a key that stays the same while it's in the same state; a key not seen before
 *   is news. The first look after starting only learns what's there.
 * - Bundling: the first note shows at once; what follows within the window comes as one summary.
 * - Quiet hours (optional): outside Mon–Fri 08–17 nothing rings; the pages still show it.
 * - Delivery: open pages show notes (the Edge app window turns them into Windows notifications)
 *   when I'm not looking at Dovre; with no page open, a Windows toast from here.
 */
import { spawn } from "node:child_process";
import type { D1 } from "./db.ts";
import type { Need, RingKind } from "./home/needs.ts";
import { currentTz, dtf } from "./when.ts";

/** `kind`: a RingKind, a pack's ring kind, or "bundle" / "test". */
export type Note = { title: string; body?: string; url?: string; tag: string; kind?: string };

/** The core's kinds; packs add theirs (manifest rings, src/packs/registry.ts ringsOf). */
export const RING_KINDS: { kind: RingKind; label: string; hint: string }[] = [
  { kind: "deploy", label: "A deploy starts waiting for me", hint: "Once per repo, not for every newer run behind it" },
  { kind: "ci", label: "A main branch goes red", hint: "Checked against the newest run" },
  { kind: "ask", label: "A tool asks for my OK", hint: "An MCP server's question, through the relay" },
  { kind: "review", label: "Someone asks for my review", hint: "" },
  { kind: "pr-red", label: "My PR's checks fail or changes are asked", hint: "" },
  { kind: "pr-ready", label: "My PR is approved and green", hint: "" },
  { kind: "mention", label: "I'm mentioned", hint: "" },
];

export type Policy = {
  /** On or off per kind, the core's and the packs'; a kind not here rings (it's new, or its pack was off when I saved). */
  kinds: Record<string, boolean>;
  /** Minutes an agent turn must run before its end rings. */
  longTurnMin: number;
  /** Seconds after a note during which more are gathered into one. */
  bundleSec: number;
  /** Ring only Mon–Fri 08:00–17:00 in Oslo. */
  workHoursOnly: boolean;
};

export const DEFAULT_POLICY: Policy = {
  kinds: { deploy: true, ci: true, ask: true, review: true, "pr-red": true, "pr-ready": true, mention: false },
  longTurnMin: 5,
  bundleSec: 45,
  workHoursOnly: false,
};

/** A stored policy, with anything missing or odd taken from the defaults. */
export function policyOf(raw: unknown): Policy {
  const p = (raw && typeof raw === "object" ? raw : {}) as Partial<Policy>;
  const kinds: Record<string, boolean> = { ...DEFAULT_POLICY.kinds };
  // Every kind kept, the packs' too (a pack switched off keeps my choice for when it's back).
  const given = p.kinds && typeof p.kinds === "object" ? Object.entries(p.kinds as Record<string, unknown>).slice(0, 200) : [];
  for (const [k, v] of given) if (/^[a-z][a-z0-9-]{0,31}$/.test(k) && typeof v === "boolean") kinds[k] = v;
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  return {
    kinds,
    longTurnMin: num(p.longTurnMin, DEFAULT_POLICY.longTurnMin, 0, 240),
    bundleSec: num(p.bundleSec, DEFAULT_POLICY.bundleSec, 0, 600),
    workHoursOnly: typeof p.workHoursOnly === "boolean" ? p.workHoursOnly : DEFAULT_POLICY.workHoursOnly,
  };
}

export async function loadPolicy(db: D1): Promise<Policy> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'notify'").first<{ value: string }>();
  try {
    return policyOf(row ? JSON.parse(row.value) : undefined);
  } catch {
    return DEFAULT_POLICY;
  }
}

export async function savePolicy(db: D1, p: Policy) {
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES ('notify', ?, ?)").bind(JSON.stringify(p), new Date().toISOString()).run();
}

const TITLE: Record<Exclude<Need["kind"], "pack">, string> = { deploy: "Deploy waiting", ci: "Build is red", review: "Review asked", "my-pr": "Your PR", mention: "Mentioned" };

/** Does this kind ring under the policy? A kind it doesn't name does, unless it starts off (a pack's ring declared `off`). */
export const rings = (p: Policy, kind: string | undefined, startsOff?: ReadonlySet<string>) => !!kind && (p.kinds[kind] ?? !startsOff?.has(kind));

export function noteOf(n: Need): Note {
  // A pack's need says itself whole.
  const title = n.kind === "pack" ? n.title : `${TITLE[n.kind]}: ${n.title}`;
  return { title: title.slice(0, 120), body: n.line?.slice(0, 140), url: n.href.startsWith("/") ? n.href : undefined, tag: n.key.split(":").slice(0, 2).join(":"), kind: n.ring };
}

export function createNotifier() {
  let seen: Set<string> | undefined;
  return {
    /** The needs that are new since last time and ring under the policy, as notes (none on the first look). */
    observe(needs: Need[], policy: Policy = DEFAULT_POLICY, startsOff?: ReadonlySet<string>): Note[] {
      const first = !seen;
      const fresh = first ? [] : needs.filter((n) => !seen!.has(n.key) && rings(policy, n.ring, startsOff));
      seen = new Set(needs.map((n) => n.key));
      return fresh.map(noteOf);
    },
  };
}

/** Mon–Fri 08:00–17:00 in the instance timezone. */
export function workHours(at: number, tz = currentTz()): boolean {
  const parts = dtf("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const day = parts.find((p) => p.type === "weekday")!.value;
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  return !["Sat", "Sun"].includes(day) && hour >= 8 && hour < 17;
}

/** Several notes as one. */
export function bundle(notes: Note[]): Note {
  if (notes.length === 1) return notes[0]!;
  return {
    title: `${notes.length} more things need you`,
    body: notes.map((n) => n.title).join(" · ").slice(0, 200),
    url: "/",
    tag: "bundle",
    kind: "bundle",
  };
}

export type Rung = Note & { at: number; held?: "quiet" };

/**
 * Rings notes under the policy: the first at once, the rest of a burst together when the window
 * closes. Keeps the last few it rang (or held back) for the settings page.
 */
export function createRinger(opts: { deliver: (notes: Note[]) => void; policy: () => Policy; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown }) {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let windowOpen = false;
  let queue: Note[] = [];
  const log: Rung[] = [];
  const remember = (n: Note, held?: "quiet") => {
    log.unshift({ ...n, at: now(), held });
    log.length = Math.min(log.length, 30);
  };
  const flush = () => {
    windowOpen = false;
    if (!queue.length) return;
    const b = bundle(queue);
    queue = [];
    remember(b);
    opts.deliver([b]);
  };
  return {
    ring(notes: Note[]) {
      const p = opts.policy();
      if (!notes.length) return;
      if (p.workHoursOnly && !workHours(now())) {
        for (const n of notes) remember(n, "quiet");
        return;
      }
      if (p.bundleSec === 0) {
        for (const n of notes) remember(n);
        opts.deliver(notes);
        return;
      }
      let rest = notes;
      if (!windowOpen) {
        // The first goes now; the window then gathers what follows.
        const [first, ...more] = notes;
        remember(first!);
        opts.deliver([first!]);
        rest = more;
        windowOpen = true;
        setTimer(flush, p.bundleSec * 1000);
      }
      queue.push(...rest);
    },
    log: () => [...log],
  };
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/**
 * The toast XML: a click opens Dovre at the note's page, through the dovre:// link (the
 * launcher brings up the Dovre window, signed in). A plain http link opened the default
 * browser, which has no login cookie: "Not found". Only a plain page path goes in the link.
 */
export function toastXml(n: Note, _base?: string): string {
  const path = /^\/[A-Za-z0-9_\-\/]*$/.test(n.url ?? "") && !(n.url ?? "").includes("//") ? n.url! : "/";
  const launch = xml(`dovre://open${path}`);
  return `<toast activationType="protocol" launch="${launch}"><visual><binding template="ToastGeneric"><text>${xml(n.title)}</text>${n.body ? `<text>${xml(n.body)}</text>` : ""}<text placement="attribution">Dovre</text></binding></visual></toast>`;
}

/**
 * A Windows toast through Windows PowerShell's WinRT bridge, under PowerShell's app id (the one
 * id every machine has without registering our own). The XML goes in base64 of its UTF-8, since
 * PowerShell reads stdin and arguments in the console's code page and mangles æøå and emoji.
 */
export function windowsToast(notes: Note[], base: string) {
  if (process.platform !== "win32" || !notes.length) return;
  const payload = Buffer.from(JSON.stringify(notes.map((n) => toastXml(n, base))), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app)",
    `$all = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    "foreach ($x in $all) { $doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml($x); $notifier.Show([Windows.UI.Notifications.ToastNotification]::new($doc)) }",
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  child.on("error", () => {});
  child.on("close", (code) => {
    if (code) console.error("toast failed:", err.slice(0, 300));
  });
}
