/**
 * Dovre as an installable app: the web app manifest, the icon, a service worker and the page
 * it shows when the server isn't running. Installed from Edge ("App available" in the address
 * bar, or Settings → Install), it gets its own window, taskbar icon and name on notifications.
 * These routes need no login: they say nothing about my work, and the offline page has to load
 * when the server can't answer.
 */
import { readdirSync, readFileSync } from "node:fs";
import { html, raw } from "hono/html";
import type { App } from "./env.ts";
import { MARK, RIDGE_ART, SPLASH_CSS } from "./ui/splash.ts";

const asset = (name: string) => readFileSync(new URL(`../assets/${name}`, import.meta.url));

export const MANIFEST = {
  name: "Dovre",
  short_name: "Dovre",
  description: "The view from the top: what needs you across your repos, your apps and your agents.",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0a1117",
  theme_color: "#0e1922",
  icons: [
    { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/assets/icon.svg", sizes: "any", type: "image/svg+xml" },
  ],
  shortcuts: [
    { name: "Agents", url: "/agents" },
    { name: "New agent session", url: "/agents/new" },
    { name: "Deploys", url: "/deploys" },
    { name: "New work", url: "/issues/new" },
  ],
};

/** Network first; a page that can't load because the server is down gets the offline page. Shows a pack's Web Push. */
export const SERVICE_WORKER = String.raw`
const CACHE = "dovre-offline-v5";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/offline", "/starting.js", "/assets/icon-192.png", "/assets/fonts/NordwandMono-Regular.woff2"])).then(() => self.skipWaiting()));
});
// Navigation preload: the page's request starts while the worker wakes, instead of after.
self.addEventListener("activate", (e) => e.waitUntil(Promise.all([
  self.registration.navigationPreload ? self.registration.navigationPreload.enable() : null,
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  self.clients.claim(),
])));
self.addEventListener("fetch", (e) => {
  // The starting page's script and icon, when the server isn't there to serve them.
  if (e.request.mode !== "navigate") {
    const path = new URL(e.request.url).pathname;
    if (path === "/starting.js" || path === "/assets/icon-192.png" || path === "/assets/fonts/NordwandMono-Regular.woff2") e.respondWith(fetch(e.request).catch(() => caches.match(path)));
    return;
  }
  e.respondWith((async () => {
    try {
      return (await e.preloadResponse) || (await fetch(e.request));
    } catch {
      return (await caches.match("/offline")) || Response.error();
    }
  })());
});
// Web Push from a pack (the payload is {title, body, href, tag, tone}). A click goes only to a
// path on this app: "/x", never "//host" or "/\\host".
const here = (href) => typeof href === "string" && href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\") ? href : "/";
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(String(data.title || "Dovre"), {
    body: String(data.body || ""),
    icon: "/assets/icon-192.png",
    badge: "/assets/icon-192.png",
    tag: String(data.tag || "signal"),
    renotify: true,
    data: { href: here(data.href) },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const href = here(e.notification.data && e.notification.data.href);
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
    const w = ws.find((w) => "focus" in w);
    if (w) return w.navigate(href).then((n) => (n || w).focus(), () => w.focus());
    return self.clients.openWindow ? self.clients.openWindow(href) : null;
  }));
});
`;

/**
 * The page a window shows while the server starts (or when it's down): a progress bar, and a look
 * every quarter second. As soon as the server answers it goes on, so a cold start shows something
 * at once instead of nothing for seconds. Two copies: `/offline`, which the service worker keeps
 * for an installed app or a known window, and `data/starting-<port>.html`, which the launcher opens before
 * there's a server to ask (it can't rely on the service worker being there).
 *
 * Windows takes ~2 s to give up on a port nobody listens on, so looks overlap instead of waiting
 * on each other. The launcher's copy is a file:// page, which may not load anything from the
 * server (it allows only its own pages to: Cross-Origin-Resource-Policy), so it watches for
 * data/up-<port>.js instead, which the server writes once it's listening.
 */
export const STARTING_JS = String.raw`
const main = document.querySelector("main");
const bar = document.getElementById("bar");
const status = document.getElementById("status");
const help = document.getElementById("help");
const base = main.dataset.base || "";
const to = new URLSearchParams(location.search).get("to");
const started = Date.now();
let done = false;
function go() {
  if (done) return;
  done = true;
  bar.style.transform = "scaleX(1)";
  status.textContent = "Opening…";
  // From the launcher's file: on to the app (only ever this app). From the service worker: the page asked for.
  if (main.dataset.probe === "file") location.replace(to && to.startsWith(base + "/") ? to : base + "/");
  else location.reload();
}
function look() {
  if (done) return;
  if (main.dataset.probe === "file") {
    // A file:// page may not load anything from the server (it allows only its own pages), but
    // it may load a script beside it: the server writes data/up-<port>.js once it's listening.
    window.dovreUp = undefined;
    const s = document.createElement("script");
    s.src = main.dataset.up + "?look=" + Date.now();
    s.onload = () => { s.remove(); if (window.dovreUp) go(); };
    s.onerror = () => s.remove();
    document.head.append(s);
  } else {
    fetch("/healthz", { cache: "no-store", signal: AbortSignal.timeout(4000) }).then((r) => { if (r.ok) go(); }, () => {});
  }
}
setInterval(look, 250);
look();
// Most starts take a second or two: fill quickly, then ease off; it completes when the server answers.
(function grow() {
  if (done) return;
  const t = (Date.now() - started) / 1000;
  bar.style.transform = "scaleX(" + (0.92 * (1 - Math.exp(-t / 1.8))).toFixed(3) + ")";
  if (t > 3 && t < 12) status.textContent = "Starting the server and reading your code host…";
  if (t >= 12 && help.hidden) { help.hidden = false; status.textContent = "This is taking longer than usual."; }
  requestAnimationFrame(grow);
})();
`;

/**
 * The starting page: the splash (src/ui/splash.ts) with a progress line. `file`: the launcher's copy,
 * with the script inline and the server's address spelled out. Its styles are inline (a file page has
 * no server to ask), on the same tokens as the stylesheet's.
 */
export function startingPage(opts: { file?: { base: string; up: string; icon: string; font?: string; /** A pack's picture beside it (PackContext.startPicture: a file next to the page). */ picture?: string } } = {}) {
  const f = opts.file;
  const font = f?.font ?? "/assets/fonts/NordwandMono-Regular.woff2";
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting · Dovre</title>
<style>
@font-face { font-family: "Nordwand Mono"; src: url("${font}") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "Nordwand Mono"; src: url("${font.replace(/Regular(\.woff2)$/, "Bold$1")}") format("woff2"); font-weight: 700; font-display: swap; }
:root { color-scheme: light dark; --display: "Nordwand Mono", "Cascadia Mono", Consolas, monospace; --fs-s: 13px; --fs-xs: 12px;
  --bg: #f8f4ee; --sky: #efe7db; --surface: #fffdfa; --ink: #2a1d14; --ink-2: #54453a; --ink-3: #65564a; --line: #d6cabb; --accent: #1d5c88; --accent-ink: #fff;
  --ridge-far: #c3d0da; --ridge-near: #8fa5b5; --ridge-edge: #566e7f; --snow: #ffffff; --star: #ffffff; --sun: #1d5c88; }
@media (prefers-color-scheme: dark) { :root { --bg: #0a1117; --sky: #0e1922; --surface: #111c25; --ink: #e6ecf0; --ink-2: #b2bec7; --ink-3: #8c9aa5; --line: #2c3d4a; --accent: #84b9df; --accent-ink: #07131c;
  --ridge-far: #172633; --ridge-near: #253a4a; --ridge-edge: #5a7a90; --snow: #c9d7e1; --star: #dce7ef; --sun: #c9d7e1; } }
${raw(SPLASH_CSS)}
body { color: var(--ink); font: 15px/1.5 "Nordwand Mono", "Cascadia Mono", Consolas, monospace; }
#track { width: min(420px, 100%); height: 4px; border-radius: 4px; background: var(--line); overflow: hidden; margin-top: 10px; }
#bar { height: 100%; background: var(--accent); transform: scaleX(.04); transform-origin: left; transition: transform .25s ease-out; }
#status { color: var(--ink-3); margin: 12px 0 0; min-height: 1.5em; }
#help { margin-top: 18px; color: var(--ink-3); }
#help p { margin: 0 0 14px; }
a.btn { display: inline-block; padding: 9px 15px; border-radius: 9px; background: var(--accent); color: var(--accent-ink); font-weight: 600; text-decoration: none; }
code { font: 13px "Nordwand Mono", "Cascadia Mono", Consolas, monospace; }
@media (prefers-reduced-motion: reduce) { :root:not([data-motion="always"]) #bar { transition: none; } }
</style></head>
<body class="splash-page"><main class="splash" data-probe="${f ? "file" : "health"}" data-base="${f?.base ?? ""}" data-up="${f?.up ?? ""}">${RIDGE_ART}${f?.picture ? html`<img class="splash-pic" src="${f.picture}" alt="">` : ""}
<div class="splash-text"><div class="splash-brand">${MARK}<h1>Dovre</h1></div>
<div id="track" role="progressbar" aria-label="Starting Dovre"><div id="bar"></div></div>
<p id="status" aria-live="polite">Starting…</p>
<div id="help" hidden><p>It starts at login and comes back by itself after a crash. If it stopped, start it here, or run <code>dovre</code> in a terminal (<code>dovre logs</code> says why it won't).</p><a class="btn" href="dovre://open">Start Dovre</a></div></div>
</main>${f ? html`<script>${raw(STARTING_JS)}</script>` : html`<script src="/starting.js"></script>`}
<noscript><meta http-equiv="refresh" content="3"></noscript></body></html>`;
}

/** What the service worker keeps for when the server can't answer. */
export const OFFLINE = startingPage();

/** `files: false` (hosted): the icons and fonts come from the Worker's static assets instead (src/worker.ts). */
export function mountPwa(app: App, info: { version: string; startedAt: number }, opts: { files?: boolean } = {}) {
  app.get("/healthz", (c) => c.json({ ok: true, version: info.version, pid: globalThis.process?.pid, startedAt: info.startedAt }));
  app.get("/manifest.webmanifest", (c) => {
    c.header("Content-Type", "application/manifest+json");
    return c.body(JSON.stringify(MANIFEST));
  });
  app.get("/sw.js", (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    return c.body(SERVICE_WORKER);
  });
  app.get("/offline", (c) => c.html(OFFLINE));
  app.get("/starting.js", (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    return c.body(STARTING_JS);
  });
  if (opts.files === false) return;
  // The font, public like the icons (the starting page uses it before there's a login).
  for (const name of readdirSync(new URL("../assets/fonts/", import.meta.url)).filter((f) => /^NordwandMono-[A-Za-z]+\.woff2$/.test(f))) {
    const body = asset(`fonts/${name}`);
    app.get(`/assets/fonts/${name}`, (c) => {
      c.header("Content-Type", "font/woff2");
      c.header("Cache-Control", "private, max-age=31536000, immutable");
      return c.body(body);
    });
  }
  for (const [name, type] of [["icon.svg", "image/svg+xml"], ["icon-192.png", "image/png"], ["icon-512.png", "image/png"]] as const) {
    const body = asset(name);
    app.get(`/assets/${name}`, (c) => {
      c.header("Content-Type", type);
      c.header("Cache-Control", "private, max-age=86400");
      return c.body(body);
    });
  }
}
