/** A dev task: pick the issue it belongs under, then the code repo, title, body and type; preview; create and hang it under that issue. */
import { html } from "hono/html";
import type { IssueType } from "../issues/templates.ts";
import { type Checkout, inRepos, type Parent, type TaskCreated, refText } from "../issues/tasks.ts";
import { type Child, type Html, Item, KeyValues, List, Notice, PageHeader, Panel, Pill } from "../ui/kit.ts";
import { markdown } from "../ui/markdown.ts";
import { Link, MyListBox, failed, safeUrl } from "./parts.ts";
import { type Ctx, type Res, agentPanel, crumbs, hidden, page, rows, short, star, taskHref, wrap } from "./work.ts";

export type TaskDraft = { repo: string; title: string; body: string; type: string; assign: boolean };
export type TaskErrors = { repo?: string; title?: string; type?: string; body?: string };
export const MAX_TASK_TITLE = 256;
export const MAX_TASK_BODY = 65536;

const parentLine = (ctx: Ctx, p: Parent) => html`${Link(p.url, `${short(ctx.org, p.repo)}#${p.number}`)} ${p.title}`;

/** Step 1: which issue it belongs under. Mine first; or a reference. */
export function taskPickPage(ctx: Ctx, o: { parents: Res<Parent[]>; problem?: string; typed?: string }): Html {
  const list = o.parents.ok ? o.parents.value : [];
  const items = list.map((p) =>
    Item({
      href: taskHref(refText(p)),
      title: p.title,
      line: html`${short(ctx.org, p.repo)}#${p.number}${p.mine ? " · yours" : ""}`,
    }),
  );
  const where = [...ctx.sortingRepos, ...ctx.formRepos].map((r) => short(ctx.org, r)).join(", ");
  const byRef = html`<form method="get" action="/issues/new"><input type="hidden" name="kind" value="task"><div class="field"><label class="label" for="parent">Or name it</label><input type="text" id="parent" name="parent" value="${o.typed ?? ""}" placeholder="repo#6 or org/repo#512" required><span class="hint">Any open issue in the org works as a parent.</span></div><div class="buttons"><button type="submit">Use it</button></div></form>`;
  return page(
    ctx,
    "Dev task",
    html`${PageHeader({ title: "Dev task", sub: "A piece of a planned issue, filed in the code repo where the work happens, under the planned one. Which issue is it for?", crumbs: crumbs("Dev task") })}
${o.problem ? Notice({ tone: "bad", children: o.problem }) : ""}
${failed("Open issues", o.parents)}
${Panel({ title: "Open issues", meta: where ? html`in ${where}` : undefined, flush: true, children: items.length ? List(items) : html`<p class="t3">${o.parents.ok ? "No open issues there." : ""}</p>` })}
${Panel({ children: byRef })}
${agentPanel({ kind: "task" })}`,
  );
}

function repoField(ctx: Ctx, d: TaskDraft, dirs: Checkout[], err?: string): Html {
  const repos = [...new Set(dirs.map((c) => c.repo))].filter((r) => !inRepos(ctx.sortingRepos, r)).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  const listed = repos.includes(d.repo);
  return wrap(
    err,
    html`<label class="label" for="repo">Code repo${star(true)}</label><select id="repo" name="repo"${err ? html` aria-invalid="true"` : ""}><option value="">Pick the repo…</option>${repos.map((r) => html`<option value="${r}"${r === d.repo ? html` selected` : ""}>${short(ctx.org, r)}</option>`)}</select><input type="text" name="repo_other" value="${listed ? "" : d.repo}" placeholder="…or another: ${ctx.org}/name" aria-label="Another repo"><span class="hint">Your checkouts of ${ctx.org}'s repos; type one that isn't checked out here.</span>`,
  );
}

function typeField(d: TaskDraft, types: Res<IssueType[]>, err?: string): Html {
  const list = types.ok ? types.value : [];
  return wrap(
    err,
    html`<label class="label" for="type">Issue Type${star(true)}</label><select id="type" name="type" required><option value="">Pick a type…</option>${list.map((t) => html`<option value="${t.name}"${t.name === d.type ? html` selected` : ""}>${t.name}${t.description ? ` · ${t.description}` : ""}</option>`)}</select>`,
  );
}

/** Step 2: the task itself, under the chosen issue. `closed`: the repo picked takes no hand-made issues. */
export function taskFormPage(ctx: Ctx, o: { parent: Parent; draft: TaskDraft; dirs: Checkout[]; types: Res<IssueType[]>; errors?: TaskErrors; closed?: Html }): Html {
  const d = o.draft;
  const e = o.errors ?? {};
  const n = Object.values(e).filter(Boolean).length;
  const form = html`<form method="post" action="/issues/task/preview">${hidden([["parent", refText(o.parent)]])}
${repoField(ctx, d, o.dirs, e.repo)}
${wrap(e.title, html`<label class="label" for="title">Title${star(true)}</label><input type="text" id="title" name="title" value="${d.title}" maxlength="${MAX_TASK_TITLE}" required${e.title ? html` aria-invalid="true"` : ""}>`)}
${typeField(d, o.types, e.type)}
${wrap(e.body, html`<label class="label" for="body">Description</label><span class="hint">Markdown. What has to change, and what the next person needs to know.</span><textarea id="body" name="body" rows="${rows(d.body, 8)}">\n${d.body}</textarea>`)}
<div class="field"><label class="check"><input type="checkbox" name="assign" value="on"${d.assign ? html` checked` : ""}> Assign it to me (${ctx.frame.operator})</label></div>
<div class="buttons"><button type="submit" class="primary">Preview</button><a class="btn ghost" href="${taskHref()}">Another issue</a></div>
</form>`;
  return page(
    ctx,
    "Dev task",
    html`${PageHeader({ title: "Dev task", sub: html`Under ${parentLine(ctx, o.parent)}`, crumbs: crumbs("Dev task") })}
${n ? Notice({ tone: "bad", children: `${n} ${n === 1 ? "thing needs" : "things need"} fixing before the preview.` }) : ""}
${o.closed ?? ""}
${failed("Issue Types", o.types)}
${Panel({ title: "The task", children: form })}
${agentPanel({ kind: "task", parent: refText(o.parent), ...(d.repo ? { repo: d.repo } : {}) })}`,
  );
}

export function taskPairs(parent: Parent, d: TaskDraft): [string, string][] {
  return [["parent", refText(parent)], ["repo", d.repo], ["title", d.title], ["type", d.type], ["body", d.body], ...(d.assign ? ([["assign", "on"]] as [string, string][]) : [])];
}

export function taskPreviewPage(ctx: Ctx, o: { parent: Parent; draft: TaskDraft; types: Res<IssueType[]>; nonce: string; problem?: string }): Html {
  const d = o.draft;
  const type = o.types.ok ? o.types.value.find((t) => t.name === d.type) : undefined;
  const kv = KeyValues([
    ["Repo", d.repo],
    ["Under", parentLine(ctx, o.parent)],
    ["Type", html`${Pill({ children: d.type })}${type?.description ? html` <span class="t2">${type.description}</span>` : ""}`],
    ["Title", html`<strong>${d.title.trim()}</strong>`],
    ["Assignee", d.assign ? ctx.frame.operator : html`<span class="t3">nobody</span>`],
  ]);
  const actions = html`<form method="post" action="/issues/task/create">${hidden([...taskPairs(o.parent, d), ["nonce", o.nonce]])}${MyListBox}<div class="buttons"><button type="submit" formaction="/issues/task/preview" name="edit" value="1">Edit</button><button type="submit" class="primary">Create task</button></div></form>`;
  return page(
    ctx,
    "Preview",
    html`${PageHeader({ title: "Preview", sub: html`Nothing is created until <strong>Create task</strong>.`, crumbs: crumbs("Dev task") })}
${o.problem ? Notice({ tone: "bad", children: o.problem }) : ""}
${Panel({ title: "What will be created", children: html`${kv}${d.body.trim() ? markdown(d.body) : html`<p class="t3">No description.</p>`}`, foot: actions })}`,
  );
}

/** After: the link, the line for the PR, and an agent to start on it. */
export function taskDonePage(ctx: Ctx, o: { repo: string; number: number; url: string; result?: Extract<TaskCreated, { ok: true }>; dir?: string }): Html {
  const ref = `${o.repo}#${o.number}`;
  const closes = `Closes ${ref}`;
  const parent = o.result ? refText(o.result.parent) : undefined;
  const prompt = `Work on ${ref}${o.result ? ` (${o.result.title})` : ""}. Read the issue${parent ? ` and the one it hangs under, ${parent}` : ""} first. Close it from the PR with "${closes}".`;
  const agent = o.dir ? html`<a class="btn" href="${safeUrl(`/agents/new?repo=${encodeURIComponent(o.dir)}&prompt=${encodeURIComponent(prompt)}`)}">Start an agent on it</a>` : "";
  const more: Child = parent ? html`<a class="btn ghost" href="${taskHref(parent)}">Another task under ${parent}</a>` : "";
  return page(
    ctx,
    "Task created",
    html`${PageHeader({ title: "Task created", sub: o.result?.title, crumbs: crumbs("Dev task") })}
${Notice({ tone: "ok", children: html`Created ${Link(o.url, ref)}${o.result?.linked && parent ? html`, under ${parent}` : ""}.` })}
${(o.result?.warnings ?? []).map((w) => Notice({ tone: "warn", children: w }))}
${Panel({ title: "In the PR that does it", children: html`<p><code data-copy="${closes}">${closes}</code></p><p class="hint t3">Closing it counts toward the issue it hangs under.</p>` })}
<div class="buttons">${Link(o.url, "Open it on GHE", "btn primary")}${agent}${more}</div>`,
  );
}
