/**
 * The review panel (#555 step 4): which reviewers a diff calls for. Code quality always reviews;
 * security, UX and design, and performance only when the changed paths or the added lines call
 * for them, each saying why it was called. A wrong call costs one model call, a missed one a
 * review nobody did, so the tests lean towards calling. Pure.
 */
import type { PrFile } from "../sources/prview.ts";
import type { FindingTag } from "./finding.ts";

export const SPECIALITIES = ["quality", "security", "ux", "performance"] as const;
export type Speciality = (typeof SPECIALITIES)[number];
export type Specialist = Exclude<Speciality, "quality">;

export const REVIEWER: Record<Speciality, string> = { quality: "Code quality", security: "Security", ux: "UX and design", performance: "Performance" };

/** What a specialist reviews, as a sentence names it: "security wasn't reviewed". */
export const TOPIC: Record<Specialist, string> = { security: "security", ux: "UX and design", performance: "performance" };

/** The tag every finding of a specialist carries, so it says whose it is. */
export const SPECIALIST_TAG: Record<Specialist, FindingTag> = { security: "security", ux: "ux", performance: "performance" };

/** A reviewer on the panel, and why the diff called for it (empty for code quality, which always reviews). */
export type Seat = { who: Speciality; why: string };

/** Tests, fixtures, docs and lock files: what they say doesn't call a specialist. */
const QUIET_PATH = /(?:^|\/)(?:tests?|__tests__|specs?|fixtures?|testdata|docs?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rb)$|\.(?:md|mdx|txt|lock|snap)$|(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|go\.sum)$/i;

type Probe = { path?: RegExp; added?: [RegExp, string][] };

const SQL = /\b(?:SELECT\s[^;]{0,200}\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/;

const PROBES: Record<Specialist, Probe> = {
  security: {
    path: /(?:^|[/._-])(?:auth\w*|log(?:in|out)|sign(?:in|up)|sessions?|tokens?|secrets?|passw(?:or)?ds?|passkeys?|credentials?|crypto\w*|oauth\w*|jwt|cookies?|cors|csrf|saniti[sz]\w*|escap\w*|permissions?|acl|access|security|sandbox\w*|egress|proxy|webhooks?|uploads?|strict|guard)(?:[/._-]|$)|(?:^|\/)\.github\/workflows\/|(?:^|\/)(?:Dockerfile|Containerfile)|\.Containerfile$|(?:^|\/)\.env(?:\.|$)/i,
    added: [
      // Not a method named exec or system: a RegExp's `.exec(` is everywhere.
      [/\b(?:eval|execSync|execFile|execFileSync|spawn|spawnSync|popen)\s*\(|(?<![.\w])(?:exec|system)\s*\(|\bnew Function\s*\(|\bchild_process\b|\bsubprocess\b|\bos\.system\b/, "runs a command or evaluates code"],
      [/\b(?:innerHTML|outerHTML|dangerouslySetInnerHTML|insertAdjacentHTML)\b|\bdocument\.write\b|\bv-html\b|\braw\s*\(/, "writes HTML without escaping"],
      [SQL, "builds a database query"],
      [/\b(?:authorization|set-cookie|api[_-]?key|private[_-]?key|passw(?:or)?d|credentials?|secret\w*|jwt|csrf|hmac)\b|\bbearer /i, "handles a secret or a credential"],
      [/\bcrypto\.|\bcreate(?:Hash|Hmac|Cipheriv|Decipheriv)\s*\(|\bsubtle\.\w+\s*\(/, "does its own cryptography"],
      [/\b(?:readFile|writeFile|appendFile|createReadStream|createWriteStream|unlink|rmdir|rm|mkdir|rename|copyFile)(?:Sync)?\s*\(/, "reads or writes files by path"],
      [/\bredirect\s*\(|\blocation\.(?:href|assign|replace)\b/, "redirects to an address"],
      [/\b(?:pickle\.loads?|yaml\.load|unserialize|Marshal\.load|ObjectInputStream)\b/, "reads serialised data back into objects"],
      [/\b(?:chmod|chown|sudo)\b|--privileged\b|\bpermissionMode\b|\ballowedTools\b|dangerously/i, "changes what something is allowed to do"],
    ],
  },
  ux: {
    path: /\.(?:css|scss|sass|less|html?|vue|svelte|[jt]sx|astro|hbs|ejs)$|(?:^|\/)(?:ui|views?|pages?|components?|styles?|layouts?|screens?)\/|(?:^|\/)(?:view|style|theme)s?\.[cm]?[jt]s$/i,
    added: [
      [/\bhtml`|<(?:button|form|input|select|textarea|dialog|label|nav|table|h[1-6]|a)\b/, "adds markup people see"],
      [/\bclassName=|\bclass="|\baria-\w+=|\brole="/, "adds markup people see"],
    ],
  },
  performance: {
    path: /\.sql$|(?:^|[/._-])(?:db|database|migrations?|stores?|cache\w*|queues?|cron|jobs?|index(?:er|ing)|search|stream\w*|batch\w*|gather\w*|poll\w*)(?:[/._-]|$)/i,
    added: [
      [SQL, "adds a database query"],
      [/\.(?:prepare|query|execute|findMany|aggregate)\s*\(/, "adds a database query"],
      [/\b(?:setInterval|requestAnimationFrame)\s*\(|\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/, "adds work that repeats"],
      [/\b(?:readFileSync|execSync|spawnSync)\s*\(/, "adds a call that blocks"],
    ],
  },
};

const LOOP = /\b(?:for|while)\s*(?:await\s*)?\(|\.(?:map|forEach|flatMap|reduce)\s*\(/;
const WAITS = /\bawait\b|\bfetch\s*\(|\.then\s*\(/;
/** Added lines after a loop's first in which a call that waits counts as inside it. */
const LOOP_BODY = 6;
/** A call that waits, in a loop: one request or query for each item. */
const waitsInLoop = (added: string[]) => added.some((l, i) => LOOP.test(l) && added.slice(i, i + LOOP_BODY + 1).some((x) => WAITS.test(x)));

/** The lines a patch adds, without their "+". */
export const addedLines = (patch: string | undefined): string[] =>
  (patch ?? "")
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));

function called(who: Specialist, files: { path: string; added: string[] }[]): string {
  const p = PROBES[who];
  const at = p.path ? files.find((f) => p.path!.test(f.path)) : undefined;
  if (at) return `it changes ${at.path}`;
  for (const f of files) {
    for (const [re, what] of p.added ?? []) if (f.added.some((l) => re.test(l))) return `${f.path} ${what}`;
    if (who === "performance" && waitsInLoop(f.added)) return `${f.path} adds a call that waits inside a loop`;
  }
  return "";
}

/**
 * Who reviews this diff: code quality first, then each specialist the changed paths or added
 * lines call for, with why. Tests, docs and lock files call nobody.
 */
export function panelFor(files: PrFile[]): Seat[] {
  const loud = files.filter((f) => f.status !== "removed" && !QUIET_PATH.test(f.path)).map((f) => ({ path: f.path, added: addedLines(f.patch) }));
  const seats: Seat[] = [{ who: "quality", why: "" }];
  for (const who of ["security", "ux", "performance"] as const) {
    const why = called(who, loud);
    if (why) seats.push({ who, why });
  }
  return seats;
}
