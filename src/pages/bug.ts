/**
 * /bug (#384): report a bug in Dovre from wherever it showed. The page you came from (the form's
 * `page`, else the Referer), an error an error page passed on, and which Dovre this is go under
 * what I write. Open on GitHub sends me to a prefilled issues/new under my own login; File it has
 * the token file it (write kind `bug.file`), only in the owners' repos.
 */
import { Hono } from "hono";
import { html } from "hono/html";
import { type Filed, fileBug, type Home, linkOf, MAX_TITLE, MAX_WHAT, type PackHome, pathOf, type Report, reportOf, wheres, whereFor, type Where } from "../bugs.ts";
import { owns } from "../owners.ts";
import { type Frame, shell } from "../html.ts";
import type { AppEnv } from "../env.ts";
import type { D1 } from "../db.ts";
import type { Ghe } from "../sources/ghe.ts";
import { ConfirmSubmit, Notice, PageHeader, Panel } from "../ui/kit.ts";
import { safeUrl } from "./parts.ts";

type BugView = { wheres: Where[]; home: Home; report: Report; /** Which of the wheres the token may file in. */ canFile: (repo: string) => boolean; nonce: string; filed?: { url: string; ref: string }; problem?: string };

function bugPage(frame: Frame, v: BugView) {
  const r = v.report;
  const where = html`<div class="field"><span class="label">Where it goes</span><span>${v.wheres.map(
    (w) => html`<label class="check"><input type="radio" name="where" value="${w.home}"${w.home === v.home ? html` checked` : ""}> ${w.label} <code>${w.repo}</code></label>`,
  )}</span><span class="hint">Picked from the page you came from.${v.wheres.some((w) => !v.canFile(w.repo)) ? html` ${v.wheres.filter((w) => !v.canFile(w.repo)).map((w) => w.repo).join(", ")} isn't among your owners' repos: open it on GitHub.` : ""}</span></div>`;
  const context = [r.page && html`<dt>Page</dt><dd class="mono">${r.page}</dd>`, r.pack && html`<dt>Pack</dt><dd>${r.pack}</dd>`, html`<dt>Dovre</dt><dd>${r.version || "unknown"} (${r.mode})</dd>`, r.error && html`<dt>Error</dt><dd class="mono">${r.error}</dd>`].filter(Boolean);
  const form = html`<form method="post" action="/bug">
<input type="hidden" name="nonce" value="${v.nonce}"><input type="hidden" name="page" value="${r.page}"><input type="hidden" name="error" value="${r.error}"><input type="hidden" name="pack" value="${r.pack ?? ""}">
${where}
<div class="field"><label class="label" for="bug-title">Title</label><input type="text" id="bug-title" name="title" value="${r.title}" maxlength="${MAX_TITLE}" required placeholder="What's wrong, in one line"></div>
<div class="field"><label class="label" for="bug-what">What happened</label><textarea id="bug-what" name="what" rows="6" maxlength="${MAX_WHAT}" placeholder="What you did, what you expected, what you got">\n${r.what}</textarea></div>
<div class="field"><span class="label">Added below it</span><dl class="facts">${context}</dl></div>
<div class="buttons"><button type="submit" name="how" value="link" class="primary" formtarget="_blank">Open on GitHub</button>${ConfirmSubmit({ label: "File it", name: "how", value: "file", kind: "bug.file", question: "File this as an issue with the GitHub token, labelled bug?" })}<span class="hint">Open on GitHub fills in a new issue for you to check and submit. File it creates it now.</span></div>
</form>`;
  const body = html`${PageHeader({ title: "Report a bug", sub: "A bug in Dovre or one of its packs, to the repo it belongs to." })}
${v.filed ? Notice({ tone: "ok", children: html`<p>Filed <a href="${safeUrl(v.filed.url)}">${v.filed.ref}</a>. Thanks.</p>` }) : ""}
${v.problem ? Notice({ tone: "bad", children: html`<p><strong>Not filed.</strong> ${v.problem}</p>` }) : ""}
${Panel({ children: form })}`;
  return shell({ title: "Report a bug · Dovre", frame, current: "/bug", body });
}

/** `https://<host>/<owner>/<repo>/issues/<n>` → `owner/repo#n`; anything else null. */
function filedRef(host: string, url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = url.match(/^https:\/\/([^/]+)\/([\w.-]+)\/([\w.-]+)\/issues\/(\d{1,9})$/);
  return m && m[1] === host ? `${m[2]}/${m[3]}#${m[4]}` : null;
}

export function createBugRoutes(o: {
  ghe: Ghe;
  db: D1;
  owners: () => string;
  frame: () => Promise<Frame>;
  /** The pack that owns a path's first segment, and where it comes from. */
  packOf: (seg: string) => PackHome | undefined;
  /** The instance repo, when there is one (INSTANCE_REPO). */
  instance: () => string | null;
  version: string;
  hosted: boolean;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const mode = o.hosted ? "hosted" : "local";
  const canFile = (repo: string) => owns(o.owners(), repo.split("/")[0]!);
  // A nonce once filed: the URL it made, so a second press doesn't file it twice.
  const spent = new Map<string, string>();
  const view = (report: Report, home: Home, extra: Partial<BugView> = {}): BugView => ({ wheres: wheres(o.instance()), home, report, canFile, nonce: crypto.randomUUID(), ...extra });

  app.get("/bug", async (c) => {
    const q = c.req.query();
    const host = new URL(c.req.url).host;
    const page = pathOf(q.from, host) || pathOf(c.req.header("referer"), host);
    const at = whereFor(page, o.packOf, o.instance());
    const report = reportOf({ ...q, page, pack: q.pack || at.pack?.id }, { version: o.version, mode });
    const filed = filedRef(o.ghe.host, q.filed);
    return c.html(bugPage(await o.frame(), view(report, at.home, filed ? { filed: { url: q.filed!, ref: filed } } : {})));
  });

  app.post("/bug", async (c) => {
    const f = (await c.req.parseBody()) as Record<string, unknown>;
    const report = reportOf(f, { version: o.version, mode });
    const all = wheres(o.instance());
    const where = all.find((w) => w.home === f.where) ?? all[0]!;
    const again = (status: 400 | 502, problem: string) => o.frame().then((fr) => c.html(bugPage(fr, view(report, where.home, { problem })), status));
    if (!report.title) return again(400, "A bug needs a title.");
    if (f.how === "link") return c.redirect(linkOf(o.ghe.host, where.repo, report), 303);
    const nonce = typeof f.nonce === "string" && /^[\w-]{8,64}$/.test(f.nonce) ? f.nonce : "";
    if (!nonce) return again(400, "File it from the form: nothing was filed.");
    const was = spent.get(nonce);
    if (was) return c.redirect(`/bug?filed=${encodeURIComponent(was)}`, 303);
    const r: Filed = await fileBug(o.ghe, o.db, o.owners(), where.repo, report);
    if (!r.ok) return again(502, r.error);
    spent.set(nonce, r.url);
    if (spent.size > 200) spent.delete(spent.keys().next().value!);
    return c.redirect(`/bug?filed=${encodeURIComponent(r.url)}`, 303);
  });
  return app;
}
