/**
 * Dovre's code explorer (local only): a checkout's files, its own diff, and two texts compared.
 * Read-only. The PR viewer is the PRs pack's (src/packs/core/prs/).
 */
import { ownersIn } from "../owners.ts";
import { Hono } from "hono";
import { html } from "hono/html";
import type { AppEnv, Env } from "../env.ts";
import { type Frame, shell } from "../html.ts";
import { type Checkout, checkouts } from "../checkouts.ts";
import type { Ghe } from "../sources/ghe.ts";
import { type Child, Empty, Grid2, type Html, Item, List, Notice, PageHeader, Panel, Tabs } from "../ui/kit.ts";
import { blob, commitOf, dirOf, type Entry, type Git, git as realGit, grep, safePath, safeRef, tree } from "../viewer/code.ts";
import { fileViews, parsePatch } from "../viewer/diff.ts";
import { type Compared, canonicalJson, comparePatch, MAX_TEXT } from "../viewer/compare.ts";
import { type DiffAsk, type LocalDiff, localDiff, MAX_FILES, MAX_UNTRACKED } from "../viewer/localdiff.ts";
import { codeHref, diffHref, diffTable, fileView, withTree } from "./diffview.ts";

function crumbsOf(dir: string, ref: string, path: string): Html {
  const parts = path ? path.split("/") : [];
  return html`<nav class="code-crumbs" aria-label="Path"><a href="${codeHref(dir, { ref })}">${dir}</a>${parts.map((p, i) => html` / <a href="${codeHref(dir, { ref, path: parts.slice(0, i + 1).join("/") })}">${p}</a>`)}</nav>`;
}

function codeListPage(frame: Frame, list: Checkout[]): Html {
  return shell({
    title: "Code · Dovre",
    frame,
    current: "/code",
    body: html`${PageHeader({ title: "Code", sub: "Checkouts at any branch, tag or commit. Read-only.", actions: html`<a class="btn sm ghost" href="/compare">Compare text</a>` })}${Panel({
      flush: true,
      children: list.length ? List(list.map((c) => Item({ href: codeHref(c.dir), title: html`<strong>${c.dir}</strong>`, line: c.repo }))) : Empty({ title: "No checkouts of the org's repos in your code folder" }),
    })}`,
  });
}

type CodeView =
  | { kind: "tree"; entries: Entry[] }
  | { kind: "file"; text?: string; size: number; note?: string }
  | { kind: "search"; q: string; hits: { path: string; line: number; text: string }[]; more: boolean }
  | { kind: "problem"; message: Child };

function codePage(frame: Frame, o: { dir: string; repo: string; ref: string; sha: string; path: string; view: CodeView }): Html {
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
    body: html`${PageHeader({ title: o.path ? o.path.split("/").pop()! : o.dir, sub: html`<code>${o.repo}</code> at <code>${o.ref}</code> (${o.sha.slice(0, 7)})`, crumbs: [{ href: "/code", label: "Code" }, { href: codeHref(o.dir), label: o.dir }], actions: html`<a class="btn sm ghost" href="${diffHref(o.dir)}">Changes</a>` })}${forms}${crumbsOf(o.dir, o.ref, o.path)}${inner}`,
  });
}

// ── A checkout's own diff (dovre#105) ───────────────────────────────────────

export function diffPage(frame: Frame, o: { dir: string; repo: string; ask: DiffAsk; diff: LocalDiff; /** Side by side. */ split?: boolean }): Html {
  const a = o.ask;
  const d = o.diff;
  const short = (sha?: string) => (sha ? sha.slice(0, 7) : "");
  const sub =
    a.kind === "worktree"
      ? html`What's not committed in <code>${o.dir}</code>, against <code>${a.base}</code>${d.ok ? html` (${short(d.base)})` : ""}, untracked files too.`
      : a.kind === "refs"
        ? html`<code>${a.head}</code> against <code>${a.base}</code>, from where they split.`
        : html`Commit <code>${short(d.ok ? d.head : a.sha) || a.sha}</code>.`;
  const tabs = Tabs({
    label: "What to compare",
    items: [
      { href: diffHref(o.dir, { split: o.split }), label: "Uncommitted", current: a.kind === "worktree" && a.base === "HEAD" },
      { href: diffHref(o.dir, { base: "origin/HEAD", head: "HEAD", split: o.split }), label: "Branch vs default", current: a.kind === "refs" },
    ],
  });
  // The same comparison, the other way of laying it out.
  const same = a.kind === "commit" ? { commit: a.sha } : a.kind === "refs" ? { base: a.base, head: a.head } : { base: a.base === "HEAD" ? undefined : a.base };
  const layout = html`<a class="btn sm ghost" href="${diffHref(o.dir, { ...same, split: !o.split })}">${o.split ? "Unified" : "Side by side"}</a>`;
  const keep = o.split ? html`<input type="hidden" name="view" value="split">` : "";
  const form = html`<div class="code-bar"><form method="get" action="${diffHref(o.dir)}" class="code-ref"><label class="label" for="base">Base</label><input type="text" id="base" name="base" value="${a.kind === "commit" ? "" : a.base}" maxlength="200" placeholder="HEAD"><label class="label" for="head">Head</label><input type="text" id="head" name="head" value="${a.kind === "refs" ? a.head : ""}" maxlength="200" placeholder="working tree">${keep}<button type="submit" class="sm">Compare</button></form><form method="get" action="${diffHref(o.dir)}" class="code-ref"><label class="label" for="commit">Commit</label><input type="text" id="commit" name="commit" value="${a.kind === "commit" ? a.sha : ""}" maxlength="200">${keep}<button type="submit" class="sm">Show</button></form>${layout}</div>`;
  let inner: Html;
  if (!d.ok) inner = Notice({ tone: "bad", children: html`<strong>The diff didn't load.</strong> ${d.error}` });
  else if (!d.files.length) inner = Panel({ children: Empty({ title: a.kind === "worktree" ? "Nothing uncommitted" : "No changes" }) });
  else {
    const views = fileViews(d.files, []);
    const adds = d.files.reduce((n, f) => n + f.additions, 0);
    const dels = d.files.reduce((n, f) => n + f.deletions, 0);
    // "View file" opens the head commit; the working tree has none.
    const head = a.kind === "worktree" ? undefined : d.head;
    const key = head ?? `worktree:${o.dir}`;
    inner = html`<p class="t3">${d.files.length} ${d.files.length === 1 ? "file" : "files"} · <span class="add">+${adds}</span> <span class="del">−${dels}</span></p>${withTree(
      views,
      html`${d.capped ? Notice({ tone: "warn", children: `Showing the first ${MAX_FILES} files.` }) : ""}${
        d.moreUntracked ? Notice({ tone: "warn", children: `${d.moreUntracked} more untracked ${d.moreUntracked === 1 ? "file" : "files"} past the first ${MAX_UNTRACKED}, not shown.` }) : ""
      }${views.map((fv) => fileView(fv, { sha: key, dir: head ? o.dir : undefined, present: !!head, split: o.split }))}`,
    )}`;
  }
  return shell({
    title: `Changes · ${o.dir} · Dovre`,
    frame,
    current: "/code",
    body: html`${PageHeader({ title: "Changes", sub, crumbs: [{ href: "/code", label: "Code" }, { href: codeHref(o.dir), label: o.dir }], tabs })}${form}${inner}`,
  });
}

// ── Two texts compared (dovre#105) ──────────────────────────────────────────

type CompareAsk = { a: string; b: string; json: boolean; split: boolean };

function comparePage(frame: Frame, o: { ask?: CompareAsk; result?: Compared }): Html {
  const k = o.ask ?? { a: "", b: "", json: false, split: false };
  const r = o.result;
  const max = String(MAX_TEXT);
  const form = html`<form method="post" action="/compare" class="compare">${Grid2(html`<label class="field"><span class="label">Before</span><textarea name="a" rows="12" maxlength="${max}" spellcheck="false">${k.a}</textarea></label><label class="field"><span class="label">After</span><textarea name="b" rows="12" maxlength="${max}" spellcheck="false">${k.b}</textarea></label>`)}<p><label class="check"><input type="checkbox" name="json" value="1"${k.json ? html` checked` : ""}> As JSON: keys sorted, laid out alike</label><label class="check"><input type="checkbox" name="split" value="1"${k.split ? html` checked` : ""}> Side by side</label> <button type="submit" class="primary sm">Compare</button></p></form>`;
  const out = !r
    ? ""
    : !r.ok
      ? Notice({ tone: "bad", children: r.error })
      : !r.patch
        ? Panel({ children: Empty({ title: "They're the same" }) })
        : Panel({ title: html`<span class="add">+${r.additions}</span> <span class="del">−${r.deletions}</span>`, flush: true, children: diffTable(parsePatch(r.patch), { split: k.split }) });
  return shell({
    title: "Compare · Dovre",
    frame,
    current: "/code",
    body: html`${PageHeader({ title: "Compare", sub: "Two pieces of text, or two JSON documents, line by line. Nothing is kept.", crumbs: [{ href: "/code", label: "Code" }] })}${form}${out}`,
  });
}

/** What a compare form sent: each side capped, JSON laid out alike when asked. */
function compareOf(form: Record<string, unknown>): { ask: CompareAsk; result: Compared } {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const ask: CompareAsk = { a: text(form.a), b: text(form.b), json: form.json === "1", split: form.split === "1" };
  if (!ask.json) return { ask, result: comparePatch(ask.a, ask.b) };
  const a = canonicalJson(ask.a);
  const b = canonicalJson(ask.b);
  if (a === undefined || b === undefined) return { ask, result: { ok: false, error: `${a === undefined ? "Before" : "After"} isn't JSON.` } };
  return { ask, result: comparePatch(a, b) };
}

// ── Routes ───────────────────────────────────────────────────────────────────
// ── Routes ───────────────────────────────────────────────────────────────────

type CodeDeps = {
  ghe: Pick<Ghe, "host">;
  frame: () => Promise<Frame>;
  checkouts?: () => Checkout[];
  git?: Git;
};

/** /code and /compare: mounted at "/" by app.ts, behind its cookie and same-origin checks. Hosted, they aren't there. */
export function createCodeRoutes(env: Env, deps: CodeDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const g = deps.git ?? realGit;
  const list = () => {
    try {
      return deps.checkouts ? deps.checkouts() : checkouts(env.CODE_DIR, deps.ghe.host, ownersIn(env));
    } catch {
      return [];
    }
  };

  app.get("/code", async (c) => env.IS_HOSTED === "1" ? c.notFound() : c.html(codeListPage(await deps.frame(), list())));

  app.get("/compare", async (c) => (env.IS_HOSTED === "1" ? c.notFound() : c.html(comparePage(await deps.frame(), {}))));
  app.post("/compare", async (c) => {
    if (env.IS_HOSTED === "1") return c.notFound();
    const { ask, result } = compareOf(await c.req.parseBody());
    return c.html(comparePage(await deps.frame(), { ask, result }), result.ok ? 200 : 400);
  });

  app.get("/code/:dir/diff", async (c) => {
    if (env.IS_HOSTED === "1") return c.notFound();
    const co = list().find((x) => x.dir === c.req.param("dir"));
    if (!co) return c.notFound();
    const frame = await deps.frame();
    const q = (k: string) => (c.req.query(k) ?? "").trim().slice(0, 200);
    const commit = q("commit");
    const base = q("base") || "HEAD";
    const head = q("head");
    const ask: DiffAsk = commit ? { kind: "commit", sha: commit } : head ? { kind: "refs", base, head } : { kind: "worktree", base };
    const refs = ask.kind === "commit" ? [ask.sha] : ask.kind === "refs" ? [ask.base, ask.head] : [ask.base];
    if (!refs.every(safeRef)) return c.html(diffPage(frame, { dir: co.dir, repo: co.repo, ask, diff: { ok: false, error: "That isn't a ref in this checkout." } }), 400);
    const diff = await localDiff(g, dirOf(env.CODE_DIR, co.dir), ask);
    return c.html(diffPage(frame, { dir: co.dir, repo: co.repo, ask, diff, split: c.req.query("view") === "split" }), diff.ok ? 200 : 404);
  });

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

