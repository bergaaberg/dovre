/**
 * What a pack's agent turns run on (#467), locally: the runner, a checkout found by its origin,
 * and a sandbox run's commits as a draft PR (src/actions/sandbox.ts). The gate in front of it is
 * src/packs/ai.ts; nothing here decides what a pack may do.
 *
 * A `read` turn is plan mode in the checkout, and allows the dovre MCP server's tools (`mcp__dovre`)
 * without asking: /mcp lists and answers only those in its scope, so that's exactly its grant. Any
 * other ask is refused, as in every headless turn. A `sandbox` turn is the runner's own yolo in a box.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { D1 } from "../db.ts";
import type { Runner } from "../agents/runner.ts";
import { originRepo } from "../agents/sandbox.ts";
import { openSandboxPr } from "../actions/sandbox.ts";
import type { Ghe } from "../sources/ghe.ts";
import { listRepos } from "../sources/claude.ts";
import type { AgentHost } from "./ai.ts";
import { join } from "node:path";

const run = promisify(execFile);

/** `owner/name` of a checkout's origin, or undefined. */
async function originOf(dir: string): Promise<string | undefined> {
  const r = await run("git", ["remote", "get-url", "origin"], { cwd: dir, timeout: 5000 }).catch(() => undefined);
  return r ? originRepo(String(r.stdout)) : undefined;
}

export function agentHostOf(o: { runner: Runner; codeDir: string; owners: () => string; db: D1; ghe: Pick<Ghe, "rest">; origin?: (dir: string) => Promise<string | undefined> }): AgentHost {
  const origin = o.origin ?? originOf;
  return {
    start: (s) =>
      o.runner.start({
        harness: "claude",
        cwd: s.cwd,
        prompt: s.prompt,
        mode: s.sandbox ? "default" : "plan",
        model: s.model,
        sandbox: s.sandbox,
        budget: s.budget,
        turns: s.turns,
        maxMs: s.maxMs,
        scope: s.scope,
        ...(s.sandbox ? {} : { allowed: ["mcp__dovre"] }),
      }),
    get: (id) => o.runner.get(id),
    sandbox: () => o.runner.sandbox(),
    owners: o.owners,
    async checkout(repo) {
      const name = repo.split("/")[1]?.toLowerCase();
      for (const dir of listRepos(o.codeDir).filter((d) => d.toLowerCase() === name)) {
        const path = join(o.codeDir, dir);
        if ((await origin(path))?.toLowerCase() === repo.toLowerCase()) return path;
      }
      return undefined;
    },
    async land(r, kind) {
      const pr = await openSandboxPr({
        db: o.db,
        ghe: o.ghe,
        owners: o.owners(),
        run: r,
        kind,
        push: () => o.runner.pushSandbox(r.id).catch((e) => ({ error: String((e as Error)?.message ?? e) })),
      });
      if (!pr.ok) return { error: pr.error };
      o.runner.landed(r.id, { number: pr.number, url: pr.url });
      return { number: pr.number, url: pr.url };
    },
  };
}
