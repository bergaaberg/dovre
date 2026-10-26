/** Dependabot (dovre#108): the open bumps across the owners' repos, and combining a repo's into one PR. */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import type { RepoQueue } from "../actions/dependabot.ts";
import { MAX_COMBINE } from "../actions/dependabot.ts";
import { Confirm, Empty, type Html, Item, List, Notice, PageHeader, Panel, Pill } from "../ui/kit.ts";
import { ago } from "../format.ts";
import { Link, prTabs, safeUrl } from "./parts.ts";

export type Job = { repo: string; state: "running" } | { repo: string; state: "done"; ok: boolean; message: string; url?: string };

function repoPanel(r: RepoQueue, now: number, running: boolean): Html {
  const n = r.prs.length;
  const take = Math.min(n, MAX_COMBINE);
  const meta = html`${n} open · oldest ${ago(Date.parse(r.oldest), now)}${r.security ? html` · ${Pill({ tone: "bad", children: `${r.security} security` })}` : ""}`;
  const action = running
    ? html`<span class="t3">Combining…</span>`
    : n >= 2
      ? Confirm({
          action: "/prs/dependabot/combine",
          fields: { repo: r.repo },
          label: `Combine ${take}`,
          question: html`Open one PR in ${r.repo} with ${take} Dependabot bump${take === 1 ? "" : "s"}? Each is merged onto a new branch from the default branch; ones that conflict are left out and listed.${r.security ? html` The ${r.security} security fix${r.security === 1 ? "" : "es"} are listed first.` : ""}`,
        })
      : "";
  return Panel({
    title: r.repo,
    meta,
    actions: action,
    children: html`${r.combined ? Notice({ children: html`A combined PR is already open: ${Link(r.combined.url, `#${r.combined.number}`)}.` }) : ""}${List(
      r.prs.map((p) =>
        Item({
          href: safeUrl(p.url),
          title: html`#${p.number} ${p.title}`,
          line: html`opened ${ago(Date.parse(p.createdAt), now)}`,
          trail: p.security ? Pill({ tone: "bad", children: "security fix" }) : "",
        }),
      ),
    )}`,
  });
}

export function dependabotPage(frame: Frame, o: { org: string; repos?: RepoQueue[]; alertsUnread?: string[]; error?: string; pending?: boolean; jobs?: Job[]; now?: number }): string {
  const now = o.now ?? Date.now();
  const jobs = o.jobs ?? [];
  const running = new Set(jobs.filter((j) => j.state === "running").map((j) => j.repo));
  const jobLines = jobs.map((j) =>
    j.state === "running"
      ? html`<section class="pending" data-pending aria-busy="true"><span class="spinner" aria-hidden="true"></span><p class="t2">Combining the Dependabot PRs in ${j.repo}. This fills in by itself.</p></section>`
      : Notice({ tone: j.ok ? "ok" : "bad", children: html`${j.message}${j.url ? html` ${Link(j.url, "Open it")}` : ""}` }),
  );
  const total = (o.repos ?? []).reduce((n, r) => n + r.prs.length, 0);
  const body = o.pending
    ? html`<section class="pending" data-pending aria-busy="true"><span class="spinner" aria-hidden="true"></span><h1>Reading Dependabot's PRs</h1><p class="t2">The page fills in by itself.</p></section>`
    : html`${jobLines}${o.error ? Notice({ tone: "bad", children: html`Dependabot's PRs didn't load: ${o.error}` }) : ""}${
        o.alertsUnread?.length ? html`<p class="t3">Security fixes can't be told apart in ${o.alertsUnread.join(", ")}: the token can't read Dependabot alerts there.</p>` : ""
      }${
        o.repos && !o.repos.length
          ? Empty({ title: "No Dependabot PRs", children: html`<p class="t2">Nothing open from Dependabot in ${o.org}.</p>` })
          : (o.repos ?? []).map((r) => repoPanel(r, now, running.has(r.repo)))
      }`;
  return String(
    shell({
      title: "Dependabot · Dovre",
      frame,
      current: "/prs/dependabot",
      body: html`${PageHeader({ title: "Pull requests", sub: o.repos ? `Dependabot: ${total} open bump${total === 1 ? "" : "s"} in ${o.repos.length} repo${o.repos.length === 1 ? "" : "s"}, security fixes first.` : "Dependabot's open bumps, by repo.", tabs: prTabs("dependabot") })}<div data-live id="dependabot">${body}</div>`,
    }),
  );
}
