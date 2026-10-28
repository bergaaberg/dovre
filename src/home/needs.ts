/**
 * What needs me in GitHub, in the order to deal with it: deploys waiting for my approval, red
 * builds, reviews asked of me, my PRs that are stuck (or ready), mentions. Pure: a snapshot in, a
 * ranked list out. The packs add theirs (agents waiting, a signal in one of my apps) through their
 * `needs` hook (src/packs/registry.ts needsFrom); `rankNeeds` puts them all in one order.
 */
import type { Snapshot } from "../gather.ts";
import { prNeeds } from "../sources/ghe.ts";

const prHref = (p: { repo: string; number: number }) => `/prs#pr-${p.repo.replace(/[^\w-]/g, "-")}-${p.number}`;

export type NeedKind = "deploy" | "ci" | "review" | "my-pr" | "mention" | "pack";

/**
 * The core's kinds of notification (src/notify.ts RING_KINDS); packs add their own (manifest
 * rings). A need without one never rings.
 */
export type RingKind = "deploy" | "ci" | "review" | "pr-red" | "pr-ready" | "mention" | "ask";

export type Need = {
  kind: NeedKind;
  /** Stays the same while the thing is in the same state: what notifications are deduplicated on. */
  key: string;
  /** A RingKind, or one a pack declared. */
  ring?: string;
  /** A pack's need: which pack, and its label in a list. */
  pack?: string;
  label?: string;
  /** Lower comes first. */
  rank: number;
  at: number;
  title: string;
  line?: string;
  href: string;
  tone: "bad" | "warn" | "accent" | "ok" | "neutral";
  /** A core need: the repo it's about (owner/name), and its page on the forge when `href` is Dovre's. */
  repo?: string;
  url?: string;
};

export const KIND_LABEL: Record<NeedKind, string> = { deploy: "Deploy", ci: "Red build", review: "Review", "my-pr": "My PR", mention: "Mention", pack: "App" };
export const needLabel = (n: Need) => n.label ?? KIND_LABEL[n.kind];

/** Lower rank first, then the newest. */
export const rankNeeds = (needs: Need[]): Need[] => [...needs].sort((a, b) => a.rank - b.rank || b.at - a.at);

const short = (repo: string, org: string) => repo.replace(new RegExp(`^${org}/`), "");

export function needsOf(s: Snapshot): Need[] {
  const out: Need[] = [];

  if (s.deploys.ok)
    for (const d of s.deploys.value) {
      const log = s.changelogs.get(d.id);
      // A waiting run for the commit that's already live changes nothing: it's clean-up, not a decision.
      const live = log?.ok && log.value.prodSha && !log.value.changes.length;
      const ships = log?.ok && log.value.changes.length ? `ships ${log.value.changes.filter((c) => c.kind !== "deps").length} changes` : undefined;
      out.push({
        kind: "deploy",
        // Per repo and workflow, not per run: a newer run superseding the last isn't news.
        key: `deploy:${d.repo}:${d.name}`,
        ring: live ? undefined : "deploy",
        rank: live ? 4 : 0,
        at: Date.parse(d.createdAt),
        title: `${short(d.repo, s.org)} → ${d.envs.map((e) => e.name).join(", ")}: ${d.title}`,
        line: [live ? "already live: a leftover run to reject" : ships, `${d.name} · by ${d.actor} · ${d.sha}`, d.superseded.length ? `${d.superseded.length}${d.more ? "+" : ""} older waiting runs superseded` : ""].filter(Boolean).join(" · "),
        href: "/deploys",
        tone: live ? "neutral" : "bad",
        repo: d.repo,
      });
    }

  for (const r of s.red)
    out.push({ kind: "ci", key: `ci:${r.repo}:${r.branch}:${r.workflow}`, ring: "ci", rank: 0, at: Date.parse(r.since), title: `${short(r.repo, s.org)} ${r.branch} is red`, line: `${r.workflow}: the newest run failed; ${r.failures} failure ${r.failures === 1 ? "notice" : "notices"} unread`, href: r.url, tone: "bad", repo: r.repo, url: r.url });

  if (s.prs.ok) {
    for (const p of s.prs.value.review)
      out.push({
        kind: "review",
        key: `review:${p.url}`,
        ring: "review",
        rank: 2,
        at: Date.parse(p.updatedAt),
        title: `${short(p.repo, s.org)}#${p.number} ${p.title}`,
        line: `${p.author} asks for your review${p.draft ? " (draft)" : ""}`,
        href: prHref(p),
        tone: "accent",
        repo: p.repo,
        url: p.url,
      });
    for (const p of s.prs.value.mine) {
      const why = prNeeds(p);
      if (!why.length) continue;
      const ready = why[0]!.startsWith("approved");
      out.push({
        kind: "my-pr",
        key: `my-pr:${p.url}:${why[0]}`,
        ring: ready ? "pr-ready" : why[0] === "checks failing" || why[0] === "changes requested" ? "pr-red" : undefined,
        rank: ready ? 2 : 3,
        at: Date.parse(p.updatedAt),
        title: `${short(p.repo, s.org)}#${p.number} ${p.title}`,
        line: why.join(", "),
        href: prHref(p),
        tone: ready ? "ok" : why[0] === "checks failing" || why[0] === "changes requested" ? "bad" : "warn",
        repo: p.repo,
        url: p.url,
      });
    }
  }

  if (s.notes.ok)
    for (const n of s.notes.value)
      if (n.reason === "mention" || n.reason === "team_mention")
        out.push({ kind: "mention", key: `mention:${n.id}:${n.updatedAt}`, ring: "mention", rank: 4, at: Date.parse(n.updatedAt), title: n.title, line: `${short(n.repo, s.org)} · ${n.reason === "team_mention" ? "your team was mentioned" : "you were mentioned"}`, href: n.url, tone: "neutral", repo: n.repo, url: n.url });

  return rankNeeds(out);
}
