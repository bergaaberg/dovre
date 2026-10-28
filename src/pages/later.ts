/**
 * The slow part of a page. A page answers within its budget either way: a load that isn't
 * back by then keeps running and is kept here, and the page shows `Reading` (data-pending).
 * The client fetches a pending page again until it isn't (src/ui/app.js.ts); `landed` can tell
 * the hub at once. A failure is kept a little while too, so the page shows it instead of
 * reading forever, and the next look after that tries again.
 *
 *   const stories = later({ landed: (key) => hub.publish([key]) });
 *   const got = await stories(`stories:${repo}#${n}`, () => findStories(ghe, repo, n));
 *   // undefined: still reading; { ok: false, error }: failed; { ok: true, value }: here.
 */
import { html } from "hono/html";
import type { Html } from "../ui/kit.ts";
import { type Res, settle } from "./work.ts";

export { type Res, settle };

/** How long a page waits for a slow part before it shows `Reading` (ms). */
export const BUDGET_MS = 1500;

/** `p`, if it's back within `ms`; else undefined (and `p` carries on). */
export function within<T>(p: Promise<T>, ms = BUDGET_MS): Promise<T | undefined> {
  if (!Number.isFinite(ms)) return p;
  let timer: unknown;
  const wait = new Promise<undefined>((res) => (timer = setTimeout(() => res(undefined), ms)));
  return Promise.race([p, wait]).finally(() => clearTimeout(timer as Parameters<typeof clearTimeout>[0]));
}

type Entry = { at: number; p: Promise<Res<unknown>>; done?: Res<unknown> };

/**
 * Loads by key, each answered within a budget. A value is reused for `ttlMs` (default a minute),
 * a failure for `failMs` (default 15 s). At most `max` keys are kept (default 100), oldest out first.
 */
export function later(opts: { budgetMs?: number; ttlMs?: number; failMs?: number; max?: number; now?: () => number; landed?: (key: string) => void } = {}) {
  const now = opts.now ?? Date.now;
  const kept = new Map<string, Entry>();
  const expired = (e: Entry) => !!e.done && now() - e.at > (e.done.ok ? (opts.ttlMs ?? 60e3) : (opts.failMs ?? 15e3));
  /** `fresh`: load again now. `budgetMs: Infinity`: wait for the whole load (before a write). */
  return function get<T>(key: string, load: () => Promise<T>, o: { fresh?: boolean; budgetMs?: number } = {}): Promise<Res<T> | undefined> {
    let e = kept.get(key);
    if (!e || o.fresh || expired(e)) {
      const p: Promise<Res<unknown>> = Promise.resolve()
        .then(load)
        .then(
          (value) => ({ ok: true as const, value }),
          (err) => ({ ok: false as const, error: String((err as Error)?.message ?? err) }),
        );
      const entry: Entry = { at: now(), p };
      e = entry;
      kept.delete(key);
      kept.set(key, entry);
      while (kept.size > (opts.max ?? 100)) kept.delete(kept.keys().next().value as string);
      void p.then((r) => {
        entry.done = r;
        entry.at = now();
        if (kept.get(key) === entry) opts.landed?.(key);
      });
    }
    if (e.done) return Promise.resolve(e.done as Res<T>);
    return within(e.p as Promise<Res<T>>, o.budgetMs ?? opts.budgetMs ?? BUDGET_MS);
  };
}

/** What a page shows while its slow part loads: the client fetches it again until it's gone. */
export function Reading(o: { title?: string; text: string }): Html {
  return html`<section class="pending" data-pending aria-busy="true"><span class="spinner" aria-hidden="true"></span>${o.title ? html`<h1>${o.title}</h1>` : ""}<p class="t2">${o.text}</p></section>`;
}
