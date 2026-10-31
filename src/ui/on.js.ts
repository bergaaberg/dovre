/**
 * `dovreOn(topics, fn, { notes })`, for packs' scripts (Pack.script): how a script hears what the hub
 * said changed. Every open tab hears every change, so a script that asks the server on each one
 * multiplies its requests by the tabs open (hosted, that once came to ~800k a day). This hears only
 * the changes naming one of `topics` (one ending in ":" is a prefix, "run:" for every run) or, with
 * `notes: true`, carrying notes. Changes that come while `fn`'s last call is still out, or while the
 * tab is hidden, are merged (their topics and notes together) into one call after it, or once the tab
 * is shown. `fn` gets { topics, notes, ... }; it may return a promise. Core refuses a pack script that
 * listens to `dovre:change` itself (src/app.ts).
 */
export const ON_JS = String.raw`
window.dovreOn = (topics, fn, o = {}) => {
  let busy = false, held = null;
  const hits = (c) => (o.notes && (c.notes || []).length > 0) || (c.topics || []).some((t) => topics.some((w) => (w.endsWith(":") ? t.startsWith(w) : t === w)));
  const run = () => {
    if (busy || !held || document.hidden) return;
    const c = held;
    held = null;
    busy = true;
    Promise.resolve().then(() => fn(c)).catch(() => {}).finally(() => { busy = false; run(); });
  };
  document.addEventListener("dovre:change", (e) => {
    const c = e.detail || {};
    if (!hits(c)) return;
    held = held ? { ...held, ...c, topics: [...new Set([...held.topics, ...(c.topics || [])])], notes: [...held.notes, ...(c.notes || [])] } : { ...c, topics: [...(c.topics || [])], notes: [...(c.notes || [])] };
    run();
  });
  document.addEventListener("visibilitychange", run);
};
`;

/** A pack script that listens to the core's changes itself rather than through `dovreOn`. */
export const RAW_CHANGE = /addEventListener\(\s*["'`]dovre:change["'`]/;
