/**
 * What I may do to an issue from /tracker (#40), and the checks before it: the repo is the owners'
 * (refused before any URL), the form is well formed, and the issue as it is now still allows it.
 * Pure; the routes (index.ts) read the issue, write, log and redirect.
 */
import { repoIn } from "../../../actions/deploys.ts";
import type { Issue, IssueAct } from "../../../forge/types.ts";
import { keyOf } from "./model.ts";

export const ACT_KINDS = ["assign", "close", "reopen", "comment"] as const;
export type ActKindId = (typeof ACT_KINDS)[number];
export const MAX_COMMENT = 4000;

/** The act a form asks for, or why it can't be one. `login`: who "me" is, for assign. */
export function actOf(form: Record<string, unknown>, owners: string, login: string): { ok: true; act: IssueAct } | { ok: false; error: string } {
  const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  const repo = repoIn(owners, str("repo"));
  if (!repo) return { ok: false, error: "That isn't one of your repos." };
  const n = /^\d{1,9}$/.test(str("number")) ? Number(str("number")) : 0;
  if (n < 1) return { ok: false, error: "That isn't an issue number." };
  const kind = str("kind");
  if (kind === "assign") return login ? { ok: true, act: { kind, repo, number: n, login } } : { ok: false, error: "Who you are isn't known yet." };
  if (kind === "close") {
    const reason = str("reason") === "not_planned" ? "not_planned" : str("reason") === "completed" ? "completed" : null;
    return reason ? { ok: true, act: { kind, repo, number: n, reason } } : { ok: false, error: "Close as done or as not planned?" };
  }
  if (kind === "reopen") return { ok: true, act: { kind, repo, number: n } };
  if (kind === "comment") {
    const body = str("body").trim();
    if (!body) return { ok: false, error: "The comment is empty." };
    if (body.length > MAX_COMMENT) return { ok: false, error: `The comment is longer than ${MAX_COMMENT} characters.` };
    return { ok: true, act: { kind, repo, number: n, body } };
  }
  return { ok: false, error: "Not something this page does." };
}

/** Why the issue as it is now doesn't allow the act; undefined when it does. */
export function refusal(now: Issue | undefined, a: IssueAct): string | undefined {
  if (!now) return "There's no such issue (or it's a pull request).";
  if (a.kind === "assign") {
    if (now.state === "CLOSED") return "It's closed.";
    if (now.assignees.some((x) => x.toLowerCase() === a.login.toLowerCase())) return "It's already assigned to you.";
  }
  if (a.kind === "close" && now.state === "CLOSED") return "It's already closed.";
  if (a.kind === "reopen" && now.state === "OPEN") return "It's already open.";
  return undefined;
}

/** What the log and the page say it did: "Closed bergaaberg/dovre#33 (not planned)". */
export function doneText(a: Pick<IssueAct, "kind" | "repo" | "number"> & { reason?: string }): string {
  const k = keyOf(a);
  if (a.kind === "assign") return `Assigned ${k} to you`;
  if (a.kind === "close") return `Closed ${k}${a.reason === "not_planned" ? " (not planned)" : ""}`;
  if (a.kind === "reopen") return `Reopened ${k}`;
  return `Commented on ${k}`;
}
