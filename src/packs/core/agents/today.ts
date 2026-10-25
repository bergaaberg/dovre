/**
 * What the agents pack adds to Today: its card (what needs me first: asking, failed, working;
 * then the rest counted; one row per session, a run started here is a row until its session shows
 * up), its numbers and sentence in the briefing, its row on the horizon, and its feed events.
 * Pure: sessions and runs in.
 */
import { html } from "hono/html";
import { latestRuns, sessionCost, turnCost } from "../../../agents/latest.ts";
import type { Run } from "../../../agents/runner.ts";
import type { Snapshot } from "../../../gather.ts";
import { Ago, Chev, harnessTag, Link, mineByKey, st, trunc } from "../../../pages/parts.ts";
import type { Session } from "../../../sources/claude.ts";
import { prKeyOfUrl } from "../../../sources/ghe.ts";
import type { Bit, FeedItem, Glance, Lane } from "../../types.ts";

type Sessions = { live: Session[]; recent: Session[] };
const DAY = 86400e3;
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const word = (n: number) => (n < WORDS.length ? WORDS[n]! : String(n));
const refused = (r: Run) => r.status !== "running" && r.events.some((e) => e.t === "denied");

const short = (repo: string, org: string) => repo.replace(`${org}/`, "");

function sessionState(a: Session) {
  if (a.status === "busy") return { pulse: "busy", st: st("acc", "Working") };
  if (a.status === "waiting") return { pulse: "bad", st: st("bad", a.waitingFor ? `Needs your OK: ${a.waitingFor}` : "Needs your OK") };
  return { pulse: "warn", st: st("warn", "Waiting for you") };
}

function agentRow(a: Session, s: Snapshot) {
  const state = sessionState(a);
  const mine = mineByKey(s);
  const prs = a.prs.slice(-4);
  return html`<li class="row">
<details id="ag-${a.sessionId}">
<summary><span class="row-k"><span class="breathe ${state.pulse}" aria-hidden="true"></span>${a.repo ?? ""}${harnessTag(a.harness)}</span><span class="row-t">${a.title ?? a.name ?? "Untitled session"}</span>${
    a.summary ? html`<span class="row-x">${a.summary}</span>` : a.lastPrompt ? html`<span class="row-x">“${trunc(a.lastPrompt, 160)}”</span>` : ""
  }<span class="row-m">${state.st}${a.branch ? html`<span>${a.branch}</span>` : ""}<span>${Ago(a.statusSince ?? a.lastAt)}</span></span>${Chev}</summary>
<div class="expand">
<dl class="facts">${a.lastPrompt ? html`<dt>You asked</dt><dd class="quote">“${trunc(a.lastPrompt, 400)}”</dd>` : ""}${a.summary ? html`<dt>Recap</dt><dd>${a.summary}</dd>` : ""}${
    prs.length
      ? html`<dt>PRs</dt><dd>${prs.map((p) => {
          const key = prKeyOfUrl(p.url) ?? "";
          const pr = mine.get(key);
          const state = pr ? (pr.checks === "FAILURE" ? "checks failing" : pr.draft ? "draft" : "open") : (s.refs.get(key)?.state.toLowerCase() ?? "");
          return html`${Link(p.url, `${short(p.repo, s.org)}#${p.number}`)} <span class="t3">${state}</span> `;
        })}</dd>`
      : ""
  }${a.cost ? html`<dt>Cost</dt><dd>$${a.cost.toFixed(2)}</dd>` : ""}</dl>
<div class="buttons"><a class="btn primary" href="/agents/s/${a.sessionId}">Open the conversation</a>${a.repo ? html`<a class="btn ghost" href="/agents/new?repo=${encodeURIComponent(a.repo)}">New session here</a>` : ""}</div>
</div>
</details>
</li>`;
}

function runRow(r: Run, all: Run[]) {
  const cost = sessionCost(r, all);
  const denied = r.events.some((e) => e.t === "denied");
  const tone = r.status === "running" ? "busy" : denied || r.status === "failed" ? "bad" : "idle";
  const label = r.status === "running" ? st("acc", "Working here") : denied ? st("bad", "Needs your OK") : r.status === "failed" ? st("bad", "Failed") : st("mute", "Done");
  return html`<li class="row"><a class="row-link" href="${r.sessionId ? `/agents/s/${r.sessionId}` : `/agents/r/${r.id}`}"><span class="row-k"><span class="breathe ${tone}" aria-hidden="true"></span>${r.repo}${harnessTag(r.harness, r.model)}</span><span class="row-t">${trunc(r.prompt.split("\n")[0], 140)}</span><span class="row-m">${label}<span>${Ago(r.startedAt)}</span>${cost ? html`<span>$${cost.toFixed(2)}</span>` : ""}</span></a></li>`;
}

export type AgentPick = { kind: "run"; run: Run } | { kind: "session"; session: Session };

/**
 * What the agents card shows: what needs me first (an OK asked, a run that failed), then what's
 * working, then sessions waiting for my next message; newest first within each. At most `max`;
 * runs here that finished fine are only counted (they're on /agents).
 */
export function agentPicks(live: Session[], runs: Run[], now: number, max = 5): { shown: AgentPick[]; more: number; done: number } {
  // One row per session: a reply is a run of its own, and the newest one says where it stands.
  const recent = latestRuns(runs).filter((r) => r.status === "running" || now - r.startedAt < 6 * 3600e3);
  const ranked: { pick: AgentPick; rank: number; at: number }[] = [];
  let done = 0;
  for (const r of recent) {
    const denied = r.status !== "running" && r.events.some((e) => e.t === "denied");
    const rank = denied ? 0 : r.status === "failed" ? 1 : r.status === "running" ? 2 : -1;
    if (rank < 0) done++;
    else ranked.push({ pick: { kind: "run", run: r }, rank, at: r.startedAt });
  }
  for (const a of live) ranked.push({ pick: { kind: "session", session: a }, rank: a.status === "waiting" ? 0 : a.status === "busy" ? 2 : 3, at: a.statusSince ?? (a.lastAt ? Date.parse(a.lastAt) : 0) });
  ranked.sort((x, y) => x.rank - y.rank || y.at - x.at);
  return { shown: ranked.slice(0, max).map((x) => x.pick), more: Math.max(0, ranked.length - max), done };
}

export function agentsCard(s: Snapshot, sessions: Sessions, runs: Run[], now: number) {
  const live = sessions.live;
  const here = latestRuns(runs).filter((r) => r.status === "running" || now - r.startedAt < 6 * 3600e3);
  const needs = live.filter((a) => a.status !== "busy").length + here.filter((r) => r.status !== "running" && r.events.some((e) => e.t === "denied")).length;
  const working = live.filter((a) => a.status === "busy").length + here.filter((r) => r.status === "running").length;
  const { shown, more, done } = agentPicks(live, runs, now);
  const spend = live.reduce((n, a) => n + (a.cost ?? 0), 0);
  return html`<section class="card" id="agents" aria-labelledby="agents-h">
<div class="card-h"><h2 id="agents-h">Agents</h2><p>${live.length + here.filter((r) => r.status === "running").length} live</p></div>
<p class="stat-row">${needs ? st("bad", `${needs} need${needs === 1 ? "s" : ""} you`) : st("ok", "none need you")}${working ? st("acc", `${working} working`) : ""}${done ? st("mute", `${done} done here today`) : ""}${spend ? st("mute", `$${spend.toFixed(2)} on the live ones`) : ""}</p>
<ul class="rows">${shown.map((p) => (p.kind === "run" ? runRow(p.run, runs) : agentRow(p.session, s)))}${!shown.length ? html`<li class="row"><p class="empty">No agents running.</p></li>` : ""}</ul>
<div class="card-f"><span>${more ? html`<a href="/agents">${more} more</a>` : html`<a href="/agents/new">Start a new session</a>`}</span><a href="/agents">All sessions</a></div>
</section>`;
}

/** "Agents live" and "Agent spend" (the last 24 hours) beside the greeting. */
export function agentGlance(sessions: Sessions, runs: Run[], now: number): Glance[] {
  const since = now - DAY;
  const seen = [...sessions.live, ...sessions.recent].filter((x) => Date.parse(x.lastAt ?? "") >= since || x.live);
  // A session started here is also in Claude Code's list, with its whole cost: count it once.
  const counted = new Set(seen.filter((x) => x.cost).map((x) => x.sessionId));
  const spend = seen.reduce((n, x) => n + (x.cost ?? 0), 0) + runs.filter((r) => r.startedAt >= since && !(r.sessionId && counted.has(r.sessionId))).reduce((n, r) => n + turnCost(r, runs), 0);
  return [
    { label: "Agents live", value: sessions.live.length + runs.filter((r) => r.status === "running").length },
    { label: "Agent spend", value: `$${Math.round(spend)}` },
  ];
}

/** Today's sentence when agents want me: asking for an OK (the one thing, when it's one), else waiting for my next message. */
export function agentBrief(live: Session[], runs: Run[]): Bit[] {
  const asking = live.filter((a) => a.status === "waiting");
  const idle = live.filter((a) => a.status === "idle");
  const ask = asking.length + latestRuns(runs).filter(refused).length;
  const agents = (n: number) => `${word(n)} ${n === 1 ? "agent" : "agents"}`;
  if (ask) {
    const one = asking[0];
    if (ask === 1 && one?.waitingFor) return [{ text: agents(1), href: "/#agents", tone: "warn" }, " wants your OK for ", { text: "", href: "", code: one.waitingFor }, "."];
    return [{ text: agents(ask), href: "/#agents", tone: "warn" }, ` ${ask === 1 ? "needs" : "need"} your OK.`];
  }
  if (idle.length) return [{ text: agents(idle.length), href: "/#agents" }, ` ${idle.length === 1 ? "waits" : "wait"} for you.`];
  return [];
}

const titleOf = (a: Session) => a.title ?? a.name ?? "session";

/** The horizon's Agents row: sessions that stopped in the last day, sized by cost; live ones at the right. */
export function agentLane(sessions: Sessions, now: number): Lane {
  const marks: Lane["marks"] = [];
  for (const s of sessions.recent) {
    const at = Date.parse(s.lastAt ?? "");
    if (at >= now - DAY) marks.push({ at, size: 2.4 + Math.min(5.5, Math.sqrt(s.cost || 0.3) * 1.2), title: `${titleOf(s)} · $${(s.cost ?? 0).toFixed(2)}` });
  }
  for (const s of sessions.live) marks.push({ at: now, live: true, title: `${titleOf(s)} (running)` });
  return { label: "Agents", legend: "Agent session, by cost", marks };
}

/** The feed's agent events of the last day: sessions changing state, and runs started here (and how they ended). */
export function agentFeed(sessions: Sessions, runs: Run[], now: number): FeedItem[] {
  const out: FeedItem[] = [];
  const title = (a: Session) => a.title ?? a.name ?? (a.lastPrompt ? a.lastPrompt.slice(0, 90) : undefined);
  for (const a of sessions.live) {
    const [tone, what]: [FeedItem["tone"], string] = a.status === "waiting" ? ["bad", `needs your OK${a.waitingFor ? `: ${a.waitingFor}` : ""}`] : a.status === "busy" ? ["acc", "is working"] : ["warn", "waits for you"];
    out.push({ key: `a:${a.sessionId}:${a.status ?? "idle"}`, at: a.statusSince ?? (a.lastAt ? Date.parse(a.lastAt) : 0), tone, who: "Agent", what, title: title(a), href: `/agents/s/${a.sessionId}`, repo: a.repo });
  }
  for (const a of sessions.recent) {
    out.push({ key: `e:${a.sessionId}:${a.lastAt ?? ""}`, at: a.lastAt ? Date.parse(a.lastAt) : 0, tone: "mute", who: "Agent", what: "stopped", title: title(a), href: `/agents/s/${a.sessionId}`, repo: a.repo });
  }
  for (const r of runs) {
    const href = r.sessionId ? `/agents/s/${r.sessionId}` : `/agents/r/${r.id}`;
    const t = r.prompt.split("\n")[0]!.slice(0, 90);
    const reply = !!r.sessionId && !r.forked && runs.some((x) => x !== r && x.sessionId === r.sessionId && x.startedAt < r.startedAt);
    out.push({ key: `r:${r.id}:start`, at: r.startedAt, tone: "acc", who: "You", what: reply ? "replied to an agent" : "started an agent", title: t, href, repo: r.repo, mine: true });
    if (r.status !== "running" && r.endedAt) {
      const [tone, what]: [FeedItem["tone"], string] = refused(r) ? ["bad", "needs your OK"] : r.status === "failed" ? ["bad", "failed"] : r.status === "stopped" ? ["mute", "was stopped"] : ["ok", "finished"];
      out.push({ key: `r:${r.id}:${r.status}`, at: r.endedAt, tone, who: "Agent", what, title: t, href, repo: r.repo });
    }
  }
  return out.filter((e) => Number.isFinite(e.at) && e.at > 0 && now - e.at < DAY);
}
