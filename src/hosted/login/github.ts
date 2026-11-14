/**
 * Sign in with GitHub (#523): the instance's own GitHub App, made by provision through the manifest
 * flow (src/github-app.ts). Its user authorisation runs with PKCE and a state bound to a cookie;
 * the person is a verified email of theirs on GitHub that ALLOWED_EMAILS names. The user token is
 * used for two reads and then dropped: never stored, never logged.
 */
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

/** The verified emails of the GitHub account that `code` was given for, lower-cased, primary first. */
export async function githubEmails(f: typeof fetch, app: GithubApp, o: { code: string; verifier: string; redirectUri: string }): Promise<string[]> {
  const t = await f("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, code: o.code, redirect_uri: o.redirectUri, code_verifier: o.verifier }),
  });
  const tok = ((await t.json().catch(() => ({}))) as { access_token?: unknown }).access_token;
  if (!t.ok || typeof tok !== "string" || !tok) throw new Error("GitHub didn't give a token");
  const r = await f("https://api.github.com/user/emails", { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${tok}`, "user-agent": UA, "x-github-api-version": "2022-11-28" } });
  if (!r.ok) throw new Error(`GitHub's emails: ${r.status}`);
  const list = (await r.json()) as unknown;
  if (!Array.isArray(list)) throw new Error("GitHub's emails: not a list");
  return list
    .filter((e): e is { email: string; verified: true; primary?: boolean } => !!e && typeof e === "object" && typeof e.email === "string" && e.verified === true)
    .sort((a, b) => Number(!!b.primary) - Number(!!a.primary))
    .map((e) => e.email.trim().toLowerCase());
}
