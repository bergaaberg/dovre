/**
 * First run's suggestions (#415, epic #386): a short interview by role, and a scan of the checkouts
 * for marker files, pick which packs to switch on. Core owns the questions and never names a pack:
 * each pack says in its manifest which roles, answers and markers suit it.
 */
import type { OnboardStep, PackManifest, Role } from "./types.ts";

export const ROLES: Record<Role, string> = { dev: "Developer", lead: "Team lead", po: "Product owner", op: "Operator", an: "Analyst" };

export type Question = { id: string; q: string; multi: boolean; opts: { v: string; l: string }[] };

const q = (id: string, text: string, multi: boolean, opts: [string, string][]): Question => ({ id, q: text, multi, opts: opts.map(([v, l]) => ({ v, l })) });

/** Every question, by id. A pack's `answers` name an option as `<question>:<option>`. */
export const QUESTIONS: Record<string, Question> = Object.fromEntries(
  [
    q("agents", "Coding agents?", false, [["many", "All day"], ["some", "Sometimes"], ["no", "Not yet"]]),
    q("tasks", "Where do tasks live?", true, [["github", "GitHub Issues"], ["linear", "Linear"], ["jira", "Jira"], ["head", "In my head"]]),
    q("catch", "Tell me early about…", true, [["red", "Red main, stuck PRs"], ["deploys", "Deploys waiting"], ["bumps", "Bumps piling up"], ["agents", "Agent PRs"]]),
    q("hear", "Where do people reach you?", true, [["slack", "Slack"], ["support", "Intercom or Zendesk"], ["docs", "Docs"], ["meetings", "Planning meetings"]]),
    q("run", "What do you run?", true, [["workers", "Cloudflare Workers"], ["prometheus", "Prometheus or Grafana"], ["kafka", "Kafka"], ["servicebus", "Service Bus"], ["pubsub", "Pub/Sub"], ["containers", "Containers"]]),
    q("alert", "Alerts go to…", true, [["pager", "PagerDuty or Opsgenie"], ["slack", "Slack"], ["none", "Nowhere yet"], ["finance", "The finance team"]]),
    q("data", "Your data lives in…", true, [["files", "Files: Parquet, CSV"], ["warehouse", "BigQuery or Snowflake"], ["prometheus", "Prometheus"]]),
    q("share", "You share results as…", true, [["docs", "Docs"], ["boards", "Boards"], ["slack", "Slack posts"]]),
  ].map((x) => [x.id, x]),
);

/** The interview: two questions a role, asked in this order. */
export const INTERVIEW: Record<Role, string[]> = { dev: ["agents", "tasks"], lead: ["tasks", "catch"], po: ["tasks", "hear"], op: ["run", "alert"], an: ["data", "share"] };

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const isRole = (r: unknown): r is Role => typeof r === "string" && Object.hasOwn(ROLES, r);
const optionOf = (key: string) => {
  const [qid, v] = key.split(":");
  return Object.hasOwn(QUESTIONS, qid!) ? QUESTIONS[qid!]!.opts.find((o) => o.v === v) : undefined;
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : []);

/** The roles a manifest suits: known ones, each once. */
export const rolesOf = (m: PackManifest | undefined): Role[] => strings(m?.roles).filter(isRole);
/** The answers a manifest suits: `<question>:<option>` that the interview has, each once. */
export const answersOf = (m: PackManifest | undefined): string[] => strings(m?.answers).filter((a) => /^[a-z]+:[a-z]+$/.test(a) && !!optionOf(a));

const PART = /^[A-Za-z0-9._-]+$/;
const LAST = /^[A-Za-z0-9._*-]+$/;
/**
 * Its markers after the checks: relative paths of at most 3 parts and 80 characters, a `*` only in
 * the last part and never all of it, no `.` or `..` parts, at most 8.
 */
export const markersOf = (m: PackManifest | undefined): string[] =>
  strings(m?.markers)
    .filter((k) => {
      if (k.length > 80) return false;
      const parts = k.replace(/\/$/, "").split("/");
      if (parts.length > 3 || parts.some((p) => p === "." || p === "..")) return false;
      const last = parts.pop()!;
      return parts.every((p) => PART.test(p)) && LAST.test(last) && /[^*.]/.test(last);
    })
    .slice(0, 8);

/** Does a path in a checkout match a marker? `path` is relative, a folder's ends in "/". */
export function markerMatches(marker: string, path: string): boolean {
  if (marker.endsWith("/") !== path.endsWith("/")) return false;
  const a = marker.replace(/\/$/, "").split("/");
  const b = path.replace(/\/$/, "").split("/");
  if (a.length !== b.length) return false;
  const last = new RegExp(`^${a.pop()!.replace(/[.+?^${}()|[\]\\-]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return a.every((p, i) => p === b[i]) && last.test(b.pop()!);
}

/** Its setup after the checks: up to 3 steps, ids lowercase and unique, titles one line of 60. Undefined without a step. */
export function onboardOf(m: PackManifest | undefined): { steps: OnboardStep[]; required: boolean } | undefined {
  const raw = m?.onboard;
  if (!raw || !Array.isArray(raw.steps)) return undefined;
  const seen = new Set<string>();
  const steps: OnboardStep[] = [];
  for (const s of raw.steps) {
    const title = typeof s?.title === "string" ? s.title.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 60) : "";
    if (typeof s?.id !== "string" || !ID.test(s.id) || seen.has(s.id) || !title) continue;
    seen.add(s.id);
    steps.push({ id: s.id, title });
  }
  return steps.length ? { steps: steps.slice(0, 3), required: raw.required === true } : undefined;
}

/** What I answered: an option, or several for a multi question, by question id. */
export type Answers = Record<string, string | string[] | undefined>;

/**
 * Which packs to suggest, each with why: the role's name, an answer's words, or "found <marker>".
 * Only the role's own questions count. In the manifests' order; a pack with no reason is left out.
 */
export function suggest(manifests: PackManifest[], role: Role | undefined, answers: Answers, found: Iterable<string>): Map<string, string[]> {
  const asked = role && isRole(role) ? INTERVIEW[role] : [];
  const given = asked.flatMap((qid) => {
    const a = answers[qid];
    const vs = Array.isArray(a) ? (QUESTIONS[qid]!.multi ? a : a.slice(0, 1)) : a ? [a] : [];
    return vs.map((v) => `${qid}:${v}`).filter((k) => !!optionOf(k));
  });
  const hit = new Set(found);
  const out = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const m of manifests) {
    if (!m || !ID.test(m.id) || seen.has(m.id)) continue;
    seen.add(m.id);
    const why: string[] = [];
    const add = (w: string) => !why.includes(w) && why.push(w);
    if (role && rolesOf(m).includes(role)) add(ROLES[role]);
    const suits = answersOf(m);
    for (const k of given) if (suits.includes(k)) add(optionOf(k)!.l);
    for (const k of markersOf(m)) if (hit.has(k)) add(`found ${k}`);
    if (why.length) out.set(m.id, why);
  }
  return out;
}
