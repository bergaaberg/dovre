/**
 * GitHub as the person (#523): Sign in with GitHub keeps the app's user token and refresh token,
 * sealed (src/seal.ts, GITHUB_TOKEN_SEAL) in `github_tokens`, one row per email. Dovre then calls
 * GitHub with them in place of the broad GITHUB_TOKEN:
 *
 * - A person's write (a POST they make) goes with their own token, when they've signed in with GitHub.
 * - Everything else (pages, the background snapshot, cron) goes with the operator's: the row whose
 *   login is GITHUB_USER, else the first ALLOWED_EMAILS entry that has one.
 * - Without a usable row, GITHUB_TOKEN as before; without that, the call fails saying what to do.
 *
 * GitHub App user tokens last 8 hours and their refresh tokens 6 months. A token is refreshed here
 * when less than REFRESH_BEFORE_MS is left. GitHub rotates the refresh token on each use, so a
 * refresh is written only if the row still holds the one it started from; the loser reads the
 * winner's. A refused refresh marks the row revoked (sign in with GitHub again), but only while the
 * row still holds that refresh token, and a winner's write sets it back to ok. Tokens are never
 * logged, and only an isolate's memory holds them unsealed.
 */
import type { D1 } from "../../db.ts";
import { SEAL_MIN, seal, unseal } from "../../seal.ts";
import type { GithubApp } from "./github.ts";

export const REFRESH_BEFORE_MS = 15 * 60_000;
/** How long "nobody has a token" is believed before D1 is asked again (a new sign-in shows within this). */
export const MISS_MS = 60_000;

export type Grant = { access: string; accessExpiresAt: number; refresh: string; refreshExpiresAt: number };

/** GitHub's token answer → a grant (ms times), or undefined (an error, or an app whose tokens don't expire). */
export function grantOf(body: unknown, nowMs: number): Grant | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
  if (typeof b.access_token !== "string" || typeof b.refresh_token !== "string" || !b.access_token || !b.refresh_token) return undefined;
  const ttl = n(b.expires_in);
  const refreshTtl = n(b.refresh_token_expires_in);
  if (!ttl || !refreshTtl) return undefined;
  return { access: b.access_token, accessExpiresAt: nowMs + ttl * 1000, refresh: b.refresh_token, refreshExpiresAt: nowMs + refreshTtl * 1000 };
}

/** The sealing secret, when it's long enough to use. */
export const sealOf = (b: { GITHUB_TOKEN_SEAL?: string }): string | undefined => {
  const s = b.GITHUB_TOKEN_SEAL?.trim();
  return s && s.length >= SEAL_MIN ? s : undefined;
};

type Row = { email: string; login: string; access_sealed: string; access_expires_at: number; refresh_sealed: string; refresh_expires_at: number; status: string };

const ctx = (email: string, which: "access" | "refresh") => `${email}:${which}`;

/** Keeps a fresh grant for this email (a sign-in), replacing any earlier one. */
export async function keepGrant(db: D1, secret: string, email: string, login: string, grant: Grant, nowMs = Date.now()): Promise<void> {
  const e = email.trim().toLowerCase();
  await db
    .prepare(
      `INSERT INTO github_tokens (email, login, access_sealed, access_expires_at, refresh_sealed, refresh_expires_at, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ok', ?)
       ON CONFLICT(email) DO UPDATE SET login = excluded.login, access_sealed = excluded.access_sealed, access_expires_at = excluded.access_expires_at,
         refresh_sealed = excluded.refresh_sealed, refresh_expires_at = excluded.refresh_expires_at, status = 'ok', updated_at = excluded.updated_at`,
    )
    .bind(e, login, await seal(secret, ctx(e, "access"), grant.access), grant.accessExpiresAt, await seal(secret, ctx(e, "refresh"), grant.refresh), grant.refreshExpiresAt, nowMs)
    .run();
}

export type AppTokens = {
  /** This person's current token, or undefined when they have none that works. */
  forEmail(email: string): Promise<string | undefined>;
  /** The operator's (GITHUB_USER's row, else ALLOWED_EMAILS in order), or undefined. */
  operator(): Promise<string | undefined>;
};

export function appTokens(o: { db: D1; secret: string; app: GithubApp; allowedEmails: string[]; operatorLogin?: string; fetch?: typeof fetch; now?: () => number }): AppTokens {
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = o.now ?? Date.now;
  const allowed = o.allowedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  /** Unsealed tokens by email, while they have more than REFRESH_BEFORE_MS left: one D1 read per token, not per call. */
  const mem = new Map<string, { token: string; until: number }>();
  const inflight = new Map<string, Promise<string | undefined>>();
  /** Emails with no usable token, until when: asked again after MISS_MS, not on every call. */
  const miss = new Map<string, number>();
  let operatorEmail: string | undefined;
  let operatorMissUntil = 0;

  const rowOf = (email: string) => o.db.prepare("SELECT * FROM github_tokens WHERE email = ?").bind(email).first<Row>();

  const answer = async (r: Row): Promise<string | undefined> => {
    const token = await unseal(o.secret, ctx(r.email, "access"), r.access_sealed);
    if (token) mem.set(r.email, { token, until: r.access_expires_at - REFRESH_BEFORE_MS });
    return token;
  };

  const refresh = async (r: Row): Promise<string | undefined> => {
    const stillValid = r.access_expires_at > now() + 60_000;
    const old = await unseal(o.secret, ctx(r.email, "refresh"), r.refresh_sealed);
    if (!old) return undefined;
    let body: Record<string, unknown> = {};
    let ok = false;
    try {
      const res = await f("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "dovre" },
        body: new URLSearchParams({ client_id: o.app.clientId, client_secret: o.app.clientSecret, grant_type: "refresh_token", refresh_token: old }),
      });
      ok = res.ok;
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (e) {
      console.error(`github tokens: refresh failed: ${(e as Error)?.message ?? e}`);
      return stillValid ? answer(r) : undefined;
    }
    const at = now();
    const grant = ok ? grantOf(body, at) : undefined;
    if (!grant) {
      const code = typeof body.error === "string" ? body.error.slice(0, 60) : "";
      console.error(`github tokens: refresh refused ${code}`);
      // Another isolate's refresh may have used it a moment ago: its row is the one to use.
      const now2 = await rowOf(r.email);
      if (now2 && now2.refresh_sealed !== r.refresh_sealed) return now2.status === "ok" && now2.access_expires_at > at ? answer(now2) : undefined;
      if (code === "bad_refresh_token") await o.db.prepare("UPDATE github_tokens SET status = 'revoked', updated_at = ? WHERE email = ? AND refresh_sealed = ?").bind(at, r.email, r.refresh_sealed).run();
      return stillValid ? answer(r) : undefined;
    }
    const w = await o.db
      .prepare("UPDATE github_tokens SET access_sealed = ?, access_expires_at = ?, refresh_sealed = ?, refresh_expires_at = ?, status = 'ok', updated_at = ? WHERE email = ? AND refresh_sealed = ?")
      .bind(await seal(o.secret, ctx(r.email, "access"), grant.access), grant.accessExpiresAt, await seal(o.secret, ctx(r.email, "refresh"), grant.refresh), grant.refreshExpiresAt, at, r.email, r.refresh_sealed)
      .run();
    if (w.meta.changes) {
      mem.set(r.email, { token: grant.access, until: grant.accessExpiresAt - REFRESH_BEFORE_MS });
      return grant.access;
    }
    // Someone wrote first; this grant is still a good token, but theirs is what the row keeps.
    const theirs = await rowOf(r.email);
    return theirs && theirs.status === "ok" ? answer(theirs) : grant.access;
  };

  const fresh = async (email: string): Promise<string | undefined> => {
    const r = await rowOf(email);
    if (!r || r.status !== "ok" || r.refresh_expires_at <= now()) return undefined;
    if (r.access_expires_at - now() > REFRESH_BEFORE_MS) return answer(r);
    return refresh(r);
  };

  const forEmail = async (raw: string): Promise<string | undefined> => {
    const email = raw.trim().toLowerCase();
    // Only someone ALLOWED_EMAILS still names: removing an email stops its token being used.
    if (!allowed.includes(email)) return undefined;
    const m = mem.get(email);
    if (m && m.until > now()) return m.token;
    if ((miss.get(email) ?? 0) > now()) return undefined;
    // One refresh per email at a time in this isolate.
    let p = inflight.get(email);
    if (!p) {
      p = fresh(email)
        .then((t) => (t ? miss.delete(email) : miss.set(email, now() + MISS_MS), t))
        .catch((e) => (console.error(`github tokens: ${(e as Error)?.message ?? e}`), undefined))
        .finally(() => inflight.delete(email));
      inflight.set(email, p);
    }
    return p;
  };

  const operator = async (): Promise<string | undefined> => {
    const kept = operatorEmail && mem.get(operatorEmail);
    if (kept && kept.until > now()) return kept.token;
    if (operatorMissUntil > now()) return undefined;
    const found = await pickOperator();
    if (found) operatorEmail = found.email;
    else operatorMissUntil = now() + MISS_MS;
    return found?.token;
  };

  const pickOperator = async (): Promise<{ email: string; token: string } | undefined> => {
    const login = o.operatorLogin?.trim().toLowerCase();
    if (login) {
      const r = await o.db.prepare("SELECT email FROM github_tokens WHERE lower(login) = ? AND status = 'ok' ORDER BY updated_at DESC").bind(login).all<{ email: string }>();
      for (const { email } of r.results) {
        const t = await forEmail(email);
        if (t) return { email, token: t };
      }
    }
    for (const email of allowed) {
      const t = await forEmail(email);
      if (t) return { email, token: t };
    }
    return undefined;
  };

  return { forEmail, operator };
}
