/**
 * Teams chats as Dovre shows them, from Graph's answers, read strictly: what a chat is called,
 * its last message as plain text, and whether something in it is new to me (and mentions me).
 * Message text is kept short and only in memory (src/teams/teams.ts).
 */

export type ChatKind = "oneOnOne" | "group" | "meeting" | "other";

export type TeamsChat = {
  id: string;
  name: string;
  kind: ChatKind;
  /** Teams' own link to the chat (https only, on a Teams host). */
  webUrl?: string;
  last?: { from: string; text: string; at: string; mine: boolean };
  /** Something new from someone else since I last read the chat. */
  unread: boolean;
  /** How many of the newest messages are new (counted for unread chats only). */
  unreadCount?: number;
  /** One of the new messages mentions me. */
  mentioned?: boolean;
};

const s = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** One form for every time (Graph mixes "…:00Z" and "…:00.123Z"), so they compare as text. */
const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : "");

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aring: "å", Aring: "Å", oslash: "ø", Oslash: "Ø", aelig: "æ", AElig: "Æ", eacute: "é", Eacute: "É", auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü",
  hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•", euro: "€",
};

/** A message body as one short line of plain text (Teams sends HTML). */
export function textOf(body: string, max = 200): string {
  const plain = body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<attachment[^>]*>[\s\S]*?<\/attachment>/gi, " [attachment] ")
    .replace(/<img[^>]*>/gi, " [image] ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
      }
      return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

const TEAMS_HOSTS = new Set(["teams.microsoft.com", "teams.cloud.microsoft", "teams.live.com"]);

/** Only Teams' own https links. */
export function teamsUrl(v: unknown): string | undefined {
  const u = s(v, 2000);
  try {
    const url = new URL(u);
    return url.protocol === "https:" && TEAMS_HOSTS.has(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const kindOf = (v: unknown): ChatKind => (v === "oneOnOne" || v === "group" || v === "meeting" ? v : "other");

/** The chats from `/me/chats?$expand=members,lastMessagePreview`, newest first; hidden ones left out. */
export function chatsOf(raw: unknown, meId: string): TeamsChat[] {
  const out: TeamsChat[] = [];
  for (const c of list(obj(raw).value)) {
    const chat = obj(c);
    const id = s(chat.id, 200);
    if (!id || obj(chat.viewpoint).isHidden === true) continue;
    const others = list(chat.members)
      .map(obj)
      .filter((m) => s(m.userId, 100) !== meId)
      .map((m) => s(m.displayName, 120).trim())
      .filter(Boolean);
    const topic = s(chat.topic, 200).trim();
    const name = topic || (others.length ? (others.length > 3 ? `${others.slice(0, 3).join(", ")} +${others.length - 3}` : others.join(", ")) : "Chat");
    const p = obj(chat.lastMessagePreview);
    const at = iso(p.createdDateTime);
    const fromUser = obj(obj(p.from).user);
    const mine = !!meId && s(fromUser.id, 100) === meId;
    const body = obj(p.body);
    const text = p.isDeleted === true ? "(deleted)" : p.messageType && p.messageType !== "message" ? "(an event in the chat)" : textOf(s(body.content, 20_000));
    const last = at ? { from: mine ? "You" : s(fromUser.displayName, 120) || "Someone", text, at, mine } : undefined;
    const readAt = iso(obj(chat.viewpoint).lastMessageReadDateTime);
    const unread = !!last && !mine && p.messageType === "message" && (!readAt || Date.parse(at) > Date.parse(readAt));
    out.push({ id, name, kind: kindOf(chat.chatType), webUrl: teamsUrl(chat.webUrl), last, unread });
  }
  return out;
}

/** For an unread chat: how many of its newest messages are new to me, and whether one mentions me. */
export function newIn(raw: unknown, meId: string, readAt: string | undefined): { count: number; mentioned: boolean } {
  const since = readAt ? Date.parse(readAt) : 0;
  let count = 0;
  let mentioned = false;
  for (const m of list(obj(raw).value).map(obj)) {
    if (m.messageType !== "message" || m.deletedDateTime) continue;
    if (s(obj(obj(m.from).user).id, 100) === meId) continue;
    const at = Date.parse(iso(m.createdDateTime));
    if (!(at > since)) continue;
    count++;
    if (list(m.mentions).some((x) => s(obj(obj(obj(x).mentioned).user).id, 100) === meId)) mentioned = true;
  }
  return { count, mentioned };
}

/** When I last read a chat, from the same answer chatsOf reads. */
export function readAtOf(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of list(obj(raw).value).map(obj)) {
    const r = iso(obj(c.viewpoint).lastMessageReadDateTime);
    if (r && typeof c.id === "string") out.set(c.id, r);
  }
  return out;
}

/** A message as the store keeps it: real messages only (no system events, nothing deleted). */
export function messageOf(raw: unknown, meId: string): { id: string; at: string; fromId: string | null; from: string; mine: boolean; mentionsMe: boolean; text: string; reactions: { emoji: string; count: number; mine: boolean }[] } | undefined {
  const m = obj(raw);
  const id = s(m.id, 30);
  const at = iso(m.createdDateTime);
  if (!/^\d{1,20}$/.test(id) || !at || m.messageType !== "message" || m.deletedDateTime) return undefined;
  const user = obj(obj(m.from).user);
  const fromId = s(user.id, 100) || null;
  const mine = !!meId && fromId === meId;
  const byEmoji = new Map<string, { emoji: string; count: number; mine: boolean }>();
  for (const r of list(m.reactions).map(obj)) {
    const emoji = s(r.reactionType, 16);
    if (!emoji) continue;
    const e = byEmoji.get(emoji) ?? { emoji, count: 0, mine: false };
    e.count++;
    if (s(obj(obj(r.user).user).id, 100) === meId) e.mine = true;
    byEmoji.set(emoji, e);
  }
  return {
    id,
    at,
    fromId,
    from: mine ? "You" : s(user.displayName, 120) || "Someone",
    mine,
    mentionsMe: list(m.mentions).some((x) => s(obj(obj(obj(x).mentioned).user).id, 100) === meId),
    text: textOf(s(obj(m.body).content, 40_000), 4000),
    reactions: [...byEmoji.values()],
  };
}
