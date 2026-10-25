/**
 * Teams: a card on Today (what's new, mentions first), /teams (connect, my chats, the store and the
 * crawler), /teams/c/<chat> (a chat's messages, send and react, each behind a second click), and
 * the crawler's proposals on My list. Chat text is the chat's: escaped like any other.
 */
import { html } from "hono/html";
import { dockShell, type Frame, shell } from "../html.ts";
import type { ChannelReply, ChannelsView, Followed, JoinedTeam } from "../teams/channels.ts";
import { REACTIONS } from "../teams/helper.ts";
import type { TeamsChat } from "../teams/model.ts";
import type { Finding, StoredChat, StoredMessage } from "../teams/store.ts";
import type { TeamsView } from "../teams/teams.ts";
import { type Child, Confirm, Empty, type Html, Item, List, Notice, PageHeader, Panel, Pill } from "../ui/kit.ts";
import { Ago, Link } from "./parts.ts";

const st = (tone: "ok" | "warn" | "bad" | "acc" | "mute", text: unknown) => html`<span class="st ${tone}"><i></i>${text}</span>`;

export const chatHref = (id: string) => `/teams/c/${encodeURIComponent(id)}`;
/** Opening a chat: at its newest message. */
export const chatLink = (id: string) => `${chatHref(id)}#end`;

/** New first, those mentioning me first among them, then the newest. */
export function newestFirst(chats: TeamsChat[]): TeamsChat[] {
  const rank = (c: TeamsChat) => (c.unread ? (c.mentioned ? 0 : c.kind === "oneOnOne" ? 1 : 2) : 3);
  return [...chats].sort((a, b) => rank(a) - rank(b) || (b.last?.at ?? "").localeCompare(a.last?.at ?? ""));
}

const KIND: Record<string, string> = { oneOnOne: "Chat", group: "Group", meeting: "Meeting", other: "Chat" };

const lastLine = (c: TeamsChat) => (c.last ? html`<strong>${c.last.from}:</strong> ${c.last.text || "(no text)"}` : "No messages");

function connectBox(v: TeamsView): Html {
  if (v.state === "connecting")
    return Notice({ children: html`<p><span class="spinner" aria-hidden="true"></span> <strong>Signing in to Microsoft…</strong> A Microsoft sign-in may have opened in your browser; finish it there. This page fills in by itself.</p>` });
  return Notice({
    tone: v.why ? "warn" : "neutral",
    children: html`<p><strong>${v.why ? "Teams isn't connected." : "Connect Dovre to Teams."}</strong> It signs in through Microsoft's Graph PowerShell, which your tenant already allows. A Microsoft sign-in may open once; after that it signs in by itself.</p>
${v.why ? html`<p class="notes">${v.why}</p>` : ""}
<form method="post" action="/teams/connect" class="buttons"><button type="submit" class="primary" data-busy="Signing in">Connect Teams</button></form>`,
  });
}

export function teamsCard(v: TeamsView, channels?: ChannelsView): Html | "" {
  if (v.state === "off") return "";
  if (v.state !== "ok")
    return html`<section class="card" id="teams-card" aria-labelledby="teams-h"><div class="card-h"><h2 id="teams-h">Teams</h2></div><p class="notes">${v.state === "connecting" ? "Signing in to Microsoft…" : html`Teams isn't connected. <a href="/teams">Connect</a> to see what's new in your chats here.`}</p></section>`;
  const fresh = newestFirst(v.chats.filter((c) => c.unread));
  const mentions = fresh.filter((c) => c.mentioned).length;
  const proposals = v.crawl?.proposals ?? 0;
  return html`<section class="card" id="teams-card" aria-labelledby="teams-h">
<div class="card-h"><h2 id="teams-h">Teams</h2><p>${fresh.length ? st(mentions ? "warn" : "acc", `${fresh.length} with something new${mentions ? `, ${mentions} mention you` : ""}`) : st("ok", "all read")}</p></div>
${v.error ? html`<p class="notes">${st("bad", "Didn't read just now")} ${v.error}</p>` : ""}${
    fresh.length
      ? html`<ul class="wts">${fresh.slice(0, 4).map((c) => html`<li><span class="wt-n">${c.mentioned ? "@ " : ""}<a href="${chatLink(c.id)}">${c.name}</a></span><span class="wt-b">${c.last ? `${c.last.from}: ${c.last.text}` : ""}</span><span class="wt-t">${Ago(c.last?.at)}</span></li>`)}</ul>`
      : ""
  }
${channelLine(channels)}
<div class="card-f"><span>${proposals ? html`<a href="/todo">${proposals} from Teams for My list</a>` : v.at ? html`Read ${Ago(v.at)}` : ""}</span><a href="/teams">All chats</a></div>
</section>`;
}

/** On the Teams card: what is new in the channels I follow. */
function channelLine(v: ChannelsView | undefined): Html | "" {
  const fresh = (v?.followed ?? []).filter((f) => f.fresh > 0);
  if (!fresh.length) return "";
  const n = fresh.reduce((a, f) => a + f.fresh, 0);
  const at = fresh.some((f) => f.mentioned);
  return html`<p class="notes">${st(at ? "warn" : "acc", `${n} new in ${fresh.length === 1 ? fresh[0]!.name : `${fresh.length} channels`}${at ? ", mentions you" : ""}`)} ${fresh.length === 1 ? html`<a href="${channelHref(fresh[0]!.teamId, fresh[0]!.channelId)}">Open</a>` : html`<a href="/teams">Channels</a>`}</p>`;
}

function chatItem(c: TeamsChat): Html {
  return Item({
    href: chatLink(c.id),
    lead: c.mentioned ? Pill({ tone: "warn", children: "Mentions you" }) : c.unread ? Pill({ tone: "accent", children: c.unreadCount && c.unreadCount > 1 ? `${c.unreadCount} new` : "New" }) : html`<span class="t3">${KIND[c.kind] ?? "Chat"}</span>`,
    title: html`<strong>${c.name}</strong>`,
    line: lastLine(c),
    trail: Ago(c.last?.at),
    quiet: !c.unread,
  });
}

function storeLine(v: TeamsView): Html | "" {
  const s = v.store;
  if (!s) return "";
  if ("error" in s) return Notice({ tone: "bad", children: s.error });
  const done = s.chats ? Math.round((s.backfilled / s.chats) * 100) : 0;
  return html`<p class="notes">Kept on this machine, encrypted (only your Windows account can open it): ${s.messages} messages in ${s.chats} chats${s.oldest ? html`, back to ${s.oldest.slice(0, 10)}` : ""}. History from ${s.since.slice(0, 10)} on is ${done >= 100 ? "in" : `coming in (${done} % of chats)`}.</p>`;
}

function crawlBox(v: TeamsView): Html | "" {
  const c = v.crawl;
  if (!c) return "";
  const last = c.last;
  return Panel({
    title: "Todos from your chats",
    meta: c.proposals ? html`<a href="/todo">${c.proposals} proposed on My list</a>` : "",
    children: html`<p class="notes">Every two hours a ${c.model} model (Copilot, through omp, with no tools) looks through what's new and proposes todos, reminders and follow-ups on My list; nothing lands there until you add it. Claude never reads your chats.</p>
${c.why ? Notice({ tone: "warn", children: c.why }) : ""}
${last ? html`<p class="notes">Last look ${Ago(last.at)}: ${last.ok ? `${last.messages} messages, ${last.found} found` : html`${st("bad", "failed")} ${last.error ?? ""}`}.</p>` : ""}
${c.why ? "" : html`<form method="post" action="/teams/crawl" class="buttons"><button type="submit" data-busy="Looking"${c.running ? html` disabled` : ""}>${c.running ? "Looking through…" : "Look through now"}</button></form>`}`,
  });
}

const ABOUT = html`<p class="notes">Dovre asks Graph only for who you are, your chats and their messages, the channels you follow here, and (on <a href="/outlook">Outlook</a>) your inbox, and writes only what you send or react here: both Dovre and its PowerShell helper hold that list. Graph PowerShell's sign-in can do far more (directory, mail, sites), so that list is what keeps it to those. Chat text never goes to logs or to anything Claude sees (Bino, agents, summaries).</p>`;

export function teamsPage(frame: Frame, v: TeamsView, o: { flash?: { ok: boolean; message: string }; channels?: ChannelsView } = {}): Html {
  const fresh = newestFirst(v.chats.filter((c) => c.unread));
  const rest = v.chats.filter((c) => !c.unread);
  const body = html`${PageHeader({ title: "Teams", sub: v.state === "ok" && v.account ? html`Signed in as ${v.account}` : undefined })}
${o.flash ? Notice({ tone: o.flash.ok ? "ok" : "bad", children: o.flash.message }) : ""}
<div data-live id="teams">${
    v.state === "off"
      ? Notice({ tone: "warn", children: v.why ?? "Teams is off." })
      : v.state !== "ok"
        ? connectBox(v)
        : html`${v.error ? Notice({ tone: "bad", children: html`<strong>Teams didn't read just now.</strong> ${v.error}${v.at ? html` Showing what it said ${Ago(v.at)}.` : ""}` }) : ""}
${Panel({ title: "Something new", meta: String(fresh.length), flush: true, children: fresh.length ? List(fresh.map(chatItem)) : Empty({ title: "All read" }) })}
${Panel({ title: "Lately", meta: String(rest.length), flush: true, children: rest.length ? List(rest.slice(0, 25).map(chatItem)) : Empty({ title: "No other chats" }) })}
${o.channels ? channelsPanel(o.channels) : ""}
${crawlBox(v)}
${storeLine(v)}`
  }</div>
${ABOUT}
${v.state === "ok" ? Confirm({ action: "/teams/disconnect", label: "Disconnect", question: "Disconnect Teams? Graph PowerShell is signed out on this machine (also for your own scripts), and Dovre stops reading. What's kept stays encrypted on disk." }) : ""}`;
  return shell({ title: "Teams · Dovre", frame, current: "/teams", body });
}

/** Message text with its https links clickable (the rest stays text). */
function withLinks(text: string): Html {
  const parts: (string | Html)[] = [];
  let at = 0;
  for (const m of text.matchAll(/https:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g)) {
    parts.push(text.slice(at, m.index));
    parts.push(Link(m[0], m[0]));
    at = m.index! + m[0].length;
  }
  parts.push(text.slice(at));
  return html`${parts}`;
}

const clock = (at: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" }).format(Date.parse(at));
const dayOf = (at: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(Date.parse(at));
function dayLabel(at: string, now: number): string {
  const d = dayOf(at);
  if (d === dayOf(new Date(now).toISOString())) return "Today";
  if (d === dayOf(new Date(now - 86_400_000).toISOString())) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", weekday: "long", day: "numeric", month: "long", ...(d.slice(0, 4) === dayOf(new Date(now).toISOString()).slice(0, 4) ? {} : { year: "numeric" }) }).format(Date.parse(at));
}

/** Reactions shown small; the picker opens from a ☺ (shown on hover), and a pick is the second click. */
function reactionsOf(chatId: string, m: StoredMessage, canWrite: boolean, dock = false): Html | "" {
  const shown = m.reactions.filter((r) => r.count > 0);
  if (!shown.length && !canWrite) return "";
  const mine = new Set(m.reactions.filter((r) => r.mine).map((r) => r.emoji));
  return html`<div class="tmsg-r">${shown.map((r) => html`<span class="treact${r.mine ? " mine" : ""}"${r.mine ? html` title="You reacted"` : ""}>${r.emoji}${r.count > 1 ? html` ${r.count}` : ""}</span>`)}${
    canWrite
      ? html`<details class="treact-pick" id="r-${m.id}"><summary title="React" aria-label="React">☺</summary><form method="post" action="${chatHref(chatId)}/react"><input type="hidden" name="message" value="${m.id}">${dock ? DOCK_FIELD : ""}${REACTIONS.map(
          (e) => html`<button type="submit" name="${mine.has(e) ? "off" : "on"}" value="${e}" title="${mine.has(e) ? "Take back" : "React"} ${e}"${mine.has(e) ? html` class="on"` : ""}>${e}</button>`,
        )}</form></details>`
      : ""
  }</div>`;
}

/** Messages in runs: one header per sender while they keep writing (within 10 minutes), a line between days. */
function chatList(c: StoredChat, msgs: StoredMessage[], canWrite: boolean, now: number, dock = false): Html {
  const items: Html[] = [];
  let prev: StoredMessage | undefined;
  for (const m of msgs) {
    if (!prev || dayOf(prev.at) !== dayOf(m.at)) items.push(html`<li class="tday"><span>${dayLabel(m.at, now)}</span></li>`);
    const cont = !!prev && dayOf(prev.at) === dayOf(m.at) && prev.fromId === m.fromId && Date.parse(m.at) - Date.parse(prev.at) < 10 * 60_000;
    items.push(
      html`<li class="tmsg${m.mine ? " mine" : ""}${cont ? " cont" : ""}${m.mentionsMe ? " mention" : ""}" id="m-${m.id}"${cont ? "" : html` data-stop="2"`}>${cont ? "" : html`<p class="tmsg-h">${m.mine ? "" : html`<strong>${m.from}</strong> `}<time datetime="${m.at}">${clock(m.at)}</time>${m.mentionsMe ? html` · <span class="tmention">mentions you</span>` : ""}</p>`}<p class="tmsg-t">${m.text ? withLinks(m.text) : html`<span class="t3">(no text)</span>`}</p>${reactionsOf(c.id, m, canWrite, dock)}</li>`,
    );
    prev = m;
  }
  return html`<ol class="tchat" data-follow>${items}</ol>`;
}

/** A message that Teams didn't take: why, and what it said, to copy and send again. */
export type SendFailed = { message: string; text: string };
function failedBox(f: SendFailed | undefined): Html | "" {
  return f ? Notice({ tone: "bad", children: html`<p><strong>${f.message}</strong></p><p class="tfail-t">${f.text}</p>` }) : "";
}

/** One chat: its newest messages from the store, newest at the bottom, the box to write in kept below them. */
export function chatPage(frame: Frame, c: StoredChat, msgs: StoredMessage[], o: { flash?: { ok: boolean; message: string }; failed?: SendFailed; canWrite: boolean; why?: string; now?: number }): Html {
  const body = html`${PageHeader({ title: c.name, crumbs: [{ href: "/teams", label: "Teams" }], actions: c.webUrl ? Link(c.webUrl, "Open in Teams", "btn sm") : "" })}
${o.flash ? Notice({ tone: o.flash.ok ? "ok" : "bad", children: o.flash.message }) : ""}
<div class="tthread"><div data-live id="teams-chat">${msgs.length ? chatList(c, msgs, o.canWrite, o.now ?? Date.now()) : Empty({ title: "Nothing kept from this chat yet", children: "It fills in as Dovre reads it." })}${failedBox(o.failed)}</div>
<span id="end"></span>
${
    o.canWrite
      ? html`<form method="post" action="${chatHref(c.id)}/send" class="tcompose" data-send><textarea name="text" rows="2" maxlength="4000" required aria-label="Write to ${c.name}" placeholder="Write to ${c.name}… (Enter sends, Shift+Enter for a new line)"></textarea><button type="submit" class="primary tsend">Send</button></form>`
      : Notice({ tone: "warn", children: o.why ?? "Connect Teams to write here." })
  }</div>`;
  return shell({ title: `${c.name} · Teams`, frame, current: "/teams", body });
}

// ── The dock: Teams in a panel at the bottom right of every page (a frame of /teams/dock, see src/html.ts) ──

/** Marks a write from the dock, so it comes back to the dock rather than the full page. */
const DOCK_FIELD = html`<input type="hidden" name="dock" value="1">`;
export const dockHref = (id: string) => `/teams/dock/c/${encodeURIComponent(id)}#end`;

/** The dock's bar: back to the chats, the title, out to the full page (and Teams), minimise. */
function dockBar(title: Child, o: { back?: boolean; full: string; teams?: string }): Html {
  return html`<header class="dock-h">${o.back ? html`<a class="dock-i" href="/teams/dock" title="All chats" aria-label="All chats">←</a>` : ""}<h1>${title}</h1>${o.teams ? Link(o.teams, "Teams", "dock-l") : ""}<a class="dock-l" href="${o.full}" target="_top" title="Open as a page">Page</a><button type="button" class="dock-i ghost" data-dock-close title="Minimise (Esc)" aria-label="Minimise">–</button></header>`;
}

function dockRow(c: TeamsChat): Html {
  return html`<li${c.unread ? html` class="new"` : ""}><a href="${dockHref(c.id)}"><span class="tdl-n">${c.mentioned ? html`<span class="tmention">@ </span>` : ""}${c.name}</span><span class="tdl-t">${Ago(c.last?.at)}</span><span class="tdl-l">${c.last ? `${c.last.from}: ${c.last.text || "(no text)"}` : "No messages"}</span></a></li>`;
}

/** The dock's first view: every chat, what's new first. */
export function dockListPage(v: TeamsView): Html {
  const chats = newestFirst(v.chats);
  const body = html`${dockBar("Teams", { full: "/teams" })}
<div class="dock-b" data-live id="tdock-list">${
    v.state !== "ok"
      ? html`<p class="notes">${v.state === "connecting" ? "Signing in to Microsoft…" : html`Teams isn't connected. <a href="/teams" target="_top">Connect it on the Teams page</a>.`}</p>`
      : html`${v.error ? html`<p class="notes">${st("bad", "Didn't read just now")} ${v.error}</p>` : ""}${chats.length ? html`<ul class="tdl">${chats.slice(0, 40).map(dockRow)}</ul>` : html`<p class="notes">No chats yet.</p>`}`
  }</div>`;
  return dockShell({ title: "Teams", body });
}

/** One chat in the dock: the thread scrolls, the box to write in stays at the bottom. */
export function dockChatPage(c: StoredChat, msgs: StoredMessage[], o: { flash?: { ok: boolean; message: string }; failed?: SendFailed; canWrite: boolean; now?: number }): Html {
  const body = html`${dockBar(c.name, { back: true, full: chatLink(c.id), teams: c.webUrl ?? undefined })}
<div class="dock-b">${o.flash ? Notice({ tone: o.flash.ok ? "ok" : "bad", children: o.flash.message }) : ""}<div data-live id="teams-chat">${msgs.length ? chatList(c, msgs, o.canWrite, o.now ?? Date.now(), true) : html`<p class="notes">Nothing kept from this chat yet. It fills in as Dovre reads it.</p>`}${failedBox(o.failed)}</div><span id="end"></span></div>
${
    o.canWrite
      ? html`<form method="post" action="${chatHref(c.id)}/send" class="tcompose dock-compose" data-send>${DOCK_FIELD}<textarea name="text" rows="2" maxlength="4000" required aria-label="Write to ${c.name}" placeholder="Write to ${c.name}…"></textarea><button type="submit" class="primary tsend">Send</button></form>`
      : html`<p class="notes dock-why">Teams isn't connected: <a href="/teams" target="_top">connect it</a> to write here.</p>`
  }`;
  return dockShell({ title: `${c.name} · Teams`, body });
}

const FIND_KIND: Record<string, string> = { todo: "To do", reminder: "Remember", followup: "Follow up" };

/** The crawler's proposals, on My list: add one (it becomes an item) or dismiss it. */
export function proposalsPanel(fs: Finding[], chats: Map<string, StoredChat>): Html | "" {
  if (!fs.length) return "";
  return html`<section class="todo-group teams-proposals" aria-labelledby="g-teams"><h2 id="g-teams">From Teams <span class="t3">${fs.length}</span></h2>
<p class="notes">Found in your chats by a Copilot model. Nothing is on your list until you add it; once added, it's an ordinary item (Bino sees My list).</p>
<ul class="todo-list">${fs.slice(0, 20).map((f) => {
    const chat = chats.get(f.chatId);
    return html`<li class="todo-item proposal" id="tf-${f.id}"><div class="todo-main"><p class="todo-title"><span>${f.title}</span> <span class="t3">${FIND_KIND[f.kind] ?? f.kind}${f.due ? ` · ${f.due}` : ""}</span></p><p class="notes">From <a href="${chatHref(f.chatId)}${f.messageId ? `#m-${f.messageId}` : ""}">${chat?.name ?? "a chat"}</a> · ${Ago(f.createdAt)}</p></div><form method="post" action="/teams/finding/${f.id}/add" class="buttons"><button type="submit" class="sm primary">Add</button><button type="submit" class="sm ghost" formaction="/teams/finding/${f.id}/dismiss">Dismiss</button></form></li>`;
  })}</ul></section>`;
}

// ── Team channels I follow (src/teams/channels.ts): read-only, held in memory only ──

export const channelHref = (teamId: string, channelId: string) => `/teams/ch/${encodeURIComponent(teamId)}/${encodeURIComponent(channelId)}`;

/** On /teams: the channels I follow, what's new first. */
export function channelsPanel(v: ChannelsView): Html | "" {
  if (v.state !== "ok") return "";
  const rows = [...v.followed].sort((a, b) => Number(b.mentioned) - Number(a.mentioned) || b.fresh - a.fresh || (b.posts[0]?.lastAt ?? "").localeCompare(a.posts[0]?.lastAt ?? ""));
  return Panel({
    title: "Channels",
    meta: html`<a href="/teams/channels">Choose channels</a>`,
    flush: true,
    children: rows.length
      ? List(
          rows.map((f) => {
            const p = f.posts[0];
            const last = p ? (p.replies.length ? p.replies[p.replies.length - 1]! : p) : undefined;
            return Item({
              href: channelHref(f.teamId, f.channelId),
              lead: f.error ? Pill({ tone: "bad", children: "Failed" }) : f.mentioned ? Pill({ tone: "warn", children: "Mentions you" }) : f.fresh ? Pill({ tone: "accent", children: `${f.fresh} new` }) : html`<span class="t3">Channel</span>`,
              title: html`<strong>${f.name}</strong> <span class="t3">${f.teamName}</span>`,
              line: f.error ? f.error : last ? html`<strong>${last.from}:</strong> ${last.text || "(no text)"}` : f.at ? "No posts" : "Reading…",
              trail: Ago(p?.lastAt),
              quiet: !f.fresh && !f.error,
            });
          }),
        )
      : Empty({ title: "No channels followed", children: html`<a href="/teams/channels">Choose the channels to follow</a>` }),
  });
}

/** /teams/channels: my teams, a team's channels when opened, a Follow toggle on each. */
export function channelsPickPage(frame: Frame, v: ChannelsView, open: string | undefined): Html {
  const followed = new Set(v.followed.map((f) => `${f.teamId}|${f.channelId}`));
  const team = (t: JoinedTeam) => {
    const isOpen = t.id === open;
    return html`<li class="pick-team"><p class="pick-h"><a href="/teams/channels?team=${encodeURIComponent(t.id)}#t-${t.id}" id="t-${t.id}"><strong>${t.name}</strong></a></p>${
      !isOpen
        ? ""
        : t.error
          ? Notice({ tone: "bad", children: t.error })
          : !t.channels
            ? html`<p class="notes"><span class="spinner" aria-hidden="true"></span> Reading channels…</p>`
            : html`<ul class="pick-ch">${t.channels.map((c) => {
                const on = followed.has(`${t.id}|${c.id}`);
                return html`<li><span>${c.name}${c.kind !== "standard" ? html` <span class="t3">${c.kind}</span>` : ""}</span><form method="post" action="/teams/channels/follow"><input type="hidden" name="team" value="${t.id}"><input type="hidden" name="channel" value="${c.id}"><button type="submit" class="sm${on ? "" : " primary"}" name="${on ? "off" : "on"}" value="1">${on ? "Unfollow" : "Follow"}</button></form></li>`;
              })}</ul>`
    }</li>`;
  };
  const body = html`${PageHeader({ title: "Choose channels", crumbs: [{ href: "/teams", label: "Teams" }] })}
<p class="notes">Teams can't tell Dovre which channels you follow there, so pick them here. Only which channels is kept on this machine; their posts are read every three minutes and held in memory only, never given to Claude or any other model.</p>
<div data-live id="teams-pick">${
    v.state !== "ok"
      ? Notice({ tone: "warn", children: html`Teams isn't connected: <a href="/teams">connect it</a> first.` })
      : html`${v.teamsError ? Notice({ tone: "bad", children: v.teamsError }) : ""}${!v.teams || !v.teams.length ? html`<p class="notes"><span class="spinner" aria-hidden="true"></span> Reading your teams…</p>` : html`<ul class="pick">${v.teams.map(team)}</ul>`}`
  }</div>`;
  return shell({ title: "Choose channels · Teams", frame, current: "/teams", body });
}

/** One followed channel: its posts, newest activity first, replies under each. */
export function channelPage(frame: Frame, f: Followed, o: { now?: number } = {}): Html {
  const now = o.now ?? Date.now();
  const line = (m: ChannelReply, reply: boolean) =>
    html`<li class="tmsg${m.mine ? " mine" : ""}${m.mentionsMe ? " mention" : ""}${reply ? " creply" : ""}" id="m-${m.id}"><p class="tmsg-h">${m.mine ? "" : html`<strong>${m.from}</strong> `}<time datetime="${m.at}">${dayLabel(m.at, now)} ${clock(m.at)}</time>${m.mentionsMe ? html` · <span class="tmention">mentions you</span>` : ""}</p><p class="tmsg-t">${m.text ? withLinks(m.text) : html`<span class="t3">(no text)</span>`}</p></li>`;
  const body = html`${PageHeader({ title: f.name, sub: f.teamName, crumbs: [{ href: "/teams", label: "Teams" }], actions: f.webUrl ? Link(f.webUrl, "Open in Teams", "btn sm") : "" })}
<div data-live id="teams-channel">${f.error ? Notice({ tone: "bad", children: f.error }) : ""}${
    f.posts.length
      ? html`<ol class="cposts">${f.posts.map((p) => html`<li class="cpost" data-stop="2">${p.subject ? html`<h2 class="cpost-s">${p.subject}</h2>` : ""}<ol class="tchat">${line(p, false)}${p.replies.map((r) => line(r, true))}</ol>${p.webUrl ? html`<p class="notes">${Link(p.webUrl, "Reply in Teams")}</p>` : ""}</li>`)}</ol>`
      : Empty({ title: f.at ? "No posts" : "Reading…" })
  }</div>
<p class="notes">Read-only here, every three minutes. Posts are held in memory only.</p>`;
  return shell({ title: `${f.name} · Teams`, frame, current: "/teams", body });
}
