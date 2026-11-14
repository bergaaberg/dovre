/**
 * The instance's GitHub App through GitHub's manifest flow (#523): provision serves a page on
 * 127.0.0.1 that posts the manifest to GitHub, the person clicks "Create GitHub App", and GitHub
 * sends the browser back to that page with a one-time code, which turns into the app's id, client
 * secret and private key. They go up as the Worker's secrets; nothing is written to disk here.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export type AppCreds = { id: number; slug: string; clientId: string; clientSecret: string; pem: string; htmlUrl?: string };

/**
 * The app: private, no webhook. Sign-in reads a user's verified emails; the repository permissions
 * are what Dovre does on GitHub as the signed-in person (their token reaches only the repos the app
 * is installed on, and never more than they can do themselves).
 */
export function appManifest(o: { host: string; name: string; redirectUrl: string }) {
  return {
    name: o.name.slice(0, 34),
    url: `https://${o.host}`,
    description: `Sign in to the Dovre at ${o.host}.`,
    redirect_url: o.redirectUrl,
    callback_urls: [`https://${o.host}/_auth/github/callback`],
    public: false,
    request_oauth_on_install: false,
    hook_attributes: { url: `https://${o.host}/`, active: false },
    default_permissions: {
      email_addresses: "read",
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      issues: "write",
      actions: "write",
      deployments: "write",
      checks: "read",
      statuses: "read",
      vulnerability_alerts: "read",
    },
    default_events: [],
  };
}

const PAGE_CSS = "body{font:15px/1.5 ui-monospace,Menlo,monospace;max-width:32rem;margin:3rem auto;padding:0 1rem}";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page that posts the manifest to GitHub (for a user, or an organisation's apps). */
export function manifestPage(o: { manifest: object; state: string; org?: string }): string {
  const base = o.org ? `https://github.com/organizations/${encodeURIComponent(o.org)}/settings/apps/new` : "https://github.com/settings/apps/new";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Dovre · GitHub App</title><style>${PAGE_CSS}</style></head>
<body>
<form id="f" method="post" action="${esc(`${base}?state=${encodeURIComponent(o.state)}`)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(o.manifest))}">
<p>This makes your Dovre's own GitHub App, for Sign in with GitHub and for calling GitHub as you. On GitHub, check the name (it has to be unique) and click “Create GitHub App”.</p>
<button type="submit">Continue to GitHub</button></form></body></html>`;
}

/** The app GitHub made for a manifest `code`. */
export async function convertManifest(f: typeof fetch, code: string): Promise<AppCreds> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new Error("Not a manifest code");
  const r = await f(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json", "user-agent": "dovre-provision", "x-github-api-version": "2022-11-28" } });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || typeof j.id !== "number" || typeof j.client_id !== "string" || typeof j.client_secret !== "string" || typeof j.pem !== "string") throw new Error(`GitHub didn't make the app (${r.status}): ${String(j.message ?? "")}`);
  return { id: j.id, slug: String(j.slug ?? ""), clientId: j.client_id, clientSecret: j.client_secret, pem: j.pem, htmlUrl: typeof j.html_url === "string" ? j.html_url : undefined };
}

export type MakeGithubApp = (o: { host: string; name: string; org?: string; log: (l: string) => void }) => Promise<AppCreds>;

/** Runs the flow in the browser, with a callback on 127.0.0.1 that lasts until it's done (or 10 minutes). */
export const makeGithubApp: MakeGithubApp = (o) =>
  new Promise((resolve, reject) => {
    const state = randomBytes(24).toString("base64url");
    let done = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const send = (status: number, body: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
        res.end(body);
      };
      if (url.pathname === "/") return send(200, manifestPage({ manifest: appManifest({ host: o.host, name: o.name, redirectUrl: `http://127.0.0.1:${port()}/done` }), state, org: o.org }));
      if (url.pathname !== "/done" || done) return send(404, "Not found");
      if (url.searchParams.get("state") !== state) return send(400, "This isn't the app this run asked for: start provision again.");
      done = true;
      convertManifest(fetch, url.searchParams.get("code") ?? "").then(
        (app) => {
          send(200, `<!doctype html><meta charset="utf-8"><title>Dovre</title><style>${PAGE_CSS}</style><p>The GitHub App ${esc(app.slug)} is made. Now <a href="https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new">install it</a> on the accounts whose repos Dovre tracks, then back to the terminal.</p>`);
          finish(() => resolve(app));
        },
        (e: unknown) => {
          send(502, "GitHub didn't make the app: see the terminal.");
          finish(() => reject(e));
        },
      );
    });
    const port = () => (server.address() as { port: number }).port;
    const timer = setTimeout(() => finish(() => reject(new Error("No GitHub App within 10 minutes: run provision again."))), 10 * 60_000);
    const finish = (then: () => void) => {
      clearTimeout(timer);
      server.close();
      then();
    };
    server.listen(0, "127.0.0.1", () => {
      const at = `http://127.0.0.1:${port()}/`;
      o.log(`→ Making the GitHub App for Sign in with GitHub: opening ${at} (open it yourself if no browser comes up)…`);
      const opener = process.platform === "darwin" ? ["open", [at]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", at]] : ["xdg-open", [at]];
      spawn(opener[0] as string, opener[1] as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    });
  });
