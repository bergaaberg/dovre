/**
 * Running a program without stalling the server. On this machine starting claude.exe blocks the
 * starting thread for about a second (it's ~300 MB and scanned on every start), and Node starts
 * programs on its main thread, so every `claude agents --json` and every summary froze every page
 * and event stream for that long. Here they start on a worker thread instead; the server only
 * waits for the answer, like any other I/O.
 */
import { Worker } from "node:worker_threads";
import type { Done, Job, Kill } from "./spawn-worker.ts";

export type Ran = { code: number | null; stdout: string; stderr: string };

let worker: Worker | undefined;
let next = 1;
const waiting = new Map<number, { resolve: (r: Ran) => void; reject: (e: Error) => void }>();

function start(): Worker {
  // Bundled (dist/bridge, `pnpm build:bridge`), the worker is the bundle's spawn-worker.mjs.
  const w = new Worker(new URL(import.meta.url.endsWith(".mjs") ? "./spawn-worker.mjs" : "./spawn-worker.ts", import.meta.url));
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
 * `signal`: aborting it kills the program and fails the call with "stopped".
 */
export function runOff(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; maxBuffer?: number; env?: Record<string, string | null>; signal?: AbortSignal } = {}): Promise<Ran> {
  const { signal, ...rest } = opts;
  if (signal?.aborted) return Promise.reject(new Error("stopped"));
  worker ??= start();
  const w = worker;
  const id = next++;
  const job: Job = { id, bin, args, ...rest };
  return new Promise((resolve, reject) => {
    const stop = () => {
      if (!waiting.delete(id)) return;
      w.postMessage({ kill: id } satisfies Kill);
      if (!waiting.size) w.unref();
      reject(new Error("stopped"));
    };
    signal?.addEventListener("abort", stop, { once: true });
    const off = () => signal?.removeEventListener("abort", stop);
    waiting.set(id, { resolve: (r) => (off(), resolve(r)), reject: (e) => (off(), reject(e)) });
    // Held open while something runs; idle, it doesn't keep a finished script alive.
    worker!.ref();
    worker!.postMessage(job);
  });
}
