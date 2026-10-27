/**
 * Settings → What Dovre sends (#145): every call Dovre can make to Dovre's own services, and the
 * record of those it made. Hosted, what each machine's bridge sent the hub; on a machine, what its
 * bridge wrote down before sending (src/bridge/sentfile.ts). Field names and sizes only, never values.
 */
import { html } from "hono/html";
import type { ReceivedDay } from "../hosted/hub.ts";
import { bytes, count, when } from "../format.ts";
import { CATALOG, type FrameDay, KEEP_DAYS, type SentRecord } from "../sent.ts";
import { Empty, type Html, Item, List, Panel } from "../ui/kit.ts";

export type SentView = {
  hosted: boolean;
  /** Hosted: what machines sent the hub. */
  received?: ReceivedDay[];
  /** On a machine: what its bridge recorded, when it has a record. */
  machine?: SentRecord & { file: string };
};

const plural = (n: number, one: string) => `${count(n)} ${one}${n === 1 ? "" : "s"}`;

function catalogPanel(hosted: boolean): Html {
  return Panel({
    title: "Every call Dovre can make home",
    id: "catalog",
    meta: `${CATALOG.length} kinds`,
    flush: true,
    foot: html`<p class="t2">Nothing else goes to Dovre: no usage stats, no update checks, no error reports. Bino, GitHub and your packs talk to your own services with your own keys.${hosted ? "" : " This machine's server makes none of these calls; only its bridge does, when it's paired."}</p>`,
    children: List(
      CATALOG.map((c) =>
        Item({
          title: html`<strong>${c.what}</strong>`,
          line: html`${c.who} → ${c.to}`,
          more: html`Sends: ${c.sends}. When: ${c.when}. Recorded: ${c.recorded}.`,
        }),
      ),
    ),
  });
}

/** One line a day and source: each kind with its count and size. */
function dayItems<T extends { day: number; kind: string; count: number; bytes: number }>(rows: T[], keyOf: (r: T) => string, nameOf: (r: T) => string, now: number): Html[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = `${r.day} ${keyOf(r)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    const total = g.reduce((n, r) => n + r.bytes, 0);
    const frames = g.reduce((n, r) => n + r.count, 0);
    return Item({
      lead: html`<span class="t2">${when(g[0]!.day + 12 * 3600_000, now)}</span>`,
      title: nameOf(g[0]!),
      line: g.map((r, i) => html`${i ? " · " : ""}${r.kind} ×${count(r.count)} (${bytes(r.bytes)})`),
      trail: html`<span class="t2">${plural(frames, "frame")}, ${bytes(total)}</span>`,
    });
  });
}

function receivedPanel(rows: ReceivedDay[], now: number): Html {
  return Panel({
    title: "What your machines sent here",
    id: "received",
    meta: `last ${KEEP_DAYS} days`,
    flush: true,
    foot: html`<p class="t2">Counted by this cockpit as each frame arrives. Keep-alive pings are answered before they reach it, so they aren't counted here; each machine's own record (<code>dovre bridge sent</code>) has them.</p>`,
    children: rows.length ? List(dayItems(rows, (r) => r.machine, (r) => r.name, now)) : Empty({ title: "Nothing yet", children: html`No machine has sent anything in the last ${KEEP_DAYS} days.` }),
  });
}

function machinePanel(m: NonNullable<SentView["machine"]>, now: number): Html {
  const calls = m.calls.slice(0, 50);
  return html`${Panel({
    title: "Calls this machine's bridge made",
    id: "calls",
    meta: m.calls.length > calls.length ? `newest ${calls.length} of ${count(m.calls.length)}` : plural(m.calls.length, "call"),
    flush: true,
    foot: html`<p class="t2">From <code>${m.file}</code>, written as each call is made.</p>`,
    children: calls.length
      ? List(
          calls.map((c) =>
            Item({
              lead: html`<span class="t2">${when(c.at, now)}</span>`,
              title: html`<code>${c.method} ${c.host}${c.path}</code>`,
              line: html`${c.purpose}${c.fields.length ? html` · fields: ${c.fields.join(", ")}` : ""} · ${bytes(c.bytes)}`,
              trail: c.status ? html`<span class="t2">${c.status}</span>` : html`<span class="t2">no answer</span>`,
            }),
          ),
        )
      : Empty({ title: "No calls", children: html`None in the last ${KEEP_DAYS} days.` }),
  })}${Panel({
    title: "Frames this machine's bridge sent",
    id: "frames",
    meta: `last ${KEEP_DAYS} days`,
    flush: true,
    children: m.frames.length ? List(dayItems<FrameDay>(m.frames, (r) => r.host, (r) => r.host, now)) : Empty({ title: "None", children: html`No frames in the last ${KEEP_DAYS} days.` }),
  })}`;
}

export function sentPanels(v: SentView, now = Date.now()): Html {
  return html`<p class="t2">What Dovre sends to Dovre's own services, and the record of it: field names and sizes, never what was in them. <a href="/settings/sent.json" download>Download the record (JSON)</a></p>${catalogPanel(v.hosted)}${v.hosted ? receivedPanel(v.received ?? [], now) : ""}${v.machine ? machinePanel(v.machine, now) : v.hosted ? "" : Panel({ title: "This machine's bridge", id: "calls", children: Empty({ title: "No record here", children: html`This machine's bridge hasn't run, so nothing was sent.` }) })}`;
}
