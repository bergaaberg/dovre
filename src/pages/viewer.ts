/**
 * Dovre's own PR viewer (conversation and files) and code explorer. GHE stays one link away
 * ("Open on GHE ↗", new tab). Read-only. A PR seen before draws at once from the cache and is read
 * again in the background; the first visit shows "Reading" and fills itself in over the hub.
 */
import { ownersIn } from "../owners.ts";
import { Hono } from "hono";
import { html } from "hono/html";
import { repoIn } from "../actions/deploys.ts";
import type { AppEnv, Env } from "../env.ts";
import { type Frame, shell } from "../html.ts";
import { type Checkout, checkoutOf, checkouts } from "../issues/tasks.ts";
import { type Kept, memoize } from "../issues/templates.ts";
import type { Hub } from "../live.ts";
import type { Ghe } from "../sources/ghe.ts";
import { loadPrFiles, loadPrView, type PrFile, type PrView, type Thread } from "../sources/prview.ts";
import { type Child, Empty, type Html, Item, KeyValues, List, Notice, PageHeader, Panel, Pill, Tabs } from "../ui/kit.ts";
import { markdown } from "../ui/markdown.ts";
import type { PrSlotArg } from "../packs/types.ts";
import { blob, commitOf, dirOf, type Entry, type Git, git as realGit, grep, safePath, safeRef, tree } from "../viewer/code.ts";
import { type DiffLine, type FileView, fileViews } from "../viewer/diff.ts";
import { Ago, Link } from "./parts.ts";

type Res<T> = { ok: true; value: T } | { ok: false; error: string };
const settle = <T>(p: Promise<T>): Promise<Res<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }),
  );

export const prHref = (repo: string, n: number) => `/prs/${repo}/${n}`;
const codeHref = (dir: string, o: { ref?: string; path?: string; q?: string } = {}) => {
  const q = new URLSearchParams();
  if (o.ref) q.set("ref", o.ref);
  if (o.path) q.set("path", o.path);
  if (o.q) q.set("q", o.q);
  const s = q.toString();
  return `/code/${encodeURIComponent(dir)}${s ? `?${s}` : ""}`;
};

const STATE_TONE = { OPEN: "ok", MERGED: "ok", CLOSED: "bad" } as const;
const REVIEW_TONE: Record<string, "ok" | "bad" | "warn" | undefined> = { APPROVED: "ok", CHANGES_REQUESTED: "bad", REVIEW_REQUIRED: "warn" };
const REVIEW_WORD: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "pending", REVIEW_REQUIRED: "review required" };
const RUN_TONE = { ok: "ok", bad: "bad", pending: "warn", skipped: undefined } as const;

// ── PR: header and tabs ──────────────────────────────────────────────────────

function header(v: PrView, current: "conversation" | "files", extra: { stack?: Child }) {
  const tabs = Tabs({
    label: "Pull request",
    items: [
      { href: prHref(v.repo, v.number), label: "Conversation", current: current === "conversation" },
      { href: `${prHref(v.repo, v.number)}/files`, label: "Files", n: v.changedFiles, current: current === "files" },
    ],
  });
  const sub = html`<span class="pr-meta">${Pill({ tone: v.draft ? undefined : STATE_TONE[v.state], children: v.draft ? "draft" : v.state.toLowerCase() })}${
    v.reviewDecision ? Pill({ tone: REVIEW_TONE[v.reviewDecision], children: REVIEW_WORD[v.reviewDecision] ?? v.reviewDecision }) : ""
  }${v.mergeable === "CONFLICTING" ? Pill({ tone: "bad", children: "conflicts" }) : ""} <span>${v.author}</span> wants <code>${v.head}</code> into <code>${v.base}</code> · <span class="add">+${v.additions}</span> <span class="del">−${v.deletions}</span> in ${v.changedFiles} ${
    v.changedFiles === 1 ? "file" : "files"
  } · opened ${Ago(v.createdAt)} ago${extra.stack ? html` · ${extra.stack}` : ""}</span>`;
  return PageHeader({
    title: html`#${v.number} ${v.title}`,
    sub,
    crumbs: [{ href: "/prs", label: "Pull requests" }, { label: v.repo }],
    actions: Link(v.url, html`Open on GHE ↗`, "btn ghost"),
    tabs,
  });
}

function checks(v: PrView): Html {
  if (!v.runs.length) return html`<p class="t3">No checks reported on ${v.headSha.slice(0, 7)}.</p>`;
  return List(v.runs.map((r) => Item({ lead: Pill({ tone: RUN_TONE[r.state], children: r.state === "ok" ? "passed" : r.state === "bad" ? "failed" : r.state === "pending" ? "running" : "skipped" }), title: r.url ? Link(r.url, r.name) : r.name, quiet: r.state === "skipped" })));
}

function comment(c: { author: string; body: string; at: string; url: string }): Html {
  return html`<li class="pr-comment" data-stop="2"><div class="pr-who"><strong>${c.author}</strong> ${Ago(c.at)}${c.url ? html` · ${Link(c.url, "↗")}` : ""}</div>${c.body.trim() ? html`<div class="description">${markdown(c.body, { headingOffset: 3 })}</div>` : ""}</li>`;
}

function threadView(t: Thread, o: { showPath?: boolean } = {}): Html {
  const label = html`${o.showPath ? html`<code>${t.path}${t.line !== null ? `:${t.line}` : ""}</code> · ` : ""}${t.comments.length} ${t.comments.length === 1 ? "comment" : "comments"}${t.resolved ? " · resolved" : ""}${t.outdated ? " · outdated" : ""}`;
  return html`<details class="pr-thread" data-stop="2"${t.resolved || t.outdated ? "" : html` open`}><summary>${label}</summary><ol class="pr-comments">${t.comments.map(comment)}</ol></details>`;
}

const TIMELINE_WORD: Record<string, string> = { commit: "pushed", "force-push": "force-pushed", "review-requested": "asked for a review from", ready: "marked it ready for review", draft: "made it a draft", merged: "merged it", closed: "closed it", reopened: "reopened it" };

export function prPage(frame: Frame, o: { view: PrView; agent?: Html | ""; stack?: Child; /** Pack facts for this PR ("pr.facts" slot). */ facts?: (pr: PrSlotArg) => [Child, Child][]; topic: string }): Html {
  const v = o.view;
  const open = v.threads.filter((t) => !t.resolved && !t.outdated);
  const folded = v.threads.filter((t) => t.resolved || t.outdated);
  const reviews = v.reviews.filter((r) => r.state !== "PENDING" && (r.body.trim() || r.state !== "COMMENTED"));
  const factRows = o.facts?.({ repo: v.repo, number: v.number, branch: v.head, title: v.title, url: v.url }) ?? [];
  const body = html`<div data-live id="pr-view">
${Panel({ title: "Description", children: html`${factRows.length ? KeyValues(factRows) : ""}${v.body.trim() ? html`<div class="description">${markdown(v.body)}</div>` : html`<p class="t3">No description.</p>`}` })}
${o.agent ?? ""}
${Panel({ title: "Checks", meta: v.headSha.slice(0, 7), flush: true, children: checks(v) })}
${Panel({
  title: "Reviews",
  meta: v.requested.length ? html`asked: ${v.requested.join(", ")}` : undefined,
  children: reviews.length ? html`<ol class="pr-comments">${reviews.map((r) => html`<li class="pr-comment"><div class="pr-who"><strong>${r.author}</strong> ${Pill({ tone: REVIEW_TONE[r.state], children: REVIEW_WORD[r.state] ?? r.state.toLowerCase() })} ${Ago(r.at)}</div>${r.body.trim() ? html`<div class="description">${markdown(r.body, { headingOffset: 3 })}</div>` : ""}</li>`)}</ol>` : html`<p class="t3">No reviews yet.</p>`,
})}
${Panel({
  title: "Review threads",
  meta: `${open.length} open${folded.length ? `, ${folded.length} resolved or outdated` : ""}`,
  children: v.threads.length ? html`${open.map((t) => threadView(t, { showPath: true }))}${folded.length ? html`<details class="pr-folded"><summary>${folded.length} resolved or outdated</summary>${folded.map((t) => threadView(t, { showPath: true }))}</details>` : ""}` : html`<p class="t3">No review threads.</p>`,
})}
${Panel({
  title: "Timeline",
  flush: true,
  children: v.timeline.length ? List([...v.timeline].reverse().slice(0, 30).map((t) => Item({ title: html`<strong>${t.who}</strong> ${TIMELINE_WORD[t.what] ?? t.what}${t.detail ? html` <code>${t.detail}</code>` : ""}`, trail: Ago(t.at), quiet: t.what === "commit" }))) : Empty({ title: "Nothing yet" }),
})}
</div>`;
  return shell({ title: `#${v.number} ${v.title} · Dovre`, frame, current: "/prs", body: html`${header(v, "conversation", { stack: o.stack })}${body}`, head: html`<meta name="u-topics" content="snapshot ${o.topic}">` });
}

// ── PR: files ────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, "ok" | "bad" | "warn" | undefined> = { added: "ok", removed: "bad", renamed: "warn" };

const LINE_CLASS = { add: "d-add", del: "d-del", ctx: "d-ctx" } as const;

/** What goes under a line besides its threads (the draft page's comment cards). */
export type LineExtra = (l: DiffLine) => Html | "";

function lineRow(l: DiffLine, extra?: LineExtra): Html {
  if (l.kind === "hunk") return html`<tr class="d-hunk" data-stop="2"><td class="ln"></td><td class="ln"></td><td class="code"><code>${l.text}</code></td></tr>`;
  if (l.kind === "note") return html`<tr class="d-note"><td class="ln"></td><td class="ln"></td><td class="code t3">${l.text}</td></tr>`;
  const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
  return html`<tr class="${LINE_CLASS[l.kind]}"><td class="ln">${l.old ?? ""}</td><td class="ln">${l.new ?? ""}</td><td class="code"><code><span class="d-sign" aria-hidden="true">${sign}</span>${l.text}</code></td></tr>${
    l.threads?.length ? html`<tr class="d-threads"><td colspan="3">${l.threads.map((t) => threadView(t))}</td></tr>` : ""
  }${extra ? extra(l) : ""}`;
}

export const fileId = (path: string) => `f-${path.replace(/[^\w-]/g, "-")}`;

/** One file of a diff. `extra` adds rows under lines; a file with draft comments starts open. */
export function fileView(fv: FileView, o: { sha: string; dir?: string; present: boolean; extra?: LineExtra }): Html {
  const f = fv.file;
  const name = f.previous && f.previous !== f.path ? html`<code>${f.previous}</code> → <code>${f.path}</code>` : html`<code>${f.path}</code>`;
  const view = o.dir && f.status !== "removed" ? (o.present ? html`<a class="btn sm ghost" href="${codeHref(o.dir, { ref: o.sha, path: f.path })}">View file</a>` : "") : "";
  return html`<details class="dfile" id="${fileId(f.path)}" data-stop="1" data-stop-label="${f.path}"${fv.folded && !fv.drafts ? "" : html` open`}><summary><span class="dfile-name">${Pill({ tone: STATUS_TONE[f.status], children: f.status })} ${name}</span><span class="dfile-meta"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span>${
    fv.threads.length ? html` · ${fv.threads.length} ${fv.threads.length === 1 ? "thread" : "threads"}` : ""
  }${fv.drafts ? html` · <span class="spark">${fv.drafts} from the agent</span>` : ""} <label class="viewed-label"><input type="checkbox" class="viewed" data-key="${o.sha}:${f.path}"> Viewed</label>${view}</span></summary>${fv.why ? html`<p class="dfile-why t3">${fv.why}</p>` : ""}${
    fv.unplaced.length ? html`<div class="dfile-threads">${fv.unplaced.map((t) => threadView(t, { showPath: true }))}</div>` : ""
  }${fv.lines.length ? html`<div class="diff-wrap"><table class="diff"><tbody>${fv.lines.map((l) => lineRow(l, o.extra))}</tbody></table></div>` : ""}</details>`;
}

export function filesPage(frame: Frame, o: { view: PrView; files: Res<PrFile[]> | undefined; dir?: string; present: boolean; topic: string }): Html {
  const v = o.view;
  let inner: Html;
  if (!o.files) inner = html`<section class="pending" data-pending aria-busy="true"><span class="spinner" aria-hidden="true"></span><p class="t2">Reading the files from GHE…</p></section>`;
  else if (!o.files.ok) inner = Notice({ tone: "bad", children: html`<strong>The files didn't load.</strong> ${o.files.error}` });
  else {
    const views = fileViews(o.files.value, v.threads);
    const fetch = o.dir && !o.present ? html`<p class="t3">${v.headSha.slice(0, 7)} isn't in your checkout yet: <code data-copy>git -C ${o.dir} fetch origin ${v.head}</code></p>` : "";
    inner = html`<nav class="dfile-index" aria-label="Files"><ul>${views.map(
      (fv) => html`<li><a href="#${fileId(fv.file.path)}"><code>${fv.file.path}</code></a> <span class="add">+${fv.file.additions}</span> <span class="del">−${fv.file.deletions}</span></li>`,
    )}</ul></nav>${fetch}${o.files.value.length >= 300 ? Notice({ tone: "warn", children: "Showing the first 300 files." }) : ""}${views.map((fv) => fileView(fv, { sha: v.headSha, dir: o.dir, present: o.present }))}`;
  }
  return shell({
    title: `Files · #${v.number} ${v.title} · Dovre`,
    frame,
    current: "/prs",
    body: html`${header(v, "files", {})}<div data-live id="pr-files">${inner}</div>`,
    head: html`<meta name="u-topics" content="${o.topic}">`,
  });
}

/** While a PR's first read is under way. */
export function readingPage(frame: Frame, o: { repo: string; n: number; topic: string; error?: string }): Html {
  return shell({
    title: `${o.repo}#${o.n} · Dovre`,
    frame,
    current: "/prs",
    body: html`${PageHeader({ title: `${o.repo}#${o.n}`, crumbs: [{ href: "/prs", label: "Pull requests" }] })}${
      o.error ? Notice({ tone: "bad", children: html`<strong>The pull request didn't load.</strong> ${o.error}` }) : html`<section class="pending" data-pending aria-busy="true"><span class="spinner" aria-hidden="true"></span><h1>Reading the pull request</h1><p class="t2">It fills in by itself.</p></section>`
    }`,
    head: html`<meta name="u-topics" content="${o.topic}">`,
  });
}

// ── Code explorer ────────────────────────────────────────────────────────────

function crumbsOf(dir: string, ref: string, path: string): Html {
  const parts = path ? path.split("/") : [];
  return html`<nav class="code-crumbs" aria-label="Path"><a href="${codeHref(dir, { ref })}">${dir}</a>${parts.map((p, i) => html` / <a href="${codeHref(dir, { ref, path: parts.slice(0, i + 1).join("/") })}">${p}</a>`)}</nav>`;
}

export function codeListPage(frame: Frame, list: Checkout[]): Html {
  return shell({
    title: "Code · Dovre",
    frame,
    current: "/code",
    body: html`${PageHeader({ title: "Code", sub: "Checkouts at any branch, tag or commit. Read-only." })}${Panel({
      flush: true,
      children: list.length ? List(list.map((c) => Item({ href: codeHref(c.dir), title: html`<strong>${c.dir}</strong>`, line: c.repo }))) : Empty({ title: "No checkouts of the org's repos in your code folder" }),
    })}`,
  });
}

export type CodeView =
  | { kind: "tree"; entries: Entry[] }
  | { kind: "file"; text?: string; size: number; note?: string }
  | { kind: "search"; q: string; hits: { path: string; line: number; text: string }[]; more: boolean }
  | { kind: "problem"; message: Child };

export function codePage(frame: Frame, o: { dir: string; repo: string; ref: string; sha: string; path: string; view: CodeView }): Html {
  const v = o.view;
  let inner: Html;
  if (v.kind === "problem") inner = Notice({ tone: "bad", children: v.message });
  else if (v.kind === "tree") inner = Panel({ flush: true, children: v.entries.length ? List(v.entries.map((e) => Item({ href: codeHref(o.dir, { ref: o.ref, path: e.path }), lead: e.type === "tree" ? "📁" : e.type === "commit" ? "⎇" : "", title: e.type === "tree" ? html`<strong>${e.name}/</strong>` : e.name, trail: e.size !== null ? html`<span class="t3">${e.size.toLocaleString("en-GB")} B</span>` : "" }))) : Empty({ title: "Empty folder" }) });
  else if (v.kind === "file")
    inner = v.text === undefined
      ? Notice({ tone: "neutral", children: v.note ?? "Can't show this file." })
      : html`<div class="diff-wrap"><table class="code-view"><tbody>${v.text.replace(/\n$/, "").split("\n").map((line, i) => html`<tr id="L${i + 1}"><td class="ln"><a href="#L${i + 1}">${i + 1}</a></td><td class="code"><code>${line}</code></td></tr>`)}</tbody></table></div>`;
  else
    inner = Panel({
      title: html`Lines with «${v.q}»`,
      meta: `${v.hits.length}${v.more ? "+" : ""}`,
      flush: true,
      children: v.hits.length ? List(v.hits.map((h) => Item({ href: `${codeHref(o.dir, { ref: o.ref, path: h.path })}#L${h.line}`, title: html`<code>${h.path}:${h.line}</code>`, line: html`<code>${h.text}</code>` }))) : Empty({ title: "Nothing found" }),
    });
  const forms = html`<div class="code-bar"><form method="get" action="/code/${encodeURIComponent(o.dir)}" class="code-ref"><label class="label" for="ref">Ref</label><input type="text" id="ref" name="ref" value="${o.ref}" maxlength="200"><input type="hidden" name="path" value="${o.path}"><button type="submit" class="sm">Go</button></form><form method="get" action="/code/${encodeURIComponent(o.dir)}" class="code-search"><input type="hidden" name="ref" value="${o.ref}"><input type="search" name="q" placeholder="Search this ref" maxlength="200" value="${v.kind === "search" ? v.q : ""}" aria-label="Search this ref"><button type="submit" class="sm">Search</button></form></div>`;
  return shell({
    title: `${o.path || o.dir} · Code · Dovre`,
    frame,
    current: "/code",
    body: html`${PageHeader({ title: o.path ? o.path.split("/").pop()! : o.dir, sub: html`<code>${o.repo}</code> at <code>${o.ref}</code> (${o.sha.slice(0, 7)})`, crumbs: [{ href: "/code", label: "Code" }, { href: codeHref(o.dir), label: o.dir }] })}${forms}${crumbsOf(o.dir, o.ref, o.path)}${inner}`,
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────

export type ViewerDeps = {
  ghe: Ghe;
  frame: () => Promise<Frame>;
  hub?: Hub;
  kept?: Kept;
  /** The agent review card for a PR the snapshot knows (src/pages/reviews.ts). */
  agentFor?: (repo: string, n: number) => Promise<Html | "">;
  /** "2 of 6 in a stack · waits on #839", when the stacks are known (never waits for them). */
  stackFor?: (repo: string, n: number) => Promise<Child | undefined>;
  /** Pack facts for the PR ("pr.facts" slot), keyed by the PR itself. */
  facts?: (pr: PrSlotArg) => [Child, Child][];
  checkouts?: () => Checkout[];
  git?: Git;
};

const SHA = /^[0-9a-f]{40}$/;

/** /prs/:owner/:repo/:n(/files) and /code: mounted at "/" by app.ts, behind its cookie and same-origin checks. */
export function createViewerRoutes(env: Env, deps: ViewerDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const g = deps.git ?? realGit;
  const views = memoize({ ttlMs: 60e3, kept: deps.kept });
  // Patches are big and a commit's never change: memory only, by head sha.
  const files = memoize({ ttlMs: 60 * 60e3 });
  const list = () => {
    try {
      return deps.checkouts ? deps.checkouts() : checkouts(env.CODE_DIR, deps.ghe.host, ownersIn(env));
    } catch {
      return [];
    }
  };
  const topicOf = (repo: string, n: number) => `pr:${repo}#${n}`;
  /** The PR, at once if it's known (refreshed in the background, and the page told when it lands); else up to 1.5 s for the first read. */
  async function viewOf(repo: string, n: number): Promise<Res<PrView> | undefined> {
    const loading = settle(views(`prview:${repo}#${n}`, () => loadPrView(deps.ghe, repo, n).then((v) => (deps.hub?.publish([topicOf(repo, n)]), v))));
    return Promise.race([loading, new Promise<undefined>((res) => setTimeout(res, 1500))]);
  }
  const present = new Map<string, boolean>();
  async function hasCommit(dir: string, sha: string) {
    const key = `${dir}@${sha}`;
    if (!present.has(key)) present.set(key, SHA.test(sha) && (await commitOf(g, dirOf(env.CODE_DIR, dir), sha)) === sha);
    return present.get(key)!;
  }

  const parse = (owner: string, repo: string, n: string) => {
    const full = /^[\w.-]{1,100}$/.test(repo) && !repo.includes("..") ? repoIn(ownersIn(env), `${owner}/${repo}`) : null;
    return full && /^\d{1,7}$/.test(n) ? { repo: full, n: Number(n) } : null;
  };

  app.get("/prs/:owner/:repo/:n", async (c) => {
    const at = parse(c.req.param("owner"), c.req.param("repo"), c.req.param("n"));
    if (!at) return c.notFound();
    const frame = await deps.frame();
    const topic = topicOf(at.repo, at.n);
    const got = await viewOf(at.repo, at.n);
    if (!got || !got.ok) return c.html(readingPage(frame, { ...at, topic, error: got && !got.ok ? got.error : undefined }), got ? 502 : 200);
    return c.html(prPage(frame, { view: got.value, agent: (await deps.agentFor?.(at.repo, at.n)) ?? "", stack: await deps.stackFor?.(at.repo, at.n), facts: deps.facts, topic }));
  });

  app.get("/prs/:owner/:repo/:n/files", async (c) => {
    const at = parse(c.req.param("owner"), c.req.param("repo"), c.req.param("n"));
    if (!at) return c.notFound();
    const frame = await deps.frame();
    const topic = topicOf(at.repo, at.n);
    const got = await viewOf(at.repo, at.n);
    if (!got || !got.ok) return c.html(readingPage(frame, { ...at, topic, error: got && !got.ok ? got.error : undefined }), got ? 502 : 200);
    const v = got.value;
    const loading = settle(files(`files:${at.repo}#${at.n}@${v.headSha}`, () => loadPrFiles(deps.ghe, at.repo, at.n).then((f) => (deps.hub?.publish([topic]), f))));
    const fs = await Promise.race([loading, new Promise<undefined>((res) => setTimeout(res, 1500))]);
    const co = checkoutOf(list(), at.repo);
    return c.html(filesPage(frame, { view: v, files: fs, dir: co?.dir, present: co ? await hasCommit(co.dir, v.headSha) : false, topic }));
  });

  app.get("/code", async (c) => env.IS_HOSTED === "1" ? c.notFound() : c.html(codeListPage(await deps.frame(), list())));

  app.get("/code/:dir", async (c) => {
    if (env.IS_HOSTED === "1") return c.notFound();
    const dirName = c.req.param("dir");
    const co = list().find((x) => x.dir === dirName);
    if (!co) return c.notFound();
    const frame = await deps.frame();
    const dir = dirOf(env.CODE_DIR, co.dir);
    const ref = c.req.query("ref") || "HEAD";
    const path = safePath(c.req.query("path") ?? "");
    const q = (c.req.query("q") ?? "").slice(0, 200);
    const base = { dir: co.dir, repo: co.repo, ref, path: path ?? "", sha: "" };
    if (!safeRef(ref) || path === null) return c.html(codePage(frame, { ...base, view: { kind: "problem", message: "That isn't a ref or a path in this checkout." } }), 400);
    const sha = await commitOf(g, dir, ref);
    if (!sha) return c.html(codePage(frame, { ...base, view: { kind: "problem", message: html`<code>${ref}</code> isn't in this checkout. Fetch it first: <code data-copy>git -C ${co.dir} fetch origin</code>` } }), 404);
    if (q.trim()) {
      const r = await grep(g, dir, sha, q);
      return c.html(codePage(frame, { ...base, sha, view: r ? { kind: "search", q, ...r } : { kind: "problem", message: "The search failed." } }));
    }
    // A folder lists; anything else is read as a file.
    const entries = await tree(g, dir, sha, path);
    if (entries) return c.html(codePage(frame, { ...base, sha, view: { kind: "tree", entries } }));
    const b = await blob(g, dir, sha, path);
    if (b.kind === "missing") return c.html(codePage(frame, { ...base, sha, view: { kind: "problem", message: "No such file or folder at this ref." } }), 404);
    if (b.kind === "text") return c.html(codePage(frame, { ...base, sha, view: { kind: "file", text: b.text, size: b.size } }));
    return c.html(codePage(frame, { ...base, sha, view: { kind: "file", size: b.size, note: b.kind === "binary" ? `A binary file (${b.size.toLocaleString("en-GB")} bytes).` : `Too big to show here (${b.size.toLocaleString("en-GB")} bytes).` } }));
  });

  return app;
}

