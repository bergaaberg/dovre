/**
 * Auto runs in the agents pack (#207): the needs they leave on Today, and their panel on
 * Settings → Packs → Agents (the limits, and the latest issues picked up). The loop itself is
 * src/actions/auto.ts; the pack calls it from `refresh`.
 */
import { html } from "hono/html";
import type { AutoPass } from "../../../actions/auto.ts";
import type { AutoRow, AutoSettings } from "../../../agents/auto.ts";
import { AUTO_LABEL } from "../../../agents/auto.ts";
import { Ago, safeUrl } from "../../../pages/parts.ts";
import { Empty, Item, List, Pill, type Tone } from "../../../ui/kit.ts";
import type { PackNeed } from "../../types.ts";

const DAY = 86_400_000;
const issueUrl = (host: string, r: Pick<AutoRow, "repo" | "number">) => `https://${host}/${r.repo}/issues/${r.number}`;
const name = (r: Pick<AutoRow, "repo" | "number">) => `${r.repo.split("/")[1]}#${r.number}`;

/** What waits for me: a PR to OK, a run that got stuck (for a day), one that can't start, and the day's cap. */
export function autoNeeds(pass: AutoPass | undefined, host: string, now: number): PackNeed[] {
  if (!pass) return [];
  const out: PackNeed[] = [];
  for (const r of pass.rows) {
    const base = { label: "Auto run", at: r.updated, line: r.why ?? r.title };
    if (r.state === "waiting" && r.run)
      out.push({ ...base, key: `auto:${r.key}:waiting:${r.at}`, ring: "agent-auto", rank: 1, title: `The draft PR for ${name(r)} waits for your OK`, href: `/agents/r/${encodeURIComponent(r.run)}`, tone: "accent" });
    else if (r.state === "stuck" && now - r.updated < DAY)
      out.push({ ...base, key: `auto:${r.key}:stuck:${r.at}`, ring: "agent-auto", rank: 1, title: `The auto run for ${name(r)} got stuck`, href: r.run ? `/agents/r/${encodeURIComponent(r.run)}` : safeUrl(issueUrl(host, r)), tone: "warn" });
    else if (r.state === "queued" && r.why)
      out.push({ ...base, key: `auto:${r.key}:queued:${r.why}`, rank: 2, title: `The auto run for ${name(r)} can't start`, href: "/settings/packs/agents", tone: "warn" });
  }
  if (pass.paused && pass.rows.some((r) => r.state === "queued"))
    out.push({ key: `auto:paused:${pass.paused}`, label: "Auto runs", at: now, rank: 3, title: "Auto runs are paused", line: pass.paused, href: "/settings/packs/agents", tone: "neutral" });
  return out;
}

const STATE: Record<AutoRow["state"], { label: string; tone?: Tone }> = {
  queued: { label: "queued" },
  starting: { label: "starting" },
  running: { label: "running", tone: "accent" },
  waiting: { label: "PR waits for you", tone: "accent" },
  done: { label: "done", tone: "ok" },
  stuck: { label: "stuck", tone: "warn" },
  refused: { label: "refused", tone: "bad" },
};

/** The panel: the limits as a form, then the latest issues and where each one is. */
export function autoPanel(s: AutoSettings, pass: AutoPass | undefined, host: string, tz?: string) {
  const v = (n: number) => String(Math.round(n * 100) / 100);
  const form = html`<form method="post" action="/agents/auto">
<p class="t2">Open issues in your repos that you label <code>${AUTO_LABEL}</code> are picked up on their own: Claude Code works on each in a sandbox run, then a draft PR, a comment on the issue, and the label swapped for <code>${AUTO_LABEL}-done</code> or <code>${AUTO_LABEL}-stuck</code>. Only a label an owner put there counts. An issue can narrow these in a fenced <code>dovre</code> block: <code>model</code>, <code>effort</code>, <code>budget</code>, <code>minutes</code>, <code>base</code>.</p>
<div class="field"><label class="check"><input type="checkbox" name="on" value="on"${s.on ? html` checked` : ""}> Pick up labelled issues</label></div>
<div class="fields aligned">
<label class="field"><span class="label">At once</span><input type="number" name="atOnce" min="1" max="5" value="${s.atOnce}"><span class="hint">runs going at the same time</span></label>
<label class="field"><span class="label">Cost per run</span><input type="number" name="runUsd" min="0.5" max="100" step="0.5" value="${v(s.runUsd)}"><span class="hint">dollars: Claude Code stops there</span></label>
<label class="field"><span class="label">Cost per day</span><input type="number" name="dayUsd" min="0.5" max="500" step="0.5" value="${v(s.dayUsd)}"><span class="hint">dollars over 24 hours: nothing new starts past it</span></label>
<label class="field"><span class="label">Wall clock</span><input type="number" name="minutes" min="5" max="240" value="${s.minutes}"><span class="hint">minutes a run may take before it's stopped</span></label>
<label class="field"><span class="label">Quiet from</span><input type="number" name="quietFrom" min="0" max="23" value="${s.quiet ? String(s.quiet.from) : ""}"><span class="hint">hour (${tz || "this machine's zone"}): nothing new starts…</span></label>
<label class="field"><span class="label">Quiet until</span><input type="number" name="quietTo" min="0" max="23" value="${s.quiet ? String(s.quiet.to) : ""}"><span class="hint">…until this hour. Empty: no quiet hours.</span></label>
</div>
<label class="field"><span class="label">Repos left out</span><input type="text" name="off" value="${s.off.join(", ")}" placeholder="owner/name, owner/name"><span class="hint">Labelled issues there wait until you take a repo off this list.</span></label>
<div class="buttons"><button type="submit" class="primary">Save</button></div>
</form>`;
  const rows = (pass?.rows ?? []).slice(0, 15);
  const list = rows.length
    ? List(
        rows.map((r) => {
          const st = STATE[r.state];
          return Item({
            href: safeUrl(issueUrl(host, r)),
            title: html`<strong>${name(r)}</strong> ${r.title} ${Pill({ tone: st.tone, children: st.label })}`,
            line: html`${r.why ?? ""}${r.pr ? html` <a href="${safeUrl(r.pr)}">Its draft PR</a>` : ""}${r.run && r.state !== "refused" ? html` <a href="/agents/r/${encodeURIComponent(r.run)}">Its run</a>` : ""}`,
            trail: html`${r.cost ? `$${r.cost.toFixed(2)} · ` : ""}${Ago(r.updated)}`,
          });
        }),
      )
    : Empty({ title: "No labelled issues picked up yet" });
  return html`${form}${pass?.paused ? html`<p class="t2">${pass.paused}</p>` : ""}${list}`;
}
