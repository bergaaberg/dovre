/**
 * Reporting a bug in Dovre (#384): from any page, to the repo behind it. Core's pages and its own
 * packs go to Dovre's repo, a pack from dovre-packs to dovre-packs, an instance's own pack to the
 * instance repo. Two ways out: a prefilled issues/new link opened under my own GitHub login (no
 * token write, so it works where the repo is outside REPO_OWNERS), or filed by the token, re-checked
 * and logged as `bug.file`.
 */
import { logAction, repoIn } from "./actions/deploys.ts";
import type { D1 } from "./db.ts";
import { HOME_SOURCE } from "./packs/releases.ts";
import type { Ghe } from "./sources/ghe.ts";

/** Dovre's own repo: where core's bugs go. */
export const CORE_REPO = "bergaaberg/dovre";

export type Home = "core" | "packs" | "instance";
export type Where = { home: Home; repo: string; label: string };
/** A pack that owns a path: its id, name and where it comes from. */
export type PackHome = { id: string; name: string; home: Home };

export const MAX_TITLE = 200;
export const MAX_WHAT = 6000;
const MAX_ERROR = 600;
/** GitHub turns away very long issues/new links: the body is cut to fit under this. */
const MAX_LINK = 7500;

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, "").trim().slice(0, max) : "");
const oneLine = (s: unknown, max: number) => clean(s, max * 2).replace(/\s+/g, " ").slice(0, max);

/** The places a report can go here: Dovre's repo, dovre-packs, and the instance repo when there is one. */
export function wheres(instance?: string | null): Where[] {
  const out: Where[] = [
    { home: "core", repo: CORE_REPO, label: "Dovre itself" },
    { home: "packs", repo: HOME_SOURCE, label: "A pack from dovre-packs" },
  ];
  if (instance) out.push({ home: "instance", repo: instance, label: "This instance's own packs" });
  return out;
}

/** A page path from a form or a Referer: same app, a path only, short. Anything else is "". */
export function pathOf(raw: unknown, host?: string): string {
  if (typeof raw !== "string" || !raw) return "";
  let p = raw;
  if (!raw.startsWith("/")) {
    try {
      const u = new URL(raw);
      if (!host || u.host !== host) return "";
      p = u.pathname + u.search;
    } catch {
      return "";
    }
  }
  if (p.startsWith("//") || /[\u0000-\u001f\u007f\s]/.test(p)) return "";
  // Coming from the bug page itself says nothing about where the bug is.
  if (p === "/bug" || p.startsWith("/bug?") || p.startsWith("/bug/")) return "";
  return p.slice(0, 300);
}

/** Where a report from this page goes by default, and the pack that owns the page if one does. */
export function whereFor(path: string, packOf: (seg: string) => PackHome | undefined, instance?: string | null): { home: Home; pack?: PackHome } {
  const seg = path.split(/[/?#]/)[1] ?? "";
  const pack = seg ? packOf(seg) : undefined;
  if (!pack) return { home: "core" };
  return { home: pack.home === "instance" && !instance ? "core" : pack.home, pack };
}

export type Report = { title: string; what: string; page: string; error: string; pack?: string; version: string; mode: "local" | "hosted" };

/** A report from a form's fields, checked. */
export function reportOf(f: Record<string, unknown>, o: { version: string; mode: "local" | "hosted" }): Report {
  return { title: oneLine(f.title, MAX_TITLE), what: clean(f.what, MAX_WHAT), page: pathOf(f.page), error: clean(f.error, MAX_ERROR), pack: oneLine(f.pack, 40) || undefined, version: oneLine(o.version, 40), mode: o.mode };
}

/** The context lines under what I wrote: what the page was, the error, which Dovre. */
export function contextOf(r: Report): string {
  const lines = [r.page && `- Page: \`${r.page.replace(/`/g, "")}\``, r.pack && `- Pack: ${r.pack}`, `- Dovre: ${r.version || "unknown"} (${r.mode})`];
  const err = r.error ? `\n\nError:\n\n\`\`\`\n${r.error.replace(/```/g, "'''")}\n\`\`\`` : "";
  return `${lines.filter(Boolean).join("\n")}${err}`;
}

export function bodyOf(r: Report): string {
  return `${r.what || "(no description)"}\n\n---\n${contextOf(r)}\n\n<sub>Reported from Dovre.</sub>`;
}

/** The issues/new link with title, body and the `bug` label filled in; a long body is cut to fit. */
export function linkOf(host: string, repo: string, r: Report): string {
  const base = `https://${host}/${repo}/issues/new`;
  const url = (body: string) => `${base}?${new URLSearchParams({ title: r.title, body, labels: "bug" })}`;
  let body = bodyOf(r);
  let u = url(body);
  while (u.length > MAX_LINK && body.length > 200) {
    body = `${body.slice(0, Math.floor(body.length * 0.8))}\n\n(cut to fit the link)`;
    u = url(body);
  }
  return u;
}

export type Filed = { ok: true; url: string; number: number } | { ok: false; error: string };

/**
 * Files the report with the token: the repo must be one of the owners' and take issues (read again
 * now, not from a cache), then one REST call. Logged either way.
 */
export async function fileBug(ghe: Ghe, db: D1, owners: string, repo: string, r: Report): Promise<Filed> {
  const at = repoIn(owners, repo);
  const fail = async (error: string): Promise<Filed> => {
    await logAction(db, { kind: "bug.file", target: repo.slice(0, 200), detail: r.title, ok: false, error }).catch(() => {});
    return { ok: false, error };
  };
  if (!at) return fail(`${repo} isn't one of ${owners.replace(/,/g, ", ")}'s repos, so Dovre won't file there. Open it on GitHub instead.`);
  if (!r.title) return fail("A bug needs a title.");
  try {
    const info = await ghe.rest<{ has_issues?: boolean; archived?: boolean }>(`/repos/${at}`);
    if (info.archived) return fail(`${at} is archived.`);
    if (info.has_issues === false) return fail(`${at} has issues turned off.`);
    const made = await ghe.rest<{ html_url: string; number: number }>(`/repos/${at}/issues`, { method: "POST", body: { title: r.title, body: bodyOf(r), labels: ["bug"] } });
    await logAction(db, { kind: "bug.file", target: `${at}#${made.number}`, detail: r.title, ok: true });
    return { ok: true, url: made.html_url, number: made.number };
  } catch (e) {
    return fail(String((e as Error)?.message ?? e).slice(0, 300));
  }
}
