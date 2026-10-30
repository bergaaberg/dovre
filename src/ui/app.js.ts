/**
 * The one script: plain JS, no build, no dependency, served as
 * /assets/app.<hash>.js under CSP `script-src 'self'`. Every feature is an enhancement: each
 * page works the same without it. It never writes markup from strings: text goes in with
 * textContent, and a live refresh moves nodes from a page this app served.
 */
import { hashOf } from "./style.ts";

/**
 * Hint labels the way Vimium makes them: all the same length, the shortest that gives every
 * target its own, the first letter varying fastest so the first key narrows evenly. Plain JS, put
 * at the top of SCRIPT; on its own so test/keys.test.ts can run it.
 */
export const HINT_LABELS_JS = String.raw`
function hintLabels(n, chars) {
  let len = 1;
  while (Math.pow(chars.length, len) < n) len++;
  const out = [];
  for (let i = 0; i < n; i++) {
    let label = "";
    for (let k = 0, x = i; k < len; k++, x = Math.floor(x / chars.length)) label += chars[x % chars.length];
    out.push(label);
  }
  return out;
}
`;

export const SCRIPT = HINT_LABELS_JS + String.raw`
const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
// The phone's keyboard is up: a field has the focus and what's visible shrank well below the
// tallest it's been in this orientation. The tab bar and docks step aside only then (style.ts html.kb).
let tallest = 0;
function kbCheck() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  tallest = Math.max(tallest, h);
  document.documentElement.classList.toggle("kb", typing(document.activeElement) && h < tallest * 0.8);
}
window.addEventListener("orientationchange", () => { tallest = 0; setTimeout(kbCheck, 300); });
(window.visualViewport || window).addEventListener("resize", kbCheck);
document.addEventListener("focusin", () => setTimeout(kbCheck, 250));
document.addEventListener("focusout", () => setTimeout(kbCheck, 50));
kbCheck();
// Inside a dock (a frame of a /…/dock page on another of this app's pages).
const framed = window.top !== window;

// ── Links to other sites, in the default browser (Settings → Layout, src/open-link.ts): in the
// installed app's window only, a link off this app goes to the server, which hands it to the
// system's opener. If the server won't, it opens the way it would have. ──
const toDefault = document.querySelector('meta[name="u-links"]')?.content === "default" && matchMedia("(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: minimal-ui)").matches;
function offSite(href) {
  try {
    const u = new URL(href, location.href);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin !== location.origin ? u.href : null;
  } catch { return null; }
}
function openNew(href) {
  const out = toDefault && offSite(href);
  if (!out) { window.open(href, "_blank", "noopener"); return; }
  fetch("/open-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: out }) })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); })
    .catch(() => window.open(out, "_blank", "noopener"));
}
function linkOut(e) {
  if (!toDefault || e.defaultPrevented || (e.type === "click" ? e.button !== 0 : e.button !== 1)) return;
  const a = e.target.closest?.("a[href]");
  if (!a || a.hasAttribute("download")) return;
  const href = offSite(typeof a.href === "string" ? a.href : a.getAttribute("href"));
  if (!href) return;
  e.preventDefault();
  e.stopPropagation();
  openNew(href);
}
document.addEventListener("click", linkOut, true);
document.addEventListener("auxclick", linkOut, true);
// A dock's page has no frame of its own to say light or dark: it takes its page's (Settings → Layout).
if (framed) try {
  const top = window.parent.document.documentElement;
  for (const a of ["data-theme", "data-accent"]) { const v = top.getAttribute(a); if (v) document.documentElement.setAttribute(a, v); }
} catch {}

// ── Times marked data-at="<ms>" say how long ago, kept current each minute ──
function since(at) {
  const min = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (min < 1) return "now";
  if (min < 60) return min + " min";
  if (min < 48 * 60) return Math.round(min / 60) + " h";
  return Math.round(min / (24 * 60)) + " d";
}
function tick(root) {
  for (const el of root.querySelectorAll("[data-at]")) {
    const at = Number(el.dataset.at);
    if (!Number.isFinite(at)) continue;
    const text = since(at);
    el.textContent = "ago" in el.dataset && text !== "now" ? text + " ago" : text;
  }
}

// ── A row of tabs too wide for the page scrolls sideways; the current tab starts in view ──
for (const nav of document.querySelectorAll("nav.tabs")) {
  const cur = nav.querySelector("[aria-current]");
  if (!cur || nav.scrollWidth <= nav.clientWidth) continue;
  const left = cur.getBoundingClientRect().left - nav.getBoundingClientRect().left;
  if (left + cur.offsetWidth > nav.clientWidth) nav.scrollLeft = left - 24;
}

// ── Today's feed ends above the docks at the bottom right: until it sticks to the top, it's only as
//    tall as the room under it. Looked up each time: a live swap replaces it. ──
function fitFeed() {
  const feed = document.querySelector(".feed");
  if (!feed || !document.querySelector(".docks")) return;
  if (getComputedStyle(feed).position !== "sticky") return void feed.style.removeProperty("max-height");
  feed.style.maxHeight = Math.max(240, innerHeight - Math.max(14, feed.getBoundingClientRect().top) - 70) + "px";
}
let feedQueued = false;
const fitFeedLater = () => feedQueued || ((feedQueued = true), requestAnimationFrame(() => ((feedQueued = false), fitFeed())));
addEventListener("scroll", fitFeedLater, { passive: true });
addEventListener("resize", fitFeedLater);

// ── A copy button beside anything marked data-copy (its value, or its text) ──
function copyButtons(root) {
  for (const el of root.querySelectorAll("[data-copy]")) {
    if (el.nextElementSibling?.classList.contains("copy")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(el.dataset.copy || el.textContent.trim());
        button.textContent = "Copied";
      } catch {
        button.textContent = "Couldn't copy";
      }
      setTimeout(() => (button.textContent = "Copy"), 1500);
    });
    el.after(button);
  }
}

// ── A PR's files: "Viewed" is remembered in this browser (by commit and path), and folds the file ──
const VIEWED = "u-viewed";
function viewedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(VIEWED) || "[]")); } catch { return new Set(); }
}
function viewedBoxes(root) {
  const seen = viewedSet();
  for (const box of root.querySelectorAll("input.viewed[data-key]")) {
    if (box.dataset.wired) continue;
    box.dataset.wired = "1";
    if (seen.has(box.dataset.key)) {
      box.checked = true;
      box.closest("details")?.removeAttribute("open");
    }
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
      const s = viewedSet();
      if (box.checked) s.add(box.dataset.key); else s.delete(box.dataset.key);
      try { localStorage.setItem(VIEWED, JSON.stringify([...s].slice(-2000))); } catch {}
      treeSeen(document);
      if (!box.checked) return;
      const file = box.closest("details");
      file?.removeAttribute("open");
      // On to the next file, the way a review goes.
      let next = file?.nextElementSibling;
      while (next && !next.matches("details[data-stop]")) next = next.nextElementSibling;
      if (next) landOn(next);
    });
  }
}

// The folder tree beside the files (dovre#299): a viewed file ticked, the one I'm in marked.
function treeLink(file) {
  return file?.id ? document.querySelector('.dfile-tree a[href="#' + CSS.escape(file.id) + '"]') : null;
}
function treeSeen(root) {
  for (const box of root.querySelectorAll("input.viewed[data-key]")) treeLink(box.closest("details"))?.classList.toggle("seen", box.checked);
}
let treeWatch = null;
function treeCurrent(root) {
  if (!("IntersectionObserver" in window) || !root.querySelector?.(".dfile-tree")) return;
  treeWatch?.disconnect();
  const showing = new Set();
  treeWatch = new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? showing.add(e.target) : showing.delete(e.target);
    const files = [...document.querySelectorAll(".dfile-list details.dfile")];
    const at = files.find((f) => showing.has(f));
    for (const a of document.querySelectorAll(".dfile-tree a[aria-current]")) a.removeAttribute("aria-current");
    const a = treeLink(at);
    if (!a) return;
    a.setAttribute("aria-current", "location");
    // Keep it in sight in the tree, without scrolling the page.
    const tree = a.closest(".dfile-tree"), r = a.getBoundingClientRect(), t = tree.getBoundingClientRect();
    if (r.top < t.top || r.bottom > t.bottom) tree.scrollTop += r.top - t.top - t.height / 3;
  }, { rootMargin: "0px 0px -60% 0px" });
  for (const f of document.querySelectorAll(".dfile-list details.dfile")) treeWatch.observe(f);
}

// ── My review on a PR's files (dovre#106): a line's + opens the comment form under it; shift-click
// another line's + in the same file and side for a range. Without this, the + is a link to the page
// with the form open there. ──
let picked = null;
function unpick() {
  for (const el of document.querySelectorAll(".d-picked")) el.classList.remove("d-picked");
  for (const el of document.querySelectorAll(".d-c.picked")) el.classList.remove("picked");
}
/** The rows under a line that belong to it (its threads, comments): the form goes after them. */
function lastOf(row) {
  let r = row;
  while (r.nextElementSibling && /\bd-(threads|drafts)\b/.test(r.nextElementSibling.className)) r = r.nextElementSibling;
  return r;
}
function commentAt(a, shift) {
  const tpl = $("c-form");
  const file = a.closest("details[data-path]");
  if (!tpl || !file) return false;
  const side = a.dataset.side, line = Number(a.dataset.line);
  const range = shift && picked && picked.file === file && picked.side === side && picked.line !== line;
  const start = range ? Math.min(picked.line, line) : 0;
  const end = range ? Math.max(picked.line, line) : line;
  const endA = range && picked.line > line ? picked.a : a;
  const was = document.getElementById("c-new");
  const typed = was?.querySelector("textarea")?.value || "";
  was?.remove();
  unpick();
  for (const el of file.querySelectorAll(".d-c")) {
    const n = Number(el.dataset.line);
    if (el.dataset.side === side && n >= (start || end) && n <= end) el.closest("tr")?.classList.add("d-picked");
  }
  a.classList.add("picked");
  picked = range ? null : { file, side, line, a };
  const row = tpl.content.firstElementChild.cloneNode(true);
  row.dataset.js = "1";
  const set = (name, v) => { const f = row.querySelector('[name="' + name + '"]'); if (f) f.value = String(v); };
  set("path", file.dataset.path);
  set("side", side);
  set("line", end);
  set("start", start || "");
  const where = row.querySelector("[data-where]");
  if (where) where.textContent = file.dataset.path + ":" + (start ? start + "–" : "") + end + (side === "LEFT" ? " (removed)" : "");
  lastOf(endA.closest("tr")).after(row);
  const box = row.querySelector("textarea");
  if (box) { box.value = typed; box.focus(); }
  return true;
}
// c: the line under the pointer, else the first one in view.
let lineHere = null;
document.addEventListener("mouseover", (e) => {
  const row = e.target.closest?.(".diff tr");
  if (row?.querySelector(":scope > .code > .d-c")) lineHere = row;
});
function commentKey() {
  let a = lineHere?.isConnected ? lineHere.querySelector(":scope > .code > .d-c") : null;
  if (!a || !inView(a)) a = [...document.querySelectorAll(".diff .d-c")].find((x) => x.getClientRects().length && !insideClosed(x) && inView(x));
  if (!a) return flash("No line to comment on here");
  commentAt(a, false);
}
const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
// v: the file I'm in, viewed (its box does the rest: folds it and moves on).
function viewedKey() {
  const files = [...document.querySelectorAll("details.dfile")].filter((d) => d.getClientRects().length);
  const at = stopAt(files);
  const box = files[at < 0 ? 0 : at]?.querySelector("input.viewed");
  if (!box) return flash("No file here");
  if (!box.checked) box.click();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a.d-c");
  if (a && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (commentAt(a, e.shiftKey)) e.preventDefault();
    return;
  }
  const cancel = e.target.closest?.('#c-new[data-js] [data-cancel]');
  if (cancel) {
    e.preventDefault();
    cancel.closest("#c-new").remove();
    unpick();
    picked = null;
  }
});

function enhance(root) {
  tick(root);
  copyButtons(root);
  viewedBoxes(root);
  treeSeen(root);
  treeCurrent(root);
  fitFeed();
}

// ── The app: offline page when the server is down, and installing it as its own app ──
// Elements are looked up when used: a whole-page swap (below) replaces them.
const $ = (id) => document.getElementById(id);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => null);
let installPrompt = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  const b = $("install");
  if (b) b.hidden = false;
});
// Web Push: a pack's <button data-push-subscribe="/base"> asks base/public-key, subscribes this
// device and posts it to base/subscribe. The base is a path on this app, nothing else.
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("button[data-push-subscribe]");
  if (!b) return;
  const base = b.dataset.pushSubscribe || "";
  if (!/^\/[A-Za-z0-9/_-]*$/.test(base) || base.startsWith("//")) return;
  const label = b.textContent;
  const fail = (why) => { b.disabled = false; b.textContent = label; alert("Couldn't subscribe: " + why); };
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return fail("this browser has no Web Push.");
  b.disabled = true;
  b.textContent = "Subscribing…";
  try {
    if ((await Notification.requestPermission()) !== "granted") return fail("notifications aren't allowed.");
    const reg = await navigator.serviceWorker.ready;
    const k = await fetch(base + "/public-key", { cache: "no-store" });
    const kj = await k.json().catch(() => ({}));
    if (!k.ok || !kj.publicKey) return fail(kj.error || "no public key (" + k.status + ").");
    const bin = atob(kj.publicKey.replace(/-/g, "+").replace(/_/g, "/"));
    const key = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const j = sub.toJSON();
    const r = await fetch(base + "/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth, userAgent: navigator.userAgent }),
    });
    if (!r.ok) return fail((await r.json().catch(() => ({}))).error || "the server said " + r.status + ".");
    location.reload();
  } catch (err) {
    fail(err?.message || String(err));
  }
});
document.addEventListener("click", async (e) => {
  if (!e.target.closest?.("#install") || !installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  const b = $("install");
  if (b) b.hidden = true;
});
addEventListener("appinstalled", () => { const b = $("install"); if (b) b.hidden = true; });

// ── Going somewhere: a thin bar at the top once a page takes longer than a blink, and a pressed
// button says it's working (and can't be pressed twice). Pages cross-fade (CSS @view-transition). ──
let goingTimer = 0;
function going() {
  clearTimeout(goingTimer);
  goingTimer = setTimeout(() => document.documentElement.classList.add("going"), 120);
}
function arrived() {
  clearTimeout(goingTimer);
  document.documentElement.classList.remove("going");
  for (const b of document.querySelectorAll("button.busy")) {
    b.classList.remove("busy");
    b.disabled = false;
    b.removeAttribute("aria-busy");
    if (b.dataset.idle) b.textContent = b.dataset.idle;
  }
}
addEventListener("pageshow", arrived);

// ── The side menu: Fold keeps to icons (remembered; /assets/side.js applies it before the page draws),
// and on a narrow screen the menu button opens it. ──
function sideFold() {
  const slim = document.documentElement.classList.toggle("side-slim");
  try { localStorage.setItem("u-side", slim ? "slim" : "wide"); } catch {}
  $("side-fold")?.setAttribute("aria-pressed", String(slim));
}
$("side-fold")?.setAttribute("aria-pressed", String(document.documentElement.classList.contains("side-slim")));
document.addEventListener("click", (e) => {
  if (e.target.closest?.("#side-fold")) return sideFold();
  const menu = e.target.closest?.("#side-menu, #tab-more");
  const side = $("side");
  if (!side) return;
  if (menu) return sideOpen(!side.classList.contains("open"));
  // On the phone with the tab bar, More is a sheet: a tap outside it closes it.
  if (side.classList.contains("open") && $("tab-more") && !e.target.closest?.("#side-sheet")) sideOpen(false);
});
function sideOpen(open) {
  $("side")?.classList.toggle("open", open);
  for (const b of [$("side-menu"), $("tab-more")]) b?.setAttribute("aria-expanded", String(open));
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("side")?.classList.contains("open")) sideOpen(false);
});

// ── Every page says how long it took to arrive, and where the time went (POST /perf → Settings → Page speed;
// a slow one also to data/perf.log; timings only). The route is the server's, from Server-Timing. ──
addEventListener("load", () => setTimeout(() => {
  const n = performance.getEntriesByType("navigation")[0];
  if (!n || !n.duration) return;
  const route = (n.serverTiming || []).find((t) => t.name === "route")?.description;
  const ms = (a, b) => Math.max(0, Math.round(n[b] - n[a]));
  const body = JSON.stringify({
    path: location.pathname, route, type: n.type, total: Math.round(n.duration),
    redirect: ms("redirectStart", "redirectEnd"), worker: n.workerStart ? ms("workerStart", "fetchStart") : 0,
    connect: ms("fetchStart", "requestStart"), wait: ms("requestStart", "responseStart"), download: ms("responseStart", "responseEnd"),
    dom: ms("responseEnd", "domContentLoadedEventEnd"), load: ms("domContentLoadedEventEnd", "loadEventEnd"),
  });
  try { navigator.sendBeacon("/perf", new Blob([body], { type: "application/json" })); } catch {}
}, 0));
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.("a[href]");
  if (!a || a.target || a.hasAttribute("download")) return;
  const to = new URL(a.href, location.href);
  if (to.origin !== location.origin || (to.pathname === location.pathname && to.search === location.search && to.hash)) return;
  going();
});
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (e.defaultPrevented || form.target) return;
  if (form.id === "refresh") return refresh(e);
  if (form.matches("form[data-send]")) return sendQuiet(e, form);
  if (form.matches("form[data-chat], form[data-inplace]")) return postInPlace(e, form);
  going();
  const b = e.submitter;
  if (!b || b.tagName !== "BUTTON") return;
  b.classList.add("busy");
  b.setAttribute("aria-busy", "true");
  if (b.dataset.busy) { b.dataset.idle = b.textContent; b.textContent = b.dataset.busy; }
  // After the form has taken the button's name and value: a second press does nothing.
  setTimeout(() => (b.disabled = true), 0);
});

// ── A chat's box (form[data-send], a pack's chat page: Teams): a message goes out in the background.
// The box clears at once and the message shows, dimmed (.tchat > .tmsg.mine.pending, styled by the
// pack), until the chat swaps in the real one. If the post itself fails, the text comes back to the
// box; if the app refuses it, the chat says so (with the text) when it swaps. ──
async function sendQuiet(e, form) {
  e.preventDefault();
  const box = form.querySelector("textarea");
  const text = box ? box.value : "";
  if (!text.trim()) return;
  const body = new URLSearchParams(new FormData(form));
  box.value = "";
  const list = document.querySelector(".tchat");
  let li;
  if (list) {
    li = document.createElement("li");
    li.className = "tmsg mine pending";
    const p = document.createElement("p");
    p.className = "tmsg-t";
    p.textContent = text;
    li.append(p);
    list.append(li);
    li.scrollIntoView({ block: "end" });
  }
  try {
    const res = await fetch(form.action, { method: "POST", body, credentials: "same-origin", headers: { "x-dovre-send": "1" } });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    if (!box.value) box.value = text;
    if (li) li.remove();
  }
  box.focus();
}
// Enter sends; Shift+Enter is a new line.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  const box = e.target.closest && e.target.closest("form[data-send] textarea");
  if (!box) return;
  e.preventDefault();
  box.form.requestSubmit();
});

// ── Refresh gathers in the background; the page swaps itself when the new data lands ──
function syncing() {
  const s = $("synced");
  if (s) s.textContent = "Syncing…";
  $("live-dot")?.classList.add("sync");
}
async function refresh(e) {
  e.preventDefault();
  syncing();
  try { await fetch("/refresh", { method: "POST", credentials: "same-origin", redirect: "manual" }); } catch {}
}

// ── Live: the server says when something changed (GET /events, Server-Sent Events; hosted, the /live socket); the page then
// fetches itself and swaps its data-live regions in place. Nothing reloads, nothing is lost:
// open rows stay open, and a region with unsent typing or an open confirm is left alone until it's done.
// A page that moved (an agent run that became its session) or was still gathering swaps whole.
// Topics a page cares about: <meta name="u-topics" content="snapshot run:<id>"> (default: snapshot). ──
const topicsOf = (doc) => {
  const m = doc.querySelector('meta[name="u-topics"]');
  return (m ? m.content : "snapshot").split(/\s+/).filter(Boolean);
};
let wanted = topicsOf(document);
const tzOf = (doc) => doc.querySelector('meta[name="u-tz"]')?.getAttribute("content") || "UTC";
const clock = (at) => new Intl.DateTimeFormat("en-GB", { timeZone: tzOf(document), hour: "2-digit", minute: "2-digit" }).format(at);

function busyWith(region) {
  if (region.contains(document.activeElement) && typing(document.activeElement)) return true;
  if (region.querySelector("details.confirm[open]")) return true;
  for (const f of region.querySelectorAll("textarea, input[type=text], input:not([type])")) if (f.value !== f.defaultValue) return true;
  return false;
}

// ── Motion (WP-S5): what a swap changes moves a little, so the eye finds it. What's new comes in
// (.fresh), what's gone fades out first (.leaving), a count that changed bumps (.bump), and an agent's
// turn that finished settles (.settled). The CSS is in src/ui/style.ts; under reduced motion, nothing moves. ──
/** Less motion: the system asks for it, and Settings → Look doesn't say Always (data-motion on <html>). */
const lessMotion = () => document.documentElement.dataset.motion !== "always" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const STILL = lessMotion();
/** Things a page names (an id, or data-key on a list's items): new ones enter, gone ones leave. */
const keyOf = (el) => (el.dataset.key ? "k:" + el.dataset.key : el.id ? "#" + el.id : "");
const keyed = (root) => new Map([...root.querySelectorAll("[data-key],[id]")].map((el) => [keyOf(el), el]));
const outermost = (els) => els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
/** What a message says: its text, not the "working…" line around it, so a finished turn matches what streamed. */
const said = (el) => (el.querySelector(".bubble > .md, .bino-text") ?? el).textContent.replace(/\s+/g, " ").trim().slice(0, 600);
/** Lists that grow at the end without names: a conversation, the calls an agent is making, the paragraphs it's writing. */
const GROWS = ["[data-follow]", "[data-grow]", ".turn-row.live .bubble > .md"];
/** A count in a badge (the menu, the tab bar, a dock button): numbers only, keyed by where it sits. */
const badges = (root) => {
  const out = new Map();
  for (const b of root.querySelectorAll("a b, button b")) {
    if (!/^[@\d\s+]+$/.test(b.textContent)) continue;
    const at = b.closest("a[href]")?.getAttribute("href") || b.closest("[id]")?.id || "";
    let k = at, n = 0;
    while (out.has(k)) k = at + "|" + ++n;
    out.set(k, b);
  }
  return out;
};
// Done moving, the marks go: a region the server sends again unchanged then still matches what's on screen.
const MOVED = { enter: "fresh", "fe-in": "fresh", bump: "bump", settle: "settled" };
document.addEventListener("animationend", (e) => {
  const cls = MOVED[e.animationName];
  const el = e.animationName === "settle" ? e.target.parentElement : e.target;
  if (!cls || !el?.classList.contains(cls)) return;
  el.classList.remove(cls);
  if (!el.classList.length) el.removeAttribute("class");
});
/** Marks what moves in the new copy of a region; returns what in the old one is leaving. */
function motion(region, copy) {
  if (STILL) return [];
  const before = keyed(region), after = keyed(copy);
  const entering = outermost([...after].filter(([k]) => k && !before.has(k)).map(([, el]) => el)).filter((el) => !el.closest(".live"));
  for (const el of entering) el.classList.add("fresh");
  for (const kind of GROWS) {
    const olds = [...region.querySelectorAll(kind)], news = [...copy.querySelectorAll(kind)];
    if (olds.length === news.length) news.forEach((list, i) => {
      // What the old list said, the live turn's words included, so the turn it becomes isn't new.
      const was = [...olds[i].children].map(said).filter(Boolean);
      for (const el of list.children) {
        if (el.classList.contains("live") || el.closest(".fresh")) continue;
        const s = said(el);
        // Seen before, or the same text grown longer (a paragraph still being written, a turn that finished).
        if (s && !was.some((w) => s === w || s.startsWith(w))) el.classList.add("fresh");
      }
    });
  }
  if (region.querySelector(".turn-row.live") && !copy.querySelector(".turn-row.live")) {
    const done = [...copy.querySelectorAll(".turn-row.agent")].pop();
    if (done && !done.classList.contains("fresh")) done.classList.add("settled");
  }
  const counts = badges(region);
  for (const [k, b] of badges(copy)) if (counts.get(k)?.textContent !== b.textContent) b.classList.add("bump");
  const going = outermost([...before].filter(([k]) => k && !after.has(k)).map(([, el]) => el)).filter((el) => !el.closest(".live"));
  return going.length <= 8 ? going : [];
}

let inFlight = false;
let queued = false;
/** The f / F hint letters on screen (below), and whether a live update waits for them to go. */
let hints = null;
let swapAfterHints = false;
async function swap() {
  if (hints) { swapAfterHints = true; return; }
  if (inFlight) { queued = true; return; }
  inFlight = true;
  const followed = followState();
  try {
    const res = await fetch(location.href, { headers: { accept: "text/html" }, credentials: "same-origin" });
    if (res.ok && (res.headers.get("content-type") || "").startsWith("text/html")) {
      const next = new DOMParser().parseFromString(await res.text(), "text/html");
      const to = new URL(res.url);
      const moved = res.redirected && to.pathname !== location.pathname;
      if (moved) history.replaceState(null, "", to.pathname + to.search + location.hash);
      if ((moved || document.querySelector("[data-pending]")) && !next.querySelector("[data-pending]")) {
        if (!busyWith(document.body)) {
          const live = $("live-dot")?.classList.contains("on");
          document.body.replaceWith(document.importNode(next.body, true));
          if (live) $("live-dot")?.classList.add("on");
          enhance(document);
          bellState(false);
          dockRestore();
          railBuild();
        }
      } else if (next.querySelector("[data-pending]") && !document.querySelector("[data-pending]")) {
        // A loaded page came back still loading (hosted, a fresh isolate reading the PR): ask again soon rather than lose the change.
        later(1500);
      } else {
        for (const region of document.querySelectorAll("[data-live][id]")) {
          const fresh = next.getElementById(region.id);
          if (!fresh || busyWith(region)) continue;
          if (fresh.innerHTML === region.innerHTML) continue;
          const copy = document.importNode(fresh, true);
          for (const d of region.querySelectorAll("details[open][id]")) copy.querySelector("#" + CSS.escape(d.id))?.setAttribute("open", "");
          for (const d of region.querySelectorAll("details[id]:not([open])")) copy.querySelector("#" + CSS.escape(d.id))?.removeAttribute("open");
          const going = motion(region, copy);
          if (going.length) {
            for (const el of going) el.classList.add("leaving");
            await new Promise((r) => setTimeout(r, 180));
            if (busyWith(region)) { for (const el of going) el.classList.remove("leaving"); continue; }
          }
          // Something that scrolls on its own keeps its place.
          const scrolled = [...region.querySelectorAll("[data-keep-scroll][id]")].map((el) => [el.id, el.scrollTop]);
          // A pack's script carries over what it shows there (a line, a mood).
          document.dispatchEvent(new CustomEvent("dovre:swap", { detail: { from: region, to: copy } }));
          region.replaceWith(copy);
          for (const [id, top] of scrolled) { const el = document.getElementById(id); if (el) el.scrollTop = top; }
          enhance(copy);
        }
      }
      followAfter(followed);
      wanted = topicsOf(next);
      const t = next.querySelector("title");
      if (t) document.title = t.textContent;
    }
  } catch {}
  inFlight = false;
  if (queued) { queued = false; swap(); }
}
let soon = 0;
const later = (ms) => { clearTimeout(soon); soon = setTimeout(swap, ms); };

// ── Desktop notifications: the server says when something new needs me; shown only when I'm not looking ──
// A page that may notify says so when it connects; while none may, the server sends a Windows toast.
const canNotify = () => "Notification" in window && Notification.permission === "granted";
function bellState(asked) {
  const bell = $("bell");
  if (!bell) return;
  const p = "Notification" in window ? Notification.permission : "denied";
  bell.hidden = p === "granted";
  const note = $("bell-note");
  if (note) note.textContent =
    p === "granted" ? "This window shows them." :
    asked ? "Edge held the request back (an app window has no address bar to ask in). Windows toasts carry on; to allow it here, open the window's … menu → App info → Permissions." :
    p === "denied" ? "Blocked for this window. Windows toasts carry on." : "Windows toasts for now.";
}
document.addEventListener("click", async (e) => {
  if (!e.target.closest?.("#bell")) return;
  try { await Notification.requestPermission(); } catch {}
  bellState(true);
  if (canNotify()) reconnect();
});
bellState(false);
function notify(notes) {
  if (!canNotify()) return;
  if (!document.hidden && document.hasFocus()) return;
  for (const n of notes) {
    try {
      const shown = new Notification(n.title, { body: n.body || "", tag: n.tag, icon: "/assets/icon-192.png" });
      shown.onclick = () => { window.focus(); if (n.url) location.href = n.url; shown.close(); };
    } catch {}
  }
}


let lastEvent = Date.now();
let es = null;
function onChange(c) {
  lastEvent = Date.now();
  const s = $("synced");
  if (c.synced && s) { s.textContent = "Synced " + clock(c.synced); $("live-dot")?.classList.remove("sync"); }
  if (c.notes && c.notes.length) notify(c.notes);
  const topics = c.topics || [];
  dockChange(topics);
  // For the packs' scripts (Pack.script): what the hub said changed.
  document.dispatchEvent(new CustomEvent("dovre:change", { detail: c }));
  if (topics.some((t) => wanted.includes(t)) || document.querySelector("[data-pending]")) later(topics.some((t) => t.startsWith("run:") || t.startsWith("bino:")) ? 120 : 300);
}
// Hosted (H5): the hub's socket, which lets the hub sleep while the tab is idle. Its keep-alive
// "ping" is answered "pong" without waking it. A socket that never opens three times running: /events.
const WS = document.querySelector('meta[name="u-live"]')?.content === "ws" && "WebSocket" in window;
let ws = null, wsFails = 0, wsOff = false, wsEver = false;
function socket() {
  let opened = false, ping = 0;
  const s = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/live");
  ws = s;
  s.addEventListener("open", () => {
    opened = true;
    wsFails = 0;
    $("live-dot")?.classList.add("on");
    lastEvent = Date.now();
    // Back after a drop: what changed meanwhile.
    if (wsEver) later(50);
    wsEver = true;
    ping = setInterval(() => { try { s.send("ping"); } catch {} }, 30000);
  });
  s.addEventListener("message", (e) => {
    lastEvent = Date.now();
    if (e.data === "pong") return;
    let c = {};
    try { c = JSON.parse(e.data); } catch {}
    onChange(c);
  });
  s.addEventListener("close", () => {
    clearInterval(ping);
    $("live-dot")?.classList.remove("on");
    if (ws === s) ws = null;
    if (!opened && ++wsFails >= 3) { wsOff = true; connect(); return; }
    setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(wsFails, 5)) + Math.random() * 500);
  });
}
// The socket carries no notes, so a change of notifying keeps it; a stream reopens with ?notify=1.
function reconnect() { if (WS && !wsOff) return; es?.close(); connect(); }
function connect() {
  if (WS && !wsOff) { if (!ws) socket(); return; }
  es = new EventSource(canNotify() ? "/events?notify=1" : "/events");
  es.addEventListener("open", () => { $("live-dot")?.classList.add("on"); lastEvent = Date.now(); });
  es.addEventListener("error", () => $("live-dot")?.classList.remove("on"));
  es.addEventListener("ping", () => { lastEvent = Date.now(); });
  es.addEventListener("change", (e) => {
    let c = {};
    try { c = JSON.parse(e.data); } catch {}
    onChange(c);
  });
}
// A dock's frame has none of its own: its page passes changes on (dockChange, below).
if ((WS || "EventSource" in window) && !framed) {
  // After the page has loaded, so a held-open stream never keeps it "loading".
  if (document.readyState === "complete") setTimeout(connect, 200);
  else addEventListener("load", () => setTimeout(connect, 200));
  // Coming back to the window (or waking the laptop): catch up at once.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) later(50); });
}
// Without a working event stream, look again every minute; every few seconds while still gathering.
setInterval(() => { if (!framed && Date.now() - lastEvent > 90000 && !document.hidden) swap(); }, 60000);
setInterval(() => { if (document.querySelector("[data-pending]")) swap(); }, 3000);
// A page whose data moves faster than anything the hub hears (a site's visits as they happen) asks to
// be looked at again every N seconds while it's on screen: <meta name="u-every" content="15"> (5 or more).
let looked = Date.now();
setInterval(() => {
  const n = Number(document.querySelector('meta[name="u-every"]')?.content);
  if (!(n >= 5) || document.hidden || Date.now() - looked < n * 1000) return;
  looked = Date.now();
  swap();
}, 1000);

// ── Saved settings restart Dovre: wait until a new server answers, then open the page it names ──
{
  const r = document.querySelector("[data-restarting]");
  const then = r?.getAttribute("data-then") || "/";
  if (r && then.startsWith("/") && !then.startsWith("//")) {
    const was = r.getAttribute("data-restarting");
    let tries = 0;
    const look = async () => {
      if (++tries > 120) return;
      try {
        const res = await fetch("/settings/started", { cache: "no-store" });
        if (res.ok && (await res.text()) !== was) { location.replace(then); return; }
      } catch {}
      setTimeout(look, 500);
    };
    setTimeout(look, 800);
  }
}

// ── Tap a chart's day: its numbers in a line under the chart (a phone shows no hover) ──
// Every mark already names itself in a <title>; this only says it out loud on a tap or click.
document.addEventListener("click", (e) => {
  const hit = e.target.closest?.("figure.viz svg .hit, figure.viz svg rect.cell");
  if (!hit) return;
  const title = hit.querySelector("title");
  const figure = hit.closest("figure.viz");
  if (!title || !figure) return;
  let out = figure.querySelector(":scope > .readout");
  if (!out) {
    out = document.createElement("p");
    out.className = "readout";
    out.setAttribute("aria-live", "polite");
    const after = [...figure.querySelectorAll(":scope > svg")].pop();
    after ? after.after(out) : figure.append(out);
  }
  for (const el of figure.querySelectorAll(".picked")) el.classList.remove("picked");
  const mark = hit.closest("g.col") || hit;
  mark.classList.add("picked");
  out.textContent = title.textContent;
});

// ── Keys, the way Vimium has them: f puts letters on everything clickable (type them to press it),
// j/k scroll, gg/G top and bottom, H/L back and forward, g <letter> goes to a section, ? lists them.
// They never fire while typing in a field, in a dialog, or with Ctrl/Alt/Meta held. ──
const GO = { h: "/", d: "/deploys", a: "/agents", p: "/prs", m: "/movement", w: "/worktrees", n: "/agents/new", c: "/issues/new", t: "/todo", b: "/bino" };
const KEYS = [
  ["Hints", [["f", "Letters on everything clickable: type them to press it"], ["F", "The same, links open in a new window"], ["Backspace", "Take back a letter"], ["Esc", "Put the letters away"]]],
  ["Moving", [["j / k", "Scroll down / up"], ["d / u", "Half a page down / up"], ["g g", "To the top"], ["G", "To the bottom, or the latest"], ["J / K", "Next / previous item: a reply, a hunk, a comment, a row"], ["] / [", "Next / previous section: your message, a file"], ["o", "The sections, to jump to one"], ["Enter", "Open the row"]]],
  ["Going to", [["Ctrl K", "Search everything: pages, PRs, agents, worktrees, My list and what your apps add"], ["g h", "Today"], ["g d", "Deploys"], ["g a", "Agents"], ["g p", "Pull requests"], ["g m", "Moved"], ["g w", "Worktrees"], ["g n", "New agent session"], ["g c", "New work"], ["g t", "My list"], ["g b", "Bino"], ["H / L", "Back / forward"]]],
  ["This page", [["r", "Refresh the data"], ["B", "Bino: open its panel, told which page you are on; into it when it's open"], ["y y", "Copy the page's address"], ["a", "Add to My list, with details"], ["c", "A PR's files: comment on the line under the pointer (Ctrl Enter adds it)"], ["v", "A PR's files: mark the file you're in viewed, on to the next"], [".", "An agent session: stop its turn"], ["A", "An agent asks: allow it (the top one on Agents)"], ["g i", "The first text field"], ["/", "Search this page, or everything"], ["?", "These keys"], ["Esc", "Leave a field, close a dialog"]]],
  ["Bino", [["Enter", "Send"], ["Shift Enter", "A new line"], ["↑", "In an empty box: what you last sent"], ["Esc / s", "While Bino answers: stop it"], ["n", "On Bino's page: a new chat"], ["i", "On Bino's page: the box to write in"], ["Alt ↑ / ↓", "On Bino's page: the chat above or below"], ["/", "On Bino's page: search the chats"], ["Esc", "Out of the box; again closes the panel"], ["B", "In the panel: close it"]]],
];
let help = null;
function showHelp() {
  if (!help) {
    help = document.createElement("dialog");
    help.className = "keys";
    const title = document.createElement("h2");
    title.textContent = "Keys";
    const groups = document.createElement("div");
    groups.className = "key-groups";
    // The packs' docks with a key of their own (Teams: T), beside Bino's.
    const docked = DOCKS.filter((d) => d.letter).map((d) => [d.letter, d.title + ": open or close its panel"]);
    for (const [name, listed] of KEYS) {
      const keys = name === "This page" ? [...listed.slice(0, 1), ...docked, ...listed.slice(1)] : listed;
      const group = document.createElement("section");
      const h = document.createElement("h3");
      h.textContent = name + (keysOff({ Hints: "hints", Moving: "moving", "Going to": "going", "This page": "page", Bino: "docks" }[name]) ? " (off in Settings)" : "");
      const list = document.createElement("dl");
      for (const [key, what] of keys) {
        const dt = document.createElement("dt");
        const kbd = document.createElement("kbd");
        kbd.textContent = key;
        dt.append(kbd);
        const dd = document.createElement("dd");
        dd.textContent = what;
        list.append(dt, dd);
      }
      group.append(h, list);
      groups.append(group);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => help.close());
    help.append(title, groups, close);
    document.body.append(help);
  }
  help.showModal();
}
const rows = () => [...document.querySelectorAll("main ul.list > li > a.item, main ul.list > li > details > summary.item")];
function move(by) {
  const all = rows();
  if (!all.length) return;
  const at = all.indexOf(document.activeElement);
  const next = all[at < 0 ? (by > 0 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, at + by))];
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

// ── Hints (f / F): a letter label at the top-left of every clickable thing in view ──
const HINT_CHARS = "sadfjklewcmpgh";
const CLICKABLE = 'a[href], button, summary, input:not([type="hidden"]), select, textarea, label, [role="button"], [tabindex]:not([tabindex="-1"])';
function insideClosed(el) {
  for (let d = el.parentElement && el.parentElement.closest("details"); d; d = d.parentElement && d.parentElement.closest("details"))
    if (!d.open && !(el.tagName === "SUMMARY" && el.parentElement === d)) return true;
  return false;
}
function targets() {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(CLICKABLE)) {
    if (el.disabled || el.closest(".key-hints")) continue;
    // A label only counts when it toggles a box; the box inside it then needs no label of its own.
    if (el.tagName === "LABEL") {
      const box = el.querySelector('input[type="checkbox"], input[type="radio"]');
      if (!box || box.disabled) continue;
      seen.add(box);
    }
    if (seen.has(el)) continue;
    // Inside a closed <details> (its own summary aside): Edge still gives it a box, but it isn't shown.
    if (insideClosed(el)) continue;
    // Nothing drawn (display:none, hidden, zero-size, out of view), nothing to press.
    const box = [...el.getClientRects()].find((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth);
    if (!box || getComputedStyle(el).visibility === "hidden") continue;
    // A modal dialog that's open: only what's in it.
    const modal = document.querySelector("dialog[open]");
    if (modal && !modal.contains(el)) continue;
    seen.add(el);
    out.push({ el, box });
  }
  return out;
}
function showHints(newTab) {
  hideHints();
  const found = targets();
  if (!found.length) return;
  const labels = hintLabels(found.length, HINT_CHARS);
  const layer = document.createElement("div");
  layer.className = "key-hints";
  layer.setAttribute("aria-hidden", "true");
  const items = found.map((t, i) => {
    const node = document.createElement("span");
    node.className = "key-hint";
    node.style.left = Math.max(0, Math.round(t.box.left)) + "px";
    node.style.top = Math.max(0, Math.round(t.box.top)) + "px";
    const typed = document.createElement("span");
    typed.className = "key-hint-typed";
    const rest = document.createTextNode(labels[i]);
    node.append(typed, rest);
    layer.append(node);
    return { el: t.el, label: labels[i], node, typed, rest };
  });
  document.body.append(layer);
  hints = { layer, items, typed: "", newTab };
  addEventListener("scroll", hideHints, { capture: true, passive: true });
  addEventListener("resize", hideHints);
  addEventListener("mousedown", hideHints, true);
}
function hideHints() {
  if (!hints) return;
  hints.layer.remove();
  hints = null;
  removeEventListener("scroll", hideHints, { capture: true });
  removeEventListener("resize", hideHints);
  removeEventListener("mousedown", hideHints, true);
  // A live update that came while they were up waited for them (it would have moved what they point at).
  if (swapAfterHints) { swapAfterHints = false; later(50); }
}
function narrow() {
  for (const it of hints.items) {
    const on = it.label.startsWith(hints.typed);
    it.node.hidden = !on;
    it.typed.textContent = on ? hints.typed : "";
    it.rest.textContent = on ? it.label.slice(hints.typed.length) : it.label;
  }
}
function press(el, newTab) {
  hideHints();
  if (newTab && el.tagName === "A" && el.href) { openNew(el.href); return; }
  const tag = el.tagName;
  const field = tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && !/^(checkbox|radio|button|submit|reset|file|color|range|image)$/i.test(el.type || ""));
  if (field) {
    el.focus();
    if (tag !== "SELECT" && typeof el.select === "function") try { el.select(); } catch {}
    return;
  }
  if (tag !== "LABEL") el.focus({ preventScroll: true });
  el.click();
}
function hintKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") return hideHints();
  if (e.key === "Backspace") { hints.typed = hints.typed.slice(0, -1); return narrow(); }
  const ch = e.key.length === 1 ? e.key.toLowerCase() : "";
  if (!ch || !HINT_CHARS.includes(ch)) return hideHints();
  const typed = hints.typed + ch;
  const left = hints.items.filter((it) => it.label.startsWith(typed));
  // A letter that matches nothing is ignored, so a slip doesn't throw the letters away.
  if (!left.length) return;
  hints.typed = typed;
  const hit = left.find((it) => it.label === typed);
  if (hit && left.length === 1) return press(hit.el, hints.newTab);
  narrow();
}

// ── The rest of the keys ──
const smooth = () => (lessMotion() ? "auto" : "smooth");
const scrollBy_ = (dy) => scrollBy({ top: dy, behavior: smooth() });
// Settings → Keys (dovre#87, src/keys.ts): how far j/k scroll, and the groups switched off.
const KEYPREFS = (() => {
  try { return JSON.parse(document.querySelector('meta[name="u-keys"]')?.content || "{}"); } catch { return {}; }
})();
const STEP = Number(KEYPREFS.scroll) || 70;
const keysOff = (group) => Array.isArray(KEYPREFS.off) && KEYPREFS.off.includes(group);
const GROUP_OF = { f: "hints", F: "hints", j: "moving", k: "moving", d: "moving", u: "moving", G: "moving", J: "moving", K: "moving", "]": "moving", "[": "moving", o: "moving", H: "going", L: "going", r: "page", "/": "page", a: "page", c: "page", v: "page", ".": "page", A: "page" };
function flash(text) {
  const el = document.createElement("div");
  el.className = "key-flash";
  el.setAttribute("role", "status");
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 1400);
}
async function copyAddress() {
  const u = new URL(location.href);
  u.searchParams.delete("tk");
  try {
    await navigator.clipboard.writeText(u.href);
    flash("Copied " + u.pathname + u.search);
  } catch {
    flash("Couldn't copy");
  }
}
function firstField() {
  const f = [...document.querySelectorAll('main input:not([type]), main input[type="text"], main input[type="search"], main input[type="url"], main input[type="email"], main input[type="number"], main textarea')]
    .find((x) => !x.disabled && x.getClientRects().length);
  if (!f) return;
  f.focus();
  try { f.select(); } catch {}
  f.scrollIntoView({ block: "nearest" });
}

// What I send from a chat box, for ↑ to bring back (this tab only).
document.addEventListener("submit", (e) => {
  const box = e.target.matches?.("form[data-chat]") && e.target.querySelector("textarea");
  if (box && box.value.trim()) try { sessionStorage.setItem("u-chat-last", box.value.slice(0, 4000)); } catch {}
}, true);

// ── The /bino workspace (.bino-ws): typing in its search narrows the chats by title at once (Enter
// searches what was said too, on the server); n is a new chat, i the box to write in, Alt ↑ / ↓ the
// chat above or below. ──
document.addEventListener("input", (e) => {
  const box = e.target.closest?.("input[data-conv-filter]");
  if (!box) return;
  const v = box.value.trim().toLowerCase();
  for (const li of document.querySelectorAll("#bino-nav li[data-title]")) li.hidden = !!v && !li.dataset.title.includes(v);
  for (const g of document.querySelectorAll("#bino-nav .bino-group")) g.hidden = !g.querySelector("li[data-title]:not([hidden])");
});
const binoBox = () => document.querySelector(".bino-ws .bino-main form[data-chat] textarea");
try {
  if (sessionStorage.getItem("u-bino-focus")) { sessionStorage.removeItem("u-bino-focus"); binoBox()?.focus(); }
} catch {}
document.addEventListener("keydown", (e) => {
  if (hints || e.defaultPrevented || !document.querySelector(".bino-ws") || e.target.closest?.("dialog")) return;
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    // In a box with text in it, Alt ↑ / ↓ is the box's own.
    if (typing(e.target) && e.target.value) return;
    const links = [...document.querySelectorAll("#bino-nav li[data-conv]:not([hidden]) > a")];
    if (!links.length) return;
    const at = links.findIndex((a) => a.closest("li").classList.contains("on"));
    const next = links[at < 0 ? (e.key === "ArrowDown" ? 0 : links.length - 1) : at + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    going();
    location.href = next.href;
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || keysOff("page")) return;
  if (e.key === "n") {
    e.preventDefault();
    if (location.pathname === "/bino" && !location.search) { binoBox()?.focus(); return; }
    try { sessionStorage.setItem("u-bino-focus", "1"); } catch {}
    going();
    location.href = "/bino";
  } else if (e.key === "i" && binoBox()) {
    e.preventDefault();
    binoBox().focus();
  }
});

let prefix = "";
let prefixTimer = 0;
document.addEventListener("keydown", (e) => {
  if (hints) return hintKey(e);
  // Ctrl K: search, from anywhere but a terminal (where it's the shell's).
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k" && !(e.target.closest && e.target.closest(".xterm")) && !framed) {
    e.preventDefault();
    openPalette();
    return;
  }
  // Ctrl+Enter sends a message box that says it may (Bino's); never a form behind a Confirm.
  // A chat box (data-chat) sends on Enter too, Shift+Enter is a new line, and not mid-composition (an IME's Enter picks a word).
  const box = e.target.matches?.("textarea") ? e.target : null;
  const chat = box && box.closest?.("form[data-chat]");
  const enter = box && e.key === "Enter" && !e.isComposing && !e.altKey;
  const sendable = !enter ? null : e.ctrlKey || e.metaKey ? box.closest?.("form[data-ctrl-enter]") : e.shiftKey ? null : chat;
  if (sendable) {
    e.preventDefault();
    if (box.value.trim()) sendable.requestSubmit();
    return;
  }
  // ↑ in an empty chat box: what I last sent, to send again or change.
  if (chat && e.key === "ArrowUp" && !box.value && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    let last = "";
    try { last = sessionStorage.getItem("u-chat-last") || ""; } catch {}
    if (last) {
      e.preventDefault();
      box.value = last;
      box.setSelectionRange(last.length, last.length);
      grow(box);
    }
    return;
  }
  // AltGr (how a Norwegian keyboard types [ ] and others) arrives as Ctrl+Alt: that's typing, not a shortcut.
  if (e.metaKey || ((e.ctrlKey || e.altKey) && !e.getModifierState?.("AltGraph"))) return;
  if (typing(e.target)) {
    // Esc leaves a field (Vimium's way out), unless something in it wants Esc itself.
    if (e.key === "Escape" && !e.target.closest?.("dialog") && !e.target.closest?.(".xterm")) e.target.blur();
    return;
  }
  if (e.target.closest?.("dialog")) return;
  const k = e.key;
  // Bino answering: Esc or s stops it, before Esc closes the panel.
  const stop = (k === "Escape" || k === "s") && document.querySelector("[data-bino-stop]");
  if (stop) { e.preventDefault(); stop.click(); return; }
  if (k === "Escape" && (framed || openDock())) { dockOpen(openDock(), false, true); return; }
  if (DOCK_KEYS[k] || (framed && /^[A-Z]$/.test(k) && !"FGHJKL".includes(k))) {
    if (keysOff("docks")) return;
    e.preventDefault(); dockKey(k); return;
  }
  const was = prefix;
  prefix = "";
  clearTimeout(prefixTimer);
  if (was === "g") {
    const group = k === "g" ? "moving" : k === "i" ? "page" : "going";
    if (keysOff(group)) return;
    e.preventDefault();
    if (k === "g") scrollTo({ top: 0, behavior: smooth() });
    else if (k === "i") firstField();
    else if (GO[k]) { going(); location.href = GO[k]; }
    return;
  }
  if (was === "y" && k === "y") { if (keysOff("page")) return; e.preventDefault(); copyAddress(); return; }
  if (k === "g" || k === "y") { prefix = k; prefixTimer = setTimeout(() => (prefix = ""), 1200); return; }
  if (GROUP_OF[k] && keysOff(GROUP_OF[k])) return;
  const act = {
    f: () => showHints(false),
    F: () => showHints(true),
    j: () => scrollBy_(STEP),
    k: () => scrollBy_(-STEP),
    d: () => scrollBy_(innerHeight / 2),
    u: () => scrollBy_(-innerHeight / 2),
    G: () => toEnd(),
    H: () => history.back(),
    L: () => history.forward(),
    r: () => refresh({ preventDefault() {} }),
    J: () => goStop(1, 2) || move(1),
    K: () => goStop(-1, 2) || move(-1),
    "]": () => goStop(1, 1) || move(1),
    "[": () => goStop(-1, 1) || move(-1),
    o: () => showOutline(),
    // Add to My list with details: here when the page has the form, else on My list.
    a: () => {
      const q = document.getElementById("todo-q");
      if (!q) { going(); location.href = "/todo?add"; return; }
      const more = document.getElementById("todo-add-more");
      if (more) more.open = true;
      q.focus();
    },
    c: () => commentKey(),
    v: () => viewedKey(),
    "?": () => showHelp(),
    "/": () => {
      // The page's own search where it has one (Data, Search); else search everything.
      const search = document.querySelector('main input[type="search"]');
      if (search) { search.focus(); search.select(); }
      else openPalette();
    },
  }[k];
  if (act) { e.preventDefault(); act(); return; }
  // A page's own key on a button (data-hotkey: an agent's Stop is ".", Allow is "A"): the first one showing.
  // Only plain buttons carry one, never a write behind a Confirm.
  const hot = [...document.querySelectorAll("button[data-hotkey]")].find((b) => b.dataset.hotkey === k && !b.disabled && b.getClientRects().length);
  if (hot) { e.preventDefault(); hot.click(); }
});

enhance(document);
setInterval(() => tick(document), 60000);

// ── Search (Ctrl K anywhere; / where the page has no search of its own): a dialog whose list the server
// draws (GET /search?frag=1, src/pages/search.ts) and this swaps in as you type. Focus stays in the
// field; arrows move aria-activedescendant over the rows; Enter opens the one marked. ──
let pal = null;
let palSeq = 0;
let palTimer = 0;
let palAt = 0;
let palFrom = null;
const svgOf = (d, extra) => {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 20 20");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.6");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("aria-hidden", "true");
  const c = document.createElementNS(ns, "circle");
  c.setAttribute("cx", "9"); c.setAttribute("cy", "9"); c.setAttribute("r", "5.5");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", d);
  s.append(c, p);
  return s;
};
function keyHint(keys, what) {
  const span = document.createElement("span");
  for (const k of keys) {
    const kbd = document.createElement("kbd");
    kbd.textContent = k;
    span.append(kbd, " ");
  }
  span.append(what);
  return span;
}
function palette() {
  if (pal) return pal;
  const d = document.createElement("dialog");
  d.className = "palette";
  d.setAttribute("aria-label", "Search Dovre");
  const form = document.createElement("form");
  form.className = "pal-in";
  form.method = "get";
  form.action = "/search";
  const input = document.createElement("input");
  input.type = "search";
  input.name = "q";
  input.id = "pal-q";
  input.maxLength = 200;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "Search pages, PRs, agents, My list…";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", "pal-list");
  input.setAttribute("aria-autocomplete", "list");
  const esc = document.createElement("kbd");
  esc.textContent = "Esc";
  form.append(svgOf("m13 13 4 4"), input, esc);
  const list = document.createElement("div");
  list.className = "pal-list";
  list.id = "pal-list";
  list.setAttribute("role", "listbox");
  const foot = document.createElement("div");
  foot.className = "pal-foot";
  foot.append(keyHint(["↑", "↓"], "move"), keyHint(["Enter"], "open"), keyHint(["pr:", "a:", "j:", "w:", "t:", ">"], "one kind"), keyHint(["Esc"], "close"));
  d.append(form, list, foot);
  input.addEventListener("input", () => {
    clearTimeout(palTimer);
    palTimer = setTimeout(palFetch, 90);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      palMark(palAt + (e.key === "ArrowDown" ? 1 : -1));
    }
  });
  // Enter: the marked row; with none (nothing found yet), the full results page.
  form.addEventListener("submit", (e) => {
    const row = palRows()[palAt];
    if (!row) return;
    e.preventDefault();
    palGo(row);
  });
  d.addEventListener("mousemove", (e) => {
    const row = e.target.closest && e.target.closest(".pal-row");
    if (row) {
      const i = palRows().indexOf(row);
      if (i >= 0 && i !== palAt) palMark(i);
    }
  });
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
    const row = e.target.closest && e.target.closest(".pal-row");
    if (row && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      palGo(row);
    }
  });
  d.addEventListener("close", () => {
    if (palFrom && palFrom.focus) palFrom.focus();
  });
  document.body.append(d);
  pal = d;
  return d;
}
const palRows = () => [...document.querySelectorAll("#pal-list .pal-row")];
function palMark(i) {
  const rows = palRows();
  const input = document.getElementById("pal-q");
  if (!rows.length) { input.removeAttribute("aria-activedescendant"); palAt = 0; return; }
  palAt = (i + rows.length) % rows.length;
  rows.forEach((r, n) => r.setAttribute("aria-selected", String(n === palAt)));
  input.setAttribute("aria-activedescendant", rows[palAt].id);
  rows[palAt].scrollIntoView({ block: "nearest" });
}
// What's gathered answers at once; GHE's own search (issues and PRs across the org) follows once
// typing pauses, keeping the row that's marked.
let palRemote = 0;
async function palFetch(remote) {
  const q = document.getElementById("pal-q").value;
  const seq = remote ? palSeq : ++palSeq;
  clearTimeout(palRemote);
  try {
    const res = await fetch("/search?frag=1&q=" + encodeURIComponent(q) + (remote ? "&remote=1" : ""), { headers: { accept: "text/html" } });
    if (!res.ok || seq !== palSeq) return;
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const fresh = doc.getElementById("pal-list");
    if (!fresh || seq !== palSeq) return;
    const marked = remote ? palRows()[palAt]?.getAttribute("href") : null;
    document.getElementById("pal-list").replaceWith(document.importNode(fresh, true));
    const again = marked ? palRows().findIndex((r) => r.getAttribute("href") === marked) : -1;
    palMark(again >= 0 ? again : remote ? palAt : 0);
    if (!remote && q.trim().length >= 3) palRemote = setTimeout(() => palFetch(true), 450);
  } catch {}
}
function palGo(row) {
  pal.close();
  if (row.target === "_blank") { openNew(row.href); return; }
  going();
  location.href = row.href;
}
function openPalette() {
  if (framed) return;
  const d = palette();
  if (d.open) { d.close(); return; }
  palFrom = document.activeElement;
  const input = document.getElementById("pal-q");
  input.value = "";
  d.showModal();
  input.focus();
  palFetch();
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest("#search-btn");
  if (!btn || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  openPalette();
});

// ── Chart tips (src/ui/chart.ts): a mark with data-tip shows its values on hover and on focus.
// Lines of plain text (textContent): the values first, strong; the last line says which period. ──
let vtip = null;
function tipShow(t, x, y) {
  if (!vtip) {
    vtip = document.createElement("div");
    vtip.className = "vtip";
    vtip.setAttribute("role", "tooltip");
    document.body.appendChild(vtip);
  }
  vtip.replaceChildren();
  const rows = (t.getAttribute("data-tip") || "").split("\n");
  rows.forEach((line, i) => {
    const el = document.createElement(i < rows.length - 1 ? "strong" : "span");
    el.textContent = line;
    vtip.appendChild(el);
  });
  vtip.hidden = false;
  const r = vtip.getBoundingClientRect();
  vtip.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x + 14)) + "px";
  vtip.style.top = Math.max(8, y - r.height - 12) + "px";
}
const tipHide = () => { if (vtip) vtip.hidden = true; };
document.addEventListener("pointermove", (e) => {
  const t = e.target.closest && e.target.closest("[data-tip]");
  if (t) tipShow(t, e.clientX, e.clientY); else tipHide();
});
document.addEventListener("focusin", (e) => {
  const t = e.target.closest && e.target.closest("[data-tip]");
  if (!t) return;
  const r = t.getBoundingClientRect();
  tipShow(t, r.left + r.width / 2, r.top);
});
document.addEventListener("focusout", tipHide);
document.addEventListener("scroll", tipHide, { passive: true });

// ── A chat box (textarea[data-enter-send]): Enter sends, Shift+Enter is a new line, and so is Enter
// inside an open code block (an odd number of fence lines before the cursor). ──
document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (e.key !== "Enter" || e.shiftKey || e.altKey || e.isComposing || !t.matches || !t.matches("textarea[data-enter-send]")) return;
  const fences = (t.value.slice(0, t.selectionStart).match(/^\s*\x60\x60\x60/gm) || []).length;
  if (fences % 2 === 1 && !e.ctrlKey) return;
  e.preventDefault();
  if (t.value.trim() && t.form) t.form.requestSubmit();
}, true);

// ── A form that saves as I change it (form[data-autosave]: Settings → Look and layout): posted in
// the background, then the page reloads where it is, so a theme or a tab shows at once. Typing in a
// box saves when it loses focus (change), not on every key. ──
document.addEventListener("change", async (e) => {
  const form = e.target.closest && e.target.closest("form[data-autosave]");
  if (!form || form.dataset.saving) return;
  form.dataset.saving = "1";
  try {
    const res = await fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form)), redirect: "manual" });
    if (res.type === "opaqueredirect" || res.ok) return location.reload();
    form.requestSubmit();
  } catch {
    form.requestSubmit();
  } finally {
    delete form.dataset.saving;
  }
});

// ── A filter form (form[data-autofilter], the PR list) goes as soon as a choice changes ──
document.addEventListener("change", (e) => {
  const form = e.target.closest && e.target.closest("form[data-autofilter]");
  if (form && e.target.tagName === "SELECT") form.requestSubmit();
});

// ── Picking a checkout on a new session (select[data-requery]) reloads the page for it, so its
// quick picks show; what's typed in the prompt so far comes along when it's short enough for a link. ──
document.addEventListener("change", (e) => {
  const sel = e.target.closest && e.target.closest("select[data-requery]");
  if (!sel || !sel.form) return;
  const q = new URLSearchParams({ repo: sel.value });
  const typed = sel.form.elements.prompt && sel.form.elements.prompt.value;
  if (typed && typed.length <= 2000) q.set("prompt", typed);
  const m = sel.form.elements.machine && sel.form.elements.machine.value;
  if (m) q.set("machine", m);
  location.assign(location.pathname + "?" + q);
});

// ── A new session (form[data-new-agent]): the Agent picked shows only its own options (#236),
// and what was last started in a checkout (agent, mode, model, effort) comes back for it. Kept in
// this browser only, as a convenience. ──
const PICKS = "u-agent-picks";
function savedPicks() {
  try { return JSON.parse(localStorage.getItem(PICKS) || "{}") || {}; } catch { return {}; }
}
function showHarness(form, h) {
  for (const fs of form.querySelectorAll("fieldset.harness-opts")) {
    const on = fs.dataset.harness === h;
    fs.hidden = !on;
    fs.disabled = !on;
  }
}
document.addEventListener("change", (e) => {
  const sel = e.target.closest && e.target.closest("select[data-harness-pick]");
  if (sel && sel.form) showHarness(sel.form, sel.value);
});
for (const form of document.querySelectorAll("form[data-new-agent]")) {
  const repo = form.elements.repo && form.elements.repo.value;
  const p = repo && savedPicks()[repo];
  const pick = form.elements.harness;
  if (!p || !pick || ![...(pick.options || [])].some((o) => o.value === p.harness)) continue;
  pick.value = p.harness;
  showHarness(form, p.harness);
  const scope = [...form.querySelectorAll("fieldset.harness-opts")].find((fs) => fs.dataset.harness === p.harness) || form;
  for (const k of ["mode", "model", "effort"]) {
    const el = scope.querySelector("select[name=" + k + "]");
    if (el && [...el.options].some((o) => o.value === p[k])) el.value = p[k];
  }
}
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (!form.matches || !form.matches("form[data-new-agent]")) return;
  const d = new FormData(form);
  const repo = d.get("repo");
  if (!repo) return;
  const all = savedPicks();
  delete all[repo];
  all[repo] = { harness: d.get("harness"), mode: d.get("mode"), model: d.get("model"), effort: d.get("effort") || "" };
  try { localStorage.setItem(PICKS, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-50)))); } catch {}
});

// ── A link to /page#id opens that row in place (a <details> closed by default) ──
function openTarget() {
  const el = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (el && el.tagName === "DETAILS") {
    el.open = true;
    el.scrollIntoView({ block: "start" });
  }
}
openTarget();
addEventListener("hashchange", openTarget);

// ── Long pages (an agent session, a PR's files, a chat): stops to move between, marked data-stop="1"
// (a section: your message, a file) or "2" (an item in one: a reply, a hunk, a comment); a rail at
// the right edge with top, previous, where I am, next and latest; an outline of the sections (o).
// A list marked data-follow (a conversation) opens at its latest and stays there while I'm there. ──
function scrollerOf(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}
const viewTop = (sc) => (sc ? sc.getBoundingClientRect().top : 0);
const viewBottom = (sc) => (sc ? sc.getBoundingClientRect().bottom : innerHeight);
function stopsOf(level) {
  const all = [...document.querySelectorAll(level === 1 ? '[data-stop="1"]' : "[data-stop]")];
  return all.filter((el) => el.getClientRects().length && !insideClosed(el));
}
/** The sections, or the items on a page that has no sections. */
const sections = () => { const s1 = stopsOf(1); return s1.length ? s1 : stopsOf(2); };
/** Which stop I'm in: the last one whose start is at or above the top of the view. */
function stopAt(list) {
  let at = -1;
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (el.getBoundingClientRect().top - viewTop(scrollerOf(el)) <= 60) at = i;
    else break;
  }
  return at;
}
function landOn(el) {
  el.scrollIntoView({ block: "start", behavior: smooth() });
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  el.classList.remove("landed");
  void el.offsetWidth;
  el.classList.add("landed");
  setTimeout(() => el.classList.remove("landed"), 1300);
}
/** One stop on (dir 1) or back (-1); back from the middle of a long one goes to its start. False on a page with none. */
function goStop(dir, level) {
  const list = level === 1 ? sections() : stopsOf(2).length ? stopsOf(2) : stopsOf(1);
  if (!list.length) return false;
  const at = stopAt(list);
  let i = at + dir;
  if (dir < 0 && at >= 0 && list[at].getBoundingClientRect().top - viewTop(scrollerOf(list[at])) < -4) i = at;
  if (i < 0) scrollTo({ top: 0, behavior: smooth() });
  else if (i >= list.length) flash(level === 1 ? "That was the last section" : "That was the last one");
  else landOn(list[i]);
  return true;
}

// Following: open at the latest; after a live update, stay there if I was there.
const followEl = () => document.querySelector("[data-follow]");
function atLatest(f) {
  return f.getBoundingClientRect().bottom <= viewBottom(scrollerOf(f)) + 160;
}
/** Brings the end of the list into view; opening, not past the start of the latest stop (so a long reply reads from its top). */
function toLatest(f, o) {
  const sc = scrollerOf(f);
  const stops = [...f.querySelectorAll("[data-stop]")];
  const last = stops[stops.length - 1];
  let dy = f.getBoundingClientRect().bottom - viewBottom(sc) + 16;
  if (o.opening && last) dy = Math.min(dy, last.getBoundingClientRect().top - viewTop(sc) - 12);
  if (dy > 0) (sc || window).scrollBy({ top: dy, behavior: o.smooth ? smooth() : "auto" });
}
function toEnd() {
  const f = followEl();
  if (f) toLatest(f, { smooth: true });
  else scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth() });
  railNew(false);
}
function followState() {
  const f = followEl();
  return f ? { at: atLatest(f), height: f.getBoundingClientRect().height } : null;
}
function followAfter(was) {
  const f = followEl();
  if (!f || !was) return railUpdate();
  if (was.at) toLatest(f, {});
  else if (f.getBoundingClientRect().height > was.height + 4) { railNew(true); pillShow(f, true); }
  railUpdate();
}

// The rail.
let rail = null;
let railAt = null;
let railEnd = null;
function railBuild() {
  rail?.remove();
  rail = null;
  if (framed || !document.querySelector("[data-stop]")) return;
  rail = document.createElement("nav");
  rail.className = "rail";
  rail.setAttribute("aria-label", "Move through this page");
  const button = (cls, text, title, act) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", act);
    rail.append(b);
    return b;
  };
  button("rail-b", "⤒", "To the top (g g)", () => scrollTo({ top: 0, behavior: smooth() }));
  button("rail-b", "↑", "Previous section ([)", () => goStop(-1, 1));
  railAt = button("rail-b rail-at", "", "Sections on this page (o)", showOutline);
  button("rail-b", "↓", "Next section (])", () => goStop(1, 1));
  railEnd = button("rail-b rail-end", "⤓", followEl() ? "To the latest (G)" : "To the bottom (G)", toEnd);
  document.body.append(rail);
  railUpdate();
}
function railUpdate() {
  if (!rail) return;
  rail.hidden = document.documentElement.scrollHeight < innerHeight * 1.5;
  const list = sections();
  const at = stopAt(list);
  railAt.textContent = (at < 0 ? "–" : at + 1) + "/" + list.length;
  const f = followEl();
  if (f && atLatest(f)) railNew(false);
}
function railNew(on) {
  if (!railEnd) return;
  railEnd.classList.toggle("new", on);
  railEnd.title = on ? "Something new below (G)" : followEl() ? "To the latest (G)" : "To the bottom (G)";
}
let railFrame = 0;
addEventListener("scroll", () => {
  if (railFrame) return;
  railFrame = requestAnimationFrame(() => { railFrame = 0; railUpdate(); });
}, { passive: true });
addEventListener("resize", () => railUpdate());

// The outline: the sections, the one I'm in marked; j / k or arrows move, Enter jumps.
function showOutline() {
  const list = sections();
  if (!list.length) return;
  const d = document.createElement("dialog");
  d.className = "outline";
  const box = document.createElement("div");
  box.className = "outline-box";
  const h = document.createElement("h2");
  h.textContent = document.querySelector('[data-stop="1"]') ? "Sections" : "On this page";
  const ol = document.createElement("ol");
  const at = stopAt(list);
  list.forEach((el, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = (el.dataset.stopLabel || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) || "…";
    if (i === at) b.setAttribute("aria-current", "true");
    b.addEventListener("click", () => { d.close(); landOn(el); });
    li.append(b);
    ol.append(li);
  });
  box.append(h, ol);
  d.append(box);
  d.addEventListener("close", () => d.remove());
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  d.addEventListener("keydown", (e) => {
    const all = [...ol.querySelectorAll("button")];
    const i = all.indexOf(document.activeElement);
    const by = e.key === "j" || e.key === "ArrowDown" ? 1 : e.key === "k" || e.key === "ArrowUp" ? -1 : 0;
    if (!by) return;
    e.preventDefault();
    all[Math.min(all.length - 1, Math.max(0, i + by))]?.focus();
  });
  document.body.append(d);
  d.showModal();
  const current = ol.querySelector("[aria-current]") || ol.querySelector("button");
  current?.focus();
  current?.scrollIntoView({ block: "nearest" });
}

// ── A chat (Bino's, form[data-chat]) and its small buttons (form[data-inplace]: Stop, Retry) post without
// leaving the page: what I wrote shows at once, dimmed, with Bino's dots, and the page the server answers
// with takes the place of this one (a new conversation's address too). The answer then fills in over
// the hub. If the post can't be made, the text comes back to the box. ──
async function postInPlace(e, form) {
  e.preventDefault();
  if (form.dataset.posting) return;
  const box = form.matches("[data-chat]") ? form.querySelector("textarea") : null;
  const text = box ? box.value : "";
  // A starter (a button with a name and value: a question, an item to break down) sends without the box.
  const by = e.submitter?.name ? e.submitter : null;
  if (box && !text.trim() && !by) return;
  const body = new URLSearchParams(new FormData(form));
  if (by) body.append(by.name, by.value);
  form.dataset.posting = "1";
  const b = e.submitter;
  if (b) { b.disabled = true; b.classList.add("busy"); }
  let shown = [];
  if (box) {
    box.value = "";
    grow(box);
    draftDrop();
    shown = chatPending(form, text.trim() ? text : by.textContent.replace(/\s+/g, " ").trim());
  }
  try {
    const res = await fetch(form.action, { method: "POST", body, credentials: "same-origin" });
    if (!(res.headers.get("content-type") || "").startsWith("text/html")) throw new Error(String(res.status));
    // Refused (the demo's read-only page, a conversation that's gone): what the server says, here.
    takePage(new DOMParser().parseFromString(await res.text(), "text/html"), res);
    const f = followEl();
    if (f) toLatest(f, {});
    if (box && !matchMedia("(pointer: coarse)").matches) document.querySelector("form[data-chat] textarea")?.focus({ preventScroll: true });
  } catch {
    for (const el of shown) el.remove();
    if (box && !box.value) { box.value = text; grow(box); }
    delete form.dataset.posting;
    if (b) { b.disabled = false; b.classList.remove("busy"); }
    flash(box ? "Couldn't send: your message is back in the box" : "That didn't go through: try again");
  }
}
/** The page the server answered with, in place of this one: as a moved page swaps (above). */
function takePage(next, res) {
  const to = new URL(res.url);
  if (res.redirected && to.origin === location.origin && to.pathname !== location.pathname) {
    history.replaceState(null, "", to.pathname + to.search);
    const d = framed && DOCKS.find((x) => location.pathname.startsWith(x.home));
    if (d && d.ok.test(location.pathname)) dockSave(d, { src: location.pathname });
  }
  const live = $("live-dot")?.classList.contains("on");
  document.body.replaceWith(document.importNode(next.body, true));
  if (live) $("live-dot")?.classList.add("on");
  enhance(document);
  bellState(false);
  dockRestore();
  railBuild();
  draftRestore();
  wanted = topicsOf(next);
  const t = next.querySelector("title");
  if (t) document.title = t.textContent;
}
/** What I just sent, dimmed at the end of the conversation (a new one: where it will be), and Bino's dots under it. */
function chatPending(form, text) {
  let list = followEl();
  if (!list) {
    list = document.createElement("ol");
    list.className = "bino-msgs";
    const area = document.querySelector(".dock-b");
    if (area) area.replaceChildren(list);
    else form.before(list);
  }
  for (const el of document.querySelectorAll(".bino-after, .bino-thinking")) el.remove();
  const li = document.createElement("li");
  li.className = "bino-msg you pending";
  const said = document.createElement("div");
  said.className = "bino-text";
  said.textContent = text;
  li.append(said);
  list.append(li);
  const dots = document.createElement("div");
  dots.className = "bino-thinking";
  const typingDots = document.createElement("span");
  typingDots.className = "typing";
  typingDots.setAttribute("aria-hidden", "true");
  typingDots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  const label = document.createElement("span");
  label.textContent = "Bino is thinking…";
  dots.append(typingDots, label);
  list.after(dots);
  dots.scrollIntoView({ block: "end" });
  return [li, dots];
}

// Copy on one of Bino's answers: its text as it reads.
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-copy-msg]");
  if (!b) return;
  const text = (b.closest(".bino-msg")?.querySelector(".bino-text")?.innerText || "").trim();
  try {
    await navigator.clipboard.writeText(text);
    b.textContent = "Copied";
  } catch {
    b.textContent = "Couldn't copy";
  }
  setTimeout(() => (b.textContent = "Copy"), 1500);
});
// The other recent chats (the pane's header) and a chat's menu on /bino: a click elsewhere closes them.
document.addEventListener("click", (e) => {
  for (const d of document.querySelectorAll("details.dock-recent[open], details.bino-ci-m[open]")) if (!d.contains(e.target)) d.open = false;
});

// A chat's box grows with what's in it (CSS field-sizing where the browser has it), and keeps what I
// was writing, by conversation, for as long as this window (closing the pane, moving between pages).
const growByHand = !(window.CSS && CSS.supports && CSS.supports("field-sizing", "content"));
function grow(box) {
  if (!growByHand || !box) return;
  box.style.height = "auto";
  box.style.height = Math.min(box.scrollHeight + 2, Math.round(innerHeight * 0.5)) + "px";
}
const draftKey = () => "u-draft:" + location.pathname;
const draftDrop = () => { try { sessionStorage.removeItem(draftKey()); } catch {} };
function draftRestore() {
  const box = document.querySelector("form[data-chat] textarea");
  if (!box || box.value) return;
  try {
    const kept = sessionStorage.getItem(draftKey());
    if (kept) { box.value = kept; grow(box); }
  } catch {}
}
document.addEventListener("input", (e) => {
  const box = e.target.closest?.("form[data-chat] textarea");
  if (!box) return;
  grow(box);
  try { box.value ? sessionStorage.setItem(draftKey(), box.value.slice(0, 8000)) : sessionStorage.removeItem(draftKey()); } catch {}
});

// Something new below while I'm reading further up, where there's no rail (the pane): a pill to the latest.
let pill = null;
function pillShow(f, on) {
  if (rail) return;
  if (on && !pill) {
    pill = document.createElement("button");
    pill.type = "button";
    pill.className = "new-pill";
    pill.textContent = "New messages ↓";
    pill.addEventListener("click", () => { toEnd(); pillShow(null, false); });
  }
  if (!pill) return;
  if (on) (scrollerOf(f) || f.parentElement).append(pill);
  pill.hidden = !on;
}
// The pane's place in a conversation, for when it opens again on it.
const scrollKey = () => "u-scroll:" + location.pathname;
let keptFrame = 0;
document.addEventListener("scroll", (e) => {
  if (keptFrame) return;
  keptFrame = requestAnimationFrame(() => {
    keptFrame = 0;
    const f = followEl();
    const end = f ? atLatest(f) : true;
    if (end && pill && !pill.hidden) pill.hidden = true;
    const sc = $("dock-scroll");
    if (framed && sc && e.target === sc) try { sessionStorage.setItem(scrollKey(), JSON.stringify({ top: Math.round(sc.scrollTop), end })); } catch {}
  });
}, { capture: true, passive: true });

// Opening: a conversation at its latest (unless the address points somewhere, or the pane was left
// further up it), then the rail, and what I was writing.
{
  const f = followEl();
  let kept = null;
  try { kept = framed ? JSON.parse(sessionStorage.getItem(scrollKey()) || "null") : null; } catch {}
  const sc = $("dock-scroll");
  if (kept && !kept.end && sc && Number.isFinite(kept.top)) sc.scrollTop = kept.top;
  else if (f && !location.hash) toLatest(f, { opening: true });
  railBuild();
  draftRestore();
}

// ── SQL completion in a query box (textarea[data-schema], a pack's: Data): tables and columns from the
// database's schema (names only) at the URL the box names, fetched once when the box is first focused. A
// strip under the box: Tab or Enter takes the marked one, Up and Down move the mark, Esc closes. ──
const SQL_WORDS = ["SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "INNER JOIN", "ON", "AND", "OR", "NOT", "NULL", "IS NULL", "IS NOT NULL", "LIKE", "IN", "BETWEEN", "AS", "GROUP BY", "ORDER BY", "HAVING", "DISTINCT", "TOP", "COUNT(*)", "DESC", "ASC", "UNION", "EXISTS", "CASE", "WHEN", "THEN", "ELSE", "END"];
const sqlSchemas = new Map();
function sqlSchema(url) {
  if (!sqlSchemas.has(url)) {
    sqlSchemas.set(url, fetch(url, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && Array.isArray(j.tables) ? j.tables : null))
      .catch(() => null));
  }
  return sqlSchemas.get(url);
}
/** A name as T-SQL wants it: bare when it can be, else in brackets. */
const sqlName = (s) => (/^[A-Za-z_][\w$#@]*$/.test(s) ? s : "[" + s.replace(/]/g, "]]") + "]");
const sqlBare = (s) => s.replace(/^\[|\]$/g, "").toLowerCase();
const SQL_NOT_ALIAS = /^(where|join|on|left|right|inner|outer|cross|full|group|order|with|union|having|as)$/i;
/** The tables a query names after FROM and JOIN: by alias, by table name, by schema.table. */
function sqlTablesIn(text, tables) {
  const out = new Map();
  for (const m of text.matchAll(/\b(?:from|join)\s+([\w$#@.\[\]]+)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi)) {
    const parts = m[1].split(".").map(sqlBare);
    const t = tables.find(([name]) => {
      const p = name.toLowerCase().split(".");
      return parts.length > 1 ? p[0] === parts[parts.length - 2] && p[1] === parts[parts.length - 1] : p[1] === parts[0];
    });
    if (!t) continue;
    out.set(t[0].toLowerCase(), t);
    out.set(t[0].toLowerCase().split(".")[1], t);
    if (m[2] && !SQL_NOT_ALIAS.test(m[2])) out.set(m[2].toLowerCase(), t);
  }
  return out;
}
/** What fits the word before the caret: after a dot, that table's columns (or that schema's tables); else columns, tables, words. */
function sqlSuggest(text, word, tables) {
  const named = sqlTablesIn(text, tables);
  const out = [];
  const add = (label, insert, hint) => {
    if (out.length < 8 && !out.some((x) => x.insert === insert)) out.push({ label, insert, hint });
  };
  const dot = word.lastIndexOf(".");
  if (dot >= 0) {
    const head = sqlBare(word.slice(0, dot).split(".").pop() || "");
    const tail = sqlBare(word.slice(dot + 1));
    const t = named.get(head);
    if (t) for (const [c, ty] of t[1]) if (c.toLowerCase().startsWith(tail)) add(c, sqlName(c), ty);
    for (const [name] of tables) {
      const [s, n] = name.split(".");
      if (s.toLowerCase() === head && n.toLowerCase().startsWith(tail)) add(name, sqlName(n), "table");
    }
    return { from: dot + 1, list: out };
  }
  const w = sqlBare(word);
  const full = (name) => name.split(".").map(sqlName).join(".");
  for (const t of new Set(named.values())) for (const [c, ty] of t[1]) if (c.toLowerCase().startsWith(w)) add(c, sqlName(c), ty);
  for (const [name] of tables) if (name.toLowerCase().split(".")[1].startsWith(w)) add(name, full(name), "table");
  for (const k of SQL_WORDS) if (k.toLowerCase().startsWith(w) && k.toLowerCase() !== w) add(k, k, "");
  for (const [name] of tables) if (name.toLowerCase().split(".")[1].includes(w)) add(name, full(name), "table");
  return { from: 0, list: out };
}
function sqlComplete(box) {
  if (box.dataset.sqlOn) return;
  box.dataset.sqlOn = "1";
  const strip = document.createElement("ul");
  strip.className = "sqlc";
  strip.hidden = true;
  strip.setAttribute("role", "listbox");
  strip.setAttribute("aria-label", "Suggestions");
  box.after(strip);
  let tables = null;
  let list = [];
  let mark = 0;
  let span = null;
  sqlSchema(box.dataset.schema).then((t) => (tables = t));
  const close = () => {
    strip.hidden = true;
    list = [];
  };
  const take = () => {
    const s = list[mark];
    if (s && span) box.setRangeText(s.insert, span[0], span[1], "end");
    close();
  };
  const draw = () => {
    strip.replaceChildren(...list.map((s, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === mark));
      if (i === mark) li.className = "on";
      li.textContent = s.label;
      if (s.hint) {
        const k = document.createElement("span");
        k.className = "k";
        k.textContent = s.hint;
        li.append(k);
      }
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        mark = i;
        take();
      });
      return li;
    }));
    strip.hidden = !list.length;
  };
  box.addEventListener("input", () => {
    const at = box.selectionStart;
    if (!tables || at !== box.selectionEnd) return close();
    const m = /[\w$#@.\[\]]*$/.exec(box.value.slice(0, at));
    const word = m ? m[0] : "";
    if (!word || (word.length < 2 && !word.includes("."))) return close();
    const r = sqlSuggest(box.value, word, tables);
    // Nothing to offer when the word already is the one suggestion.
    if (!r.list.length || (r.list.length === 1 && r.list[0].insert.toLowerCase() === word.slice(r.from).toLowerCase())) return close();
    list = r.list;
    mark = 0;
    span = [at - word.length + r.from, at];
    draw();
  });
  box.addEventListener("keydown", (e) => {
    if (strip.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      mark = (mark + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
      draw();
    } else if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      take();
    } else if (e.key === "Escape") {
      // The strip closes; the box keeps the focus.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  box.addEventListener("blur", () => setTimeout(close, 120));
}
document.addEventListener("focusin", (e) => {
  if (e.target.matches?.("textarea[data-schema]")) sqlComplete(e.target);
});

// ── The docks (src/html.ts): Bino's and the packs', each a panel at the bottom right holding its /…/dock pages
// in a frame. Whether one is open, and on which page, lasts as long as this window (sessionStorage),
// so it stays put while I move between pages. One is open at a time. ──
/** A pack's dock (data-dock on the page, src/html.ts): its pages are /<id>/dock…, a plain path. */
const packDock = (pack, title, letter) => {
  const home = "/" + pack + "/dock";
  return { id: "dock-" + pack, key: "u-dock-" + pack, title: title || pack, home, topic: pack, letter: /^[A-Z]$/.test(letter || "") ? letter : undefined, ok: { test: (src) => (src === home || src.startsWith(home + "/") || src.startsWith(home + "#")) && /^\/[\w\-./:@%]*(#[\w-]+)?$/.test(src) && !src.includes("..") && !src.includes("//") } };
};
const DOCKS = [
  { id: "bdock", key: "u-bdock", title: "Bino", home: "/bino/dock", ok: /^\/bino\/dock(\/c\/[0-9a-f-]{36})?$/ },
  ...[...document.querySelectorAll("[data-dock]")].map((el) => packDock(el.id.replace(/^dock-/, ""), el.dataset.dockTitle, el.dataset.dockKey)),
];
/** B for Bino's; a pack's dock its own letter (the server keeps it to one dock, and off the page's own keys). */
const DOCK_KEYS = { B: "bdock", ...Object.fromEntries(DOCKS.filter((d) => d.letter && d.letter !== "B").map((d) => [d.letter, d.id])) };
const dockOf = (id) => DOCKS.find((d) => d.id === id);
function dockState(d) {
  try { return JSON.parse(sessionStorage.getItem(d.key) || "{}"); } catch { return {}; }
}
function dockSave(d, change) {
  try { sessionStorage.setItem(d.key, JSON.stringify({ ...dockState(d), ...change })); } catch {}
}
const dockFrame = (d) => $(d.id + "-panel")?.querySelector("iframe");
const dockIsOpen = (d) => !framed && !!$(d.id + "-panel") && !$(d.id + "-panel").hidden;
const openDock = () => DOCKS.find(dockIsOpen);
/** Into a dock: its writing box when it has one, else the frame. */
function dockFocus(frame) {
  if (!frame) return;
  // On a touch screen opening the pane doesn't pop the keyboard up (and pan the page): a tap in the box does.
  if (matchMedia("(pointer: coarse)").matches) return;
  frame.focus();
  try { frame.contentDocument?.querySelector("textarea")?.focus(); } catch {}
}
function dockOpen(d, open, focus) {
  if (framed) {
    if (!open) parent.postMessage({ dock: "close" }, location.origin);
    return;
  }
  const panel = d && $(d.id + "-panel");
  const button = d && $(d.id + "-btn");
  if (!panel || !button) return;
  if (open) for (const o of DOCKS) if (o !== d && dockIsOpen(o)) dockOpen(o, false, false);
  let frame = dockFrame(d);
  if (open && !frame) {
    frame = document.createElement("iframe");
    frame.title = d.title;
    const src = dockState(d).src || "";
    frame.src = d.ok.test(src) ? src : d.home;
    if (focus) frame.addEventListener("load", () => dockFocus(frame), { once: true });
    panel.append(frame);
  } else if (open && panel.hidden && frame) {
    // It missed what changed while it was closed.
    try { frame.contentWindow.dispatchEvent(new CustomEvent("u-change", { detail: ["snapshot", "bino", ...(d.topic ? [d.topic] : [])] })); } catch {}
  }
  panel.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  $(d.id)?.classList.toggle("open", open);
  dockSave(d, { open });
  if (focus) open ? dockFocus(frame) : button.focus();
}
function dockRestore() {
  if (!framed) for (const d of DOCKS) if (dockState(d).open) dockOpen(d, true, false);
}
/** A change the server announced: a dock's page swaps its live regions the way any page does. */
function dockChange(topics) {
  for (const d of DOCKS) {
    const frame = dockFrame(d);
    if (!frame || !dockIsOpen(d)) continue;
    try { frame.contentWindow.dispatchEvent(new CustomEvent("u-change", { detail: topics })); } catch {}
  }
}
/** B, or a pack dock's letter: that dock opened, or focused when it's open; from inside a dock, its page asks the one around it to close it. */
function dockKey(k) {
  if (framed) return parent.postMessage({ dock: "key", key: k }, location.origin);
  const d = dockOf(DOCK_KEYS[k]);
  if (!d) return;
  // Open but I'm on the page: into it. From inside it the key closes it (the message handler below).
  if (dockIsOpen(d)) return dockFocus(dockFrame(d));
  dockOpen(d, true, true);
}
if (framed) {
  const own = /^\/([a-z][a-z0-9-]*)\/dock(\/|$)/.exec(location.pathname);
  const mine = DOCKS.find((d) => location.pathname.startsWith(d.home)) || (own && own[1] !== "bino" ? packDock(own[1]) : undefined);
  if (mine) dockSave(mine, { src: location.pathname + (mine.topic ? location.hash : "") });
  addEventListener("u-change", (e) => {
    lastEvent = Date.now();
    const topics = Array.isArray(e.detail) ? e.detail : [];
    if (topics.some((t) => wanted.includes(t))) later(150);
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest?.("[data-dock-close]")) return dockOpen(mine, false, true);
    // Out to a full page: the dock closes behind it.
    if (mine && e.target.closest?.('a[target="_top"]')) dockSave(mine, { open: false });
  });
  // What I ask Bino from its pane goes with the page I'm on; the server turns it into names and
  // states (src/packs/core/assistant/bino/view.ts), a private page only by its name.
  document.addEventListener("submit", (e) => {
    const v = e.target.querySelector?.("input[data-view]");
    if (v) try { v.value = parent.location.pathname + parent.location.search; } catch {}
  }, true);
} else {
  // Before the "going somewhere" bar sees the click: the button opens the panel, it goes nowhere.
  document.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const d = DOCKS.find((x) => e.target.closest?.("#" + x.id + "-btn"));
    if (!d) return;
    e.preventDefault();
    dockOpen(d, !dockIsOpen(d), true);
  }, true);
  addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    const from = DOCKS.find((x) => e.source === dockFrame(x)?.contentWindow);
    if (!from) return;
    if (e.data?.dock === "close") dockOpen(from, false, true);
    // Its own key from inside a dock closes it; another dock's opens that one.
    else if (e.data?.dock === "key" && DOCK_KEYS[e.data.key]) DOCK_KEYS[e.data.key] === from.id ? dockOpen(from, false, true) : dockKey(e.data.key);
  });
  dockRestore();
}

`;

export const SCRIPT_PATH = `/assets/app.${hashOf(SCRIPT)}.js`;
