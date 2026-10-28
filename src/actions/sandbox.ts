/**
 * A sandbox run's work as a draft PR (#206). Its commits came home as branch `sandbox/<id>` of the
 * checkout it was cloned from (src/agents/sandbox.ts); here they go to the forge:
 *
 * 1. The repo is origin's, and must be the owners' (REPO_OWNERS): refused before anything is sent.
 * 2. The machine the run was on pushes the branch with the user's own git credentials (`push`,
 *    which checks the branch is still at the run's head and origin still the repo).
 * 3. The forge's branch is checked to be at that head, and that no PR is open from it yet.
 * 4. A draft PR into the default branch. If that fails, the pushed branch is deleted again.
 *
 * Logged under `sandbox.pr`, or `sandbox.pr-ci` when the diff touches CI config: that kind always
 * asks twice (src/writes.ts), since a push runs the repo's workflows with its secrets.
 */
import type { D1 } from "../db.ts";
import type { Run } from "../agents/runner.ts";
import type { SandboxReady } from "../agents/sandbox.ts";
import type { Ghe } from "../sources/ghe.ts";
import { ownedRepo } from "../sources/files.ts";
import { logAction } from "./deploys.ts";
import type { Proposed } from "./propose.ts";

/** The write kind a run's PR goes under: the CI one has a twice floor. */
export const sandboxKind = (out: Pick<SandboxReady, "ci">) => (out.ci ? "sandbox.pr-ci" : "sandbox.pr");

const line = (s: unknown, max: number) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
/** The agent wrote this: no @mentions reach anyone, and it's bounded. */
const quiet = (s: string, max: number) => s.replace(/@(?=[\w-])/g, "@​").slice(0, max);

/** The PR's title and body, from the run's prompt, the agent's last word and what it made. */
export function sandboxPrText(run: Pick<Run, "prompt" | "events" | "cost">, out: SandboxReady): { title: string; body: string } {
  const title = line(quiet(run.prompt.split("\n").find((l) => l.trim()) ?? "", 200), 100) || "Work from a sandbox run";
  const result = [...run.events].reverse().find((e) => e.t === "result");
  const said = result?.t === "result" && result.text.trim() ? quiet(result.text.trim(), 4000) : "";
  const n = out.commits.length;
  const foot = `Opened by Dovre from a sandbox run: Claude Code worked unattended in a fresh clone inside a container. ${n} commit${n === 1 ? "" : "s"}${run.cost ? `, $${run.cost.toFixed(2)}` : ""}.`;
  return { title, body: `${said ? `${said}\n\n---\n\n` : ""}**Prompt**\n\n${quiet(run.prompt, 2000).replace(/^/gm, "> ")}\n\n${foot}` };
}

export async function openSandboxPr(o: {
  db: D1;
  ghe: Pick<Ghe, "rest">;
  owners: string;
  run: Run;
  /** The machine pushes the branch (src/agents/desk.ts `pushSandbox`). */
  push: () => Promise<{ repo: string; branch: string; head: string } | { error: string }>;
}): Promise<Proposed> {
  const out = o.run.out?.state === "ready" ? o.run.out : undefined;
  const kind = out ? sandboxKind(out) : "sandbox.pr";
  const target = `${line(out?.repo, 100) || line(o.run.repo, 100)}:${line(out?.branch, 80)}`;
  const refuse = async (error: string): Promise<Proposed> => {
    await logAction(o.db, { kind, target, ok: false, error }).catch(() => {});
    return { ok: false, error };
  };
  if (!out) return refuse("There's nothing from that run to open a PR with.");
  if (out.pr) return { ok: false, error: `Its draft PR is open already: #${out.pr.number}.` };
  const repo = ownedRepo(o.owners, out.repo);
  if (!repo) return refuse(out.repo ? `${line(out.repo, 100)} isn't in your repos.` : "The checkout's origin isn't a repo on the forge.");
  const pushed = await o.push();
  if ("error" in pushed) return refuse(`Couldn't push: ${line(pushed.error, 300)}`);
  if (pushed.repo !== repo || pushed.branch !== out.branch || pushed.head !== out.head) return refuse("The machine pushed something other than what the run made.");
  const ref = `/repos/${repo}/git/refs/heads/${out.branch.split("/").map(encodeURIComponent).join("/")}`;
  try {
    const at = await o.ghe.rest<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${out.branch.split("/").map(encodeURIComponent).join("/")}`);
    if (at.object.sha !== out.head) return refuse(`${out.branch} on the forge isn't at the run's last commit.`);
    const owner = repo.split("/")[0]!;
    const open = await o.ghe.rest<unknown[]>(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${out.branch}`)}`);
    if (Array.isArray(open) && open.length) return refuse(`A PR from ${out.branch} is open already.`);
    const info = await o.ghe.rest<{ default_branch: string }>(`/repos/${repo}`);
    const text = sandboxPrText(o.run, out);
    let pr: { number: number; html_url: string };
    try {
      pr = await o.ghe.rest<{ number: number; html_url: string }>(`/repos/${repo}/pulls`, { method: "POST", body: { title: text.title, head: out.branch, base: info.default_branch, body: text.body, draft: true } });
    } catch (e) {
      await o.ghe.rest(ref, { method: "DELETE" }).catch(() => {});
      throw e;
    }
    await logAction(o.db, { kind, target: `${repo}:${out.branch}`, detail: `#${pr.number}`, ok: true }).catch(() => {});
    return { ok: true, number: pr.number, url: pr.html_url };
  } catch (e) {
    return refuse(line((e as Error)?.message ?? e, 300));
  }
}
