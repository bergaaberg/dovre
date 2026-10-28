/** Stacked PRs: every stack around my PRs and my review requests, bottom first, problems first. */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import { type Problem, problemText, type Stack, type StackNode, type StackPr, waitText } from "../home/stacks.ts";
import { Confirm, Empty, type Html, Notice, PageHeader, Panel, Pill } from "../ui/kit.ts";
import { Reading } from "./later.ts";
import { Link, prTabs } from "./parts.ts";

const short = (org: string, repo: string) => repo.replace(`${org}/`, "");
/** A branch steps right; past three it stays there. */
const LANES = ["lane-0", "lane-1", "lane-2", "lane-3"] as const;

function pills(p: StackPr): Html {
  const review =
    p.review === "APPROVED" ? Pill({ tone: "ok", children: "approved" }) : p.review === "CHANGES_REQUESTED" ? Pill({ tone: "bad", children: "changes requested" }) : Pill({ children: "awaiting review" });
  const checks = p.checks === "ok" ? Pill({ tone: "ok", children: "checks ✓" }) : p.checks === "bad" ? Pill({ tone: "bad", children: "checks ✗" }) : p.checks === "pending" ? Pill({ tone: "warn", children: "checks …" }) : "";
  const merge = p.mergeState === "DIRTY" ? Pill({ tone: "bad", children: "conflicts" }) : p.mergeState === "BEHIND" ? Pill({ tone: "warn", children: "behind its base" }) : "";
  return html`${p.draft ? Pill({ children: "draft" }) : ""}${review}${checks}${merge}`;
}

function node(n: StackNode, total: number, me: string): Html {
  const p = n.pr;
  return html`<li class="stack-pr ${LANES[Math.min(n.lane, LANES.length - 1)]}"><span class="stack-pos" title="Merges ${n.position === 1 ? "first" : `after ${n.position - 1} before it`}">${n.position}/${total}</span><span class="stack-main"><span class="stack-title">${Link(p.url, html`<strong>#${p.number}</strong> ${p.title}`)}</span><span class="stack-line"><code>${p.head}</code> → <code>${p.base}</code>${p.author !== me ? html` · ${p.author}` : ""}${n.waits ? html` · <span class="stack-wait">${waitText(n.waits)}</span>` : ""}</span><span class="stack-pills">${pills(p)}</span></span></li>`;
}

function problemLine(s: Stack, x: Problem): Html {
  const text = problemText(x);
  if (x.kind !== "base-merged") return Notice({ tone: x.kind === "conflicts" ? "warn" : "bad", children: text });
  const pr = s.nodes.find((n) => n.pr.number === x.pr)?.pr;
  return Notice({
    tone: "warn",
    children: html`${text} ${pr ? Confirm({ kind: "pr.retarget", action: "/prs/stacks/retarget", fields: { repo: s.repo, number: String(pr.number), from: pr.base }, label: `Retarget onto ${x.onto}`, question: html`Change #${pr.number}'s base from <code>${pr.base}</code> to <code>${x.onto}</code> on GHE?` }) : ""}`,
  });
}

function stackPanel(s: Stack, org: string, me: string): Html {
  const n = s.nodes.length;
  const meta = html`${s.approved}/${n} approved${s.red ? html` · <span class="stack-red">${s.red} red</span>` : ""}`;
  return Panel({
    title: html`${short(org, s.repo)} · ${n === 1 ? "1 PR" : `${n} PRs`}`,
    meta,
    children: html`${s.problems.map((x) => problemLine(s, x))}${s.ready ? Notice({ tone: "ok", children: html`Ready: merge #${s.ready} first, then the next one up.` }) : ""}<p class="t3 stack-order">Bottom first: that's the order they merge in, onto <code>${s.defaultBranch}</code>.</p><ol class="stack">${s.nodes.map((x) => node(x, n, me))}</ol>`,
  });
}

export function stacksPage(frame: Frame, o: { org: string; me: string; stacks?: Stack[]; error?: string; pending?: boolean; flash?: { ok: boolean; message: string } }): string {
  const body = o.pending
    ? Reading({ title: "Reading stacks", text: "Your open PRs and review requests, and the chains they're in. The page fills in by itself." })
    : html`${o.flash ? Notice({ tone: o.flash.ok ? "ok" : "bad", children: o.flash.message }) : ""}${o.error ? Notice({ tone: "bad", children: html`Stacks didn't load: ${o.error}` }) : ""}${
        o.stacks && !o.stacks.length
          ? Empty({ title: "No stacks", children: html`<p class="t2">None of your open PRs or review requests sit on another PR's branch.</p>` })
          : (o.stacks ?? []).map((s) => stackPanel(s, o.org, o.me))
      }`;
  return String(
    shell({
      title: "Stacks · Dovre",
      frame,
      current: "/prs/stacks",
      body: html`${PageHeader({ title: "Pull requests", sub: html`Stacks: pull requests built on other pull requests, in ${o.org}, yours and the ones you're asked to review.`, tabs: prTabs("stacks") })}<div data-live id="stacks">${body}</div>`,
    }),
  );
}
