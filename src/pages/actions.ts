/**
 * What Dovre did for me (the `actions` table, src/actions/deploys.ts): deploys decided, Teams
 * messages sent, issues and tasks created, production asked for, questions answered. A card on
 * Today and /actions. The log holds what and where, never what was said or what came back; a Teams
 * chat shows by its name, looked up here.
 */
import { html } from "hono/html";
import type { Logged } from "../actions/deploys.ts";
import { type Frame, shell } from "../html.ts";
import { Empty, type Html, Item, List, PageHeader, Panel, Pill } from "../ui/kit.ts";
import { Ago } from "./parts.ts";

const WHAT: Record<string, string> = {
  "deploy.approved": "Approved a deploy",
  "deploy.rejected": "Rejected a deploy",
  "deploy.reject-superseded": "Rejected superseded deploys",
  "issue.create": "Created an issue",
  "task.create": "Created a dev task",
  "pr.retarget": "Retargeted a pull request",
  "pr.review": "Posted an agent's review",
  "pr.replies": "Posted replies on a pull request",
  "relay.answer": "Answered a question",
};
export const whatOf = (kind: string) => WHAT[kind] ?? kind;

/** What a pack calls an entry it logged ("actions.where"); undefined: as logged. */
export type Named = (a: Pick<Logged, "kind" | "target">) => string | undefined;

/** Where it happened, in words: what a pack calls it, or as logged. */
export function whereOf(a: Pick<Logged, "kind" | "target">, named?: Named): string {
  return named?.(a) ?? a.target;
}

const st = (tone: "ok" | "bad", text: string) => html`<span class="st ${tone}"><i></i>${text}</span>`;

/** Today's card: the newest few. */
export function actionsCard(log: Logged[], named?: Named): Html {
  const shown = log.slice(0, 6);
  return html`<section class="card" id="actions-card" aria-labelledby="actions-h">
<div class="card-h"><h2 id="actions-h">Actions</h2><p>${log.length ? "what Dovre did for you" : ""}</p></div>
${
  shown.length
    ? html`<ul class="wts">${shown.map((a) => html`<li><span class="wt-n">${st(a.ok ? "ok" : "bad", whatOf(a.kind))}</span><span class="wt-b">${a.ok ? whereOf(a, named) : `${whereOf(a, named)}: ${a.error ?? "failed"}`}</span><span class="wt-t">${Ago(a.at)}</span></li>`)}</ul>`
    : html`<p class="notes">Nothing yet. Deploys you decide, messages you send and issues you create from here show up here.</p>`
}
<div class="card-f"><span></span><a href="/actions">All actions</a></div>
</section>`;
}

/** /actions: the whole log, newest first. */
export function actionsPage(frame: Frame, log: Logged[], named?: Named): Html {
  const body = html`${PageHeader({ title: "Actions", sub: "What Dovre did for you, newest first: what and where, never what was said or what came back." })}
${Panel({
  title: "Done from here",
  meta: String(log.length),
  flush: true,
  children: log.length
    ? List(log.map((a) => Item({ lead: Pill({ tone: a.ok ? "ok" : "bad", children: a.ok ? "done" : "failed" }), title: whatOf(a.kind), line: [whereOf(a, named), a.ok ? "" : (a.error ?? "")].filter(Boolean).join(" · "), trail: Ago(a.at) })))
    : Empty({ title: "Nothing yet" }),
})}`;
  return shell({ title: "Actions · Dovre", frame, current: "/actions", body });
}
