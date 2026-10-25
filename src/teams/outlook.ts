/**
 * Outlook's inbox through the Teams helper's sign-in: the newest first, and how many are unread.
 * Read every two minutes while Microsoft is connected.
 *
 * Mail lives in memory only: never on disk, in logs, the snapshot or search, and never given to a
 * model (Claude or the crawler). No calendar: Calendars.Read needs a tenant admin's grant.
 */
import { type Helper, PATHS } from "./helper.ts";
import { textOf } from "./model.ts";

export type Mail = {
  id: string;
  subject: string;
  from: string;
  fromAddress: string;
  at: string;
  unread: boolean;
  important: boolean;
  flagged: boolean;
  /** Outlook's Focused inbox (false: "Other"). */
  focused: boolean;
  preview: string;
  webUrl?: string;
};

export type OutlookView = {
  /** off: no helper; waiting: Microsoft isn't connected (the Teams sign-in). */
  state: "off" | "waiting" | "ok";
  mail?: { unread: number; items: Mail[]; at: number };
  mailError?: string;
};

const s = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : "");

const OUTLOOK_HOSTS = new Set(["outlook.office365.com", "outlook.office.com", "outlook.cloud.microsoft", "outlook.live.com"]);

/** Only Outlook's own https links. */
export function outlookUrl(v: unknown): string | undefined {
  try {
    const url = new URL(s(v, 4000));
    return url.protocol === "https:" && OUTLOOK_HOSTS.has(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The inbox's counts, from `/me/mailFolders/inbox`. */
export function inboxOf(raw: unknown): { unread: number; total: number } {
  const o = obj(raw);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return { unread: n(o.unreadItemCount), total: n(o.totalItemCount) };
}

/** The inbox's newest messages, read strictly. */
export function mailOf(raw: unknown): Mail[] {
  const out: Mail[] = [];
  for (const m of list(obj(raw).value).map(obj)) {
    const id = s(m.id, 400);
    const at = iso(m.receivedDateTime);
    if (!id || !at) continue;
    const addr = obj(obj(m.from).emailAddress);
    out.push({
      id,
      subject: s(m.subject, 300).trim() || "(no subject)",
      from: s(addr.name, 120).trim() || s(addr.address, 200) || "Someone",
      fromAddress: s(addr.address, 200),
      at,
      unread: m.isRead === false,
      important: m.importance === "high",
      flagged: obj(m.flag).flagStatus === "flagged",
      focused: m.inferenceClassification !== "other",
      preview: textOf(s(m.bodyPreview, 1000), 240),
      webUrl: outlookUrl(m.webLink),
    });
  }
  return out;
}

export type Outlook = {
  view(): OutlookView;
  /** Read again now (a page opened, Refresh). */
  kick(): void;
  stop(): void;
};

export function createOutlook(o: {
  helper?: Helper;
  /** Whether Microsoft is connected (the Teams sign-in). */
  connected: () => boolean;
  everyMs?: number;
  onChange?: () => void;
  now?: () => number;
}): Outlook {
  const now = o.now ?? Date.now;
  const every = o.everyMs ?? 120_000;
  let view: OutlookView = { state: o.helper ? "waiting" : "off" };
  let lastRead = 0;
  let reading = false;
  const set = (v: Partial<OutlookView>) => {
    view = { ...view, ...v };
    o.onChange?.();
  };

  async function read(force = false) {
    if (!o.helper || reading) return;
    if (!o.connected()) {
      if (view.state !== "waiting") set({ state: "waiting", mail: undefined, mailError: undefined });
      return;
    }
    if (!force && now() - lastRead < every) return;
    reading = true;
    lastRead = now();
    try {
      const [box, msgs] = await Promise.all([o.helper.get(PATHS.inbox), o.helper.get(PATHS.mail(25))]);
      set({ state: "ok", mail: { unread: inboxOf(box).unread, items: mailOf(msgs), at: now() }, mailError: undefined });
    } catch (e) {
      set({ state: "ok", mailError: (e as Error).message.slice(0, 300) });
    } finally {
      reading = false;
    }
  }

  // Check often whether Microsoft just connected; read every `every`.
  const timer = setInterval(() => void read(), Math.min(every, 30_000));
  timer.unref?.();
  setTimeout(() => void read(), 5_000).unref?.();

  return {
    view: () => view,
    kick: () => void read(now() - lastRead > 20_000),
    stop: () => clearInterval(timer),
  };
}
