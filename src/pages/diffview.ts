/**
 * How a diff draws (core): a file's lines, unified or side by side, with its review threads, and
 * the folder tree beside a diff's files. The code explorer's local diff (src/pages/code.ts), the
 * PRs pack's Files tab and the reviews pack's draft page all draw with it.
 */
import { html } from "hono/html";
import type { Thread } from "../sources/prview.ts";
import { ConfirmSubmit, Confirm, type Html, Pill } from "../ui/kit.ts";
import { markdown } from "../ui/markdown.ts";
import { type DiffLine, type FileView, type Mark } from "../viewer/diff.ts";
import { fileTree, type TreeNode } from "../viewer/tree.ts";
import { MAX_BODY } from "../reviews/draft.ts";
import { Ago, Link } from "./parts.ts";

export const codeHref = (dir: string, o: { ref?: string; path?: string; q?: string } = {}) => {
  const q = new URLSearchParams();
  if (o.ref) q.set("ref", o.ref);
  if (o.path) q.set("path", o.path);
  if (o.q) q.set("q", o.q);
  const s = q.toString();
  return `/code/${encodeURIComponent(dir)}${s ? `?${s}` : ""}`;
};
/** A checkout's own diff (dovre#105): uncommitted by default, or two refs, or one commit. */
export const diffHref = (dir: string, o: { base?: string; head?: string; commit?: string; /** Side by side. */ split?: boolean } = {}) => {
  const q = new URLSearchParams();
  for (const k of ["base", "head", "commit"] as const) if (o[k]) q.set(k, o[k]!);
  if (o.split) q.set("view", "split");
  const s = q.toString();
  return `/code/${encodeURIComponent(dir)}/diff${s ? `?${s}` : ""}`;
};

export function comment(c: { author: string; body: string; at: string; url: string }): Html {
  return html`<li class="pr-comment" data-stop="2"><div class="pr-who"><strong>${c.author}</strong> ${Ago(c.at)}${c.url ? html` · ${Link(c.url, "↗")}` : ""}</div>${c.body.trim() ? html`<div class="description">${markdown(c.body, { headingOffset: 3 })}</div>` : ""}</li>`;
}

/** Replying to and resolving a thread (dovre#106), where the PR's page can: its base, and the tab to come back to. */
export type ThreadActs = { base: string; back: "files" | "conversation" };

function threadActs(t: Thread, a: ThreadActs): Html | "" {
  if (!t.id) return "";
  const fields = { thread: t.id, back: a.back };
  const reply = t.firstId
    ? html`<details class="thread-reply"><summary>Reply</summary><form method="post" action="${a.base}/threads/reply">${Object.entries(fields).map(([n, v]) => html`<input type="hidden" name="${n}" value="${v}">`)}<textarea name="body" rows="3" maxlength="${MAX_BODY}" required aria-label="Your reply" placeholder="Your reply (Markdown)"></textarea><div class="buttons">${ConfirmSubmit({ kind: "review.reply", label: "Reply", question: "Post this reply as you?" })}</div></form></details>`
    : "";
  const resolve = Confirm({ kind: "review.resolve", action: `${a.base}/threads/resolve`, fields: { ...fields, resolve: t.resolved ? "0" : "1" }, label: t.resolved ? "Reopen" : "Resolve", question: t.resolved ? "Reopen this thread?" : "Resolve this thread?" });
  return html`<div class="thread-acts">${reply}<div class="buttons">${resolve}</div></div>`;
}

export function threadView(t: Thread, o: { showPath?: boolean; acts?: ThreadActs } = {}): Html {
  const label = html`${o.showPath ? html`<code>${t.path}${t.line !== null ? `:${t.line}` : ""}</code> · ` : ""}${t.comments.length} ${t.comments.length === 1 ? "comment" : "comments"}${t.resolved ? " · resolved" : ""}${t.outdated ? " · outdated" : ""}`;
  return html`<details class="pr-thread" data-stop="2"${t.resolved || t.outdated ? "" : html` open`}><summary>${label}</summary><ol class="pr-comments">${t.comments.map(comment)}</ol>${o.acts ? threadActs(t, o.acts) : ""}</details>`;
}


// ── PR: files ────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, "ok" | "bad" | "warn" | undefined> = { added: "ok", removed: "bad", renamed: "warn" };

const LINE_CLASS = { add: "d-add", del: "d-del", ctx: "d-ctx" } as const;

/** What goes under a line besides its threads (the draft page's comment cards). */
export type LineExtra = (l: DiffLine) => Html | "";

/** Where a line's "+" goes (my own review, dovre#106): a comment on that side's line number. */
export type CommentAt = (side: "LEFT" | "RIGHT", line: number) => string;

/** A line's text, the words that changed in it marked. */
function marked(text: string, marks?: Mark[]): Html | string {
  if (!marks?.length) return text;
  const parts: (Html | string)[] = [];
  let at = 0;
  for (const [from, to] of marks) {
    if (from > at) parts.push(text.slice(at, from));
    parts.push(html`<mark class="d-w">${text.slice(from, to)}</mark>`);
    at = to;
  }
  if (at < text.length) parts.push(text.slice(at));
  return html`${parts}`;
}

type Code = Extract<DiffLine, { kind: "ctx" | "add" | "del" }>;
const half = (l: Code | undefined, side: "old" | "new") =>
  l ? html`<td class="ln ${LINE_CLASS[l.kind]}">${l[side] ?? ""}</td><td class="code ${LINE_CLASS[l.kind]}"><code>${marked(l.text, l.marks)}</code></td>` : html`<td class="ln d-empty"></td><td class="code d-empty"></td>`;

/** Side by side (dovre#105): the old file left, the new right; removed lines face the lines that took their place. */
function splitRows(lines: DiffLine[]): Html[] {
  const rows: Html[] = [];
  for (let i = 0; i < lines.length; ) {
    const l = lines[i]!;
    if (l.kind === "hunk" || l.kind === "note") {
      rows.push(html`<tr class="${l.kind === "hunk" ? "d-hunk" : "d-note"}"${l.kind === "hunk" ? html` data-stop="2"` : ""}><td class="ln"></td><td class="code${l.kind === "note" ? " t3" : ""}" colspan="3"><code>${l.text}</code></td></tr>`);
      i++;
    } else if (l.kind === "ctx") {
      rows.push(html`<tr>${half(l, "old")}${half(l, "new")}</tr>`);
      i++;
    } else {
      const dels: Code[] = [];
      const adds: Code[] = [];
      while (lines[i]?.kind === "del") dels.push(lines[i++] as Code);
      while (lines[i]?.kind === "add") adds.push(lines[i++] as Code);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push(html`<tr>${half(dels[k], "old")}${half(adds[k], "new")}</tr>`);
    }
  }
  return rows;
}

function lineRow(l: DiffLine, extra?: LineExtra, at?: CommentAt, acts?: ThreadActs): Html {
  if (l.kind === "hunk") return html`<tr class="d-hunk" data-stop="2"><td class="ln"></td><td class="ln"></td><td class="code"><code>${l.text}</code></td></tr>`;
  if (l.kind === "note") return html`<tr class="d-note"><td class="ln"></td><td class="ln"></td><td class="code t3">${l.text}</td></tr>`;
  const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
  const side = l.kind === "del" ? "LEFT" : "RIGHT";
  const line = side === "LEFT" ? l.old : l.new;
  const plus = at && line ? html`<a class="d-c" href="${at(side, line)}" data-side="${side}" data-line="${line}" aria-label="Comment on line ${line}" title="Comment (c)">+</a>` : "";
  return html`<tr class="${LINE_CLASS[l.kind]}"><td class="ln">${l.old ?? ""}</td><td class="ln">${l.new ?? ""}</td><td class="code">${plus}<code><span class="d-sign" aria-hidden="true">${sign}</span>${marked(l.text, l.marks)}</code></td></tr>${
    l.threads?.length ? html`<tr class="d-threads"><td colspan="3">${l.threads.map((t) => threadView(t, { acts }))}</td></tr>` : ""
  }${extra ? extra(l) : ""}`;
}

/** A diff's lines as a table: unified (with comments and threads, when given) or side by side. */
export function diffTable(lines: DiffLine[], o: { split?: boolean; extra?: LineExtra; at?: CommentAt; acts?: ThreadActs } = {}): Html {
  return html`<div class="diff-wrap"><table class="diff${o.split ? " split" : ""}"><tbody>${o.split ? splitRows(lines) : lines.map((l) => lineRow(l, o.extra, o.at, o.acts))}</tbody></table></div>`;
}

export const fileId = (path: string) => `f-${path.replace(/[^\w-]/g, "-")}`;

/** The folder tree beside a diff's files (dovre#299): sticky while they scroll, each file's link marked viewed by the page's script. */
function treeOf(views: FileView[], nodes: TreeNode[]): Html {
  return html`<ul>${nodes.map((n) => {
    if (n.dir) return html`<li class="dt-dir"><span class="dt-folder">${n.name}/</span>${treeOf(views, n.kids)}</li>`;
    const f = views[n.i]!.file;
    const mark = views[n.i]!.mine || views[n.i]!.drafts ? html` <span class="spark" title="Comments in your review">●</span>` : "";
    return html`<li><a href="#${fileId(f.path)}" title="${f.path}"><span class="dt-name">${n.name}${mark}</span><span class="dt-n"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></span></a></li>`;
  })}</ul>`;
}

/** A diff's files with their tree beside them; one file needs none. */
export function withTree(views: FileView[], list: Html): Html {
  if (views.length < 2) return list;
  return html`<div class="dfiles"><nav class="dfile-tree" aria-label="Files">${treeOf(views, fileTree(views.map((fv) => fv.file.path)))}</nav><div class="dfile-list">${list}</div></div>`;
}

/** One file of a diff. `extra` adds rows under lines; a file with draft comments starts open. */
export function fileView(fv: FileView, o: { sha: string; dir?: string; present: boolean; extra?: LineExtra; /** The "+" on each line, for this file. */ comment?: (path: string) => CommentAt; acts?: ThreadActs; /** Side by side: no comments or threads on lines (the local diff has none). */ split?: boolean; /** Pack buttons for this file ("pr.file" slot). */ more?: Html | "" }): Html {
  const f = fv.file;
  const name = f.previous && f.previous !== f.path ? html`<code>${f.previous}</code> → <code>${f.path}</code>` : html`<code>${f.path}</code>`;
  const view = o.dir && f.status !== "removed" ? (o.present ? html`<a class="btn sm ghost" href="${codeHref(o.dir, { ref: o.sha, path: f.path })}">View file</a>` : "") : "";
  const at = o.comment && f.patch !== undefined ? o.comment(f.path) : undefined;
  return html`<details class="dfile" id="${fileId(f.path)}" data-stop="1" data-stop-label="${f.path}"${at ? html` data-path="${f.path}"` : ""}${fv.folded && !fv.drafts && !fv.mine ? "" : html` open`}><summary><span class="dfile-name">${Pill({ tone: STATUS_TONE[f.status], children: f.status })} ${name}</span><span class="dfile-meta"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span>${
    fv.threads.length ? html` · ${fv.threads.length} ${fv.threads.length === 1 ? "thread" : "threads"}` : ""
  }${fv.drafts ? html` · <span class="spark">${fv.drafts} from the agent</span>` : ""}${fv.mine ? html` · <span class="spark">${fv.mine} pending</span>` : ""} <label class="viewed-label"><input type="checkbox" class="viewed" data-key="${o.sha}:${f.path}"> Viewed</label>${o.more ?? ""}${view}</span></summary>${fv.why ? html`<p class="dfile-why t3">${fv.why}</p>` : ""}${
    fv.unplaced.length ? html`<div class="dfile-threads">${fv.unplaced.map((t) => threadView(t, { showPath: true, acts: o.acts }))}</div>` : ""
  }${fv.lines.length ? diffTable(fv.lines, { split: o.split, extra: o.extra, at, acts: o.acts }) : ""}</details>`;
}

