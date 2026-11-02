/**
 * A small Markdown renderer for PR and issue bodies: headings, lists (with task boxes), quotes,
 * fenced code, tables, paragraphs; inline code, bold, italic, strike, links and bare URLs.
 * Built from `html` fragments, so every piece of text is escaped; links go through safeUrl and
 * open in a new tab. Raw HTML in the source is shown as text, comments are dropped.
 *
 * A closed fence names its language as `data-lang` (lowercase; `mermaid`, `dot`), so a pack's
 * script may draw it in place, the source staying as it is without one. A fence still open at
 * the end (an answer being written) gets none: it isn't finished.
 *
 * Math is marked the same way, for a pack to draw: `$…$` and `` $`…`$ `` as `<code data-tex>`, a
 * `$$` block as a `math` fence. A `$` after a space doesn't close (`$5 and $6` is money), nor one
 * before a digit; a `$$` block still open at the end stays as text.
 */
import { html } from "hono/html";
import type { Child, Html } from "./kit.ts";
import { newTab } from "./kit.ts";

function safeHref(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "#";
  } catch {
    return "#";
  }
}

const link = (href: string, children: Child) => {
  const h = safeHref(href);
  return html`<a href="${h}"${newTab(h)}>${children}</a>`;
};

const INLINE = /(\$`[^`\n]+`\$|(?<![\\\w$])\$(?:[^\s$\\]|[^\s$][^$\n]*?[^\s\\])\$(?![\d$]))|(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*[^*\s][^*\n]*\*|\b_[^_\s][^_\n]*_\b)/g;

export function inline(text: string): Child[] {
  const out: Child[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    const [all, math, code, bold, strike, mdLink, url, em] = m;
    if (math) out.push(html`<code data-tex>${math.startsWith("$`") ? math.slice(2, -2) : math.slice(1, -1)}</code>`);
    else if (code) out.push(html`<code>${code.slice(1, -1)}</code>`);
    else if (bold) out.push(html`<strong>${inline(bold.slice(2, -2))}</strong>`);
    else if (strike) out.push(html`<s>${inline(strike.slice(2, -2))}</s>`);
    else if (mdLink) {
      const [, label, href] = mdLink.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      out.push(link(href!, inline(label!)));
    } else if (url) out.push(link(url, url));
    else if (em) out.push(html`<em>${inline(em.slice(1, -1))}</em>`);
    else out.push(all);
    at = m.index! + all.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function markdown(source: string, opts: { headingOffset?: number } = {}): Html {
  const text = source.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const lines = text.split("\n");
  const blocks: Html[] = [];
  const off = opts.headingOffset ?? 2;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)\s*([A-Za-z][\w+-]{0,31})?/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      const lang = i < lines.length && fence[2] ? fence[2].toLowerCase() : "";
      i++;
      blocks.push(lang ? html`<pre class="code" data-lang="${lang}">${body.join("\n")}</pre>` : html`<pre class="code">${body.join("\n")}</pre>`);
      continue;
    }
    const tex = line.match(/^\s*\$\$(.*)$/);
    if (tex) {
      const one = tex[1]!.trim().match(/^(.+?)\$\$$/);
      let end = i + 1;
      if (!one && !tex[1]!.trim()) while (end < lines.length && lines[end]!.trim() !== "$$") end++;
      if (one || (!tex[1]!.trim() && end < lines.length)) {
        const body = one ? one[1]!.trim() : lines.slice(i + 1, end).join("\n");
        blocks.push(html`<pre class="code" data-lang="math">${body}</pre>`);
        i = one ? i + 1 : end + 1;
        continue;
      }
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(6, h[1]!.length + off);
      const content = inline(h[2]!.replace(/\s+#+\s*$/, ""));
      blocks.push(
        level <= 3 ? html`<h3 class="md-h">${content}</h3>` : level === 4 ? html`<h4 class="md-h">${content}</h4>` : html`<h5 class="md-h">${content}</h5>`,
      );
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push(html`<blockquote>${markdown(body.join("\n"), opts)}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      blocks.push(
        html`<div class="table-wrap"><table class="data"><thead><tr>${head.map((c) => html`<th>${inline(c)}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${inline(c)}</td>`)}</tr>`)}</tbody></table></div>`,
      );
      continue;
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: { task?: boolean; done?: boolean; parts: string[] }[] = [];
      while (i < lines.length && (bullet.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const l = lines[i++]!;
        if (!bullet.test(l)) {
          items[items.length - 1]!.parts.push(l.trim());
          continue;
        }
        const body = l.replace(bullet, "");
        const task = body.match(/^\[([ xX])\]\s+(.*)$/);
        items.push(task ? { task: true, done: task[1] !== " ", parts: [task[2]!] } : { parts: [body] });
      }
      const lis = items.map((it) =>
        it.task
          ? html`<li class="${it.done ? "task done" : "task"}"><span class="box" aria-hidden="true">${it.done ? "☑" : "☐"}</span> ${inline(it.parts.join(" "))}</li>`
          : html`<li>${inline(it.parts.join(" "))}</li>`,
      );
      blocks.push(ordered ? html`<ol class="md-list">${lis}</ol>` : html`<ul class="md-list">${lis}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*\$\$|\s*```|\s*~~~|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    if (!para.length) {
      blocks.push(html`<p>${inline(line)}</p>`);
      i++;
      continue;
    }
    blocks.push(html`<p>${inline(para.join(" "))}</p>`);
  }
  return html`<div class="md">${blocks}</div>`;
}
