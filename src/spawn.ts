/**
 * Running a program without stalling the server. On this machine starting claude.exe blocks the
 * starting thread for about a second (it's ~300 MB and scanned on every start), and Node starts
 * programs on its main thread, so every `claude agents --json` and every summary froze every page
 * and event stream for that long. Here they start on a worker thread instead; the server only
 * waits for the answer, like any other I/O.
 */
import { Worker } from "node:worker_threads";
import type { Done, Job } from "./spawn-worker.ts";

export type Ran = { code: number | null; stdout: string; stderr: string };

let worker: Worker | undefined;
let next = 1;
const waiting = new Map<number, { resolve: (r: Ran) => void; reject: (e: Error) => void }>();

function start(): Worker {
  const w = new Worker(new URL("./spawn-worker.ts", import.meta.url));
  w.on("message", (d: Done) => {
    const p = waiting.get(d.id);
    if (!p) return;
    waiting.delete(d.id);
    if (!waiting.size) w.unref();
    if (d.error) p.reject(new Error(d.error));
    else p.resolve({ code: d.code, stdout: d.stdout, stderr: d.stderr });
  });
  // A worker that dies fails what it was running; the next call starts a new one.
  const fail = (e: Error) => {
    if (worker === w) worker = undefined;
    for (const [, p] of waiting) p.reject(e);
    waiting.clear();
  };
  w.on("error", fail);
  w.on("exit", (code) => fail(new Error(`spawn worker exited (${code})`)));
  return w;
}

/**
 * Runs `bin args` to the end on the worker thread. A non-zero exit is a result, not an error; failing to start, or a timeout, is.
 * `env`: changes to this process's environment for the program (null removes a variable).
 */
export function runOff(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; maxBuffer?: number; env?: Record<string, string | null> } = {}): Promise<Ran> {
  worker ??= start();
  const id = next++;
  const job: Job = { id, bin, args, ...opts };
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    // Held open while something runs; idle, it doesn't keep a finished script alive.
    worker!.ref();
    worker!.postMessage(job);
  });
}
