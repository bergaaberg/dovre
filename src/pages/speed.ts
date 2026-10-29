/**
 * Settings → Page speed (#294): how long pages take, the whole and each route, in the last day
 * and the last week, as the browser and the server measured them (src/speed.ts).
 */
import { html } from "hono/html";
import { count, duration } from "../format.ts";
import { byRoute, EDGES, quantile, type SpeedRow, type SpeedView } from "../speed.ts";
import { Empty, type Html, Item, List, Panel, Pill, Stat, Stats, type Tone } from "../ui/kit.ts";

const HOUR = 3600_000;
/** Routes shown per window. */
const TOP = 20;

/** A quantile as a bucket says it: "under 500 ms", or past the last edge. */
const under = (q: number | undefined, any: boolean) => (!any ? "—" : q === undefined ? `over ${duration(EDGES.at(-1)!)}` : `under ${duration(q)}`);

/** Slow is a status: 2 s and up is warn, past 4 s bad. */
const toneOf = (q: number | undefined, any: boolean): Tone | undefined => (!any ? undefined : q === undefined ? "bad" : q > 1000 ? "warn" : undefined);

const sum = (rows: (SpeedRow | undefined)[]) => {
  const b = EDGES.map(() => 0).concat(0);
  let n = 0;
  let ms = 0;
  for (const r of rows) {
    if (!r) continue;
    n += r.n;
    ms += r.ms;
    r.b.forEach((x, i) => (b[i] = (b[i] ?? 0) + x));
  }
  return { n, ms, b };
};

function routesPanel(title: string, id: string, v: SpeedView, since: number): Html {
  const routes = [...byRoute(v.rows, since)].map(([route, s]) => ({ route, page: s.page, server: s.server }));
  // Slowest first: the browser's p95, else the server's.
  const key = (r: (typeof routes)[number]) => {
    const p = r.page ?? r.server;
    return p ? (quantile(p.b, 0.95) ?? Infinity) : 0;
  };
  routes.sort((a, b) => key(b) - key(a) || (b.page?.n ?? b.server?.n ?? 0) - (a.page?.n ?? a.server?.n ?? 0) || a.route.localeCompare(b.route));
  const loads = routes.reduce((n, r) => n + (r.page?.n ?? r.server?.n ?? 0), 0);
  return Panel({
    title,
    id,
    meta: `${count(loads)} load${loads === 1 ? "" : "s"}`,
    flush: true,
    children: routes.length
      ? List(
          routes.slice(0, TOP).map((r) => {
            const p = r.page ?? r.server!;
            const p95 = quantile(p.b, 0.95);
            const server = r.server ? html` · server ${under(quantile(r.server.b, 0.5), true)}, ${duration(r.server.ms / r.server.n)} on average` : "";
            return Item({
              title: html`<code>${r.route}</code>`,
              line: html`${count(p.n)} ${r.page ? "" : "server-only "}load${p.n === 1 ? "" : "s"} · half ${under(quantile(p.b, 0.5), true)}${server}`,
              trail: Pill({ tone: toneOf(p95, true), children: html`95% ${under(p95, true)}` }),
            });
          }),
        )
      : Empty({ title: "No pages counted", children: html`A page counts once it has loaded here.` }),
  });
}

export function speedPanels(v: SpeedView): Html {
  const hour = Math.floor(v.now / HOUR) * HOUR;
  const day = hour - 23 * HOUR;
  const routes = [...byRoute(v.rows, day).values()];
  const page = sum(routes.map((r) => r.page));
  const server = sum(routes.map((r) => r.server));
  const stat = (label: string, s: ReturnType<typeof sum>, q: number) => {
    const at = quantile(s.b, q);
    return Stat({ label, value: under(at, s.n > 0), tone: toneOf(at, s.n > 0), foot: s.n ? html`${count(s.n)} loads · ${duration(s.ms / s.n)} on average` : html`none counted yet` });
  };
  return html`<p class="t2">How long pages take, from the click until the page has loaded (Access and the network included), and how much of that is the server's own time. Hosted, the server's time is mostly waiting on the database, the hub and APIs. Times are counted in steps, so they read "under 500 ms".</p>${Panel({
    title: "The last 24 hours",
    id: "speed",
    children: Stats(html`${stat("Half the pages", page, 0.5)}${stat("95% of pages", page, 0.95)}${stat("Server, 95%", server, 0.95)}`),
  })}${routesPanel("Slowest pages, last 24 hours", "speed-day", v, day)}${routesPanel("Slowest pages, last 7 days", "speed-week", v, hour - (7 * 24 - 1) * HOUR)}`;
}
