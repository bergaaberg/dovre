/**
 * Teams in Dovre: my chats and what's new in them (every minute while connected), kept in an
 * encrypted local store with history back to a start date (src/teams/store.ts), messages and
 * reactions I send from Dovre, and a crawler on a Copilot model that proposes todos from what
 * was said (src/teams/crawl.ts).
 *
 * Chat text is never in logs, the snapshot, or anything Claude sees (Bino, agents, summaries): it's
 * sealed on disk, and only the crawler's Copilot model reads it. The actions log says that a
 * message was sent, and to which chat, never what it said.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { osloDate } from "../todo/store.ts";
import { batchesOf, type Crawler, findingsOf } from "./crawl.ts";
import type { Helper } from "./helper.ts";
import { PATHS, skiptokenOf } from "./helper.ts";
import { chatsOf, messageOf, readAtOf, type TeamsChat } from "./model.ts";
import { createStore, loadKey, sealerOf, type TeamsStore } from "./store.ts";
import type { D1 } from "../db.ts";

export type TeamsState = "off" | "connect" | "connecting" | "ok";

export type TeamsView = {
  state: TeamsState;
  /** Why it's off, or what the last sign-in said. */
  why?: string;
  account?: string;
  chats: TeamsChat[];
  /** When chats were last read. */
  at?: number;
  /** The last read failed (the chats shown are from before). */
  error?: string;
  /** The local store: how much is in, or why it isn't there. */
  store?: { chats: number; messages: number; oldest: string | null; backfilled: number; since: string } | { error: string };
  crawl?: { why?: string; running: boolean; last?: { at: number; messages: number; found: number; ok: boolean; error: string | null }; proposals: number; model: string };
};

export type Result = { ok: boolean; message: string };

export type Teams = {
  view(): TeamsView;
  /** Read again now (Refresh). */
  kick(): void;
  connect(): Promise<Result>;
  disconnect(): Promise<void>;
  /** The store, once its key is in (undefined before, or if it couldn't be opened). */
  store(): TeamsStore | undefined;
  /** Read one chat's newest messages into the store now (opening its page). */
  refreshChat(chatId: string): Promise<void>;
  send(chatId: string, text: string): Promise<Result>;
  react(chatId: string, messageId: string, reaction: string, on: boolean): Promise<Result>;
  /** Look through what's new for todos now. */
  crawl(): Promise<Result>;
  stop(): void;
};

const CHAT_PAGE = 50;
const MESSAGE_PAGE = 50;
/** Graph reads per minute for keeping up and for history, so a first sync doesn't flood Graph. */
const NEWEST_BUDGET = 10;
const BACKFILL_BUDGET = 8;
/** The first crawl looks back this far; later ones go on from where the last stopped. */
const FIRST_LOOK_DAYS = 7;
const DAY = 86_400_000;

const authError = (m: string) => /not signed in|authentication needed|InvalidAuthenticationToken|token.*expired|AADSTS|interaction required/i.test(m);

export type Log = (a: { kind: string; target: string; detail?: string; ok: boolean; error?: string }) => Promise<void>;

export function createTeams(o: {
  helper?: Helper;
  marker: string;
  off?: string;
  everyMs?: number;
  onChange?: () => void;
  now?: () => number;
  /** The store: Dovre's database and where the wrapped key lives. */
  db?: D1;
  keyFile?: string;
  /** History is kept from this many days back (default 60). */
  sinceDays?: number;
  log?: Log;
  crawler?: Crawler;
  /** How often the crawler looks (default 2 h); 0: only when asked. */
  crawlEveryMs?: number;
  /** Who I am, for the crawler's prompt. */
  me?: () => string;
}): Teams {
  const now = o.now ?? Date.now;
  const every = o.everyMs ?? 60_000;
  const since = new Date(now() - (o.sinceDays ?? 60) * DAY).toISOString();
  let view: TeamsView = o.off || !o.helper ? { state: "off", why: o.off ?? "Teams needs PowerShell 7 (pwsh).", chats: [] } : { state: "connect", chats: [] };
  let me = "";
  let timer: NodeJS.Timeout | undefined;
  let crawlTimer: NodeJS.Timeout | undefined;
  let reading = false;
  let crawling = false;
  let store: TeamsStore | undefined;
  let storeError: string | undefined;
  /** Where listing older chats goes on (first sync), and whether it's done. */
  let chatsToken: string | undefined;
  let chatsListed = false;
  const set = (v: Partial<TeamsView>) => {
    view = { ...view, ...v };
    o.onChange?.();
  };
  const log: Log = o.log ?? (async () => {});

  const marked = (): boolean => {
    try {
      return existsSync(o.marker) && typeof JSON.parse(readFileSync(o.marker, "utf8")) === "object";
    } catch {
      return false;
    }
  };

  async function openStore() {
    if (store || !o.db || !o.keyFile || !o.helper) return;
    try {
      store = createStore(o.db, sealerOf(await loadKey(o.keyFile, o.helper)));
      storeError = undefined;
    } catch (e) {
      storeError = `The Teams store didn't open: ${(e as Error).message.slice(0, 200)}`;
    }
  }

  async function storeView(): Promise<TeamsView["store"]> {
    if (!store) return storeError ? { error: storeError } : undefined;
    return { ...(await store.counts()), since };
  }

  async function crawlView(): Promise<TeamsView["crawl"]> {
    if (!o.crawler) return undefined;
    const last = await store?.lastCrawl();
    return { why: o.crawler.why(), running: crawling, last, proposals: store ? (await store.findings("new", 500)).length : 0, model: o.crawler.model };
  }

  /** Newest messages of one chat, back to what's kept; the first time, also where history goes on from. */
  async function syncNewest(chatId: string, budget: { left: number }) {
    if (!store || !o.helper) return;
    const kept = await store.chat(chatId);
    let token: string | undefined;
    let newest = kept?.newestAt ?? null;
    let first = true;
    while (budget.left > 0) {
      budget.left--;
      const raw = (await o.helper.get(token ? PATHS.messagesAfter(chatId, MESSAGE_PAGE, token) : PATHS.messages(chatId, MESSAGE_PAGE))) as { value?: unknown[]; "@odata.nextLink"?: string };
      const msgs = (raw.value ?? []).map((m) => messageOf(m, me)).filter((m) => !!m);
      await store.putMessages(chatId, msgs);
      const top = msgs.reduce((a, m) => (m.at > a ? m.at : a), "");
      if (first && top && (!newest || top > newest)) newest = top;
      first = false;
      token = skiptokenOf(raw["@odata.nextLink"]);
      const oldest = msgs.reduce((a, m) => (!a || m.at < a ? m.at : a), "");
      // Caught up with what was kept, or no further back.
      if (!token || (kept?.newestAt && oldest && oldest <= kept.newestAt)) break;
      if (oldest && oldest < since) {
        token = undefined;
        break;
      }
    }
    // A chat seen for the first time: history goes on from where this stopped.
    if (!kept?.newestAt) await store.setSync(chatId, { newestAt: newest, olderToken: token ?? null, backfilled: !token });
    else await store.setSync(chatId, { newestAt: newest });
  }

  /** History, a page at a time, for chats not yet back to `since`. */
  async function backfill(budget: { left: number }) {
    if (!store || !o.helper) return;
    for (const c of await store.chats()) {
      if (budget.left <= 0) return;
      if (c.backfilled || !c.olderToken) continue;
      if (c.lastAt && c.lastAt < since) {
        await store.setSync(c.id, { backfilled: true, olderToken: null });
        continue;
      }
      budget.left--;
      const raw = (await o.helper.get(PATHS.messagesAfter(c.id, MESSAGE_PAGE, c.olderToken))) as { value?: unknown[]; "@odata.nextLink"?: string };
      const msgs = (raw.value ?? []).map((m) => messageOf(m, me)).filter((m) => !!m);
      await store.putMessages(c.id, msgs);
      const token = skiptokenOf(raw["@odata.nextLink"]);
      const oldest = msgs.reduce((a, m) => (!a || m.at < a ? m.at : a), "");
      const done = !token || (!!oldest && oldest < since);
      await store.setSync(c.id, { olderToken: done ? null : token, backfilled: done });
    }
  }

  async function read() {
    if (!o.helper || view.state !== "ok" || reading) return;
    reading = true;
    try {
      if (!me) me = String(((await o.helper.get(PATHS.me)) as { id?: unknown }).id ?? "");
      await openStore();
      const raw = (await o.helper.get(PATHS.chats(CHAT_PAGE))) as { value?: unknown[]; "@odata.nextLink"?: string };
      const chats = chatsOf(raw, me);
      const readAt = readAtOf(raw);
      if (!chatsListed && chatsToken === undefined) chatsToken = skiptokenOf(raw["@odata.nextLink"]) ?? "";
      if (store) {
        // Keep the chats, then read what's new in them.
        for (const c of chats) await store.putChat({ id: c.id, kind: c.kind, name: c.name, webUrl: c.webUrl, lastAt: c.last?.at, readAt: readAt.get(c.id) });
        const budget = { left: NEWEST_BUDGET };
        for (const c of chats) {
          const kept = await store.chat(c.id);
          if (c.last?.at && (!kept?.newestAt || c.last.at > kept.newestAt)) await syncNewest(c.id, budget).catch(() => undefined);
        }
        // Older chats, a page a minute, until they're older than `since`.
        if (!chatsListed && chatsToken && budget.left > 0) {
          budget.left--;
          const page = (await o.helper.get(PATHS.chatsAfter(CHAT_PAGE, chatsToken))) as { value?: unknown[]; "@odata.nextLink"?: string };
          const older = chatsOf(page, me);
          const readOlder = readAtOf(page);
          for (const c of older) await store.putChat({ id: c.id, kind: c.kind, name: c.name, webUrl: c.webUrl, lastAt: c.last?.at, readAt: readOlder.get(c.id) });
          for (const c of older) if (c.last?.at && c.last.at >= since && budget.left > 0) await syncNewest(c.id, budget).catch(() => undefined);
          chatsToken = skiptokenOf(page["@odata.nextLink"]);
          if (!chatsToken || older.every((c) => !c.last?.at || c.last.at < since)) chatsListed = true;
        }
        await backfill({ left: BACKFILL_BUDGET }).catch(() => undefined);
        for (const c of chats.filter((x) => x.unread)) {
          const n = await store.newIn(c.id, readAt.get(c.id) ?? null);
          c.unreadCount = Math.max(1, n.count);
          c.mentioned = n.mentioned;
        }
      }
      set({ chats, at: now(), error: undefined, store: await storeView(), crawl: await crawlView() });
    } catch (e) {
      const m = (e as Error).message;
      if (authError(m)) set({ state: "connect", why: `The Teams sign-in ran out: connect again. (${m.slice(0, 160)})` });
      else set({ error: m.slice(0, 300), store: await storeView().catch(() => undefined) });
    } finally {
      reading = false;
    }
  }

  const poll = () => {
    clearInterval(timer);
    timer = setInterval(() => void read(), every);
    timer.unref?.();
    clearInterval(crawlTimer);
    const ce = o.crawlEveryMs ?? 2 * 3_600_000;
    if (o.crawler && ce > 0) {
      crawlTimer = setInterval(() => void crawl(), ce);
      crawlTimer.unref?.();
    }
  };

  async function connect(): Promise<Result> {
    if (!o.helper) return { ok: false, message: view.why ?? "Teams is off." };
    if (view.state === "connecting") return { ok: false, message: "Already signing in: finish the Microsoft window." };
    set({ state: "connecting", why: undefined });
    try {
      const c = await o.helper.connect();
      writeFileSync(o.marker, JSON.stringify({ account: c.account, at: now() }), { mode: 0o600 });
      me = "";
      set({ state: "ok", account: c.account });
      poll();
      await read();
      return { ok: true, message: `Teams connected${c.account ? ` as ${c.account}` : ""}.` };
    } catch (e) {
      const m = (e as Error).message.slice(0, 300);
      set({ state: "connect", why: m });
      return { ok: false, message: `Teams didn't connect: ${m}` };
    }
  }

  async function crawl(): Promise<Result> {
    if (!o.crawler) return { ok: false, message: "The crawler is off." };
    const no = o.crawler.why();
    if (no) return { ok: false, message: no };
    if (!store) return { ok: false, message: storeError ?? "The Teams store isn't open yet." };
    if (crawling) return { ok: false, message: "Already looking through Teams." };
    crawling = true;
    set({ crawl: await crawlView() });
    const startedAt = now();
    let looked = 0;
    let found = 0;
    try {
      const from = (await store.crawledUpto()) ?? new Date(now() - FIRST_LOOK_DAYS * DAY).toISOString();
      const msgs = (await store.since(from, 2000)).filter((m) => m.text.trim());
      if (!msgs.length) {
        await store.addCrawl({ at: startedAt, upto: from, messages: 0, found: 0, ok: true });
        return { ok: true, message: "Nothing new in Teams to look through." };
      }
      const chats = new Map((await store.chats()).map((c) => [c.id, { name: c.name, kind: c.kind }]));
      for (const b of batchesOf(msgs, chats, { me: o.me?.() ?? "", today: osloDate(now()) }).slice(0, 5)) {
        const text = await o.crawler.ask(b.prompt);
        found += await store.addFindings(findingsOf(text, b.refs));
        looked += b.count;
        await store.addCrawl({ at: startedAt, upto: b.upto, messages: b.count, found, ok: true });
      }
      return { ok: true, message: found ? `Found ${found} in Teams for My list.` : `Looked through ${looked} messages: nothing for My list.` };
    } catch (e) {
      const m = (e as Error).message.slice(0, 300);
      await store.addCrawl({ at: startedAt, upto: "", messages: looked, found, ok: false, error: m });
      return { ok: false, message: `The crawler didn't finish: ${m}` };
    } finally {
      crawling = false;
      set({ crawl: await crawlView() });
    }
  }

  // Connected before: sign in again by itself (Graph PowerShell keeps its token cache).
  if (view.state === "connect" && marked()) void connect();

  /** Before a write: the chat (and message) are still there to write to. */
  async function recheck(chatId: string, messageId?: string): Promise<string | undefined> {
    try {
      if (messageId) {
        const m = (await o.helper!.get(PATHS.message(chatId, messageId))) as { deletedDateTime?: unknown };
        if (m.deletedDateTime) return "That message was deleted.";
      } else await o.helper!.get(PATHS.messages(chatId, 1));
      return undefined;
    } catch (e) {
      return `Couldn't check the chat first: ${(e as Error).message.slice(0, 200)}`;
    }
  }

  return {
    view: () => view,
    kick: () => void read(),
    connect,
    store: () => store,
    async refreshChat(chatId) {
      if (view.state !== "ok" || !store) return;
      await syncNewest(chatId, { left: 2 }).catch(() => undefined);
      o.onChange?.();
    },
    async send(chatId, text) {
      if (view.state !== "ok" || !o.helper) return { ok: false, message: "Teams isn't connected." };
      const target = `chat ${chatId.slice(0, 40)}`;
      const no = await recheck(chatId);
      if (no) return { ok: false, message: no };
      try {
        await o.helper.send(chatId, text);
        await log({ kind: "teams.send", target, detail: `${text.length} characters`, ok: true });
        await syncNewest(chatId, { left: 1 }).catch(() => undefined);
        o.onChange?.();
        return { ok: true, message: "Sent." };
      } catch (e) {
        const m = (e as Error).message.slice(0, 300);
        await log({ kind: "teams.send", target, detail: `${text.length} characters`, ok: false, error: m });
        return { ok: false, message: `Not sent: ${m}` };
      }
    },
    async react(chatId, messageId, reaction, on) {
      if (view.state !== "ok" || !o.helper) return { ok: false, message: "Teams isn't connected." };
      const target = `chat ${chatId.slice(0, 40)} message ${messageId}`;
      const no = await recheck(chatId, messageId);
      if (no) return { ok: false, message: no };
      try {
        await o.helper.react(chatId, messageId, reaction, on);
        await log({ kind: on ? "teams.react" : "teams.unreact", target, detail: reaction, ok: true });
        await syncNewest(chatId, { left: 1 }).catch(() => undefined);
        o.onChange?.();
        return { ok: true, message: on ? `Reacted ${reaction}.` : `Took back ${reaction}.` };
      } catch (e) {
        const m = (e as Error).message.slice(0, 300);
        await log({ kind: on ? "teams.react" : "teams.unreact", target, detail: reaction, ok: false, error: m });
        return { ok: false, message: `Didn't react: ${m}` };
      }
    },
    crawl,
    async disconnect() {
      clearInterval(timer);
      clearInterval(crawlTimer);
      rmSync(o.marker, { force: true });
      await o.helper?.disconnect();
      me = "";
      set({ state: o.helper ? "connect" : "off", account: undefined, chats: [], at: undefined, error: undefined, why: undefined });
    },
    stop() {
      clearInterval(timer);
      clearInterval(crawlTimer);
      o.helper?.stop();
    },
  };
}
