/** Dependabot (dovre#108): the open bumps across the owners' repos, and combining a repo's into one PR. */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import type { Combined, RepoQueue } from "../actions/dependabot.ts";
import { combinedReady, MAX_COMBINE } from "../actions/dependabot.ts";
import { BulkBar, Confirm, Empty, type Html, Item, List, Notice, PageHeader, Panel, Pick, Pill } from "../ui/kit.ts";
import { ago } from "../format.ts";
import { Link, prTabs, safeUrl } from "./parts.ts";

/** A write running after the redirect: combining a repo's bumps, or adding groups to its dependabot.yml. */
export type Job = { repo: string; what: "combine" | "groups" | "merge" } & ({ state: "running" } | { state: "done"; ok: boolean; message: string; url?: string });

/** Where a combined PR stands: what keeps it from merging, or that it's ready. */
function combinedState(c: Combined): Html {
  if (c.draft) return Pill({ children: "draft" });
  if (c.checks === "FAILURE" || c.checks === "ERROR") return Pill({ tone: "bad", children: "checks failed" });
  if (c.checks === "PENDING" || c.checks === "EXPECTED") return Pill({ tone: "warn", children: "checks running" });
  if (c.checks !== "SUCCESS") return Pill({ children: "no checks" });
  if (c.mergeable === "CONFLICTING") return Pill({ tone: "bad", children: "conflicts" });
  if (c.mergeable !== "MERGEABLE") return Pill({ children: "mergeable unknown" });
  return Pill({ tone: "ok", children: "green" });
}

/** The combined PRs Dovre opened: tick the green ones and merge them at once (dovre#108). */
function combinedPanel(repos: RepoQueue[], running: boolean): Html {
  const open = repos.filter((r): r is RepoQueue & { combined: Combined } => !!r.combined);
  if (!open.length) return html``;
  const ready = open.filter((r) => combinedReady(r.combined)).length;
  const bar =
    running
      ? html`<p class="t3">Merging…</p>`
      : ready
        ? BulkBar({ id: "dependabot-merge", action: "/prs/dependabot/merge", label: "Ticked:", buttons: [{ name: "go", value: "1", label: "Merge ticked", kind: "pr.merge-combined", question: "Squash-merge every ticked combined PR? Each is checked again first: still open, mergeable, its checks green." }] })
        : "";
  return Panel({
    title: "Combined PRs",
    meta: `${ready} of ${open.length} green`,
    flush: true,
    children: html`${bar}${List(
      open.map((r) =>
        Item({
          lead: !running && combinedReady(r.combined) ? Pick({ form: "dependabot-merge", value: `${r.repo}#${r.combined.number}`, label: `Pick ${r.repo}#${r.combined.number}` }) : "",
          title: html`<strong>${r.repo}</strong> ${Link(r.combined.url, `#${r.combined.number}`)}`,
          trail: combinedState(r.combined),
        }),
      ),
    )}`,
  });
}

function repoPanel(r: RepoQueue, now: number, running: Set<string>): Html {
  const n = r.prs.length;
  const take = Math.min(n, MAX_COMBINE);
  const meta = html`${n} open · oldest ${ago(Date.parse(r.oldest), now)}${r.security ? html` · ${Pill({ tone: "bad", children: `${r.security} security` })}` : ""}`;
  const combine = running.has(`combine:${r.repo}`)
    ? html`<span class="t3">Combining…</span>`
    : n >= 2
      ? Confirm({ kind: "pr.combine-dependabot",
          action: "/prs/dependabot/combine",
          fields: { repo: r.repo },
          label: `Combine ${take}`,
          question: html`Open one PR in ${r.repo} with ${take} Dependabot bump${take === 1 ? "" : "s"}? Each is merged onto a new branch from the default branch; ones that conflict are left out and listed.${r.security ? html` The ${r.security} security fix${r.security === 1 ? "" : "es"} are listed first.` : ""}`,
        })
      : "";
  const groups = running.has(`groups:${r.repo}`)
    ? html`<span class="t3">Adding groups…</span>`
    : Confirm({ kind: "pr.dependabot-groups",
        action: "/prs/dependabot/groups",
        fields: { repo: r.repo },
        label: "Group future bumps",
        question: html`Open a PR in ${r.repo} that adds a minor-and-patch group to each update in .github/dependabot.yml? Once it merges, Dependabot opens one PR per ecosystem for those bumps itself.`,
      });
  return Panel({
    title: r.repo,
    meta,
    actions: html`${groups}${combine}`,
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
  const running = new Set(jobs.filter((j) => j.state === "running").map((j) => `${j.what}:${j.repo}`));
  const jobLines = jobs.map((j) =>
    j.state === "running"
      ? html`<section class="pending" data-pending aria-busy="true"><span class="spinner" aria-hidden="true"></span><p class="t2">${j.what === "groups" ? "Adding groups to the dependabot.yml in" : j.what === "merge" ? "Merging" : "Combining the Dependabot PRs in"} ${j.repo}. This fills in by itself.</p></section>`
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
          : html`${combinedPanel(o.repos ?? [], running.has("merge:combined PRs"))}${(o.repos ?? []).map((r) => repoPanel(r, now, running))}`
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
