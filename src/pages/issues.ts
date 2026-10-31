/**
 * New work (WP-A5): a dev task under a planned issue, or an issue through a repo's own
 * forms (src/pages/work.ts says which is which). This file has the forms flow and every route:
 * pick a repo and one of its issue forms, fill it, preview the body exactly as GitHub would
 * write it, create. Templates, Issue Types and labels are read live (src/issues/templates.ts);
 * template text comes from a repo, so it renders as text, never as markup. Every create goes
 * through a preview (the confirm step) with a nonce, re-checks what it writes to, and is logged.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { html } from "hono/html";
import { logAction, repoIn } from "../actions/deploys.ts";
import { type AppEnv, type Env, reposOf } from "../env.ts";
import { ownersIn } from "../owners.ts";
import type { Frame } from "../html.ts";
import {
  type AgentAsk,
  agentPrompt,
  BLANK,
  composeBody,
  type Draft,
  emptyDraft,
  type Errors,
  formPairs,
  isValid,
  labelsOf,
  MAX_TITLE,
  NOTHING_OFFERED,
  type Offered,
  offeredLabels,
  picksType,
  PROSE_RULES,
  readDraft,
  type Setup,
  untouched,
  validate,
  type Value,
} from "../issues/compose.ts";
import { WORK } from "../agents/workdir.ts";
import { type Created, createIssue, msg } from "../issues/create.ts";
import { type Checkout, checkoutOf, checkouts, createTask, inRepos, loadIssue, loadParents, type Parent, parseRef, refText, type TaskCreated } from "../issues/tasks.ts";
import { createCatalog, type Field, type IssueType, type Kept, memoize, type Template, type Templates, takesIssues } from "../issues/templates.ts";
import type { Ghe } from "../sources/ghe.ts";
import { type Child, Grid2, type Html, Item, KeyValues, List, Notice, PageHeader, Panel, Pill, Tabs } from "../ui/kit.ts";
import { markdown } from "../ui/markdown.ts";
import { failed, forgeName, Link, MyListBox } from "./parts.ts";
import { addTodo } from "../todo/store.ts";
import { MAX_TASK_BODY, MAX_TASK_TITLE, type TaskDraft, type TaskErrors, taskDonePage, taskFormPage, taskPickPage, taskPreviewPage } from "./tasks.ts";
import {
  agentPanel,
  CURRENT,
  type Ctx,
  crumbs,
  draftPage,
  entryPage,
  first,
  hidden,
  MAX_NOTE,
  newHref,
  page,
  problemPage,
  type Res,
  rows,
  settle,
  short,
  star,
  taskHref,
  waysIn,
  wrap,
} from "./work.ts";

// ── Pieces ────────────────────────────────────────────────────────────────────

/** A template's Issue Type, with the org's live description; a type the org doesn't have is flagged. */
function typeOf(t: Template, types: Map<string, IssueType> | null): { pill: Child; line: Child } {
  if (!t.type) return { pill: Pill({ children: "pick a type" }), line: "No type in the form: you pick one." };
  const it = types?.get(t.type);
  if (types && !it) return { pill: Pill({ tone: "warn", children: t.type, title: "Not an enabled Issue Type in the org" }), line: html`«${t.type}» isn't an enabled Issue Type in the org: filing would fail.` };
  return { pill: Pill({ children: t.type }), line: it ? html`<strong>${it.name}</strong>: ${it.description}` : t.type };
}

function templateItem(repo: string, t: Template, types: Map<string, IssueType> | null): Html {
  const ty = typeOf(t, types);
  return Item({ href: newHref(repo, t.file), title: html`<strong>${t.name}</strong>`, line: t.description || undefined, more: ty.line, trail: ty.pill });
}

/** One template field as a form control. Its label, help and options come from the repo: text only. */
function fieldHtml(f: Field, i: number, v: Value, err?: string): Html {
  const id = `f${i}`;
  if (f.kind === "markdown") return html`<div class="field"><div class="hint">${markdown(f.value ?? "", { headingOffset: 1 })}</div></div>`;
  const hint = f.description ? html`<span class="hint">${f.description}</span>` : "";
  const invalid = err ? html` aria-invalid="true"` : "";
  if (f.kind === "checkboxes") {
    const boxes = f.options.map(
      (o, j) => html`<label class="check"><input type="checkbox" name="${`${id}.${j}`}" value="on"${v.ticked[j] ? html` checked` : ""}${f.mustTick[j] ? html` required` : ""}> ${o}${star(!!f.mustTick[j])}</label>`,
    );
    return wrap(err, html`<fieldset><legend>${f.label}</legend>${hint}${boxes}</fieldset>`);
  }
  const label = html`<label class="label" for="${id}">${f.label}${star(f.required)}</label>`;
  const req = f.required ? html` required` : "";
  if (f.kind === "dropdown") {
    const none = f.multiple ? "" : html`<option value="">${f.required ? "Pick one…" : "None"}</option>`;
    const opts = f.options.map((o, j) => html`<option value="${j}"${v.picked.includes(j) ? html` selected` : ""}>${o}</option>`);
    return wrap(err, html`${label}${hint}<select id="${id}" name="${id}"${f.multiple ? html` multiple` : ""}${req}${invalid}>${none}${opts}</select>`);
  }
  const ph = f.placeholder ? html` placeholder="${f.placeholder}"` : "";
  if (f.kind === "input") return wrap(err, html`${label}${hint}<input type="text" id="${id}" name="${id}" value="${v.text}"${ph}${req}${invalid}>`);
  // The newline after <textarea> is eaten by the parser, so a value's own leading newline survives.
  return wrap(err, html`${label}${hint}<textarea id="${id}" name="${id}" rows="${rows(v.text || f.placeholder || "")}"${ph}${req}${invalid}>\n${v.text}</textarea>`);
}

/** A single choice from labels the repo has: None, or one of them. */
function labelSelect(name: string, label: string, options: string[], picked: string | undefined, hint: string): Html {
  return html`<div class="field"><label class="label" for="${name}">${label}</label><select id="${name}" name="${name}"><option value="">None</option>${options.map((p) => html`<option value="${p}"${p === picked ? html` selected` : ""}>${p}</option>`)}</select><span class="hint">${hint}</span></div>`;
}

function labelsField(d: Draft, offered: Offered): Html {
  const fixed = d.template?.labels ?? [];
  return html`<div class="field"><span class="label">Labels</span>${fixed.length ? html`<span>${fixed.map((l) => html`${Pill({ children: l })} `)}</span><span class="hint">The template applies these.</span>` : html`<span class="hint">The template applies none.</span>`}${
    d.template?.projects.length ? html`<span class="hint">Added to project ${d.template.projects.join(", ")}, as the form would.</span>` : ""
  }</div>${offered.tracks.length ? labelSelect("track", "Track", offered.tracks, d.extra.find((l) => offered.tracks.includes(l)), "team: for a team's work, category: for work across teams. One at most.") : ""}${
    offered.priority.length ? labelSelect("priority", "Priority", offered.priority, d.extra.find((l) => offered.priority.includes(l)), "This repo's priority labels.") : ""
  }`;
}

function typeField(d: Draft, types: Res<IssueType[]>, err?: string): Html {
  const list = types.ok ? types.value : [];
  return wrap(
    err,
    html`<label class="label" for="type">Issue Type${star(true)}</label><select id="type" name="type" required><option value="">Pick a type…</option>${list.map(
      (t) => html`<option value="${t.name}"${t.name === d.type ? html` selected` : ""}>${t.name}${t.description ? ` · ${t.description}` : ""}</option>`,
    )}</select><span class="hint">The org's Issue Types, live. Intake workflows close an issue without one.</span>`,
  );
}

// ── The forms flow ────────────────────────────────────────────────────────────

function repoTabs(ctx: Ctx, repo: string): Html {
  const list = ctx.formRepos.includes(repo) ? ctx.formRepos : [...ctx.formRepos, repo];
  return Tabs({ label: "Repo", items: list.map((r) => ({ href: newHref(r), label: short(ctx.org, r), current: r === repo })) });
}

/** Step 1: which repo, which form. A repo that takes no hand-made issues shows its own ways in. */
export function pickPage(ctx: Ctx, o: { repo: string; templates: Res<Templates>; types: Res<IssueType[]>; notice?: string }): Html {
  const types = o.types.ok ? new Map(o.types.value.map((t) => [t.name, t])) : null;
  const ts = o.templates.ok ? o.templates.value.templates : [];
  const everyday = ts.filter((t) => !t.planning).map((t) => templateItem(o.repo, t, types));
  const planning = ts.filter((t) => t.planning).map((t) => templateItem(o.repo, t, types));
  const blankOk = !o.templates.ok || o.templates.value.config.blank;
  const blank = blankOk ? [Item({ href: newHref(o.repo, BLANK), title: html`<strong>Blank issue (pick a type)</strong>`, line: "No form: a title, one of the org's Issue Types, and a free body.", trail: Pill({ children: "any type" }) })] : [];
  const broken = o.templates.ok ? o.templates.value.broken : [];
  const closed = o.templates.ok && !takesIssues(o.templates.value);
  return page(
    ctx,
    "Issue",
    html`${PageHeader({ title: "Issue", sub: html`In <strong>${o.repo}</strong>, through its own forms. Forms, types and labels come live from ${forgeName(ctx.frame.host)}.`, crumbs: crumbs("Issue"), tabs: repoTabs(ctx, o.repo) })}
${o.notice ? Notice({ tone: "bad", children: o.notice }) : ""}
${failed("Templates", o.templates)}${failed("Issue Types", o.types)}
${broken.length ? Notice({ tone: "warn", children: html`<strong>Some templates didn't parse.</strong> ${broken.map((b) => html`${b.file}: ${b.error}. `)}` }) : ""}
${
  closed && o.templates.ok
    ? waysIn(ctx, o.repo, o.templates.value.config.links)
    : html`${Panel({ title: "Everyday", meta: o.templates.ok && !ts.length ? "this repo has no issue forms" : String(everyday.length), flush: true, children: List([...everyday, ...blank]) })}
${planning.length ? Panel({ title: "Planning", meta: String(planning.length), flush: true, children: List(planning) }) : ""}
${agentPanel({ kind: "forms", repo: o.repo })}`
}`,
  );
}

/** Step 2: the form itself, with what failed validation marked. */
export function formPage(ctx: Ctx, o: { draft: Draft; types: Res<IssueType[]>; offered: Offered; labels: Res<string[]>; errors?: Errors }): Html {
  const d = o.draft;
  const e = o.errors ?? { fields: [] };
  const t = d.template;
  const types = o.types.ok ? new Map(o.types.value.map((x) => [x.name, x])) : null;
  const n = e.fields.filter(Boolean).length + (e.title ? 1 : 0) + (e.type ? 1 : 0) + (e.body ? 1 : 0);
  const form = html`<form method="post" action="/issues/preview">${hidden([["repo", d.repo], ["template", t?.file ?? BLANK]])}
${wrap(e.title, html`<label class="label" for="title">Title${star(true)}</label><input type="text" id="title" name="title" value="${d.title}" maxlength="${MAX_TITLE}" required${e.title ? html` aria-invalid="true"` : ""}>${t?.title ? html`<span class="hint">Starts with the template's «${t.title.trim()}».</span>` : ""}`)}
${picksType(t) ? typeField(d, o.types, e.type) : ""}
${t ? t.fields.map((f, i) => fieldHtml(f, i, d.values[i]!, e.fields[i])) : wrap(e.body, html`<label class="label" for="body">Body</label><span class="hint">Markdown. For a bug: what's wrong, steps to reproduce, expected against actual, impact.</span><textarea id="body" name="body" rows="${rows(d.body, 12)}">\n${d.body}</textarea>`)}
${t && e.body ? Notice({ tone: "bad", children: e.body }) : ""}
${labelsField(d, o.offered)}
<div class="buttons"><button type="submit" class="primary">Preview</button><a class="btn ghost" href="${newHref(d.repo)}">Another form</a></div>
</form>`;
  return page(
    ctx,
    t ? t.name : "Blank issue",
    html`${PageHeader({
      title: t ? t.name : "Blank issue",
      sub: html`In <strong>${d.repo}</strong>.${t ? html` ${typeOf(t, types).line}` : ""}`,
      crumbs: [{ href: CURRENT, label: "New work" }, { href: newHref(d.repo), label: short(ctx.org, d.repo) }],
    })}
${n ? Notice({ tone: "bad", children: `${n} ${n === 1 ? "thing needs" : "things need"} fixing before the preview.` }) : ""}
${failed("Issue Types", o.types)}${failed("Labels", o.labels)}
${t?.description ? html`<p class="t2">${t.description}</p>` : ""}
${Panel({ title: "The issue", children: form })}
${agentPanel({ kind: "forms", repo: d.repo, ...(t ? { template: t.file } : {}) })}`,
  );
}

/** Step 3: what will be created, and the button that creates it (the confirm step). */
export function previewPage(ctx: Ctx, o: { draft: Draft; types: Res<IssueType[]>; nonce: string; problem?: string }): Html {
  const d = o.draft;
  const body = composeBody(d);
  const labels = labelsOf(d);
  const type = o.types.ok ? o.types.value.find((t) => t.name === d.type) : undefined;
  const left = untouched(d);
  const summary = KeyValues([
    ["Repo", d.repo],
    ["Type", html`${Pill({ children: d.type })}${type?.description ? html` <span class="t2">${type.description}</span>` : ""}`],
    ["Title", html`<strong>${d.title.trim()}</strong>`],
    ["Labels", labels.length ? labels.map((l) => html`${Pill({ children: l })} `) : html`<span class="t3">none</span>`],
    ...(d.template?.projects.length ? ([["Project", d.template.projects.join(", ")]] as [Child, Child][]) : []),
    ["Form", d.template?.name ?? "none (blank issue)"],
  ]);
  const actions = html`<form method="post" action="/issues/create">${hidden([...formPairs(d), ["nonce", o.nonce]])}${MyListBox}<div class="buttons"><button type="submit" formaction="/issues/preview" name="edit" value="1">Edit</button><button type="submit" class="primary">Create issue</button></div></form>`;
  return page(
    ctx,
    "Preview",
    html`${PageHeader({ title: "Preview", sub: html`Nothing is created until <strong>Create issue</strong>.`, crumbs: [{ href: CURRENT, label: "New work" }, { href: newHref(d.repo), label: short(ctx.org, d.repo) }] })}
${o.problem ? Notice({ tone: "bad", children: o.problem }) : ""}
${failed("Issue Types", o.types)}
${left.length ? Notice({ tone: "warn", children: html`Still the template's starting text: ${left.join(", ")}.` }) : ""}
${Grid2([
  Panel({ title: "What will be created", children: html`${summary}${body ? markdown(body) : html`<p class="t3">No body.</p>`}`, foot: actions }),
  Panel({ title: "Norwegian prose, by eye", meta: "prose rules", children: html`<ul>${PROSE_RULES.map((r) => html`<li>${r}</li>`)}</ul>` }),
])}`,
  );
}

/** After: the link, what didn't stick, and the way to the next one. */
export function donePage(ctx: Ctx, o: { repo: string; number: number; url: string; result?: Extract<Created, { ok: true }> }): Html {
  return page(
    ctx,
    "Issue created",
    html`${PageHeader({ title: "Issue created", sub: o.result?.title, crumbs: [{ href: CURRENT, label: "New work" }, { href: newHref(o.repo), label: short(ctx.org, o.repo) }] })}
${Notice({ tone: "ok", children: html`Created ${Link(o.url, `${o.repo}#${o.number}`)}.` })}
${(o.result?.warnings ?? []).map((w) => Notice({ tone: "warn", children: w }))}
<div class="buttons">${Link(o.url, `Open it on ${forgeName(ctx.frame.host)}`, "btn primary")}<a class="btn" href="${newHref(o.repo)}">File another</a></div>`,
  );
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** Remembers the last 200 of something, for the page after a redirect. */
const remember = <K, V>(m: Map<K, V>, k: K, v: V) => {
  if (m.size > 200) m.delete(m.keys().next().value as K);
  m.set(k, v);
};
const isNonce = (s: string) => /^[0-9a-f-]{36}$/.test(s);

/** /issues/…: mounted at "/" by app.ts, behind its cookie and same-origin checks. */
/**
 * `kept`: where GHE's answers are kept between runs (data/catalog.json), so these pages
 * answer at once after a restart. `prewarm`: load what the pages need shortly after starting.
 */
export function createIssueRoutes(env: Env, deps: { ghe: Ghe; frame: () => Promise<Frame>; checkouts?: () => Checkout[]; kept?: Kept; /** What packs put on New work (the "work.new" slot). */ newWork?: () => Child[]; /** The issues list, when a pack shows one (the Issues pack's /tracker): /issues goes there. */ list?: () => string | undefined; prewarm?: boolean }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (env.IS_HOSTED === "1") return app;
  const { ghe } = deps;
  const org = env.GHE_ORG;
  /** Every owner tracked: what a repo may belong to (src/owners.ts). `org` is the first, for org-only things. */
  const owners = ownersIn(env);
  const catalog = createCatalog(ghe, org, { kept: deps.kept });
  const setup: Setup = {
    sortingRepos: reposOf(owners, env.SORTING_REPOS, ""),
    formRepos: reposOf(owners, env.FORM_REPOS, ""),
    formSkill: env.FORM_SKILL,
  };
  const parentRepos = [...new Set([...setup.sortingRepos, ...setup.formRepos])];
  /** The open issues to pick from: a minute's cache, so going back to the list doesn't wait on GHE again. */
  const parentsCache = memoize({ ttlMs: 60e3, kept: deps.kept });
  /** One parent, for showing the task form; creating re-reads it. */
  const issueCache = memoize({ ttlMs: 60e3, kept: deps.kept });
  const parents = (login: string) => parentsCache(`parents:${login}`, () => loadParents(ghe, parentRepos, login));
  const ctx = async (): Promise<Ctx> => ({ ...setup, frame: await deps.frame(), org, ghe: ghe.host, extra: deps.newWork?.() });
  const dirs = () => {
    try {
      return deps.checkouts ? deps.checkouts() : checkouts(env.CODE_DIR, ghe.host, owners);
    } catch {
      return [];
    }
  };
  /** Preview nonces already pressed: a double click or a re-post doesn't file it twice. "" while it's being created. */
  const spent = new Map<string, string>();
  /** Spends a nonce: the redirect it already led to, "" while it's in flight, or null when it's fresh (and now taken). */
  const take = (nonce: string): string | null => {
    const was = spent.get(nonce);
    if (was !== undefined) return was;
    remember(spent, nonce, "");
    return null;
  };

  // ── Forms ──
  const results = new Map<string, Extract<Created, { ok: true }>>();
  const defaultFormRepo = setup.formRepos[0] ?? "";

  /** The posted form as a draft, after the repo and template are checked against what's live. */
  type Got = { problem: string; repo: string } | { draft: Draft; types: Res<IssueType[]>; labels: Res<string[]>; offered: Offered; errors: Errors };
  async function fromForm(form: Record<string, unknown>, fresh = false): Promise<Got> {
    const repo = repoIn(owners, first(form.repo));
    if (!repo) return { problem: `That isn't a repo in ${owners.replace(/,/g, ", ")}.`, repo: defaultFormRepo };
    const file = first(form.template);
    const o = { fresh };
    const [templates, types, labels] = await Promise.all([settle(catalog.templates(repo, o)), settle(catalog.types(o)), settle(catalog.labels(repo, o))]);
    if (templates.ok && !takesIssues(templates.value)) return { problem: `${repo} takes no hand-made issues: see its page for the ways in.`, repo };
    let template: Template | null = null;
    if (file !== BLANK) {
      if (!templates.ok) return { problem: `${repo}'s templates didn't load: ${templates.error}`, repo };
      const t = templates.value.templates.find((x) => x.file === file);
      if (!t) return { problem: `${repo} has no issue form «${file}» (any more).`, repo };
      template = t;
    } else if (templates.ok && !templates.value.config.blank) return { problem: `${repo} takes no blank issues: pick one of its forms.`, repo };
    const offered = labels.ok ? offeredLabels(labels.value) : NOTHING_OFFERED;
    const draft = readDraft(repo, template, form, offered);
    return { draft, types, labels, offered, errors: validate(draft, types.ok ? types.value : null) };
  }

  /** What New work created, on My list too when the preview's box was ticked. It's made already, so a miss here is only logged. */
  const onMyList = async (form: Record<string, unknown>, title: string, ref: string) => {
    if (first(form.mylist) !== "1" || !title.trim()) return;
    try {
      await addTodo(env.DB, { title: title.trim().slice(0, 300), notes: ref });
    } catch (e) {
      console.error(`my list: ${msg(e)}`);
    }
  };
  app.get("/issues", (c) => c.redirect(deps.list?.() ?? CURRENT, 303));

  app.get("/issues/new", async (c) => {
    const kind = c.req.query("kind");
    if (kind === "task") return taskNew(c.req.query("parent"), c.req.query("repo"));
    const q = c.req.query("repo");
    const file = c.req.query("template");
    if (kind !== "forms" && q === undefined && file === undefined) return c.html(entryPage(await ctx()));
    const repo = q === undefined ? defaultFormRepo : repoIn(owners, q);
    if (!repo) return c.html(pickPage(await ctx(), { repo: defaultFormRepo, templates: { ok: true, value: { templates: [], broken: [], config: { blank: true, links: [] } } }, types: { ok: true, value: [] }, notice: `That isn't a repo in ${owners.replace(/,/g, ", ")}.` }), 400);
    const [templates, types] = await Promise.all([settle(catalog.templates(repo)), settle(catalog.types())]);
    if (!file) return c.html(pickPage(await ctx(), { repo, templates, types }));
    const template = file === BLANK ? (templates.ok && !templates.value.config.blank ? undefined : null) : templates.ok ? templates.value.templates.find((t) => t.file === file) : undefined;
    if (template === undefined) return c.html(pickPage(await ctx(), { repo, templates, types, notice: file === BLANK ? `${repo} takes no blank issues.` : `${repo} has no issue form «${file}».` }), 404);
    const labels = await settle(catalog.labels(repo));
    const offered = labels.ok ? offeredLabels(labels.value) : NOTHING_OFFERED;
    return c.html(formPage(await ctx(), { draft: emptyDraft(repo, template, offered), types, offered, labels }));

    // ── A dev task: which issue it hangs under, then the task ──
    async function taskNew(parentQ: string | undefined, repoQ: string | undefined) {
      const cx = await ctx();
      const pick = async (problem?: string, status: 200 | 400 | 404 | 409 | 502 = 200, typed?: string) =>
        c.html(taskPickPage(cx, { parents: await settle(parents(cx.frame.operator)), problem, typed }), status);
      if (!parentQ) return pick();
      const parent = await resolveParent(parentQ, cx.frame.operator, true);
      if ("problem" in parent) return pick(parent.problem, parent.status, parentQ);
      const types = await settle(catalog.types());
      const draft: TaskDraft = { repo: repoIn(owners, repoQ) ?? "", title: "", body: "", type: types.ok && types.value.some((t) => t.name === "Task") ? "Task" : "", assign: true };
      return c.html(taskFormPage(cx, { parent: parent.parent, draft, dirs: dirs(), types }));
    }
  });

  app.post("/issues/preview", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const got = await fromForm(form);
    if ("problem" in got) return c.html(problemPage(await ctx(), got.problem, newHref(got.repo)), 400);
    if (first(form.edit) === "1") return c.html(formPage(await ctx(), got));
    if (!isValid(got.errors)) return c.html(formPage(await ctx(), got), 422);
    return c.html(previewPage(await ctx(), { draft: got.draft, types: got.types, nonce: randomUUID() }));
  });

  app.post("/issues/create", async (c) => {
    const form = await c.req.parseBody({ all: true });
    // Filing re-checks against GHE, not what's cached.
    const got = await fromForm(form, true);
    if ("problem" in got) return c.html(problemPage(await ctx(), got.problem, newHref(got.repo)), 400);
    const nonce = first(form.nonce);
    const ctxNow = await ctx();
    // Only from a preview: the preview is the confirm step, and its nonce stops a second filing.
    if (!isNonce(nonce)) return c.html(previewPage(ctxNow, { draft: got.draft, types: got.types, nonce: randomUUID(), problem: "Create from the preview: nothing was created." }), 400);
    if (!isValid(got.errors)) return c.html(formPage(ctxNow, got), 422);
    if (!got.types.ok) return c.html(previewPage(ctxNow, { draft: got.draft, types: got.types, nonce, problem: `The org's Issue Types didn't load, so the type can't be checked: nothing was created. ${got.types.error}` }), 502);
    const was = take(nonce);
    if (was) return c.redirect(was, 303);
    if (was === "") return c.html(problemPage(ctxNow, "That issue is being created already.", newHref(got.draft.repo)), 409);
    const d = got.draft;
    const r = await createIssue(ghe, env.DB, org, {
      repo: d.repo,
      title: d.title.trim(),
      body: composeBody(d),
      type: d.type,
      typeNodeId: got.types.value.find((t) => t.name === d.type)?.nodeId,
      labels: labelsOf(d),
      projects: d.template?.projects ?? [],
    });
    if (!r.ok) {
      spent.delete(nonce);
      return c.html(previewPage(ctxNow, { draft: d, types: got.types, nonce, problem: r.message }), 502);
    }
    await onMyList(form, d.title, `${r.repo}#${r.number}`);
    const done = `/issues/done?repo=${encodeURIComponent(r.repo)}&number=${r.number}`;
    remember(results, `${r.repo}#${r.number}`, r);
    spent.set(nonce, done);
    return c.redirect(done, 303);
  });

  app.get("/issues/done", async (c) => {
    const repo = repoIn(owners, c.req.query("repo"));
    const n = c.req.query("number") ?? "";
    if (!repo || !/^\d{1,9}$/.test(n)) return c.html(problemPage(await ctx(), "That isn't an issue in the org."), 400);
    const result = results.get(`${repo}#${n}`);
    return c.html(donePage(await ctx(), { repo, number: Number(n), url: result?.url ?? `https://${ghe.host}/${repo}/issues/${n}`, result }));
  });

  // ── Dev tasks ──
  const tasks = new Map<string, Extract<TaskCreated, { ok: true }>>();

  /** A reference to the open issue a task hangs under. */
  /** `shown`: only for showing the form, so a minute-old answer will do; creating reads it fresh. */
  async function resolveParent(input: string, login: string, shown = false): Promise<{ parent: Parent } | { problem: string; status: 400 | 404 | 409 | 502 }> {
    const ref = parseRef(input, owners, ghe.host);
    if (!ref) return { problem: `«${input}» isn't an issue in ${org}: write repo#6 or ${org}/repo#512.`, status: 400 };
    const at = ref;
    const p = await settle(shown ? issueCache(`issue:${refText(at)}:${login}`, () => loadIssue(ghe, at, login)) : loadIssue(ghe, at, login));
    if (!p.ok) return { problem: `Couldn't read ${refText(at)}: ${p.error}`, status: /: 404\b/.test(p.error) ? 404 : 502 };
    if (p.value.pr) return { problem: `${refText(at)} is a pull request; a task hangs under an issue.`, status: 400 };
    if (p.value.state !== "open") return { problem: `${refText(at)} is ${p.value.state}. Reopen it, or pick another issue.`, status: 409 };
    return { parent: p.value };
  }

  type GotTask = { problem: string; status: 400 | 404 | 409 | 502 } | { parent: Parent; draft: TaskDraft; types: Res<IssueType[]>; errors: TaskErrors; closed?: Html };
  async function taskFromForm(form: Record<string, unknown>, cx: Ctx): Promise<GotTask> {
    const parent = await resolveParent(first(form.parent), cx.frame.operator);
    if ("problem" in parent) return parent;
    const other = first(form.repo_other).trim();
    const repoText = other ? (other.includes("/") ? other : `${org}/${other}`) : first(form.repo);
    const draft: TaskDraft = { repo: repoText, title: first(form.title).replace(/[\r\n]+/g, " "), body: first(form.body).replace(/\r\n?/g, "\n"), type: first(form.type).trim(), assign: first(form.assign) === "on" };
    const types = await settle(catalog.types());
    const errors: TaskErrors = {};
    let closed: Html | undefined;
    const repo = repoIn(owners, draft.repo);
    if (!draft.repo) errors.repo = "Pick the code repo.";
    else if (!repo) errors.repo = `That isn't a repo in ${owners.replace(/,/g, ", ")}.`;
    else if (inRepos(setup.sortingRepos, repo)) errors.repo = `${short(org, repo)} is where the work is planned; tasks go in the code repo. Pick that.`;
    else {
      const t = await settle(catalog.templates(repo));
      if (t.ok && !takesIssues(t.value)) {
        errors.repo = `${short(org, repo)} takes no hand-made issues.`;
        closed = waysIn(cx, repo, t.value.config.links);
      }
    }
    const title = draft.title.trim();
    if (!title) errors.title = "Write a title.";
    else if (title.length > MAX_TASK_TITLE) errors.title = `At most ${MAX_TASK_TITLE} characters (${title.length} now).`;
    if (!draft.type) errors.type = "Pick a type.";
    else if (types.ok && !types.value.some((t) => t.name === draft.type)) errors.type = `«${draft.type}» isn't an enabled Issue Type in the org.`;
    if (draft.body.length > MAX_TASK_BODY) errors.body = `Over GitHub's ${MAX_TASK_BODY} characters.`;
    return { parent: parent.parent, draft, types, errors, closed };
  }
  const taskValid = (e: TaskErrors) => !e.repo && !e.title && !e.type && !e.body;

  app.post("/issues/task/preview", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const cx = await ctx();
    // The preview is the confirm step: it shows the parent issue as it is now.
    const got = await taskFromForm(form, cx);
    if ("problem" in got) return c.html(problemPage(cx, got.problem, taskHref()), got.status);
    const again = { parent: got.parent, draft: got.draft, dirs: dirs(), types: got.types, errors: got.errors, closed: got.closed };
    if (first(form.edit) === "1") return c.html(taskFormPage(cx, { ...again, errors: {}, closed: undefined }));
    if (!taskValid(got.errors)) return c.html(taskFormPage(cx, again), 422);
    return c.html(taskPreviewPage(cx, { parent: got.parent, draft: got.draft, types: got.types, nonce: randomUUID() }));
  });

  app.post("/issues/task/create", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const cx = await ctx();
    const got = await taskFromForm(form, cx);
    if ("problem" in got) return c.html(problemPage(cx, got.problem, taskHref()), got.status);
    const nonce = first(form.nonce);
    if (!isNonce(nonce)) return c.html(taskPreviewPage(cx, { parent: got.parent, draft: got.draft, types: got.types, nonce: randomUUID(), problem: "Create from the preview: nothing was created." }), 400);
    if (!taskValid(got.errors)) return c.html(taskFormPage(cx, { parent: got.parent, draft: got.draft, dirs: dirs(), types: got.types, errors: got.errors, closed: got.closed }), 422);
    if (!got.types.ok) return c.html(taskPreviewPage(cx, { parent: got.parent, draft: got.draft, types: got.types, nonce, problem: `The org's Issue Types didn't load: nothing was created. ${got.types.error}` }), 502);
    const was = take(nonce);
    if (was) return c.redirect(was, 303);
    if (was === "") return c.html(problemPage(cx, "That task is being created already.", taskHref(refText(got.parent))), 409);
    const d = got.draft;
    const r = await createTask(ghe, env.DB, owners, {
      repo: d.repo,
      title: d.title.trim(),
      body: d.body.trim(),
      type: d.type,
      typeNodeId: got.types.value.find((t) => t.name === d.type)?.nodeId,
      assignees: d.assign ? [cx.frame.operator] : [],
      parent: { repo: got.parent.repo, number: got.parent.number },
    });
    if (!r.ok) {
      spent.delete(nonce);
      return c.html(taskPreviewPage(cx, { parent: got.parent, draft: d, types: got.types, nonce, problem: r.message }), 502);
    }
    await onMyList(form, d.title, `${r.repo}#${r.number}, under ${refText(got.parent)}`);
    const done = `/issues/task/done?repo=${encodeURIComponent(r.repo)}&number=${r.number}`;
    remember(tasks, `${r.repo}#${r.number}`, r);
    spent.set(nonce, done);
    return c.redirect(done, 303);
  });

  app.get("/issues/task/done", async (c) => {
    const repo = repoIn(owners, c.req.query("repo"));
    const n = c.req.query("number") ?? "";
    if (!repo || !/^\d{1,9}$/.test(n)) return c.html(problemPage(await ctx(), "That isn't an issue in the org."), 400);
    const result = tasks.get(`${repo}#${n}`);
    return c.html(taskDonePage(await ctx(), { repo, number: Number(n), url: result?.url ?? `https://${ghe.host}/${repo}/issues/${n}`, result, dir: checkoutOf(dirs(), repo)?.dir }));
  });

  // ── An agent drafts it: the prompt is shown before it starts ──
  app.post("/issues/draft", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const cx = await ctx();
    const kind = first(form.kind) || "forms";
    const note = first(form.note).replace(/\r\n?/g, "\n").trim();
    let ask: AgentAsk;
    let back = CURRENT;
    let target: string | undefined;
    if (kind === "forms") {
      const repo = repoIn(owners, first(form.repo));
      if (!repo) return c.html(problemPage(cx, `That isn't a repo in ${owners.replace(/,/g, ", ")}.`), 400);
      const file = first(form.template);
      // The name the prompt carries is the live template's, never what the form says it is.
      const templates = file && file !== BLANK ? await settle(catalog.templates(repo)) : null;
      const template = templates?.ok ? templates.value.templates.find((t) => t.file === file)?.name : undefined;
      ask = { kind: "forms", repo, ...(template ? { template } : {}) };
      back = newHref(repo, file || undefined);
      target = repo;
    } else if (kind === "task") {
      const ref = parseRef(first(form.parent), owners, ghe.host);
      const parent = ref ? refText(ref) : undefined;
      const repo = repoIn(owners, first(form.repo)) ?? undefined;
      ask = { kind: "task", ...(parent ? { parent } : {}), ...(repo ? { repo } : {}) };
      back = taskHref(parent, repo);
      target = repo;
    } else if (kind === "any") ask = { kind: "any" };
    else return c.html(problemPage(cx, "That isn't a kind of work."), 400);
    if (!note) return c.html(problemPage(cx, "Describe it first: the agent starts from your note.", back), 400);
    if (note.length > MAX_NOTE) return c.html(problemPage(cx, `Keep the note under ${MAX_NOTE} characters.`, back), 400);
    const list = dirs();
    // Work in a repo starts in its checkout (its conventions); the rest in Dovre's own folder.
    const dir = (target ? checkoutOf(list, target)?.dir : undefined) ?? WORK;
    return c.html(draftPage(cx, { prompt: agentPrompt(note, ask, setup), dirs: list, dir, back }));
  });

  // Load what these pages need shortly after starting, so the first visit doesn't wait on GHE.
  if (deps.prewarm)
    setTimeout(async () => {
      const login = (await deps.frame().catch(() => undefined))?.operator ?? "";
      const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
      await Promise.all([
        quiet(catalog.types()),
        ...setup.formRepos.flatMap((r) => [quiet(catalog.templates(r)), quiet(catalog.labels(r))]),
        ...setup.sortingRepos.map((r) => quiet(catalog.templates(r))),
        login ? quiet(parents(login)) : null,
      ]);
    }, 1500).unref?.();
  return app;
}
