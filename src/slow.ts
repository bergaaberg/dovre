/**
 * Requests the server took long to answer, for data/perf.log beside the pages' own timings
 * (src/ui/app.js.ts). Each says how much of that time the event loop was blocked: most of it
 * means the server was busy with something; little means the handler was waiting on something.
 * Method, path (never the query: it can hold search text), status and numbers only.
 */
import type { MiddlewareHandler } from "hono";

const TICK = 50;
let total = 0;
let last = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** Milliseconds the event loop has been blocked since the sampler started, the gap under way included. */
export function blockedMs(): number {
  if (!timer) {
    last = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      total += Math.max(0, now - last - TICK);
      last = now;
    }, TICK);
    timer.unref?.();
  }
  return total + Math.max(0, performance.now() - last - TICK);
}

/** Logs each request slower than `ms` (default 800) through `write`. Streams and long polls are long on purpose: left out. */
export function slowLog(write: (line: string) => void, o: { ms?: number; skip?: (path: string) => boolean } = {}): MiddlewareHandler {
  const ms = o.ms ?? 800;
  return async (c, next) => {
    const t0 = performance.now();
    const b0 = blockedMs();
    await next();
    const took = performance.now() - t0;
    if (took < ms || o.skip?.(c.req.path)) return;
    if (c.res.headers.get("content-type")?.startsWith("text/event-stream")) return;
    const blocked = Math.min(took, blockedMs() - b0);
    try {
      write(`${new Date().toISOString()} server ${c.req.method} ${c.req.path.replace(/[^\w\-\/.~%@:]/g, "_").slice(0, 200)} ${c.res.status} total=${Math.round(took)} blocked=${Math.round(blocked)}`);
    } catch {}
  };
}
