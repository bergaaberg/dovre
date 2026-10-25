/**
 * Search's views (src/search/search.ts): the results as one list of links, which the palette
 * (Ctrl K, src/ui/app.js.ts) swaps in as you type, and the /search page that works without script.
 */
import { html } from "hono/html";
import { type Group, KINDS, type Kind } from "../search/search.ts";
import { type Frame, shell } from "../html.ts";
import { type Child, PageHeader, Panel } from "../ui/kit.ts";
import { safeUrl } from "./parts.ts";

/** The title with what was typed marked, where it appears as typed (case aside). */
function marked(title: string, q: string): Child {
  const t = q.trim();
  const i = t ? title.toLowerCase().indexOf(t.toLowerCase()) : -1;
  if (i < 0) return title;
  return html`${title.slice(0, i)}<mark>${title.slice(i, i + t.length)}</mark>${title.slice(i + t.length)}`;
}

/** The results: groups of links, each row an option of the palette's listbox. */
export function searchList(r: { q: string; groups: Group[] }): Child {
  let n = -1;
  const body = r.groups.length
    ? r.groups.map(
        (g) => html`<div role="group" aria-labelledby="pal-g-${g.id}"><p class="pal-grp" id="pal-g-${g.id}">${g.title}</p>${g.rows.map((row) => {
          n++;
          return html`<a class="pal-row" role="option" id="pal-o-${n}" aria-selected="false" href="${safeUrl(row.href)}"${row.out ? html` target="_blank" rel="noopener"` : ""}><span class="pal-ic" aria-hidden="true">${row.icon}</span><span class="pal-t">${marked(row.title, r.q)}</span>${row.sub ? html`<span class="pal-s">${row.sub}</span>` : ""}</a>`;
        })}</div>`,
      )
    : html`<p class="pal-empty">${r.q.trim() ? html`Nothing for “${r.q.trim()}”.` : "Type to search."}</p>`;
  return html`<div class="pal-list" id="pal-list" role="listbox" aria-label="Results">${body}</div>`;
}

export function searchPage(frame: Frame, r: { q: string; only?: Kind; groups: Group[]; total: number }, raw: string) {
  const tab = (id: Kind | undefined, label: string) => html`<a href="${safeUrl(`/search?q=${encodeURIComponent(r.q)}${id ? `&only=${id}` : ""}`)}"${r.only === id ? html` aria-current="page"` : ""}>${label}</a>`;
  const body = html`${PageHeader({ title: "Search", sub: html`Pages, pull requests, deploys, agents, worktrees and checkouts, My list. <kbd>Ctrl</kbd> <kbd>K</kbd> opens it from anywhere.` })}
<form method="get" action="/search" class="find"><label class="field"><span class="label">Search</span><input type="search" name="q" value="${raw}" maxlength="200" autofocus placeholder="A page, a PR number, a branch, an agent…"></label>${r.only ? html`<input type="hidden" name="only" value="${r.only}">` : ""}<div class="buttons"><button type="submit">Search</button></div></form>
<nav class="tabs" aria-label="Kinds">${tab(undefined, "Everything")}${KINDS.map((k) => tab(k.id, k.title))}</nav>
${Panel({ flush: true, children: searchList(r) })}`;
  return shell({ title: "Search · Dovre", frame, current: "/search", body });
}
