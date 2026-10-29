/**
 * Investigate (#214): something a pack shows me (an open signal) handed on with one click, to Bino
 * or to a new agent session that reads and reports. The pack puts the prompt in the link
 * (`investigateHref`, in the kit); this page shows it, to change before it goes anywhere. What a
 * pack writes there follows Bino's rule: names, states and counts, nothing a private page shows.
 */
import { html } from "hono/html";
import type { Frame } from "../html.ts";
import { shell } from "../html.ts";
import { safeUrl } from "./parts.ts";
import { type Html, Notice, PageHeader, Panel } from "../ui/kit.ts";

/** Longest prompt carried in the link. */
export const INVESTIGATE_MAX = 4000;

export type Investigate = { prompt: string; repo: string; from: string };

/** What the link carried, cleaned: the prompt cut to size, a repo as owner/name or a checkout's name, the page it came from as a path here. */
export function investigateOf(q: { prompt?: string; repo?: string; from?: string }): Investigate {
  const prompt = (q.prompt ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").trim().slice(0, INVESTIGATE_MAX);
  const repo = /^[\w.-]{1,100}(\/[\w.-]{1,100})?$/.test(q.repo ?? "") && !(q.repo ?? "").includes("..") ? q.repo! : "";
  const from = (q.from ?? "").startsWith("/") && !(q.from ?? "").startsWith("//") ? (q.from ?? "").slice(0, 300) : "";
  return { prompt, repo, from };
}

/** The page: the prompt to change, then Ask Bino or Start an agent (plan mode: it reads and reports, and changes nothing). */
export function investigatePage(frame: Frame, v: Investigate, o: { bino: boolean; agents: boolean }): Html {
  const none = !o.bino && !o.agents;
  const form = html`<form method="post" action="/bino/new">
<label class="field"><span class="label">What to look into</span><textarea name="prompt" rows="10" maxlength="${INVESTIGATE_MAX}" required>${v.prompt}</textarea><span class="hint">Change it as you like: nothing goes anywhere before you press a button.</span></label>
${v.repo ? html`<input type="hidden" name="repo" value="${v.repo}">` : ""}<input type="hidden" name="mode" value="plan">
<div class="buttons">${o.bino ? html`<button type="submit" class="primary" data-busy="Asking">Ask Bino</button>` : ""}${
    o.agents ? html`<button type="submit" class=${o.bino ? html`"ghost"` : html`"primary"`} formaction="/agents/new" formmethod="get">Start an agent</button>` : ""
  }</div>
${o.agents ? html`<p class="hint t3">The agent starts in plan mode${v.repo ? html` in a checkout of <code>${v.repo}</code>` : ""}: it reads the code, logs and deploys and reports, and changes nothing. You pick where it runs on the next page.</p>` : ""}
</form>`;
  const body = html`${PageHeader({ title: "Investigate", sub: v.from ? html`From <a href="${safeUrl(v.from)}">${v.from}</a>` : undefined })}
${none ? Notice({ tone: "warn", children: "Neither Bino nor agents are on here, so there's nothing to hand this to." }) : ""}
${v.prompt ? Panel({ children: form }) : Notice({ children: "There's nothing to investigate: the link carried no prompt." })}`;
  return shell({ title: "Investigate", frame, current: v.from || "/", body });
}
