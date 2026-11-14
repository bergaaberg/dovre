/**
 * The built-in login (#522): hosted Dovre without Cloudflare Access, so an instance needs nothing but
 * `wrangler login` to set up. On when the var AUTH_MODE is "passkey".
 *
 * - People sign in with a passkey (WebAuthn, ./webauthn.ts). Nobody can make one without a claim
 *   link: a single-use code that provision (or Settings, later) mints for one email. It lasts a day,
 *   and only its hash is kept. The link carries the code in its #fragment, so no server or log sees it
 *   in a URL.
 * - A sign-in sets a `__Host-` session cookie: a random token whose hash is in D1. Each request is
 *   checked against D1, so removing a passkey or an email ends its sessions at once.
 * - Every POST here must come from this origin, as JSON, small, and is rate-limited per address.
 * - With the instance's GitHub App set (GITHUB_APP_CLIENT_ID and _SECRET, #523), people can also
 *   sign in with GitHub (./github.ts): a verified email of theirs that ALLOWED_EMAILS names. With
 *   ALLOWED_EMAILS empty, nobody gets in that way.
 * - The result is the same `Verified` a Cloudflare Access token gives (src/access.ts): pages take a
 *   person, and nothing else in the app changes.
 */
import type { AccessVerifier } from "../../access.ts";
import type { D1 } from "../../db.ts";
import { authorizeUrl, type GithubApp, githubEmails } from "./github.ts";
import { b64url, ES256, RS256, verifyAssertion, verifyRegistration } from "./webauthn.ts";

export const SESSION_COOKIE = "__Host-dovre_s";
const CHALLENGE_COOKIE = "__Host-dovre_c";
const SESSION_MS = 30 * 86_400_000;
const CLAIM_MS = 86_400_000;
const CHALLENGE_MS = 5 * 60_000;
const TRY_WINDOW_MS = 10 * 60_000;
const TRIES = 20;
const MAX_BODY = 64 * 1024;

export const loginOn = (b: { AUTH_MODE?: string }): boolean => b.AUTH_MODE?.trim().toLowerCase() === "passkey";

const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function hashOf(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** The address tries are counted by: an IPv6 address by its /64, since one host can hold the whole /64. */
export function addressOf(req: Request): string {
  const ip = (req.headers.get("cf-connecting-ip") ?? "").trim().toLowerCase();
  if (!ip.includes(":")) return ip || "?";
  const [head = "", tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
/** What a GitHub session keeps in `login_sessions.passkey`: no passkey id has a colon. */
const GITHUB_SESSION = "github:";
const emailOk = (e: string) => e.length <= 254 && /^[^\s@,]+@[^\s@,]+$/.test(e);

/** A claim link's code and the SQL that stores its hash: provision runs it with `wrangler d1 execute`. */
export async function claimSql(email: string, now = Date.now()): Promise<{ code: string; sql: string }> {
  const e = email.trim().toLowerCase();
  if (!emailOk(e) || /'/.test(e)) throw new Error(`"${email}" isn't an email`);
  const code = random();
  return { code, sql: `INSERT INTO login_claims (hash, email, expires_at) VALUES ('${await hashOf(code)}', '${e}', ${now + CLAIM_MS});` };
}

/** Mints a claim link's code in D1 directly (tests; Settings later). */
export async function mintClaim(db: D1, email: string, now = Date.now()): Promise<string> {
  const e = email.trim().toLowerCase();
  if (!emailOk(e)) throw new Error(`"${email}" isn't an email`);
  const code = random();
  await db.prepare("INSERT INTO login_claims (hash, email, expires_at) VALUES (?, ?, ?)").bind(await hashOf(code), e, now + CLAIM_MS).run();
  return code;
}

function cookieOf(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
const setCookie = (name: string, value: string, maxAgeS: number) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const nope = (status = 400, why = "Not allowed") => json({ ok: false, why }, status);

type Passkey = { id: string; email: string; jwk: string; alg: number; sign_count: number };

export type Login = {
  verify: AccessVerifier;
  /** A /_auth/* request's answer; undefined for any other path. */
  handle(req: Request): Promise<Response | undefined>;
};

export function createLogin(o: { db: D1; allowedEmails?: string[]; now?: () => number; /** Sign in with GitHub (#523). */ github?: GithubApp; fetch?: typeof fetch }): Login {
  const { db, github } = o;
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = o.now ?? Date.now;
  const allowed = (o.allowedEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const emailAllowed = (e: string) => !allowed.length || allowed.includes(e);
  const seen = new WeakMap<Request, Promise<{ email: string } | undefined>>();

  const sessionOf = async (req: Request): Promise<{ email: string } | undefined> => {
    const tok = cookieOf(req, SESSION_COOKIE);
    if (!tok || !/^[A-Za-z0-9_-]{43}$/.test(tok)) return undefined;
    const row = await db
      // A passkey's session lasts while the passkey does; a GitHub one while the app is set.
      .prepare("SELECT s.email AS email FROM login_sessions s LEFT JOIN login_passkeys p ON p.id = s.passkey WHERE s.hash = ? AND s.expires_at > ? AND (p.id IS NOT NULL OR (? AND s.passkey LIKE 'github:%'))")
      .bind(await hashOf(tok), now(), github ? 1 : 0)
      .first<{ email: string }>();
    return row && emailAllowed(row.email) ? { email: row.email } : undefined;
  };

  const verify: AccessVerifier = (req) => {
    let p = seen.get(req);
    if (!p) {
      p = sessionOf(req).catch(() => undefined);
      seen.set(req, p);
    }
    return p;
  };

  /**
   * Over the limit for this address and kind: true. Each call counts as a try, recorded before it's
   * counted, so parallel tries can't all slip under the limit. Also sweeps what has expired, so
   * nobody can grow the tables by asking for challenges.
   */
  const limited = async (req: Request, kind: string): Promise<boolean> => {
    const key = `${kind}:${addressOf(req)}`;
    const t = now();
    const [, , , , n] = await db.batch([
      db.prepare("INSERT INTO login_tries (key, at) VALUES (?, ?)").bind(key, t),
      db.prepare("DELETE FROM login_tries WHERE at < ?").bind(t - 6 * TRY_WINDOW_MS),
      db.prepare("DELETE FROM login_challenges WHERE expires_at <= ?").bind(t),
      db.prepare("DELETE FROM login_sessions WHERE expires_at <= ?").bind(t),
      db.prepare("SELECT COUNT(*) AS n FROM login_tries WHERE key = ? AND at > ?").bind(key, t - TRY_WINDOW_MS),
    ]);
    const count = Number((n?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
    return count > TRIES;
  };

  /** A POST's JSON body, only from this origin. */
  const bodyOf = async (req: Request): Promise<Record<string, unknown> | undefined> => {
    const url = new URL(req.url);
    if (req.headers.get("origin") !== url.origin) return undefined;
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin") return undefined;
    if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return undefined;
    const text = await req.text();
    if (text.length > MAX_BODY) return undefined;
    try {
      const v = JSON.parse(text) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };

  const claimRow = async (code: unknown) => {
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) return undefined;
    const hash = await hashOf(code);
    const row = await db.prepare("SELECT email FROM login_claims WHERE hash = ? AND used_at IS NULL AND expires_at > ?").bind(hash, now()).first<{ email: string }>();
    return row ? { hash, email: row.email } : undefined;
  };

  const sessionCookies = async (email: string, passkey: string, h: Headers) => {
    const tok = random();
    await db.prepare("INSERT INTO login_sessions (hash, email, passkey, expires_at) VALUES (?, ?, ?, ?)").bind(await hashOf(tok), email, passkey, now() + SESSION_MS).run();
    h.append("set-cookie", setCookie(SESSION_COOKIE, tok, SESSION_MS / 1000));
    h.append("set-cookie", setCookie(CHALLENGE_COOKIE, "", 0));
    return h;
  };
  const startSession = async (email: string, passkey: string, to = "/"): Promise<Response> =>
    new Response(JSON.stringify({ ok: true, to }), { status: 200, headers: await sessionCookies(email, passkey, new Headers({ "content-type": "application/json", "cache-control": "no-store" })) });

  // ── Sign in with GitHub: a challenge row holds the PKCE verifier (challenge) and the state (claim) ──

  const callbackOf = (req: Request) => `${new URL(req.url).origin}/_auth/github/callback`;
  const githubStart = async (req: Request): Promise<Response> => {
    if (await limited(req, "github")) return page("Sign in", "login", { github: !!github, note: "busy" }, 429);
    const id = random(16);
    const verifier = random();
    const state = random();
    await db.prepare("INSERT INTO login_challenges (id, challenge, kind, claim, expires_at) VALUES (?, ?, 'github', ?, ?)").bind(id, verifier, state, now() + CHALLENGE_MS).run();
    return new Response(null, { status: 302, headers: { location: await authorizeUrl(github!, { redirectUri: callbackOf(req), state, verifier }), "set-cookie": setCookie(CHALLENGE_COOKIE, id, CHALLENGE_MS / 1000), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  };
  const githubBack = async (req: Request): Promise<Response> => {
    const q = new URL(req.url).searchParams;
    const fail = (note: Note, status = 403) => page("Sign in", "login", { github: true, note }, status);
    const cid = cookieOf(req, CHALLENGE_COOKIE);
    if (!cid || !/^[A-Za-z0-9_-]{22}$/.test(cid)) return fail("again", 400);
    // Single use, and only with the cookie of the browser that started it.
    const ch = await db.prepare("DELETE FROM login_challenges WHERE id = ? RETURNING challenge, kind, claim, expires_at").bind(cid).first<{ challenge: string; kind: string; claim: string | null; expires_at: number }>();
    if (!ch || ch.kind !== "github" || ch.expires_at <= now()) return fail("again", 400);
    if (await limited(req, "github")) return fail("busy", 429);
    if (q.get("error")) return fail("cancelled", 400);
    const code = q.get("code") ?? "";
    if (!ch.claim || q.get("state") !== ch.claim || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) return fail("again", 400);
    let emails: string[];
    try {
      emails = await githubEmails(f, github!, { code, verifier: ch.challenge, redirectUri: callbackOf(req) });
    } catch {
      return fail("github", 502);
    }
    // Unlike a passkey (which needs a claim link), any GitHub account can get this far: only a listed email comes in.
    const email = allowed.length ? emails.find((e) => allowed.includes(e)) : undefined;
    if (!email) return fail("notListed");
    return new Response(null, { status: 303, headers: await sessionCookies(email, GITHUB_SESSION + email, new Headers({ location: "/", "cache-control": "no-store" })) });
  };

  const options = async (req: Request, b: Record<string, unknown>): Promise<Response> => {
    const url = new URL(req.url);
    const kind = b.kind === "claim" ? "claim" : b.kind === "login" ? "login" : undefined;
    if (!kind) return nope();
    if (await limited(req, kind)) return nope(429, "Too many tries; wait a few minutes.");
    const id = random(16);
    const challenge = random();
    let claim: { hash: string; email: string } | undefined;
    if (kind === "claim") {
      claim = await claimRow(b.code);
      if (!claim) return nope(403, "This link isn't valid: it's been used, it's expired, or it was copied wrong.");
    }
    await db.prepare("INSERT INTO login_challenges (id, challenge, kind, claim, expires_at) VALUES (?, ?, ?, ?, ?)").bind(id, challenge, kind, claim?.hash ?? null, now() + CHALLENGE_MS).run();
    const headers = { "set-cookie": setCookie(CHALLENGE_COOKIE, id, CHALLENGE_MS / 1000) };
    if (kind === "login") return json({ ok: true, publicKey: { challenge, rpId: url.hostname, userVerification: "required", timeout: CHALLENGE_MS } }, 200, headers);
    const mine = await db.prepare("SELECT id FROM login_passkeys WHERE email = ?").bind(claim!.email).all<{ id: string }>();
    return json(
      {
        ok: true,
        publicKey: {
          challenge,
          rp: { id: url.hostname, name: "Dovre" },
          user: { id: random(16), name: claim!.email, displayName: claim!.email },
          pubKeyCredParams: [
            { type: "public-key", alg: ES256 },
            { type: "public-key", alg: RS256 },
          ],
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          attestation: "none",
          excludeCredentials: mine.results.map((r) => ({ type: "public-key", id: r.id })),
          timeout: CHALLENGE_MS,
        },
      },
      200,
      headers,
    );
  };

  const finish = async (req: Request, b: Record<string, unknown>): Promise<Response> => {
    const url = new URL(req.url);
    const cid = cookieOf(req, CHALLENGE_COOKIE);
    if (!cid || !/^[A-Za-z0-9_-]{22}$/.test(cid)) return nope(400, "Start again.");
    // Single use: taken out as it's read.
    const ch = await db.prepare("DELETE FROM login_challenges WHERE id = ? RETURNING challenge, kind, claim, expires_at").bind(cid).first<{ challenge: string; kind: string; claim: string | null; expires_at: number }>();
    if (!ch || ch.expires_at <= now()) return nope(400, "That took too long; start again.");
    if (await limited(req, ch.kind)) return nope(429, "Too many tries; wait a few minutes.");
    const r = b.response;
    if (!r || typeof r !== "object") return nope();
    const resp = r as Record<string, unknown>;
    const expect = { challenge: ch.challenge, origin: url.origin, rpId: url.hostname };
    try {
      if (ch.kind === "login") {
        const id = typeof b.id === "string" && /^[A-Za-z0-9_-]{1,1400}$/.test(b.id) ? b.id : undefined;
        const pk = id ? await db.prepare("SELECT id, email, jwk, alg, sign_count FROM login_passkeys WHERE id = ?").bind(id).first<Passkey>() : null;
        if (!pk || !emailAllowed(pk.email)) return nope(403, "This passkey isn't one of this Dovre's.");
        const { signCount } = await verifyAssertion(resp as never, expect, { jwk: JSON.parse(pk.jwk) as JsonWebKey, alg: pk.alg, signCount: pk.sign_count });
        // Only from the count it was checked against: of two uses with one count, one wins.
        const moved = await db.prepare("UPDATE login_passkeys SET sign_count = ?, used_at = ? WHERE id = ? AND sign_count = ? RETURNING id").bind(signCount, now(), pk.id, pk.sign_count).first();
        if (!moved) return nope(403, "The passkey didn't check out.");
        return startSession(pk.email, pk.id);
      }
      if (ch.kind !== "claim" || !ch.claim) return nope();
      const made = await verifyRegistration(resp as never, expect);
      // A passkey that's already here doesn't spend the link.
      const taken = await db.prepare("SELECT id FROM login_passkeys WHERE id = ?").bind(made.id).first();
      if (taken) return nope(409, "That passkey is already here.");
      // The claim is spent only by a passkey that checked out, and only once.
      const spent = await db.prepare("UPDATE login_claims SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email").bind(now(), ch.claim, now()).first<{ email: string }>();
      if (!spent) return nope(403, "This link isn't valid any more.");
      const name = typeof b.name === "string" ? b.name.replace(/[^\p{L}\p{N} ._'()-]/gu, "").slice(0, 60) : "";
      await db.prepare("INSERT INTO login_passkeys (id, email, jwk, alg, sign_count, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(made.id, spent.email, JSON.stringify(made.jwk), made.alg, made.signCount, name, now()).run();
      return startSession(spent.email, made.id);
    } catch {
      return nope(403, "The passkey didn't check out.");
    }
  };

  const logout = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.headers.get("origin") !== url.origin) return nope(403);
    const tok = cookieOf(req, SESSION_COOKIE);
    if (tok) await db.prepare("DELETE FROM login_sessions WHERE hash = ?").bind(await hashOf(tok)).run();
    return new Response(null, { status: 303, headers: { location: "/_auth/login", "set-cookie": setCookie(SESSION_COOKIE, "", 0), "cache-control": "no-store" } });
  };

  const handle = async (req: Request): Promise<Response | undefined> => {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/_auth/")) return undefined;
    if (req.method === "GET" && path === "/_auth/login") return page("Sign in", "login", { github: !!github });
    if (github && req.method === "GET" && path === "/_auth/github") return githubStart(req);
    if (github && req.method === "GET" && path === "/_auth/github/callback") return githubBack(req);
    if (req.method === "GET" && path === "/_auth/claim") return page("Make your passkey", "claim");
    if (req.method === "GET" && path === "/_auth/login.js") return new Response(SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
    if (req.method === "POST" && path === "/_auth/logout") return logout(req);
    if (req.method === "POST" && (path === "/_auth/options" || path === "/_auth/finish")) {
      const b = await bodyOf(req);
      if (!b) return nope(403);
      return path === "/_auth/options" ? options(req, b) : finish(req, b);
    }
    return new Response("Not found", { status: 404 });
  };

  return { verify, handle };
}

// ── pages: static, nothing from the request in them ──

/** What a sign-in page may say about a try that didn't work: fixed text only. */
const NOTES = {
  again: "That sign-in didn't finish, or took too long: start again.",
  busy: "Too many tries; wait a few minutes.",
  cancelled: "GitHub sign-in was cancelled.",
  github: "GitHub didn't answer as expected; try again.",
  notListed: "None of the verified emails on that GitHub account may come in here.",
} as const;
type Note = keyof typeof NOTES;

function page(title: string, kind: "login" | "claim", x: { github?: boolean; note?: Note } = {}, status = 200): Response {
  const lead =
    kind === "login"
      ? x.github
        ? "Sign in with the passkey you made for this Dovre, or with GitHub."
        : "Sign in with the passkey you made for this Dovre."
      : "This link lets you make a passkey for this Dovre. Your device keeps it (and may sync it); the link works once.";
  const gh = kind === "login" && x.github ? `<p><a id="gh" href="/_auth/github">Sign in with GitHub</a></p>` : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>Dovre · ${title}</title>
<style>body{margin:0 auto;max-width:32rem;padding:3rem 1rem;font:15px/1.55 ui-monospace,Menlo,Consolas,monospace}h1{font-size:1.4rem}button{font:inherit;padding:.6rem 1rem;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}.t2{opacity:.75}#said{min-height:1.5em}a{color:inherit}</style></head>
<body data-kind="${kind}"><h1>Dovre</h1><p class="t2">${lead}</p>
<p><button id="go" type="button">${kind === "login" ? "Sign in with a passkey" : "Make a passkey"}</button></p>${gh}<p id="said" role="status">${x.note ? NOTES[x.note] : ""}</p>
<script src="/_auth/login.js"></script></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
}

const SCRIPT = `(() => {
  const kind = document.body.dataset.kind;
  const said = document.getElementById("said");
  const go = document.getElementById("go");
  // The claim code is in the fragment: read it once, then take it out of the address bar.
  const code = kind === "claim" ? location.hash.slice(1) : "";
  if (code) history.replaceState(null, "", location.pathname);
  const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const text = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  const post = async (path, body) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.why || "That didn't work.");
    return j;
  };
  if (!window.PublicKeyCredential) { said.textContent = "This browser can't use passkeys."; go.disabled = true; return; }
  if (kind === "claim" && !code) { said.textContent = "This link has no code in it: open the whole link you were given."; go.disabled = true; return; }
  go.addEventListener("click", async () => {
    go.disabled = true;
    said.textContent = "Waiting for your device…";
    try {
      const { publicKey: o } = await post("/_auth/options", { kind, code });
      o.challenge = bytes(o.challenge);
      let body;
      if (kind === "claim") {
        o.user.id = bytes(o.user.id);
        o.excludeCredentials = (o.excludeCredentials || []).map((c) => ({ ...c, id: bytes(c.id) }));
        const c = await navigator.credentials.create({ publicKey: o });
        body = { response: { clientDataJSON: text(c.response.clientDataJSON), attestationObject: text(c.response.attestationObject) }, name: navigator.platform || "" };
      } else {
        const c = await navigator.credentials.get({ publicKey: o });
        body = { id: c.id, response: { clientDataJSON: text(c.response.clientDataJSON), authenticatorData: text(c.response.authenticatorData), signature: text(c.response.signature) } };
      }
      const done = await post("/_auth/finish", body);
      location.replace(done.to || "/");
    } catch (e) {
      said.textContent = e && e.name === "NotAllowedError" ? "Cancelled, or no passkey for this Dovre on this device." : String((e && e.message) || e);
      go.disabled = false;
    }
  });
})();`;
