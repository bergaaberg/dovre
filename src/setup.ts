/**
 * The page Dovre shows when it can't start for real: no GHE login, or GHE didn't answer (VPN
 * off, token expired) and it has never seen who I am. It says what's missing and how to fix it,
 * looks again every few seconds, and once GHE answers the server starts again for real (exit 75:
 * the supervisor starts it at once).
 *
 * It holds nothing about my work, but it's still local only: a localhost Host or a 404, like the
 * app. /login sets the cookie as the app's does, so the window is signed in when the app comes.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { html } from "hono/html";
import { secureHeaders } from "hono/secure-headers";
import { COOKIE, isLocal, isOwnOrigin, sameSecret, secureCookie } from "./access.ts";
import type { AppEnv } from "./env.ts";
import { ownersOf } from "./owners.ts";
import { forgeName } from "./pages/parts.ts";
import { mountPwa } from "./pwa.ts";

export type SetupProblem = { kind: "org" | "login" | "unreachable"; host: string; error?: string };

export type SetupState = {
  lookedAt?: number;
  ready?: boolean;
  /** Device code & verification URL when `gh auth login --web` was started from the page. */
  deviceCode?: string;
  deviceUrl?: string;
  ghStatus?: string;
  /** Discovered login + orgs when signed in, so the user can pick with one click. */
  discoveredOwners?: string[];
  notice?: string;
  error?: string;
};

const SAFE_TOKEN = /^[A-Za-z0-9_.\-]{10,256}$/;

/** Updates or appends a KEY=value line in `.dev.vars` (mode 0600). */
export function upsertDevVar(file: string, key: string, value: string): void {
  if (!/^[A-Z0-9_]+$/.test(key) || /[\r\n]/.test(value)) throw new Error("invalid key or value");
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  const next = re.test(cur) ? cur.replace(re, () => `${key}=${value}`) : `${cur.replace(/\s*$/, cur.trim() ? "\n" : "")}${key}=${value}\n`;
  writeFileSync(file, next, { mode: 0o600 });
}

/** Removes a KEY=... line from `.dev.vars` if present (mode 0600). */
export function removeDevVar(file: string, key: string): void {
  if (!/^[A-Z0-9_]+$/.test(key) || !existsSync(file)) return;
  const cur = readFileSync(file, "utf8");
  const next = cur
    .split(/\r?\n/)
    .filter((line) => !new RegExp(`^\\s*${key}\\s*=`).test(line))
    .join("\n");
  writeFileSync(file, next.trim() ? `${next.replace(/\s*$/, "")}\n` : "", { mode: 0o600 });
}

export function setupPage(p: SetupProblem, state: SetupState) {
  const patUrl =
    p.host === "github.com"
      ? "https://github.com/settings/personal-access-tokens/new"
      : `https://${p.host}/settings/tokens/new`;
  const fix =
    p.kind === "org"
      ? html`<p>Dovre follows the orgs and users you name on <strong>${p.host}</strong>. Name them below (or in <code>.dev.vars</code>):</p>
<form method="post" action="/setup/owners">
  <label>Organisations or usernames to track (comma-separated)
    <input type="text" name="owners" value="${(state.discoveredOwners ?? []).join(", ")}" placeholder="your-org, your-user" required spellcheck="false">
  </label>
  <button type="submit">Save &amp; start Dovre</button>
</form>
<details><summary>Or set in <code>.dev.vars</code></summary><pre><code>REPO_HOST=${p.host}
REPO_OWNERS=your-org, your-user</code></pre></details>`
      : p.kind === "login"
      ? html`<p>Dovre reads GitHub (<strong>${p.host}</strong>) as you. Sign in with one click using GitHub CLI, or paste a token:</p>
<div>
  <form method="post" action="/setup/gh-login">
    <button type="submit">Sign in with GitHub in browser (<code>gh auth login --web</code>)</button>
  </form>
  ${
    state.deviceCode
      ? html`<div class="notice ok">One-time code: <strong><code>${state.deviceCode}</code></strong> — open <a href="${state.deviceUrl || `https://${p.host}/login/device`}" target="_blank" rel="noreferrer">${state.deviceUrl || `https://${p.host}/login/device`}</a> to authorise.</div>`
      : state.ghStatus
        ? html`<p class="t3">${state.ghStatus}</p>`
        : ""
  }
</div>
<details><summary>Or paste a Personal Access Token / run in terminal</summary>
  <form method="post" action="/setup/token">
    <label>Fine-grained token (<a href="${patUrl}" target="_blank" rel="noreferrer">create on ${p.host}</a>: Pull requests, Contents, Actions, Issues read-only)
      <input type="password" name="token" placeholder="github_pat_… or ghp_…" required spellcheck="false" autocomplete="off">
    </label>
    <button type="submit" data-secondary>Save token to <code>.dev.vars</code></button>
  </form>
  <p class="t3">Or sign in once in a terminal:</p>
  <pre><code>gh auth login --hostname ${p.host}</code></pre>
  <p class="t3">Or put a token in <code>GHE_TOKEN</code> in <code>.dev.vars</code>.</p>
</details>`
      : html`<p>${forgeName(p.host)} at <strong>${p.host}</strong> didn't answer${p.error ? html`: <code>${p.error.slice(0, 200)}</code>` : ""}.</p><ul><li>Is the VPN on?</li><li>Has the login expired? <code>gh auth status --hostname ${p.host}</code>, then <code>gh auth login --hostname ${p.host}</code>.</li></ul>`;
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="5">
<title>Set up · Dovre</title>
<style>
:root { color-scheme: light dark; --bg: #f8f4ee; --ink: #2a1d14; --ink-3: #65564a; --line: #e9e1d5; --code: #f1ebe2; --accent: #1d5c88; }
@media (prefers-color-scheme: dark) { :root { --bg: #0a1117; --ink: #e6ecf0; --ink-3: #8c9aa5; --line: #22303b; --code: #16222c; --accent: #84b9df; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 15px/1.55 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
main { width: min(34rem, calc(100vw - 32px)); }
img { width: 56px; height: 56px; border-radius: 13px; }
h1 { font: 400 30px/1.15 "Sitka Display", Sitka, Georgia, serif; margin: 14px 0 12px; }
pre, code { font: 13px "Cascadia Mono", Consolas, monospace; background: var(--code); border-radius: 6px; }
code { padding: 1px 5px; } pre { padding: 10px 12px; overflow-x: auto; } pre code { padding: 0; background: none; }
.t3 { color: var(--ink-3); } .ok { color: var(--accent); font-weight: 600; } .bad { color: #c94a4a; font-weight: 600; }
form { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
label input { padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--code); color: var(--ink); font: 14px monospace; }
button { align-self: flex-start; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--bg); font: 600 14px system-ui, sans-serif; cursor: pointer; }
button[data-secondary] { background: transparent; color: var(--ink); border-color: var(--line); }
details { margin: 12px 0; border-top: 1px solid var(--line); padding-top: 10px; }
details summary { cursor: pointer; color: var(--ink-3); font-size: 14px; }
.notice { padding: 10px 12px; border: 1px solid var(--accent); border-radius: 6px; background: var(--code); margin: 8px 0; }
a { color: var(--accent); }
</style></head>
<body><main><img src="/assets/icon-192.png" alt=""><h1>${p.kind === "org" ? "Which organisation?" : p.kind === "login" ? `Sign in to ${forgeName(p.host)} first` : `Can't reach ${forgeName(p.host)}`}</h1>
${state.notice ? html`<p class="ok">${state.notice}</p>` : ""}
${state.error ? html`<p class="bad">${state.error}</p>` : ""}
${state.ready ? html`<p class="ok">${forgeName(p.host)} answers now. Restart Dovre (<code>dovre restart</code>) to carry on.</p>` : fix}
<p class="t3">This page looks again every few seconds${state.lookedAt ? `; last at ${new Date(state.lookedAt).toLocaleTimeString("en-GB")}` : ""}, and goes on by itself once it works.</p>
</main></body></html>`;
}

function sameLocalOrigin(req: Request, publicOrigin?: string): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  if (isOwnOrigin(req, origin, publicOrigin)) return true;
  try {
    const u = new URL(origin);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function setupApp(o: {
  problem: SetupProblem;
  token: string;
  info: { version: string; startedAt: number };
  state: () => SetupState;
  varsFile?: string;
  onSaveOwners?: (owners: string) => Promise<void> | void;
  onSaveToken?: (token: string) => Promise<void> | void;
  onStartGhLogin?: () => Promise<{ deviceCode?: string; deviceUrl?: string; status?: string }> | { deviceCode?: string; deviceUrl?: string; status?: string };
  onWake?: () => Promise<void> | void;
  /** PUBLIC_ORIGIN, checked (src/access.ts). */
  publicOrigin?: string;
}) {
  const app = new Hono<AppEnv>();
  const pub = o.publicOrigin;
  const varsFile = o.varsFile ?? ".dev.vars";
  app.use(
    secureHeaders({
      referrerPolicy: "same-origin",
      contentSecurityPolicy: { defaultSrc: ["'self'"], styleSrc: ["'unsafe-inline'"], imgSrc: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"], baseUri: ["'none'"], objectSrc: ["'none'"] },
    }),
  );
  mountPwa(app, o.info);
  app.get("/login", (c) => {
    if (!isLocal(c.req.raw, pub) || !sameSecret(c.req.query("tk"), o.token)) return c.notFound();
    setCookie(c, COOKIE, o.token, { httpOnly: true, sameSite: "Strict", path: "/", maxAge: 400 * 86400, secure: secureCookie(c.req.raw, pub) });
    return c.redirect("/", 303);
  });
  app.post("/setup/owners", async (c) => {
    if (!isLocal(c.req.raw, pub) || !sameLocalOrigin(c.req.raw, pub)) return c.notFound();
    const body = await c.req.parseBody();
    const list = ownersOf(typeof body.owners === "string" ? body.owners : "");
    const st = o.state();
    if (!list.length) {
      st.error = "Enter at least one valid GitHub username or organisation.";
      return c.redirect("/", 303);
    }
    const joined = list.join(", ");
    if (o.onSaveOwners) await o.onSaveOwners(joined);
    else upsertDevVar(varsFile, "REPO_OWNERS", joined);
    st.error = undefined;
    st.notice = `Saved REPO_OWNERS (${joined}). Starting Dovre…`;
    await o.onWake?.();
    return c.redirect("/", 303);
  });
  app.post("/setup/token", async (c) => {
    if (!isLocal(c.req.raw, pub) || !sameLocalOrigin(c.req.raw, pub)) return c.notFound();
    const body = await c.req.parseBody();
    const raw = typeof body.token === "string" ? body.token.trim() : "";
    const st = o.state();
    if (!SAFE_TOKEN.test(raw)) {
      st.error = "That doesn't look like a valid GitHub token.";
      return c.redirect("/", 303);
    }
    if (o.onSaveToken) await o.onSaveToken(raw);
    else upsertDevVar(varsFile, o.problem.host === "github.com" ? "GITHUB_TOKEN" : "GHE_TOKEN", raw);
    st.error = undefined;
    st.notice = "Saved token to .dev.vars. Checking connection…";
    await o.onWake?.();
    return c.redirect("/", 303);
  });
  app.post("/setup/gh-login", async (c) => {
    if (!isLocal(c.req.raw, pub) || !sameLocalOrigin(c.req.raw, pub)) return c.notFound();
    const st = o.state();
    st.error = undefined;
    if (o.onStartGhLogin) {
      const res = await o.onStartGhLogin();
      st.deviceCode = res.deviceCode;
      st.deviceUrl = res.deviceUrl;
      st.ghStatus = res.status;
      return c.redirect("/", 303);
    }
    try {
      const args = o.problem.host === "github.com" ? ["auth", "login", "--web", "-p", "https"] : ["auth", "login", "--hostname", o.problem.host, "--web", "-p", "https"];
      const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.write("\n");
      child.stdin.end();
      const onOut = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const codeMatch = text.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
        const urlMatch = text.match(/https:\/\/[^\s]+\/login\/device/);
        if (codeMatch) st.deviceCode = codeMatch[1];
        if (urlMatch) st.deviceUrl = urlMatch[0];
      };
      child.stdout.on("data", onOut);
      child.stderr.on("data", onOut);
      child.on("close", (code) => {
        if (code === 0) {
          st.notice = "Signed in with GitHub CLI. Starting Dovre…";
          void o.onWake?.();
        }
      });
      child.on("error", () => {
        st.error = "GitHub CLI (`gh`) wasn't found on PATH. Paste a token below or install `gh`.";
      });
      st.ghStatus = "Opened browser for GitHub login. Complete the sign-in in your browser window.";
      await new Promise((r) => setTimeout(r, 350));
    } catch {
      st.error = "Couldn't start `gh auth login --web`. Paste a token below instead.";
    }
    return c.redirect("/", 303);
  });
  app.all("*", (c) => (isLocal(c.req.raw, pub) ? c.html(setupPage(o.problem, o.state()), 503) : c.notFound()));
  return app;
}
