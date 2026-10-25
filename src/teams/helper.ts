/**
 * The Teams helper (scripts/teams.ps1): one long-lived pwsh signed in through Graph PowerShell,
 * asked over stdin/stdout in JSON lines. Graph PowerShell's token carries far more than chats
 * (directory, mail, sites), so both sides hold the same short lists: reads from the paths below
 * (chats; the inbox and team channels, read-only) and two writes the script builds itself (a
 * plain-text chat message; one of Teams' six reactions). Each is checked here before it's sent,
 * and again in the script.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

const top = (n: number) => Math.min(50, Math.max(1, Math.floor(n)));
/** encodeURIComponent, and the five characters it leaves alone too: what's left is [A-Za-z0-9%._~-]. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The only things Dovre asks Graph for. */
export const PATHS = {
  me: "/v1.0/me?$select=id,displayName",
  chats: (n: number) => `/v1.0/me/chats?$expand=members,lastMessagePreview&$top=${top(n)}&$orderby=lastMessagePreview/createdDateTime%20desc`,
  chatsAfter: (n: number, skiptoken: string) => `${PATHS.chats(n)}&$skiptoken=${enc(skiptoken)}`,
  messages: (chatId: string, n: number) => `/v1.0/chats/${enc(chatId)}/messages?$top=${top(n)}`,
  messagesAfter: (chatId: string, n: number, skiptoken: string) => `${PATHS.messages(chatId, n)}&$skiptoken=${enc(skiptoken)}`,
  message: (chatId: string, messageId: string) => `/v1.0/chats/${enc(chatId)}/messages/${/^\d{1,20}$/.test(messageId) ? messageId : "x"}`,
  // Outlook and team channels: read-only, held in memory only (src/teams/outlook.ts, channels.ts).
  inbox: "/v1.0/me/mailFolders/inbox?$select=unreadItemCount,totalItemCount",
  mail: (n: number) => `/v1.0/me/mailFolders/inbox/messages?$select=id,subject,from,receivedDateTime,isRead,importance,flag,webLink,bodyPreview,inferenceClassification&$orderby=receivedDateTime%20desc&$top=${top(n)}`,
  joinedTeams: "/v1.0/me/joinedTeams",
  channels: (teamId: string) => `/v1.0/teams/${TEAM_ID.test(teamId) ? teamId : "x"}/channels`,
  posts: (teamId: string, channelId: string, n: number) => `/v1.0/teams/${TEAM_ID.test(teamId) ? teamId : "x"}/channels/${enc(channelId)}/messages?$top=${top(n)}&$expand=replies`,
};

export const TEAM_ID = /^[0-9a-f-]{36}$/;

/** The $skiptoken of Graph's @odata.nextLink, to go on from with PATHS.*After (never the link itself). */
export function skiptokenOf(nextLink: unknown): string | undefined {
  if (typeof nextLink !== "string") return undefined;
  try {
    const u = new URL(nextLink);
    return u.origin === "https://graph.microsoft.com" ? (u.searchParams.get("$skiptoken") ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/** Teams' own six reactions, as Graph names them in chats. */
export const REACTIONS = ["👍", "❤️", "😆", "😮", "😢", "😡"] as const;
export const CHAT_ID = /^[A-Za-z0-9:@._-]{1,200}$/;
export const MESSAGE_ID = /^\d{1,20}$/;
export const MAX_SEND = 4000;

/** The same list as scripts/teams.ps1's $Allowed (test/teams.test.ts holds them together). */
export const ALLOWED = [
  /^\/v1\.0\/me\?\$select=id,displayName$/,
  /^\/v1\.0\/me\/chats\?\$expand=members,lastMessagePreview&\$top=\d{1,2}&\$orderby=lastMessagePreview\/createdDateTime%20desc$/,
  /^\/v1\.0\/me\/chats\?\$expand=members,lastMessagePreview&\$top=\d{1,2}&\$orderby=lastMessagePreview\/createdDateTime%20desc&\$skiptoken=[A-Za-z0-9%._~-]{1,4000}$/,
  /^\/v1\.0\/chats\/[A-Za-z0-9%._-]{1,200}\/messages\?\$top=\d{1,2}$/,
  /^\/v1\.0\/chats\/[A-Za-z0-9%._-]{1,200}\/messages\?\$top=\d{1,2}&\$skiptoken=[A-Za-z0-9%._~-]{1,4000}$/,
  /^\/v1\.0\/chats\/[A-Za-z0-9%._-]{1,200}\/messages\/\d{1,20}$/,
  /^\/v1\.0\/me\/mailFolders\/inbox\?\$select=unreadItemCount,totalItemCount$/,
  /^\/v1\.0\/me\/mailFolders\/inbox\/messages\?\$select=id,subject,from,receivedDateTime,isRead,importance,flag,webLink,bodyPreview,inferenceClassification&\$orderby=receivedDateTime%20desc&\$top=\d{1,2}$/,
  /^\/v1\.0\/me\/joinedTeams$/,
  /^\/v1\.0\/teams\/[0-9a-f-]{36}\/channels$/,
  /^\/v1\.0\/teams\/[0-9a-f-]{36}\/channels\/[A-Za-z0-9%._-]{1,200}\/messages\?\$top=\d{1,2}&\$expand=replies$/,
];
export const allowedPath = (p: string) => ALLOWED.some((r) => r.test(p));

/** Graph's JSON, with any raw control character in it escaped first (message text can carry them). */
export function parseGraph(text: string): unknown {
  return JSON.parse(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

export type Connected = { account: string };
export type Helper = {
  connect(): Promise<Connected>;
  disconnect(): Promise<void>;
  /** A GET of one allowed path; the parsed answer. */
  get(path: string): Promise<unknown>;
  /** A plain-text message to a chat (the script builds the request); the new message's id. */
  send(chatId: string, text: string): Promise<string>;
  /** Set (on) or take back one of Teams' six reactions on a message. */
  react(chatId: string, messageId: string, reaction: string, on: boolean): Promise<void>;
  /** Windows DPAPI for this user: wrap and unwrap the store's 32-byte key (base64). */
  wrap(key64: string): Promise<string>;
  unwrap(sealed64: string): Promise<string>;
  stop(): void;
};

type Waiting = { res: (v: Record<string, unknown>) => void; rej: (e: Error) => void; timer: NodeJS.Timeout };

export function createHelper(o: { pwsh: string; script: string; spawnFn?: typeof spawn }): Helper {
  let child: ChildProcess | undefined;
  let n = 0;
  const waiting = new Map<number, Waiting>();

  const start = (): ChildProcess => {
    const c = (o.spawnFn ?? spawn)(o.pwsh, ["-NoLogo", "-NoProfile", "-File", o.script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child = c;
    // Only the last line of stderr, and only to say why the helper ended.
    let lastErr = "";
    c.stderr?.on("data", (d) => {
      const lines = String(d).split(/\r?\n/).filter((l) => l.trim());
      if (lines.length) lastErr = lines[lines.length - 1]!.slice(0, 300);
    });
    createInterface({ input: c.stdout! }).on("line", (line) => {
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(line);
      } catch {
        // Unreadable: fail the request it answers at once, rather than waiting it out.
        const id = Number(/^\{"id":(\d+)/.exec(line)?.[1] ?? /"id":(\d+)[,}]/.exec(line)?.[1]);
        const w = waiting.get(id);
        if (w) {
          waiting.delete(id);
          clearTimeout(w.timer);
          w.rej(new Error("The Teams helper's answer didn't parse"));
        }
        return;
      }
      if (j.id === 0 && j.ok === false) lastErr = String(j.error ?? "").slice(0, 300);
      const w = waiting.get(Number(j.id));
      if (!w) return;
      waiting.delete(Number(j.id));
      clearTimeout(w.timer);
      if (j.ok === true) w.res(j);
      else w.rej(new Error(String(j.error ?? "the Teams helper said no").slice(0, 300)));
    });
    const ended = (why: string) => {
      if (child === c) child = undefined;
      for (const w of waiting.values()) {
        clearTimeout(w.timer);
        w.rej(new Error(why));
      }
      waiting.clear();
    };
    c.on("exit", (code) => ended(`The Teams helper ended (${code})${lastErr ? `: ${lastErr}` : ""}`));
    c.on("error", (e) => ended(`The Teams helper didn't start: ${e.message}`));
    return c;
  };

  const ask = (req: Record<string, unknown>, ms: number) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      const c = child ?? start();
      const id = ++n;
      const timer = setTimeout(() => {
        waiting.delete(id);
        rej(new Error(`Teams didn't answer within ${Math.round(ms / 1000)} s`));
      }, ms);
      timer.unref?.();
      waiting.set(id, { res, rej, timer });
      c.stdin?.write(`${JSON.stringify({ ...req, id })}\n`);
    });

  return {
    async connect() {
      // A sign-in window may need the user: give them time.
      const r = await ask({ op: "connect" }, 5 * 60_000);
      return { account: String(r.account ?? "") };
    },
    async disconnect() {
      await ask({ op: "disconnect" }, 30_000).catch(() => undefined);
    },
    async get(path) {
      if (!allowedPath(path)) throw new Error("not an allowed Graph path");
      const r = await ask({ op: "get", path }, 30_000);
      const text = typeof r.body64 === "string" ? Buffer.from(r.body64, "base64").toString("utf8") : typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null);
      return parseGraph(text);
    },
    async send(chatId, text) {
      if (!CHAT_ID.test(chatId)) throw new Error("not a chat id");
      if (!text.trim() || text.length > MAX_SEND) throw new Error(`a message is 1 to ${MAX_SEND} characters`);
      return String((await ask({ op: "send", chatId, text }, 30_000)).messageId ?? "");
    },
    async react(chatId, messageId, reaction, on) {
      if (!CHAT_ID.test(chatId) || !MESSAGE_ID.test(messageId)) throw new Error("not a chat message");
      if (!(REACTIONS as readonly string[]).includes(reaction)) throw new Error("not one of Teams' reactions");
      await ask({ op: "react", chatId, messageId, reaction, on }, 30_000);
    },
    async wrap(key64) {
      return String((await ask({ op: "wrap", data: key64 }, 60_000)).data ?? "");
    },
    async unwrap(sealed64) {
      return String((await ask({ op: "unwrap", data: sealed64 }, 60_000)).data ?? "");
    },
    stop() {
      child?.kill();
      child = undefined;
    },
  };
}
