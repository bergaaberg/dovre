/**
 * Settings → GitHub calls (#253): how much of each quota bucket is left, as GitHub last said, and
 * which call sites used it, in the last hour and the last day. Sites are path templates, never URLs.
 */
import { html } from "hono/html";
import { type CallCount, type CallsView, isLow } from "../forge/calls.ts";
import { count, hourOf } from "../format.ts";
import { Empty, Gauge, type Html, Item, List, Notice, Panel, Stat, Stats } from "../ui/kit.ts";

const HOUR = 3600_000;
/** The sites shown per window. */
const TOP = 15;

/** The sites in `counts` in the hours from `since` on (an hour's start), most calls first. */
export function topSites(counts: CallCount[], since: number): { bucket: string; site: string; n: number }[] {
  const by = new Map<string, { bucket: string; site: string; n: number }>();
  for (const c of counts) {
    if (c.hour < since) continue;
    const k = `${c.bucket} ${c.site}`;
    const was = by.get(k);
    if (was) was.n += c.n;
    else by.set(k, { bucket: c.bucket, site: c.site, n: c.n });
  }
  return [...by.values()].sort((a, b) => b.n - a.n || a.site.localeCompare(b.site));
}

function sitesPanel(title: string, id: string, rows: ReturnType<typeof topSites>): Html {
  const total = rows.reduce((n, r) => n + r.n, 0);
  return Panel({
    title,
    id,
    meta: `${count(total)} call${total === 1 ? "" : "s"}`,
    flush: true,
    children: rows.length
      ? List(rows.slice(0, TOP).map((r) => Item({ title: html`<code>${r.site}</code>`, line: r.bucket, trail: html`<span class="t2">${count(r.n)}</span>` })))
      : Empty({ title: "No calls counted" }),
  });
}

export function callsPanels(v: CallsView, forge: string): Html {
  const hour = Math.floor(v.now / HOUR) * HOUR;
  const low = v.quota.filter((q) => (q.bucket === "core" || q.bucket === "graphql") && isLow(q, v.now));
  const quota = v.quota.length
    ? Stats(
        v.quota.map((q) => {
          const filled = q.reset <= v.now;
          return Stat({
            label: q.bucket,
            value: filled ? count(q.limit) : count(q.remaining),
            tone: isLow(q, v.now) ? (q.remaining === 0 ? "bad" : "warn") : undefined,
            foot: filled ? html`full again since ${hourOf(q.reset)}` : html`of ${count(q.limit)} · full again at ${hourOf(q.reset)}`,
            viz: Gauge({ value: filled ? q.limit : q.remaining, max: q.limit, title: `${q.remaining} of ${q.limit} left` }),
          });
        }),
      )
    : Empty({ title: "Nothing heard yet", children: html`${forge} says what's left with each answer; none has come since the counts began.` });
  return html`<p class="t2">Every call to ${forge}'s API, counted by where in Dovre it comes from. The quota is the token's, so the gh CLI and agents using the same account spend it too: a quota that falls faster than these counts is them.</p>${
    low.length ? Notice({ tone: "warn", children: html`Low on ${low.map((q) => q.bucket).join(" and ")}: the snapshot is gathered at most every 10 minutes and Stats waits until it fills again.` }) : ""
  }${Panel({ title: "Left", id: "quota", children: quota })}${sitesPanel(`Since ${hourOf(hour)}`, "calls-hour", topSites(v.counts, hour))}${sitesPanel("The last 24 hours", "calls-day", topSites(v.counts, hour - 23 * HOUR))}`;
}
