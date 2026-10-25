/** The agents pack's pages (the list, worktrees) and the bar asking for my OK on every page. */
import { html } from "hono/html";
import type { Snapshot } from "../../../gather.ts";
import type { Session } from "../../../sources/claude.ts";
import type { Sessions } from "../../../sources/sessions.ts";
import type { Worktree } from "../../../sources/worktrees.ts";
import { Confirm, Empty, type Html, Item, List, PageHeader, Panel, Pill } from "../../../ui/kit.ts";
import { latestRuns, sessionCost } from "../../../agents/latest.ts";
import { inWorkDir } from "../../../agents/workdir.ts";
import type { Run } from "../../../agents/runner.ts";
import { mineByKey } from "../../../pages/parts.ts";
import { Ago, harnessTag, Link, type MacStatus, macNotice, prPills, sessionItem } from "../../../pages/parts.ts";
import type { PageOpts } from "../../types.ts";
import { NO } from "../../../agents/conversation.ts";
import type { AgentAsk } from "./asks.ts";


/** One agent's ask in the bar on every page: the call it wants, Allow (exactly those calls), No, and back where I was. */
export function askBar(a: AgentAsk): Html {
  const more = a.details.length - 1;
  return html`<section class="approval" aria-label="Agent in ${a.repo} asks"><div class="approval-text"><h2>Agent in ${a.repo} wants to run</h2><p class="approval-q"><code>${a.details[0] ?? a.specs[0]}</code>${more > 0 ? html` <span class="t3">+${more} more</span>` : ""}</p><p class="t3">${a.title} · <a href="/agents/s/${a.sid}">Open</a></p></div><div class="approval-do"><form method="post" action="/agents/s/${a.sid}/allow">${a.specs.map((s) => html`<input type="hidden" name="spec" value="${s}">`)}<input type="hidden" name="mode" value="${a.mode}"><input type="hidden" name="model" value="${a.model}"><input type="hidden" name="back" value="1"><button type="submit" class="primary" data-busy="Allowing">Allow</button></form><form method="post" action="/agents/s/${a.sid}/reply"><input type="hidden" name="prompt" value="${NO}"><input type="hidden" name="mode" value="${a.mode}"><input type="hidden" name="model" value="${a.model}"><input type="hidden" name="back" value="1"><button type="submit" class="ghost">No</button></form></div></section>`;
}

/** One run started here: what it was asked, how it's doing, and Stop or Clear away. */
function runItem(r: Run, all: Run[]) {
  const cost = sessionCost(r, all);
  const href = r.sessionId ? `/agents/s/${r.sessionId}` : `/agents/r/${r.id}`;
  const denied = r.events.some((e) => e.t === "denied");
  const tone = r.status === "running" ? "ok" : r.status === "failed" ? "bad" : denied ? "warn" : undefined;
  const label = r.status === "running" ? "working" : denied ? "needs your OK" : r.status;
  const act =
    r.status === "running"
      ? html`<form method="post" action="/agents/r/${r.id}/stop"><button type="submit" class="sm danger" data-busy="Stopping">Stop</button></form>`
      : html`<form method="post" action="/agents/r/${r.id}/discard"><button type="submit" class="sm ghost" title="Off Dovre's lists; the transcript stays">Clear away</button></form>`;
  return Item({
    lead: html`<span class="dot${tone ? ` ${tone}` : ""}" aria-hidden="true"></span>`,
    title: html`<a class="name" href="${href}"><strong>${r.prompt.split("\n")[0]!.slice(0, 120)}</strong></a> ${Pill({ tone, children: label })}`,
    line: html`${harnessTag(r.harness, r.model)} ${r.repo} · ${r.mode}${r.forked ? " · copy" : ""}`,
    more: html`<span class="actions">${act}</span>`,
    trail: html`${Ago(r.startedAt)}${cost ? html`<span class="t3">$${cost.toFixed(2)}</span>` : ""}`,
    quiet: r.status !== "running" && !denied,
  });
}

/** Clears every run started here that has ended, and the ended sessions in Dovre's folder. */
function clearAll(n: number) {
  return Confirm({ action: "/agents/clear", label: "Clear finished", question: html`Clear away ${n} finished ${n === 1 ? "session" : "sessions"} started here, those waiting for your OK included? Their transcripts stay; replying to one brings it back.` });
}

export function agentsPage(s: Snapshot, sessions: Sessions, all: Run[] = [], o: { workDir?: string; /** Hosted: the Mac's agents, online or not. */ mac?: MacStatus; /** Packs' panels after "Started here" ("agents.panel"). */ panels?: (Html | "")[]; /** Packs' ways to pick an ended session up ("session.resume"). */ resume?: (s: Session) => (Html | "")[] } = {}): PageOpts {
  const runs = latestRuns(all);
  const here = (a: { cwd?: string }) => !!o.workDir && inWorkDir(o.workDir, a.cwd);
  const ctx = { org: s.org, mine: mineByKey(s), refs: s.refs, prs: 8, resume: o.resume, here, discard: (a: { sessionId: string; cwd?: string }) => here(a) || runs.some((r) => r.sessionId === a.sessionId) };
  const waiting = sessions.live.filter((a) => a.status === "idle" || a.status === "waiting").length;
  const ended = runs.filter((r) => r.status !== "running");
  const endedSids = new Set(ended.map((r) => r.sessionId));
  const clearable = ended.length + sessions.recent.filter((a) => here(a) && !endedSids.has(a.sessionId)).length;
  const body = html`${PageHeader({ title: "Agents", sub: `${sessions.live.filter((a) => a.kind !== "headless").length} in terminals · ${waiting} waiting · ${runs.filter((r) => r.status === "running").length} working here`, actions: html`<a class="btn primary" href="/agents/new">New session</a>` })}
${macNotice(o.mac)}
<div data-live id="agents">
${runs.length || clearable ? Panel({ title: "Started here", meta: String(runs.length), actions: clearable ? clearAll(clearable) : undefined, flush: true, children: runs.length ? List(runs.map((r) => runItem(r, all))) : Empty({ title: "Nothing working here", children: html`<p class="t2">Ended sessions from Dovre's folder are under Recent.</p>` }) }) : ""}
${o.panels ?? ""}
${Panel({ title: "Running", meta: String(sessions.live.length), flush: true, children: sessions.live.length ? List(sessions.live.map((a) => sessionItem(a, ctx))) : Empty({ title: "No agents running" }) })}
${Panel({ title: "Recent", meta: String(sessions.recent.length), flush: true, children: sessions.recent.length ? List(sessions.recent.map((a) => sessionItem(a, ctx))) : Empty({ title: "Nothing in the last 4 days" }) })}
</div>`;
  return { title: "Agents · Dovre", current: "/agents", body };
}

export function worktreesPage(s: Snapshot, worktrees: Worktree[], actions: (name: string) => (Html | "")[] = () => []): PageOpts {
  const byBranch = new Map((s.prs.ok ? s.prs.value.mine : []).map((p) => [p.branch, p]));
  const week = 7 * 86400e3;
  const body = html`${PageHeader({ title: "Worktrees", sub: "With the open PR on each branch." })}
${Panel({
  flush: true,
  children: worktrees.length
    ? List(
        worktrees.map((w) => {
          const pr = w.branch ? byBranch.get(w.branch) : undefined;
          return Item({
            title: html`<strong>${w.name}</strong>${pr ? html` ${Link(pr.url, html`#${pr.number}`)} ${prPills(pr)}` : Pill({ children: "no open PR" })}`,
            line: html`${w.main} · ${w.branch ?? `detached at ${w.head}`}`,
            trail: html`${Ago(w.changedAt)}${actions(w.name).map((a) => (a ? html` ${a}` : ""))}`,
            quiet: !pr && Date.now() - w.changedAt > week,
          });
        }),
      )
    : Empty({ title: "No worktrees" }),
})}`;
  return { title: "Worktrees · Dovre", current: "/worktrees", body };
}
