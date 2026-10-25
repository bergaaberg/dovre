/**
 * Outlook: the inbox's newest, on /outlook and as a card on Today. What mail says is escaped like
 * any other text; links go only to Outlook's own hosts (src/teams/outlook.ts) and through safeUrl.
 */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import type { OutlookView } from "../teams/outlook.ts";
import { Empty, type Html, Item, List, Notice, PageHeader, Panel, Pill } from "../ui/kit.ts";
import { Ago, Link, safeUrl } from "./parts.ts";

const st = (tone: "ok" | "warn" | "bad" | "acc" | "mute", text: unknown) => html`<span class="st ${tone}"><i></i>${text}</span>`;

function mailPanel(v: OutlookView): Html {
  if (!v.mail) return Panel({ title: "Inbox", children: v.mailError ? Notice({ tone: "bad", children: v.mailError }) : html`<p class="notes">Reading…</p>` });
  const items = v.mail.items;
  return Panel({
    title: "Inbox",
    meta: v.mail.unread ? `${v.mail.unread} unread` : "all read",
    flush: true,
    children: html`${v.mailError ? Notice({ tone: "bad", children: html`<strong>The inbox didn't read just now.</strong> ${v.mailError} Showing what it said ${Ago(v.mail.at)}.` }) : ""}${
      items.length
        ? List(
            items.map((m) =>
              Item({
                href: m.webUrl ? safeUrl(m.webUrl) : undefined,
                lead: m.unread ? Pill({ tone: m.important ? "warn" : "accent", children: m.important ? "Important" : "New" }) : m.flagged ? Pill({ children: "Flagged" }) : "",
                title: html`<strong>${m.subject}</strong>`,
                line: html`${m.from}${m.focused ? "" : html` · <span class="t3">Other</span>`}`,
                clamp: m.preview || undefined,
                trail: Ago(m.at),
                quiet: !m.unread,
              }),
            ),
          )
        : Empty({ title: "The inbox is empty" })
    }`,
  });
}

function waiting(v: OutlookView): Html {
  return v.state === "off"
    ? Notice({ tone: "warn", children: "Outlook needs PowerShell 7 (pwsh) and Teams on." })
    : Notice({ children: html`<p><strong>Microsoft isn't connected.</strong> Outlook goes through the same sign-in as Teams: <a href="/teams">connect Teams</a> and this page fills in.</p>` });
}

const ABOUT = html`<p class="notes">Read-only, every two minutes, through the same Microsoft sign-in as Teams. Mail is held in memory only: never on disk, in logs or search, and never given to Claude or any other model.</p>`;

export function outlookPage(frame: Frame, v: OutlookView): Html {
  const body = html`${PageHeader({ title: "Outlook", actions: Link("https://outlook.office.com/mail/", "Open Outlook", "btn sm") })}
<div data-live id="outlook">${v.state !== "ok" ? waiting(v) : mailPanel(v)}</div>
${ABOUT}`;
  return shell({ title: "Outlook · Dovre", frame, current: "/outlook", body });
}

/** Today's card: unread in the inbox, the newest few. */
export function mailCard(v: OutlookView): Html | "" {
  if (v.state !== "ok" || (!v.mail && !v.mailError)) return "";
  const unread = (v.mail?.items ?? []).filter((m) => m.unread && m.focused);
  return html`<section class="card" id="mail-card" aria-labelledby="mail-h">
<div class="card-h"><h2 id="mail-h">Mail</h2><p>${v.mail ? (v.mail.unread ? st("acc", `${v.mail.unread} unread`) : st("ok", "all read")) : ""}</p></div>
${v.mailError ? html`<p class="notes">${st("bad", "Didn't read just now")} ${v.mailError}</p>` : ""}${
    unread.length
      ? html`<ul class="wts">${unread.slice(0, 4).map((m) => html`<li><span class="wt-n">${m.webUrl ? Link(m.webUrl, m.subject) : m.subject}</span><span class="wt-b">${m.from}</span><span class="wt-t">${Ago(m.at)}</span></li>`)}</ul>`
      : ""
  }
<div class="card-f"><span>${v.mail ? html`Read ${Ago(v.mail.at)}` : ""}</span><a href="/outlook">Inbox</a></div>
</section>`;
}
