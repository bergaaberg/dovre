/**
 * Who gets in (PLAN D16). Two modes, and a request never picks its own:
 * - Local (the default): a localhost Host and the launch-token cookie. Anything else is a 404.
 * - Hosted (IS_HOSTED=1, set by the Worker, never by a request): Cloudflare Access's
 *   Cf-Access-Jwt-Assertion, its RS256 signature checked against the team's published keys, with
 *   its issuer, audience and expiry. Without a team and an audience configured, nobody gets in.
 */
import { timingSafeEqual } from "node:crypto";

export const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
export const COOKIE = "u_tk";

export type CfAccessPayload = {
  aud?: string | string[];
  email?: string;
  exp?: number;
  nbf?: number;
  iss?: string;
  sub?: string;
  type?: string;
  /** A service token's client id (Access puts it here instead of an email). */
  common_name?: string;
};

export function sameSecret(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function cookieOf(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at) === name) return decodeURIComponent(part.slice(at + 1));
  }
  return undefined;
}

export function isLocal(request: Request): boolean {
  try {
    return LOCAL_HOSTS.includes(new URL(request.url).hostname);
  } catch {
    return false;
  }
}

/** Local mode: a localhost Host (no DNS rebinding) and the launch-token cookie. */
export function allowed(request: Request, token: string | undefined): boolean {
  return isLocal(request) && sameSecret(cookieOf(request, COOKIE), token);
}

// ── Hosted: Cloudflare Access ──

const b64urlBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64urlJson = (s: string): unknown => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/** A JWT's payload, unverified: only for reading claims after `verify` said yes, or in tests. */
export function parseJwtPayload(jwt: string): CfAccessPayload | undefined {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return undefined;
    const p = b64urlJson(parts[1]!);
    return p && typeof p === "object" ? (p as CfAccessPayload) : undefined;
  } catch {
    return undefined;
  }
}

export type AccessConfig = {
  /** The Access team: "myteam" or "myteam.cloudflareaccess.com". */
  team: string;
  /** The Access application's AUD tag. */
  aud: string;
  /** Lowercased; unset or empty: whoever the Access policy lets through. */
  allowedEmails?: string[];
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Tests: how long a request waits on the keys' fetch (default FETCH_MS). */
  waitMs?: number;
};

/** Hosted mode's config from the environment, or undefined when it's incomplete (then nobody gets in). */
export function accessConfigOf(env: { CF_ACCESS_TEAM?: string; CF_ACCESS_AUD?: string; ALLOWED_EMAILS?: string }): AccessConfig | undefined {
  const team = env.CF_ACCESS_TEAM?.trim();
  const aud = env.CF_ACCESS_AUD?.trim();
  if (!team || !aud) return undefined;
  const allowedEmails = (env.ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return { team, aud, allowedEmails };
}

/** A person (their email), or a service token (its client id): never both. Pages take only a person; /bridge only the bridge's token. */
export type Verified = { email: string; service?: undefined } | { service: string; email?: undefined };
/** Checks a hosted request: who it is, or undefined (refused). */
export type AccessVerifier = (request: Request) => Promise<Verified | undefined>;

type Jwk = JsonWebKey & { kid?: string };
const KEYS_FOR_MS = 60 * 60 * 1000;
/** A token naming a key we don't have refetches the keys, at most this often (Access rotates them). */
const REFETCH_AFTER_MS = 60 * 1000;
/** The longest a request waits on the keys' fetch; one older is dropped and started again. */
const FETCH_MS = 5000;

export function createAccessVerifier(cfg: AccessConfig): AccessVerifier {
  const fetchFn = cfg.fetchFn ?? fetch;
  const waitMs = cfg.waitMs ?? FETCH_MS;
  const now = cfg.now ?? Date.now;
  const host = cfg.team.includes(".") ? cfg.team : `${cfg.team}.cloudflareaccess.com`;
  const issuer = `https://${host}`;
  const certs = `${issuer}/cdn-cgi/access/certs`;
  const emails = cfg.allowedEmails?.length ? new Set(cfg.allowedEmails) : undefined;
  let keys = new Map<string, CryptoKey>();
  let keysAt = 0;
  // The keys' fetch is shared by the requests that wait on it. On a Worker, one started by a request
  // that was then cancelled never settles (nor does its abort timer), so each caller waits on its own
  // timer, and a fetch older than that is dropped and started again: a stuck one can't hold every page.
  let inflight: { p: Promise<void>; at: number } | undefined;

  const fetchKeys = (): Promise<void> => {
    if (inflight && now() - inflight.at < waitMs) return inflight.p;
    const mine: { p: Promise<void>; at: number } = { at: now(), p: Promise.resolve() };
    mine.p = (async () => {
      try {
        const res = await fetchFn(certs, { signal: AbortSignal.timeout(waitMs) });
        if (!res.ok) return;
        const body = (await res.json()) as { keys?: Jwk[] };
        const next = new Map<string, CryptoKey>();
        for (const k of body.keys ?? []) {
          if (k.kty !== "RSA" || !k.kid) continue;
          next.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
        }
        if (next.size) {
          keys = next;
          keysAt = now();
        }
      } catch {
        // Unreachable or odd: keep what we had; a request without a known key is refused.
      } finally {
        if (inflight === mine) inflight = undefined;
      }
    })();
    inflight = mine;
    return mine.p;
  };

  /** Waits on the keys' fetch at most `waitMs`, with the timer in this request. */
  const load = async (): Promise<void> => {
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([fetchKeys(), new Promise<void>((res) => (t = setTimeout(res, waitMs)))]).finally(() => clearTimeout(t));
  };

  const keyFor = async (kid: string): Promise<CryptoKey | undefined> => {
    const age = now() - keysAt;
    if (keys.has(kid) && age > KEYS_FOR_MS) {
      // Old but known: answer with it and refresh behind (Access keeps an old key valid a while after rotating).
      void load();
    } else if (!keysAt || (!keys.has(kid) && age > REFETCH_AFTER_MS)) await load();
    return keys.get(kid);
  };

  return async (request) => {
    // workers_dev is off in wrangler.toml; refuse it here too, in case it's turned on.
    try {
      if (new URL(request.url).hostname.endsWith(".workers.dev")) return undefined;
    } catch {
      return undefined;
    }
    const jwt = request.headers.get("cf-access-jwt-assertion");
    const parts = jwt?.split(".");
    if (!parts || parts.length !== 3) return undefined;
    try {
      const header = b64urlJson(parts[0]!) as { alg?: string; kid?: string };
      if (header?.alg !== "RS256" || typeof header.kid !== "string") return undefined;
      const key = await keyFor(header.kid);
      if (!key) return undefined;
      const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]!), signed))) return undefined;
      const p = b64urlJson(parts[1]!) as CfAccessPayload;
      const sec = Math.floor(now() / 1000);
      if (typeof p.exp !== "number" || p.exp < sec) return undefined;
      if (typeof p.nbf === "number" && p.nbf > sec + 60) return undefined;
      if (p.iss !== issuer) return undefined;
      const auds = Array.isArray(p.aud) ? p.aud : p.aud ? [p.aud] : [];
      if (!auds.includes(cfg.aud)) return undefined;
      const email = typeof p.email === "string" && p.email.includes("@") ? p.email.toLowerCase() : undefined;
      if (email) return emails && !emails.has(email) ? undefined : { email };
      const service = typeof p.common_name === "string" && p.common_name.trim() ? p.common_name.trim() : undefined;
      return service ? { service } : undefined;
    } catch {
      return undefined;
    }
  };
}

/** The signed-in operator's name, from a verified token's email; else the fallback. */
export function operatorOf(who: Verified | undefined, fallback = "operator"): string {
  const email = who?.email;
  return email && email.includes("@") ? email.split("@")[0]!.toLowerCase() : fallback;
}
