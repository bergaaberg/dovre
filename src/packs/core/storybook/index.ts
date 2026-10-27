/**
 * Storybook, a core pack (#160, part 2): a PR's stories before and after, side by side, from the
 * Storybook CI publishes for the PR and for its base. Off unless STORYBOOK names a repo, and then
 * only on that repo's PRs: a "Stories" fact on the PR, and its page at /storybook/<owner>/<repo>/<n>.
 *
 * The Storybook sits behind a sign-in, so the server never fetches it: the stories come from the
 * PR's files (model.ts), and my browser draws them in frames with its own session. Its frames are
 * allowed on its own pages only (`frames`), for the origins STORYBOOK names.
 */
import { html } from "hono/html";
import { owns } from "../../../owners.ts";
import { safeUrl } from "../../../pages/parts.ts";
import { type Ghe } from "../../../sources/ghe.ts";
import { loadPrFiles } from "../../../sources/prview.ts";
import { Empty, Notice, PageHeader, Panel, type Html } from "../../../ui/kit.ts";
import { type Pack, PACK_API } from "../../types.ts";
import { type Book, bookOf, booksOf, frameUrl, openUrl, originOf, parseStories, STORIES, storyId, touched, urlOf, type Changed } from "./model.ts";

export type StorybookDeps = { ghe: Ghe; /** The owners' list (OWNERS): a repo outside it is refused. */ owners: () => string };

/** At most this many stories files are read, folders listed, and stories drawn in frames (the rest are links). */
export const MAX_FILES = 20;
export const MAX_DIRS = 15;
export const MAX_FRAMES = 24;

type Story = { id: string; name: string };
type StoryFile = { path: string; title: string; status: "added" | "removed" | "changed" | "nearby"; stories: Story[] };
export type Found = { ok: true; head: string; base: string; files: StoryFile[]; more: number } | { ok: false; why: string };

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Text of a file at a ref, or undefined (missing, too big, not a file). */
async function textAt(ghe: Ghe, repo: string, path: string, ref: string): Promise<string | undefined> {
  const got = await ghe.rest<{ type?: string; encoding?: string; content?: string; size?: number }>(`/repos/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`).catch(() => undefined);
  if (got?.type !== "file" || got.encoding !== "base64" || typeof got.content !== "string" || (got.size ?? 0) > 300_000) return undefined;
  const bin = atob(got.content.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

/** The stories files in a folder at a ref. */
async function storiesIn(ghe: Ghe, repo: string, dir: string, ref: string): Promise<string[]> {
  const got = await ghe.rest<{ type?: string; path?: string }[]>(`/repos/${repo}/contents/${enc(dir)}?ref=${encodeURIComponent(ref)}`).catch(() => []);
  return Array.isArray(got) ? got.filter((x) => x?.type === "file" && typeof x.path === "string" && STORIES.test(x.path)).map((x) => x.path!) : [];
}

/** Which stories a PR touches, read from its files at its head (a removed file: at its base). */
export async function findStories(ghe: Ghe, repo: string, n: number): Promise<Found & { sha?: string; branch?: string }> {
  const pr = await ghe.rest<{ head?: { ref?: string; sha?: string }; base?: { ref?: string } }>(`/repos/${repo}/pulls/${n}`);
  const head = pr?.head?.ref, sha = pr?.head?.sha, base = pr?.base?.ref;
  if (!head || !sha || !base) return { ok: false, why: `${repo}#${n} isn't a pull request (or isn't visible).` };
  const files: Changed[] = await loadPrFiles(ghe, repo, n);
  const { stories, dirs } = touched(files);
  const seen = new Set(stories.map((s) => s.path));
  const nearby: Changed[] = [];
  for (const dir of dirs.slice(0, MAX_DIRS))
    for (const path of await storiesIn(ghe, repo, dir, sha))
      if (!seen.has(path)) {
        seen.add(path);
        nearby.push({ path, status: "nearby" });
      }
  const all = [...stories, ...nearby];
  const read = await Promise.all(
    all.slice(0, MAX_FILES).map(async (f): Promise<StoryFile | undefined> => {
      const removed = f.status === "removed";
      const src = await textAt(ghe, repo, f.path, removed ? base : sha);
      if (src === undefined) return undefined;
      const { title, exports } = parseStories(f.path, src);
      const status = removed ? "removed" : f.status === "added" ? "added" : f.status === "nearby" ? "nearby" : "changed";
      return { path: f.path, title, status, stories: exports.map((e) => ({ id: storyId(title, e), name: e })) };
    }),
  );
  return { ok: true, head, base, sha, branch: head, files: read.filter((x): x is StoryFile => !!x && x.stories.length > 0), more: Math.max(0, all.length - MAX_FILES) };
}

const STATUS: Record<StoryFile["status"], string> = { added: "new in this PR", removed: "removed in this PR", changed: "changed", nearby: "beside a changed file" };

/** The page's body: each stories file, each story before (base) and after (the PR) in frames. */
export function storiesBody(o: { repo: string; n: number; prUrl: string; found: Found | "reading"; roots?: { head: string; base: string } }): Html {
  const header = PageHeader({
    title: html`Stories in ${o.repo}#${o.n}`,
    sub: "Before (the base branch's Storybook) and after (this PR's), side by side",
    crumbs: [{ href: "/prs", label: "PRs" }, { href: safeUrl(o.prUrl), label: `${o.repo}#${o.n}` }],
  });
  if (o.found === "reading") return html`${header}<section class="pending" data-pending aria-busy="true"><span class="spinner" aria-hidden="true"></span><p class="t2">Reading the PR's stories…</p></section>`;
  if (!o.found.ok) return html`${header}${Notice({ tone: "bad", children: o.found.why })}`;
  const { files, more } = o.found;
  const roots = o.roots!;
  if (!files.length) return html`${header}${Empty({ title: "No stories here", children: html`<p>This PR changes no stories file, and none sits beside the files it changes.</p>` })}`;
  let left = MAX_FRAMES;
  const side = (label: string, root: string, story: Story, gone: string | false) =>
    html`<figure class="sb-side"><figcaption><span>${label}</span>${gone ? "" : html` <a href="${safeUrl(openUrl(root, story.id))}" target="_blank" rel="noopener noreferrer">open</a>`}</figcaption>${
      gone ? html`<div class="sb-gone t2">${gone}</div>` : html`<iframe class="sb-frame" src="${safeUrl(frameUrl(root, story.id))}" title="${label}: ${story.name}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>`
    }</figure>`;
  const pair = (f: StoryFile, s: Story) => {
    if (left <= 0) return html`<li><a href="${safeUrl(openUrl(roots.base, s.id))}" target="_blank" rel="noopener noreferrer">${s.name}</a> before · <a href="${safeUrl(openUrl(roots.head, s.id))}" target="_blank" rel="noopener noreferrer">after</a></li>`;
    left--;
    return html`<li class="sb-pair"><h3>${s.name}</h3><div class="sb-sides">${side("Before", roots.base, s, f.status === "added" && "Not in the base branch")}${side("After", roots.head, s, f.status === "removed" && "Removed in this PR")}</div></li>`;
  };
  return html`${header}
    <p class="t2">The frames are Storybook's own pages, drawn by this browser with its sign-in: if one asks to sign in or stays blank, <a href="${safeUrl(roots.head)}" target="_blank" rel="noopener noreferrer">open the Storybook</a> once, then come back.</p>
    ${files.map((f) =>
      Panel({ title: f.title, meta: html`<code>${f.path}</code> · ${STATUS[f.status]}`, children: html`<ul class="sb-list">${f.stories.map((s) => pair(f, s))}</ul>` }),
    )}
    ${more ? html`<p class="t2">${more} more stories ${more === 1 ? "file" : "files"} not read.</p>` : ""}`;
}

export function storybookPack(d: StorybookDeps): Pack {
  const cache = new Map<string, { at: number; p: Promise<Found & { sha?: string; branch?: string }> }>();
  const books = (env: Record<string, string | undefined>) => booksOf(env.STORYBOOK);
  return {
    manifest: {
      api: PACK_API,
      id: "storybook",
      name: "Storybook",
      description: "A PR's stories before and after, from the Storybook CI publishes",
      domain: "general",
      settings: [
        {
          key: "STORYBOOK",
          label: "Published Storybooks",
          required: true,
          help: "owner/repo, the PR's Storybook URL, then the base branch's, split by ; — e.g. acme/web https://acme.github.io/web/pr-{pr}/ https://acme.github.io/web/{base}/ ({pr}, {branch}, {base}, {sha})",
        },
      ],
    },
    frames: (ctx) => books(ctx.env).flatMap((b) => [originOf(b.head), originOf(b.base)].filter((o): o is string => !!o)),
    slots: (ctx) => ({
      "pr.facts": ({ repo, number }) => (bookOf(books(ctx.env), repo) ? [["Stories", html`<a href="/storybook/${enc(repo)}/${number}">before and after</a>`]] : []),
    }),
    routes: (app, ctx) => {
      app.get("/storybook/:owner/:repo/:n{[0-9]+}", async (c) => {
        const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
        const n = Number(c.req.param("n"));
        const book: Book | undefined = bookOf(books(ctx.env), repo);
        if (!book || !owns(d.owners(), repo.split("/")[0]!)) return c.notFound();
        const key = `${book.repo}#${n}`;
        let hit = cache.get(key);
        if (!hit || Date.now() - hit.at > 60e3) {
          const p = findStories(d.ghe, book.repo, n).catch((e) => (cache.delete(key), { ok: false as const, why: `The PR's files didn't load: ${String((e as Error)?.message ?? e)}` }));
          hit = { at: Date.now(), p };
          cache.set(key, hit);
          if (cache.size > 50) cache.delete(cache.keys().next().value as string);
        }
        const found = await Promise.race([hit.p, new Promise<"reading">((res) => setTimeout(() => res("reading"), 1500))]);
        const vars = found !== "reading" && found.ok ? { pr: n, branch: found.branch!, base: found.base, sha: found.sha! } : undefined;
        const roots = vars ? { head: urlOf(book.head, vars), base: urlOf(book.base, vars) } : undefined;
        const prUrl = `https://${d.ghe.host}/${book.repo}/pull/${n}`;
        return ctx.page(c, { title: `Stories · ${book.repo}#${n}`, current: "/prs", body: storiesBody({ repo: book.repo, n, prUrl, found, roots }) });
      });
    },
  };
}
