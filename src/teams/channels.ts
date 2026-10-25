/**
 * Team channels I follow, through the Teams helper's sign-in. Graph can't say which channels I
 * follow in Teams, so I pick them in Dovre (/teams/channels); only their ids are kept
 * (migrations/0009). Their newest posts and replies are read every three minutes and held in
 * memory only: never on disk, in logs, the snapshot or search, and never given to a model.
 * Reading posts may need more than Graph PowerShell's sign-in carries: a refusal shows per channel.
 */
import type { D1 } from "../db.ts";
import { CHAT_ID, type Helper, PATHS, TEAM_ID } from "./helper.ts";
import { teamsUrl, textOf } from "./model.ts";

export const CHANNEL_ID = CHAT_ID;

export type ChannelReply = { id: string; at: string; from: string; mine: boolean; mentionsMe: boolean; text: string };
export type ChannelPost = ChannelReply & { subject: string; webUrl?: string; replies: ChannelReply[]; /** The newest of the post and its replies. */ lastAt: string };
export type TeamChannel = { id: string; name: string; kind: string; webUrl?: string };
export type JoinedTeam = { id: string; name: string; channels?: TeamChannel[]; loading?: boolean; error?: string };

export type Followed = {
  teamId: string;
  channelId: string;
  name: string;
  teamName: string;
  webUrl?: string;
  posts: ChannelPost[];
  at?: number;
  error?: string;
  /** What's new from others since I last opened it here, and whether that mentions me. */
  fresh: number;
  mentioned: boolean;
};

export type ChannelsView = {
  state: "off" | "waiting" | "ok";
  teams?: JoinedTeam[];
  teamsError?: string;
  followed: Followed[];
};

const s = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : "");

/** `/me/joinedTeams`, by name. */
export function joinedTeamsOf(raw: unknown): JoinedTeam[] {
  return list(obj(raw).value)
    .map(obj)
    .map((t) => ({ id: s(t.id, 40), name: s(t.displayName, 200).trim() || "Team" }))
    .filter((t) => TEAM_ID.test(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `/teams/<id>/channels`: General first, then by name. */
export function channelsOf(raw: unknown): TeamChannel[] {
  return list(obj(raw).value)
    .map(obj)
    .map((c) => ({ id: s(c.id, 200), name: s(c.displayName, 200).trim() || "Channel", kind: s(c.membershipType, 20) || "standard", webUrl: teamsUrl(c.webUrl) }))
    .filter((c) => CHANNEL_ID.test(c.id))
    .sort((a, b) => (a.name === "General" ? -1 : b.name === "General" ? 1 : a.name.localeCompare(b.name)));
}

function replyOf(raw: unknown, meId: string): ChannelReply | undefined {
  const m = obj(raw);
  const id = s(m.id, 30);
  const at = iso(m.createdDateTime);
  if (!/^\d{1,20}$/.test(id) || !at || m.messageType !== "message" || m.deletedDateTime) return undefined;
  const user = obj(obj(m.from).user);
  const mine = !!meId && s(user.id, 100) === meId;
  return {
    id,
    at,
    from: mine ? "You" : s(user.displayName, 120) || s(obj(obj(m.from).application).displayName, 120) || "Someone",
    mine,
    mentionsMe: !!meId && list(m.mentions).some((x) => s(obj(obj(obj(x).mentioned).user).id, 100) === meId),
    text: textOf(s(obj(m.body).content, 40_000), 2000),
  };
}

/** A channel's posts (with `$expand=replies`), newest activity first. */
export function postsOf(raw: unknown, meId: string): ChannelPost[] {
  const out: ChannelPost[] = [];
  for (const r of list(obj(raw).value)) {
    const p = replyOf(r, meId);
    if (!p) continue;
    const m = obj(r);
    const replies = list(m.replies)
      .map((x) => replyOf(x, meId))
      .filter((x): x is ChannelReply => !!x)
      .sort((a, b) => a.at.localeCompare(b.at));
    const lastAt = replies.reduce((a, x) => (x.at > a ? x.at : a), p.at);
    out.push({ ...p, subject: s(m.subject, 300).trim(), webUrl: teamsUrl(m.webUrl), replies: replies.slice(-30), lastAt });
  }
  return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** What's new from others after `since`, and whether any of it mentions me. */
export function freshIn(posts: ChannelPost[], since: string): { fresh: number; mentioned: boolean } {
  let fresh = 0;
  let mentioned = false;
  for (const p of posts)
    for (const m of [p, ...p.replies])
      if (!m.mine && m.at > since) {
        fresh++;
        if (m.mentionsMe) mentioned = true;
      }
  return { fresh, mentioned };
}

type FollowRow = { team_id: string; channel_id: string; at: number; seen_at: string | null };

export type Channels = {
  view(): ChannelsView;
  /** Read the followed channels again now. */
  kick(): void;
  /** Read my teams (for picking channels), and one team's channels; the page fills in. */
  loadTeams(): void;
  loadChannels(teamId: string): void;
  follow(teamId: string, channelId: string, on: boolean): Promise<void>;
  /** I opened the channel: what's there now isn't new any more. */
  seen(teamId: string, channelId: string): Promise<void>;
  stop(): void;
};

export function createChannels(o: { helper?: Helper; db: D1; connected: () => boolean; everyMs?: number; onChange?: () => void; now?: () => number }): Channels {
  const now = o.now ?? Date.now;
  const every = o.everyMs ?? 180_000;
  let view: ChannelsView = { state: o.helper ? "waiting" : "off", followed: [] };
  let me = "";
  let lastRead = 0;
  let reading = false;
  /** Names from Graph, in memory only. */
  const teamNames = new Map<string, string>();
  const channelInfo = new Map<string, TeamChannel>();
  let namesAt = 0;
  const posts = new Map<string, { posts: ChannelPost[]; at: number; error?: string }>();
  const key = (t: string, c: string) => `${t}|${c}`;
  const set = (v: Partial<ChannelsView>) => {
    view = { ...view, ...v };
    o.onChange?.();
  };

  const follows = async () => (await o.db.prepare("SELECT team_id, channel_id, at, seen_at FROM teams_follow ORDER BY at").all<FollowRow>()).results;

  async function compose() {
    const rows = await follows();
    const followed: Followed[] = rows.map((r) => {
      const k = key(r.team_id, r.channel_id);
      const p = posts.get(k);
      const ch = channelInfo.get(k);
      const since = r.seen_at ?? new Date(r.at).toISOString();
      return { teamId: r.team_id, channelId: r.channel_id, name: ch?.name ?? "Channel", teamName: teamNames.get(r.team_id) ?? "Team", webUrl: ch?.webUrl, posts: p?.posts ?? [], at: p?.at, error: p?.error, ...freshIn(p?.posts ?? [], since) };
    });
    set({ followed });
  }

  async function names(rows: FollowRow[]) {
    if (!o.helper || (now() - namesAt < 3_600_000 && rows.every((r) => channelInfo.has(key(r.team_id, r.channel_id))))) return;
    namesAt = now();
    for (const t of joinedTeamsOf(await o.helper.get(PATHS.joinedTeams))) teamNames.set(t.id, t.name);
    for (const teamId of new Set(rows.map((r) => r.team_id))) {
      try {
        for (const c of channelsOf(await o.helper.get(PATHS.channels(teamId)))) channelInfo.set(key(teamId, c.id), c);
      } catch {}
    }
  }

  async function read(force = false) {
    if (!o.helper || reading) return;
    if (!o.connected()) {
      if (view.state !== "waiting") set({ state: "waiting", teams: undefined, followed: [] });
      me = "";
      posts.clear();
      return;
    }
    if (!force && now() - lastRead < every) return;
    reading = true;
    lastRead = now();
    try {
      if (view.state !== "ok") set({ state: "ok" });
      if (!me) me = String(((await o.helper.get(PATHS.me)) as { id?: unknown }).id ?? "");
      const rows = await follows();
      await names(rows).catch(() => undefined);
      for (const r of rows.slice(0, 12)) {
        const k = key(r.team_id, r.channel_id);
        try {
          posts.set(k, { posts: postsOf(await o.helper.get(PATHS.posts(r.team_id, r.channel_id, 25)), me), at: now() });
        } catch (e) {
          const m = (e as Error).message;
          const was = posts.get(k);
          posts.set(k, { posts: was?.posts ?? [], at: was?.at ?? 0, error: /403|Forbidden|Authorization|Missing scope|permission/i.test(m) ? `Graph refused (reading channel posts may need ChannelMessage.Read.All, which only an admin can grant): ${m.slice(0, 160)}` : m.slice(0, 300) });
        }
      }
      for (const k of [...posts.keys()]) if (!rows.some((r) => key(r.team_id, r.channel_id) === k)) posts.delete(k);
      await compose();
    } catch (e) {
      set({ teamsError: (e as Error).message.slice(0, 300) });
    } finally {
      reading = false;
    }
  }

  const timer = setInterval(() => void read(), Math.min(every, 30_000));
  timer.unref?.();
  setTimeout(() => void read(), 8_000).unref?.();

  return {
    view: () => view,
    kick: () => void read(now() - lastRead > 20_000),
    loadTeams() {
      if (!o.helper || !o.connected() || view.teams) return;
      set({ teams: [], teamsError: undefined });
      void o.helper
        .get(PATHS.joinedTeams)
        .then((raw) => {
          const teams = joinedTeamsOf(raw);
          for (const t of teams) teamNames.set(t.id, t.name);
          set({ teams });
        })
        .catch((e: Error) => set({ teams: undefined, teamsError: e.message.slice(0, 300) }));
    },
    loadChannels(teamId) {
      const t = view.teams?.find((x) => x.id === teamId);
      if (!o.helper || !t || t.channels || t.loading) return;
      const put = (p: Partial<JoinedTeam>) => set({ teams: (view.teams ?? []).map((x) => (x.id === teamId ? { ...x, ...p } : x)) });
      put({ loading: true, error: undefined });
      void o.helper
        .get(PATHS.channels(teamId))
        .then((raw) => {
          const channels = channelsOf(raw);
          for (const c of channels) channelInfo.set(key(teamId, c.id), c);
          put({ channels, loading: false });
        })
        .catch((e: Error) => put({ loading: false, error: e.message.slice(0, 300) }));
    },
    async follow(teamId, channelId, on) {
      if (!TEAM_ID.test(teamId) || !CHANNEL_ID.test(channelId)) return;
      if (on) await o.db.prepare("INSERT OR IGNORE INTO teams_follow (team_id, channel_id, at, seen_at) VALUES (?, ?, ?, NULL)").bind(teamId, channelId, now()).run();
      else await o.db.prepare("DELETE FROM teams_follow WHERE team_id = ? AND channel_id = ?").bind(teamId, channelId).run();
      await compose();
      if (on) void read(true);
    },
    async seen(teamId, channelId) {
      const newest = (posts.get(key(teamId, channelId))?.posts ?? []).reduce((a, p) => (p.lastAt > a ? p.lastAt : a), "");
      if (!newest) return;
      await o.db.prepare("UPDATE teams_follow SET seen_at = ? WHERE team_id = ? AND channel_id = ? AND (seen_at IS NULL OR seen_at < ?)").bind(newest, teamId, channelId, newest).run();
      await compose();
    },
    stop: () => clearInterval(timer),
  };
}
