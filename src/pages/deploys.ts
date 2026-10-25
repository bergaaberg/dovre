/** Deploys waiting for my approval, with the decision buttons, and the log of what I decided here. */
import type { RefRule } from "../packs/types.ts";
import { html } from "hono/html";
import type { Logged } from "../actions/deploys.ts";
import { type Frame, shell } from "../html.ts";
import type { Snapshot } from "../gather.ts";
import { Confirm, Empty, type Html, Item, List, Notice, PageHeader, Panel, Pill } from "../ui/kit.ts";
import { changelogBlock, type SummaryOf } from "./inline.ts";
import { Ago, Link, failed, safeUrl } from "./parts.ts";

export function deploysPage(frame: Frame, s: Snapshot, opts: { log: Logged[]; flash?: { ok: boolean; message: string }; decided?: ReadonlyMap<number, { state: "approved" | "rejected" }>; summary: SummaryOf; /** The packs' kinds of reference. */ rules?: RefRule[]; ghe: string; /** What the packs say is in prod for the repo ("deploy.prod"). */ prodLine?: (repo: string) => Html | ""; /** The forge approves deploys from here (default yes); else the page only lists them. */ approve?: boolean }) {
  const decided = opts.decided ?? new Map();
  // What was decided here but isn't gathered yet: the decision shows, not the buttons; rejected superseded runs aren't counted.
  const deploys = (s.deploys.ok ? s.deploys.value : []).map((d) => ({ ...d, superseded: d.superseded.filter((r) => !decided.has(r.id)) }));
  const stale = deploys.reduce((n, d) => n + d.superseded.length, 0);
  const rows = deploys.map((d) => {
    const short = d.repo.replace(`${s.org}/`, "");
    const fields = { repo: d.repo, run: String(d.id) };
    return Item({
      lead: html`<span class="kind bad">${d.envs.map((e) => e.name).join(", ")}</span>`,
      title: html`<strong>${short}</strong> ${Link(d.url, html`${d.title}`)}`,
      line: `${d.name} · ${d.branch} · ${d.sha} · by ${d.actor}`,
      trail: Ago(d.createdAt),
      more: html`${opts.prodLine ? opts.prodLine(d.repo) : ""}${changelogBlock(s.changelogs.get(d.id), opts)}${decided.has(d.id) ? Pill({ tone: decided.get(d.id)!.state === "approved" ? "ok" : "bad", children: `${decided.get(d.id)!.state === "approved" ? "Approved" : "Rejected"} · updating` }) : opts.approve === false ? "" : html`<span class="actions">${Confirm({ action: "/deploys/approve", fields, label: "Approve", question: html`Approve <strong>${short}</strong> ${d.sha} to ${d.envs.map((e) => e.name).join(", ")}?` })}${Confirm({
        action: "/deploys/reject",
        fields,
        label: "Reject",
        danger: true,
        question: html`Reject <strong>${short}</strong> ${d.sha}? The run ends without deploying.`,
      })}${
        d.superseded.length
          ? Confirm({
              action: "/deploys/reject-superseded",
              fields: { repo: d.repo, workflow: d.name },
              label: `Reject ${d.superseded.length}${d.more ? "+" : ""} superseded`,
              danger: true,
              question: html`Reject the ${d.superseded.length}${d.more ? "+" : ""} older waiting runs of <strong>${d.name}</strong> in ${short}, back to ${new Date(d.superseded[d.superseded.length - 1]!.createdAt).toLocaleDateString("en-GB")}? They end as rejected (a red run on old commits). This one stays waiting.`,
            })
          : ""
      }</span>`}`,
    });
  });
  const body = html`${PageHeader({ title: "Deploys", sub: deploys.length ? `${deploys.length} waiting${opts.approve === false ? "" : " for you"}${stale ? `, with ${stale} superseded runs behind them` : ""}.` : "Nothing waits for your approval." })}
${opts.flash ? Notice({ tone: opts.flash.ok ? "ok" : "bad", children: opts.flash.message }) : ""}
<div data-live id="deploys">${failed("Deploys", s.deploys)}
${Panel({ title: "Waiting for you", meta: String(deploys.length), flush: true, children: deploys.length ? List(rows) : Empty({ title: "Nothing waiting" }) })}
${Panel({
  title: "Decided here",
  meta: String(opts.log.length),
  actions: html`<a href="/actions">All actions</a>`,
  flush: true,
  children: opts.log.length
    ? List(opts.log.map((a) => Item({ lead: Pill({ tone: a.ok ? "ok" : "bad", children: a.ok ? "done" : "failed" }), title: html`${a.kind} · ${a.target}`, line: a.error ?? a.detail ?? undefined, trail: Ago(a.at) })))
    : Empty({ title: "Nothing yet" }),
})}</div>`;
  return shell({ title: "Deploys · Dovre", frame, current: "/deploys", body });
}
