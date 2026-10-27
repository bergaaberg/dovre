/**
 * New work: the kinds of issue, and what the issue pages share. A dev task is a piece of a planned
 * issue (a sub-issue in the code repo where it's done), and some repos take issues through their
 * own forms. Which repos play which part is config (src/env.ts). Tickets in a tracker come from a
 * pack, not from here.
 */
import { html } from "hono/html";
import { type AgentAsk, type Setup, kindsOf } from "../issues/compose.ts";
import { WORK, WORK_LABEL } from "../agents/workdir.ts";
import { type Checkout, inRepos } from "../issues/tasks.ts";
import { type Frame, shell } from "../html.ts";
import { type Child, type Html, Item, KeyValues, List, Notice, PageHeader, Panel, Pill } from "../ui/kit.ts";
import { found } from "../tools.ts";
import { HARNESS_NAME, Link, safeUrl } from "./parts.ts";

export const CURRENT = "/issues/new";
export const MAX_NOTE = 4000;

export type Ctx = Setup & { frame: Frame; org: string; ghe: string; /** What packs put on New work, above "What is it?" (the "work.new" slot: topo's Projects). */ extra?: Child[] };
export type Res<T> = { ok: true; value: T } | { ok: false; error: string };
export const settle = <T>(p: Promise<T>): Promise<Res<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }),
  );
export const first = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? (v.find((x) => typeof x === "string") ?? "") : "");

export const short = (org: string, repo: string) => repo.replace(`${org}/`, "");
export const hidden = (pairs: [string, string][]) => pairs.map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`);
export const wrap = (err: string | undefined, inner: Child) => (err ? html`<div class="field invalid">${inner}<span class="error">${err}</span></div>` : html`<div class="field">${inner}</div>`);
export const star = (on: boolean) => (on ? html` <abbr title="required">*</abbr>` : "");
export const rows = (text: string, min = 5) => Math.min(20, Math.max(min, text.split("\n").length + 1));

const q = (pairs: [string, string | undefined][]) => pairs.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
export const newHref = (repo: string, template?: string) => safeUrl(`${CURRENT}?${q([["repo", repo], ["template", template]])}`);
export const taskHref = (parent?: string, repo?: string) => safeUrl(`${CURRENT}?${q([["kind", "task"], ["parent", parent], ["repo", repo]])}`);

export function page(ctx: Ctx, title: string, body: Child): Html {
  return shell({ title: `${title} · Dovre`, frame: ctx.frame, current: CURRENT, body: html`${body}` });
}

export const crumbs = (label: string) => [{ href: CURRENT, label: "New work" }, { label }];

/** "Describe it roughly": the note goes to a page that shows the agent's prompt before anything starts. */
export function agentPanel(ask: AgentAsk, o: { title?: string; hint?: Child } = {}): Html | "" {
  // No agent CLI on this machine: nothing to hand the note to.
  if (found.harnesses && !found.harnesses.length) return "";
  const pairs: [string, string][] = [["kind", ask.kind]];
  if (ask.kind === "forms") pairs.push(["repo", ask.repo], ...(ask.template ? ([["template", ask.template]] as [string, string][]) : []));
  if (ask.kind === "task") pairs.push(...(ask.parent ? ([["parent", ask.parent]] as [string, string][]) : []), ...(ask.repo ? ([["repo", ask.repo]] as [string, string][]) : []));
  return Panel({
    title: o.title ?? "Or let an agent draft it",
    children: html`<form method="post" action="/issues/draft">${hidden(pairs)}<div class="field"><label class="label" for="note">Describe it roughly</label><textarea id="note" name="note" rows="4" maxlength="${MAX_NOTE}" required></textarea><span class="hint">${o.hint ?? "An agent drafts it, asks what's missing, and files it only after your go. You see the prompt before it starts."}</span></div><div class="buttons"><button type="submit">Draft with an agent…</button></div></form>`,
  });
}

/** The entry: which kind of work this is. */
export function entryPage(ctx: Ctx): Html {
  const sorting = ctx.sortingRepos.map((r) => short(ctx.org, r)).join(", ");
  const task = Item({ href: taskHref(), title: html`<strong>Dev task</strong> under an issue`, line: "A piece of a planned issue, in the code repo where the work happens.", more: html`A sub-issue of the planned one${sorting ? ` (in ${sorting})` : ""}; the PR closes it.` });
  const forms = ctx.formRepos.map((r) => Item({ href: newHref(r), title: html`<strong>Issue</strong> in ${short(ctx.org, r)}`, line: html`Through ${short(ctx.org, r)}'s own issue forms.` }));
  return page(
    ctx,
    "New work",
    html`${PageHeader({ title: "New work", sub: "Pick the kind. Forms, types and fields come live from GitHub." })}
${ctx.extra ?? ""}
${Panel({ title: "What is it?", flush: true, children: List([task, ...forms]) })}
${agentPanel({ kind: "any" }, { title: "Not sure which? Describe it", hint: html`An agent picks the kind, drafts it, and files it only after your go:<br>${kindsOf(ctx).split("\n").map((l) => html`${l}<br>`)}` })}`,
  );
}

/** Which agent drafts it, from those this machine has; none chosen means the first. */
function harnessField(): Html | "" {
  const hs = found.harnesses ?? [];
  if (hs.length < 2) return "";
  return html`<div class="field"><label class="label" for="harness">Agent</label><select id="harness" name="harness">${hs.map((h) => html`<option value="${h}">${HARNESS_NAME[h]}</option>`)}</select><span class="hint">Skills and MCP servers are the agent's own: the issue skill for GitHub issues, say.</span></div>`;
}

/** The agent's prompt, shown before it starts (the second click), and where it runs. */
export function draftPage(ctx: Ctx, o: { prompt: string; dirs: Checkout[]; dir?: string; back: string }): Html {
  const options = [
    html`<option value="${WORK}"${o.dir === WORK || !o.dir ? html` selected` : ""}>${WORK_LABEL}</option>`,
    ...o.dirs.map((c) => html`<option value="${c.dir}"${c.dir === o.dir ? html` selected` : ""}>${c.dir}${c.dir.toLowerCase() !== short(ctx.org, c.repo).toLowerCase() ? ` (${short(ctx.org, c.repo)})` : ""}</option>`),
  ];
  return page(
    ctx,
    "Draft with an agent",
    html`${PageHeader({ title: "Draft with an agent", crumbs: crumbs("Agent") })}
${Panel({
  title: "Start an agent",
  children: html`${KeyValues([["Prompt", html`<pre class="code">${o.prompt}</pre>`]])}<form method="post" action="/agents/new">${hidden([["mode", "default"], ["prompt", o.prompt]])}${harnessField()}<div class="field"><label class="label" for="dir">Runs in</label><select id="dir" name="repo" required>${options}</select><span class="hint">Dovre's own folder keeps it out of your repos; you can clear it away from Agents when it's done. Skills and MCP servers are the agent's own, so they work anywhere; a repo's checkout adds that repo's conventions.</span></div><div class="buttons"><button type="submit" class="primary">Start agent</button><a class="btn ghost" href="${safeUrl(o.back)}">Back</a></div></form>`,
})}`,
  );
}

export function problemPage(ctx: Ctx, message: Child, back = CURRENT): Html {
  return page(ctx, "New work", html`${PageHeader({ title: "New work" })}${Notice({ tone: "bad", children: message })}<div class="buttons"><a class="btn" href="${safeUrl(back)}">Start over</a></div>`);
}

/**
 * A repo that takes no hand-made issues: its chooser's own ways in, as links (a new tab, checked by
 * safeUrl); a planning repo also gets "a dev task under one of its issues".
 */
export function waysIn(ctx: Ctx, repo: string, links: { name: string; url: string; about: string }[]): Html {
  const items = links.map((l) => Item({ href: safeUrl(l.url), title: html`<strong>${l.name}</strong>`, line: l.about || undefined }));
  if (inRepos(ctx.sortingRepos, repo)) items.push(Item({ href: taskHref(), title: html`<strong>A dev task under one of its issues</strong>`, line: "In the code repo where the work happens, as a sub-issue of the planned one." }));
  return Panel({ title: html`${short(ctx.org, repo)} takes issues another way`, flush: true, children: List(items) });
}
