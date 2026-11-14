/**
 * Sign in with GitHub (#523): the instance's own GitHub App, made by provision through the manifest
 * flow (src/github-app.ts). Its user authorisation runs with PKCE and a state bound to a cookie;
 * the person is a verified email of theirs on GitHub that ALLOWED_EMAILS names. The user token is
 * never logged; with GITHUB_TOKEN_SEAL set it's kept sealed for calls to GitHub as them (./tokens.ts),
 * else it's dropped after these reads.
 */
import { type Grant, grantOf } from "./tokens.ts";
import { b64url } from "./webauthn.ts";

export type GithubApp = { clientId: string; clientSecret: string };

/** The app's client id and secret, when both are set. */
export function githubAppOf(b: { GITHUB_APP_CLIENT_ID?: string; GITHUB_APP_CLIENT_SECRET?: string }): GithubApp | undefined {
  const clientId = b.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = b.GITHUB_APP_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export async function authorizeUrl(app: GithubApp, o: { redirectUri: string; state: string; verifier: string }): Promise<string> {
  const q = new URLSearchParams({ client_id: app.clientId, redirect_uri: o.redirectUri, state: o.state, code_challenge: await pkceChallenge(o.verifier), code_challenge_method: "S256", allow_signup: "false" });
  return `https://github.com/login/oauth/authorize?${q}`;
}

const UA = "dovre-login";

export type SignedIn = { emails: string[]; login: string; grant?: Grant };

/**
 * The GitHub account that `code` was given for: its verified emails (lower-cased, primary first), its
 * login, and the grant to keep when the app's tokens expire (they do unless the app turned that off).
 */
export async function githubSignIn(f: typeof fetch, app: GithubApp, o: { code: string; verifier: string; redirectUri: string; now?: number }): Promise<SignedIn> {
  const t = await f("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, code: o.code, redirect_uri: o.redirectUri, code_verifier: o.verifier }),
  });
  const body = (await t.json().catch(() => ({}))) as { access_token?: unknown };
  const tok = body.access_token;
  if (!t.ok || typeof tok !== "string" || !tok) throw new Error("GitHub didn't give a token");
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${tok}`, "user-agent": UA, "x-github-api-version": "2022-11-28" };
  const u = await f("https://api.github.com/user", { headers });
  const login = ((await u.json().catch(() => ({}))) as { login?: unknown }).login;
  if (!u.ok || typeof login !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new Error(`GitHub's user: ${u.status}`);
  const r = await f("https://api.github.com/user/emails", { headers });
  if (!r.ok) throw new Error(`GitHub's emails: ${r.status}`);
  const list = (await r.json()) as unknown;
  if (!Array.isArray(list)) throw new Error("GitHub's emails: not a list");
  const emails = list
    .filter((e): e is { email: string; verified: true; primary?: boolean } => !!e && typeof e === "object" && typeof e.email === "string" && e.verified === true)
    .sort((a, b) => Number(!!b.primary) - Number(!!a.primary))
    .map((e) => e.email.trim().toLowerCase());
  return { emails, login, grant: grantOf(body, o.now ?? Date.now()) };
}
