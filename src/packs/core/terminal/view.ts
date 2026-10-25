/**
 * Terminals: the open ones and a way to start one (a program from the fixed list, in a checkout),
 * one terminal's page, and what the pack puts in core pages (slots): the panel on Agents, the
 * button on a worktree, "Resume in a terminal here" on an ended session.
 */
import { html } from "hono/html";
import { Ago, safeUrl } from "../../../pages/parts.ts";
import type { Session } from "../../../sources/claude.ts";
import { Confirm, Empty, type Html, Item, List, Notice, PageHeader, Panel, Pill } from "../../../ui/kit.ts";
import type { PageOpts } from "../../types.ts";
import { TERMINAL_JS_PATH, XTERM } from "./client.ts";
import type { Program } from "./programs.ts";
import type { ExternalApp, Term } from "./terms.ts";

function termItem(t: Term): Html {
  return Item({
    href: `/terminal/${t.id}`,
    lead: html`<span class="dot${t.endedAt ? "" : " ok"}" aria-hidden="true"></span>`,
    title: html`<strong>${t.label}</strong> in ${t.repo}${t.resume ? html` <span class="t3">resuming ${t.resume.slice(0, 8)}</span>` : ""}`,
    line: t.endedAt ? html`Ended${t.code !== undefined ? `, exit code ${t.code}` : ""}${t.reason ? html` · ${t.reason}` : ""}` : "Running",
    trail: Ago(t.startedAt),
    quiet: !!t.endedAt,
  });
}

/** The open terminals. */
export function terminalList(terms: Term[]): Html {
  return html`<div data-live id="terminals">${terms.length ? List(terms.map(termItem)) : Empty({ title: "No terminals open", children: html`<p class="t2">Start one below, or from a worktree or an ended agent session.</p>` })}</div>`;
}

/** The "agents.panel" slot: the terminals open here, on the Agents page. */
export function agentsPanel(terms: Term[]): Html {
  return Panel({ title: "Terminals here", meta: String(terms.filter((t) => !t.endedAt).length), actions: html`<a class="btn sm" href="/terminal">New terminal</a>`, flush: true, children: terminalList(terms) });
}

/** The "worktree.actions" slot: open a terminal in that checkout. */
export function worktreeButton(name: string): Html {
  return html`<a class="btn sm" href="${safeUrl(`/terminal?repo=${encodeURIComponent(name)}`)}">Terminal</a>`;
}

/** The "session.resume" slot: an ended agent session, picked up again here or in Warp / Windows Terminal, with its own CLI, in its checkout. */
export function resumeButton(s: Session, external: ExternalApp = process.platform === "win32" ? "wt" : "warp"): Html | "" {
  if (!s.repo) return "";
  const program = s.harness === "omp" ? (s.profile ? `omp:${s.profile}` : "omp") : s.harness === "copilot" || s.harness === "agy" || s.harness === "codex" ? s.harness : "claude";
  const extLabel = external === "wt" ? "Open in Windows Terminal" : "Open in Warp";
  return html`<form method="post" action="/terminal" class="resume-here"><input type="hidden" name="program" value="${program}"><input type="hidden" name="repo" value="${s.repo}"><input type="hidden" name="resume" value="${s.sessionId}"><button type="submit" class="sm" data-busy="Starting">Resume in a terminal here</button><button type="submit" formaction="/terminal/external" name="app" value="${external}" class="sm ghost" data-busy="Opening">${extLabel}</button></form>`;
}

export function terminalsPage(o: { terms: Term[]; programs: Program[]; repos: string[]; repo?: string; program?: string; problem?: string }): PageOpts {
  const form = o.programs.length
    ? html`<form method="post" action="/terminal" class="term-new"><div class="fields"><label class="field"><span class="label">Program</span><select name="program">${o.programs.map(
        (p) => html`<option value="${p.id}"${p.id === o.program ? html` selected` : ""}>${p.label}</option>`,
      )}</select></label><label class="field"><span class="label">In</span><select name="repo">${o.repos.map((r) => html`<option value="${r}"${r === o.repo ? html` selected` : ""}>${r}</option>`)}</select></label><div class="field"><button type="submit" class="primary" data-busy="Starting">Open terminal</button></div></div><p class="hint">Shells and agent CLIs found on this machine, in a checkout in your code folder. omp asks before it acts (always-ask). What a terminal shows stays in memory: never written down, never shown anywhere else.</p></form>`
    : Notice({ tone: "warn", children: "No shell or agent CLI found to run." });
  const body = html`${PageHeader({ title: "Terminals", sub: "Shells and agent CLIs in a checkout." })}
${o.problem ? Notice({ tone: "bad", children: o.problem }) : ""}
${Panel({ title: "Open", flush: true, children: terminalList(o.terms) })}
${Panel({ title: "New terminal", children: form })}`;
  return { title: "Terminals · Dovre", current: "/terminal", body };
}

export function terminalPage(t: Term): PageOpts {
  const body = html`${PageHeader({
    title: html`${t.label} <span class="t2">in ${t.repo}</span>`,
    crumbs: [{ href: "/terminal", label: "Terminals" }],
    sub: html`<span id="term-state">${t.endedAt ? `Ended${t.code !== undefined ? `, exit code ${t.code}` : ""}` : "Running"}</span> · started ${Ago(t.startedAt)} · <code>${t.cwd}</code>`,
    actions: t.endedAt
      ? html`<a class="btn" href="${safeUrl(`/terminal?repo=${encodeURIComponent(t.repo)}&program=${encodeURIComponent(t.program)}`)}">Open another</a>`
      : Confirm({ action: `/terminal/${t.id}/close`, label: "Close", question: html`Close this terminal? ${t.label} and everything it started end now.`, danger: true }),
  })}
<div class="term-wrap"><div id="term" class="term" data-id="${t.id}" aria-label="Terminal"></div></div>
<p class="hint t3">Ctrl+C copies when text is selected, else interrupts; Ctrl+V pastes. ${Pill({ children: "in memory only" })}</p>`;
  return {
    title: `${t.label} · ${t.repo} · Dovre`,
    current: "/terminal",
    body,
    head: html`<link rel="stylesheet" href="${XTERM.css}"><script src="${XTERM.js}" defer></script><script src="${XTERM.fit}" defer></script><script src="${TERMINAL_JS_PATH}" defer></script>`,
  };
}
