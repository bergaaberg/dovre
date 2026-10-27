/**
 * The worker side of src/spawn.ts: starts programs for the server, so the time Windows takes to
 * start one (claude.exe: ~1 s, scanned on every start) stalls this thread, not the server's.
 */
import { type ChildProcess, execFile } from "node:child_process";
import { parentPort } from "node:worker_threads";

export type Job = { id: number; bin: string; args: string[]; cwd?: string; timeoutMs?: number; input?: string; maxBuffer?: number; env?: Record<string, string | null> };

/** This process's environment with a job's changes (null removes a variable, whatever its case on Windows). */
export function envFor(changes: Record<string, string | null> | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
  if (!changes) return undefined;
  const out: NodeJS.ProcessEnv = {};
  const keys = Object.keys(changes).map((k) => k.toUpperCase());
  for (const [k, v] of Object.entries(base)) if (!keys.includes(k.toUpperCase())) out[k] = v;
  for (const [k, v] of Object.entries(changes)) if (v !== null) out[k] = v;
  return out;
}
/** Kill the job with this id (its caller stopped waiting for it). */
export type Kill = { kill: number };
export type Done = { id: number; code: number | null; stdout: string; stderr: string; error?: string };

const running = new Map<number, ChildProcess>();

parentPort?.on("message", (msg: Job | Kill) => {
  if ("kill" in msg) {
    running.get(msg.kill)?.kill();
    return;
  }
  const job = msg;
  const child = execFile(job.bin, job.args, { cwd: job.cwd, env: envFor(job.env), timeout: job.timeoutMs, windowsHide: true, maxBuffer: job.maxBuffer ?? 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
    const done: Done = { id: job.id, code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error: err && code === null ? ((err as { killed?: boolean }).killed ? `${job.bin} timed out after ${job.timeoutMs} ms` : String(err.message ?? err)) : undefined };
    running.delete(job.id);
    parentPort!.postMessage(done);
  });
  running.set(job.id, child);
  if (job.input !== undefined) child.stdin?.end(job.input);
  else child.stdin?.end();
});
