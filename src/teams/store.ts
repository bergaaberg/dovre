/**
 * Teams chats on disk (migrations/0007_teams.sql), for the crawler to look through. What chats say
 * is sealed with AES-256-GCM; the key lives in data/teams.key wrapped by Windows DPAPI for this
 * user, unwrapped once per start through the Teams helper, and held only in memory. Each sealed
 * value is bound to its row (the AAD), so one can't be moved to another.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { D1 } from "../db.ts";

export type Sealer = { seal(text: string, row: string): string; open(sealed: string, row: string): string };

export function sealerOf(key: Buffer): Sealer {
  if (key.length !== 32) throw new Error("a Teams store key is 32 bytes");
  return {
    seal(text, row) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(row, "utf8"));
      const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
      return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
    },
    open(sealed, row) {
      if (!sealed.startsWith("v1.")) throw new Error("not a sealed value");
      const b = Buffer.from(sealed.slice(3), "base64");
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAAD(Buffer.from(row, "utf8"));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    },
  };
}

/**
 * The store's key: unwrapped from `file`, or made and wrapped the first time. A key file that won't
 * unwrap is never replaced (that would lose what's stored); it's an error to look at.
 */
export async function loadKey(file: string, dpapi: { wrap(k: string): Promise<string>; unwrap(s: string): Promise<string> }): Promise<Buffer> {
  if (existsSync(file)) {
    const key = Buffer.from(await dpapi.unwrap(readFileSync(file, "utf8").trim()), "base64");
    if (key.length !== 32) throw new Error("data/teams.key didn't unwrap to a key");
    return key;
  }
  const key = randomBytes(32);
  const sealed = await dpapi.wrap(key.toString("base64"));
  if (!sealed) throw new Error("Windows wouldn't wrap the Teams store key");
  writeFileSync(file, sealed, { mode: 0o600, flag: "wx" });
  return key;
}

export type StoredChat = { id: string; kind: string; name: string; webUrl: string | null; lastAt: string | null; readAt: string | null; newestAt: string | null; olderToken: string | null; backfilled: boolean };
export type Reaction = { emoji: string; count: number; mine: boolean };
export type StoredMessage = { chatId: string; id: string; at: string; fromId: string | null; from: string; mine: boolean; mentionsMe: boolean; text: string; reactions: Reaction[] };
export type FindingKind = "todo" | "reminder" | "followup";
export type Finding = { id: number; chatId: string; messageId: string | null; kind: FindingKind; title: string; due: string | null; state: "new" | "added" | "dismissed"; todoId: number | null; createdAt: number };

const rowChat = (id: string) => `chat:${id}`;
const rowMsg = (chat: string, id: string, field: string) => `msg:${chat}:${id}:${field}`;
const rowFinding = (chat: string, created: number, n: number) => `finding:${chat}:${created}:${n}`;

export type TeamsStore = ReturnType<typeof createStore>;

export function createStore(db: D1, s: Sealer) {
  const openOr = (v: unknown, row: string) => {
    try {
      return typeof v === "string" ? s.open(v, row) : "";
    } catch {
      return "(can't be read)";
    }
  };
  const chatOf = (r: Record<string, unknown>): StoredChat => ({
    id: String(r.id),
    kind: String(r.kind),
    name: openOr(r.name_sealed, rowChat(String(r.id))),
    webUrl: (r.web_url as string | null) ?? null,
    lastAt: (r.last_at as string | null) ?? null,
    readAt: (r.read_at as string | null) ?? null,
    newestAt: (r.newest_at as string | null) ?? null,
    olderToken: (r.older_token as string | null) ?? null,
    backfilled: r.backfilled === 1,
  });
  const msgOf = (r: Record<string, unknown>): StoredMessage => {
    const chatId = String(r.chat_id);
    const id = String(r.id);
    let reactions: Reaction[] = [];
    try {
      reactions = JSON.parse(String(r.reactions ?? "[]"));
    } catch {}
    return { chatId, id, at: String(r.at), fromId: (r.from_id as string | null) ?? null, from: openOr(r.from_sealed, rowMsg(chatId, id, "from")), mine: r.mine === 1, mentionsMe: r.mentions_me === 1, text: openOr(r.text_sealed, rowMsg(chatId, id, "text")), reactions };
  };
  return {
    async putChat(c: { id: string; kind: string; name: string; webUrl?: string; lastAt?: string; readAt?: string }) {
      await db
        .prepare(
          `INSERT INTO teams_chat (id, kind, name_sealed, web_url, last_at, read_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name_sealed = excluded.name_sealed, web_url = excluded.web_url, last_at = excluded.last_at, read_at = excluded.read_at`,
        )
        .bind(c.id, c.kind, s.seal(c.name, rowChat(c.id)), c.webUrl ?? null, c.lastAt ?? null, c.readAt ?? null)
        .run();
    },
    async chat(id: string): Promise<StoredChat | undefined> {
      const r = await db.prepare("SELECT * FROM teams_chat WHERE id = ?").bind(id).first<Record<string, unknown>>();
      return r ? chatOf(r) : undefined;
    },
    async chats(): Promise<StoredChat[]> {
      const { results } = await db.prepare("SELECT * FROM teams_chat ORDER BY last_at DESC").all<Record<string, unknown>>();
      return results.map(chatOf);
    },
    async setSync(id: string, o: { newestAt?: string | null; olderToken?: string | null; backfilled?: boolean }) {
      const c = await this.chat(id);
      if (!c) return;
      await db
        .prepare("UPDATE teams_chat SET newest_at = ?, older_token = ?, backfilled = ? WHERE id = ?")
        .bind(o.newestAt !== undefined ? o.newestAt : c.newestAt, o.olderToken !== undefined ? o.olderToken : c.olderToken, (o.backfilled ?? c.backfilled) ? 1 : 0, id)
        .run();
    },
    /** Kept as Graph has them now (an edit replaces the old text); how many were new. */
    async putMessages(chatId: string, msgs: Omit<StoredMessage, "chatId">[]): Promise<number> {
      let added = 0;
      for (const m of msgs) {
        const had = await db.prepare("SELECT 1 AS x FROM teams_message WHERE chat_id = ? AND id = ?").bind(chatId, m.id).first();
        await db
          .prepare("INSERT OR REPLACE INTO teams_message (chat_id, id, at, from_id, from_sealed, mine, mentions_me, text_sealed, reactions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(chatId, m.id, m.at, m.fromId, s.seal(m.from, rowMsg(chatId, m.id, "from")), m.mine ? 1 : 0, m.mentionsMe ? 1 : 0, s.seal(m.text, rowMsg(chatId, m.id, "text")), JSON.stringify(m.reactions.slice(0, 12)))
          .run();
        if (!had) added++;
      }
      return added;
    },
    /** A chat's newest messages, oldest first. */
    async messages(chatId: string, limit = 60): Promise<StoredMessage[]> {
      const { results } = await db.prepare("SELECT * FROM teams_message WHERE chat_id = ? ORDER BY at DESC LIMIT ?").bind(chatId, limit).all<Record<string, unknown>>();
      return results.map(msgOf).reverse();
    },
    async message(chatId: string, id: string): Promise<StoredMessage | undefined> {
      const r = await db.prepare("SELECT * FROM teams_message WHERE chat_id = ? AND id = ?").bind(chatId, id).first<Record<string, unknown>>();
      return r ? msgOf(r) : undefined;
    },
    /** What's new to me in a chat since I read it. */
    async newIn(chatId: string, readAt: string | null): Promise<{ count: number; mentioned: boolean }> {
      const r = await db
        .prepare("SELECT COUNT(*) AS n, MAX(mentions_me) AS m FROM teams_message WHERE chat_id = ? AND mine = 0 AND at > ?")
        .bind(chatId, readAt ?? "")
        .first<{ n: number; m: number | null }>();
      return { count: Number(r?.n ?? 0), mentioned: r?.m === 1 };
    },
    /** Messages after `since`, oldest first, for the crawler. */
    async since(since: string, limit: number): Promise<StoredMessage[]> {
      const { results } = await db.prepare("SELECT * FROM teams_message WHERE at > ? ORDER BY at ASC LIMIT ?").bind(since, limit).all<Record<string, unknown>>();
      return results.map(msgOf);
    },
    async counts(): Promise<{ chats: number; messages: number; oldest: string | null; backfilled: number }> {
      const c = await db.prepare("SELECT COUNT(*) AS n, SUM(backfilled) AS b FROM teams_chat").first<{ n: number; b: number | null }>();
      const m = await db.prepare("SELECT COUNT(*) AS n, MIN(at) AS o FROM teams_message").first<{ n: number; o: string | null }>();
      return { chats: Number(c?.n ?? 0), backfilled: Number(c?.b ?? 0), messages: Number(m?.n ?? 0), oldest: m?.o ?? null };
    },

    async addFindings(fs: { chatId: string; messageId: string | null; kind: FindingKind; title: string; due: string | null }[], now = Date.now()): Promise<number> {
      let n = 0;
      for (const f of fs) {
        // The same thing from the same message isn't proposed twice.
        const { results } = await db.prepare("SELECT * FROM teams_finding WHERE chat_id = ? AND message_id IS ?").bind(f.chatId, f.messageId).all<Record<string, unknown>>();
        if (results.some((r) => openOr(r.title_sealed, rowFinding(String(r.chat_id), Number(r.created_at), Number(r.id))).toLowerCase() === f.title.toLowerCase())) continue;
        const ins = await db
          .prepare("INSERT INTO teams_finding (chat_id, message_id, kind, title_sealed, due, created_at) VALUES (?, ?, ?, '', ?, ?) RETURNING id")
          .bind(f.chatId, f.messageId, f.kind, f.due, now)
          .first<{ id: number }>();
        if (!ins) continue;
        await db.prepare("UPDATE teams_finding SET title_sealed = ? WHERE id = ?").bind(s.seal(f.title, rowFinding(f.chatId, now, ins.id)), ins.id).run();
        n++;
      }
      return n;
    },
    async findings(state: Finding["state"] = "new", limit = 50): Promise<Finding[]> {
      const { results } = await db.prepare("SELECT * FROM teams_finding WHERE state = ? ORDER BY created_at DESC, id DESC LIMIT ?").bind(state, limit).all<Record<string, unknown>>();
      return results.map((r) => ({
        id: Number(r.id),
        chatId: String(r.chat_id),
        messageId: (r.message_id as string | null) ?? null,
        kind: String(r.kind) as FindingKind,
        title: openOr(r.title_sealed, rowFinding(String(r.chat_id), Number(r.created_at), Number(r.id))),
        due: (r.due as string | null) ?? null,
        state: String(r.state) as Finding["state"],
        todoId: (r.todo_id as number | null) ?? null,
        createdAt: Number(r.created_at),
      }));
    },
    async finding(id: number): Promise<Finding | undefined> {
      for (const st of ["new", "added", "dismissed"] as const) {
        const f = (await this.findings(st, 500)).find((x) => x.id === id);
        if (f) return f;
      }
      return undefined;
    },
    async settle(id: number, state: "added" | "dismissed", todoId?: number) {
      await db.prepare("UPDATE teams_finding SET state = ?, todo_id = ? WHERE id = ? AND state = 'new'").bind(state, todoId ?? null, id).run();
    },

    async addCrawl(c: { at: number; upto: string; messages: number; found: number; ok: boolean; error?: string }) {
      await db.prepare("INSERT INTO teams_crawl (at, upto, messages, found, ok, error) VALUES (?, ?, ?, ?, ?, ?)").bind(c.at, c.upto, c.messages, c.found, c.ok ? 1 : 0, c.error ?? null).run();
    },
    async lastCrawl(): Promise<{ at: number; upto: string; messages: number; found: number; ok: boolean; error: string | null } | undefined> {
      const r = await db.prepare("SELECT * FROM teams_crawl ORDER BY id DESC LIMIT 1").first<Record<string, unknown>>();
      return r ? { at: Number(r.at), upto: String(r.upto), messages: Number(r.messages), found: Number(r.found), ok: r.ok === 1, error: (r.error as string | null) ?? null } : undefined;
    },
    /** Up to when the crawler has looked, counting only crawls that worked. */
    async crawledUpto(): Promise<string | undefined> {
      const r = await db.prepare("SELECT MAX(upto) AS u FROM teams_crawl WHERE ok = 1").first<{ u: string | null }>();
      return r?.u ?? undefined;
    },
  };
}
