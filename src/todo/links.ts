/**
 * References in what I write on my list, shown as links with what's known about them: a PR or
 * issue on GHE (a URL, `owner/repo#12` or `repo#12`), what a pack's apps call their things (its
 * `refs`: a ticket key, say), an agent session (its id) and plain links. Nothing is fetched for this: a PR's state
 * comes from the snapshot when it's there. The text itself stays text (html`` escapes it).
 */
import { html } from "hono/html";
import type { Html } from "../ui/kit.ts";
import { Pill } from "../ui/kit.ts";
import { safeUrl } from "../pages/parts.ts";
import type { RefRule } from "../packs/types.ts";

export type LinkCtx = {
  ghe: string;
  org: string;
  /** The packs' kinds of reference (src/packs/types.ts `refs`). */
  rules?: RefRule[];
  /** What's known about PRs, by "owner/repo#n". */
  prs: Map<string, { state: string; title?: string }>;
};

export type Ref =
  | { kind: "gh"; repo: string; number: number; url: string; state?: string; title?: string }
  | { kind: "app"; text: string; url: string }
  | { kind: "agent"; id: string; url: string }
  | { kind: "url"; url: string };

type Piece = string | Ref;

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const GH_RE = /(?<![\w./-])(?:([\w.-]+)\/)?([\w.-]+)#(\d{1,7})\b/g;
const SID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

function ghRef(ctx: LinkCtx, owner: string, repo: string, n: number, url?: string): Ref {
  const key = `${owner}/${repo}#${n}`;
  const known = ctx.prs.get(key);
  return { kind: "gh", repo: `${owner}/${repo}`, number: n, url: url ?? `https://${ctx.ghe}/${owner}/${repo}/issues/${n}`, state: known?.state, title: known?.title };
}

/**
 * Where the packs' rules match in `text`. A rule that throws, matches nothing sensible (empty,
 * over 64 characters) or gives no href is skipped; the href is checked by safeUrl when it's drawn.
 */
export function appRefs(text: string, rules: RefRule[] = []): { at: number; end: number; ref: Ref }[] {
  const out: { at: number; end: number; ref: Ref }[] = [];
  for (const rule of rules) {
    try {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
      for (const m of text.matchAll(re)) {
        if (!m[0] || m[0].length > 64) continue;
        const url = rule.href(m[0]);
        if (typeof url === "string" && url) out.push({ at: m.index!, end: m.index! + m[0].length, ref: { kind: "app", text: m[0], url } });
      }
    } catch {}
  }
  return out;
}

/** Splits text into plain runs and references, left to right, without overlaps. */
export function refsIn(text: string, ctx: LinkCtx): Piece[] {
  type Hit = { at: number; end: number; ref: Ref };
  const hits: Hit[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?)\]]+$/, "");
    const at = m.index!;
    const u = (() => {
      try {
        return new URL(raw);
      } catch {
        return undefined;
      }
    })();
    if (!u) continue;
    const gh = u.host === ctx.ghe ? u.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/) : null;
    const ref: Ref = gh ? ghRef(ctx, gh[1]!, gh[2]!, Number(gh[3]), raw) : { kind: "url", url: raw };
    hits.push({ at, end: at + raw.length, ref });
  }
  const free = (at: number, end: number) => !hits.some((h) => at < h.end && end > h.at);
  for (const m of text.matchAll(GH_RE)) {
    const at = m.index!;
    const end = at + m[0].length;
    if (free(at, end)) hits.push({ at, end, ref: ghRef(ctx, m[1] ?? ctx.org, m[2]!, Number(m[3])) });
  }
  for (const m of appRefs(text, ctx.rules)) if (free(m.at, m.end)) hits.push(m);
  for (const m of text.matchAll(SID_RE)) {
    const at = m.index!;
    const end = at + m[0].length;
    if (free(at, end)) hits.push({ at, end, ref: { kind: "agent", id: m[0], url: `/agents/s/${m[0]}` } });
  }
  hits.sort((a, b) => a.at - b.at);
  const out: Piece[] = [];
  let i = 0;
  for (const h of hits) {
    if (h.at > i) out.push(text.slice(i, h.at));
    out.push(h.ref);
    i = h.end;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

const newTab = (href: string) => (/^https?:/.test(href) ? html` target="_blank" rel="noopener noreferrer"` : "");
const TONE: Record<string, "ok" | "bad" | "accent" | undefined> = { OPEN: "accent", MERGED: "ok", CLOSED: "bad" };

/** One reference as a link (and its state, when the snapshot knows it). */
export function refLink(r: Ref, ctx: LinkCtx): Html {
  const href = safeUrl(r.url);
  if (r.kind === "gh") {
    const short = r.repo.startsWith(`${ctx.org}/`) ? r.repo.slice(ctx.org.length + 1) : r.repo;
    return html`<a class="ref" href="${href}"${newTab(href)}${r.title ? html` title="${r.title}"` : ""}>${short}#${r.number}</a>${r.state ? html` ${Pill({ tone: TONE[r.state], children: r.state.toLowerCase() })}` : ""}`;
  }
  if (r.kind === "app") return html`<a class="ref" href="${href}"${newTab(href)}>${r.text}</a>`;
  if (r.kind === "agent") return html`<a class="ref" href="${href}">agent ${r.id.slice(0, 8)}</a>`;
  let shown = r.url;
  try {
    const u = new URL(r.url);
    shown = (u.host + u.pathname).replace(/\/$/, "");
  } catch {}
  return html`<a href="${href}"${newTab(href)}>${shown.length > 48 ? `${shown.slice(0, 47)}…` : shown}</a>`;
}

/** Text with its references as links. */
export function linked(text: string, ctx: LinkCtx): Html {
  return html`${refsIn(text, ctx).map((p) => (typeof p === "string" ? p : refLink(p, ctx)))}`;
}

/** Just the references, for a line under the notes. */
export const refsOnly = (text: string, ctx: LinkCtx): Ref[] => refsIn(text, ctx).filter((p): p is Ref => typeof p !== "string");
