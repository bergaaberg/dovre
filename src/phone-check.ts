/**
 * `pnpm phone <base> [paths…]`: opens Dovre's pages at a phone's width in headless Chromium and
 * says what doesn't fit. Two findings:
 *  - wide: the page is wider than the screen (it scrolls sideways), and the outermost elements
 *    that stick out;
 *  - clipped: something a pack drew runs past its `.pack-box`, so the box cuts it off.
 * No paths: every page in the sidebar. Exits 1 when anything doesn't fit.
 *
 * Signed in with `--cookie name=value` (or DOVRE_COOKIE): locally `u_tk=<launch token>`; hosted,
 * the `CF_Authorization` cookie of a browser signed in through Access. Chromium: CHROME, else
 * Playwright's headless shell in ~/Library/Caches/ms-playwright. Only GETs pages; acts on nothing.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

type Stray = { what: string; pack?: string; right: number; width: number };
export type Fit = { path: string; status: number; viewport: number; page: number; wide: Stray[]; clipped: Stray[] };

/** The sidebar's own pages, from a page's HTML: same-site paths, no queries. */
export function pagesOf(page: string): string[] {
  const side = /<nav class="side"[\s\S]*?<\/nav>/.exec(page)?.[0] ?? "";
  const out = new Set<string>();
  for (const m of side.matchAll(/href="(\/[^"?#]*)"/g)) {
    const p = m[1]!;
    if (!p.startsWith("//") && !/^\/(assets|logout|events)\b/.test(p)) out.add(p);
  }
  return [...out];
}

/**
 * Runs in the page: what sticks out past the screen (outermost only, and not inside something
 * that scrolls or clips sideways), and what runs past its pack's box by more than the box's 16px.
 */
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + [...el.classList].slice(0, 3).map((c) => "." + c).join("");
  const pathOf = (el) => { const out = []; for (let e = el; e && e !== document.body && out.length < 4; e = e.parentElement) out.unshift(name(e)); return out.join(" > "); };
  const clips = (el) => { const o = getComputedStyle(el).overflowX; return o !== "visible"; };
  const out = (el, edge) => el.getBoundingClientRect().right > edge + 1;
  const wide = [], clipped = [];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    const box = el.parentElement && el.parentElement.closest(".pack-box");
    if (!box && getComputedStyle(el).position === "fixed") continue;
    if (box) {
      const edge = box.getBoundingClientRect().right + 16;
      if (out(el, edge) && !(el.parentElement !== box && out(el.parentElement, edge))) {
        let inner = false; for (let e = el.parentElement; e && e !== box; e = e.parentElement) if (clips(e)) { inner = true; break; }
        if (!inner) clipped.push({ what: pathOf(el), pack: box.dataset.pack, right: Math.round(r.right), width: Math.round(r.width) });
      }
      continue;
    }
    if (out(el, vw) && !(el.parentElement && el.parentElement !== document.body && out(el.parentElement, vw))) {
      let inner = false; for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (clips(e)) { inner = true; break; }
      if (!inner) wide.push({ what: pathOf(el), pack: el.closest("[data-pack]")?.dataset.pack, right: Math.round(r.right), width: Math.round(r.width) });
    }
  }
  return { viewport: vw, page: document.documentElement.scrollWidth, wide: wide.slice(0, 8), clipped: clipped.slice(0, 8) };
})()`;

/** Chromium to drive: CHROME, else Playwright's headless shell (newest). */
export function chromium(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.CHROME) return existsSync(env.CHROME) ? env.CHROME : undefined;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
    for (const sub of readdirSync(join(cache, dir))) {
      const bin = join(cache, dir, sub, "chrome-headless-shell");
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

type Cdp = { send(method: string, params?: object): Promise<any>; once(method: string): Promise<any>; close(): void };

async function connect(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  await new Promise((ok, no) => ((ws.onopen = ok), (ws.onerror = () => no(new Error("couldn't reach Chromium")))));
  let id = 0;
  const calls = new Map<number, (m: any) => void>();
  const waits = new Map<string, ((p: any) => void)[]>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id) calls.get(m.id)?.(m), calls.delete(m.id);
    else for (const w of waits.get(m.method)?.splice(0) ?? []) w(m.params);
  };
  return {
    send: (method, params = {}) =>
      new Promise((ok, no) => {
        calls.set(++id, (m) => (m.error ? no(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
        ws.send(JSON.stringify({ id, method, params }));
      }),
    once: (method) => new Promise((ok) => waits.set(method, [...(waits.get(method) ?? []), ok])),
    close: () => ws.close(),
  };
}

/** Opens Chromium, checks each path at `width`, closes it. */
export async function checkPages(o: { base: string; paths: string[]; cookies: string[]; width?: number; bin: string; settleMs?: number }): Promise<Fit[]> {
  const dir = mkdtempSync(join(tmpdir(), "dovre-phone-"));
  const proc = spawn(o.bin, ["--headless", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  try {
    let port = "";
    for (let i = 0; i < 100 && !port; i++) {
      try { port = readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]!; } catch { await sleep(100); }
    }
    if (!port) throw new Error("Chromium didn't start");
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const cdp = await connect(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
    const width = o.width ?? 390;
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: true });
    for (const c of o.cookies) {
      const at = c.indexOf("=");
      if (at > 0) await cdp.send("Network.setCookie", { name: c.slice(0, at).trim(), value: c.slice(at + 1).trim(), url: o.base });
    }
    const fits: Fit[] = [];
    for (const path of o.paths) {
      let status = 0;
      const seen = (p: any) => { if (p.type === "Document") status = p.response.status; };
      const off = cdp.once("Network.responseReceived").then(seen);
      const loaded = cdp.once("Page.loadEventFired");
      await cdp.send("Page.navigate", { url: new URL(path, o.base).href });
      await Promise.race([loaded, sleep(15_000)]);
      await Promise.race([off, sleep(10)]);
      await sleep(o.settleMs ?? 800);
      const r = await cdp.send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
      const m = r.result.value as Omit<Fit, "path" | "status">;
      fits.push({ path, status, ...m });
    }
    cdp.close();
    return fits;
  } finally {
    proc.kill();
    await sleep(200);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A line or a few per page; `ok` when everything fits. */
export function report(fits: Fit[]): { text: string; ok: boolean } {
  const lines: string[] = [];
  let ok = true;
  for (const f of fits) {
    if (f.status >= 400) { lines.push(`${f.path}: ${f.status}`); continue; }
    const wide = f.page > f.viewport + 1;
    if (!wide && !f.clipped.length) { lines.push(`${f.path}: fits`); continue; }
    ok = false;
    if (wide) lines.push(`${f.path}: ${f.page}px wide on a ${f.viewport}px screen`, ...f.wide.map((s) => `  sticks out: ${s.what}${s.pack ? ` [${s.pack}]` : ""} (${s.width}px, to ${s.right}px)`));
    if (f.clipped.length) lines.push(...(wide ? [] : [`${f.path}: fits, but cut off in a pack's box`]), ...f.clipped.map((s) => `  cut off: ${s.what} [${s.pack ?? "?"}] (${s.width}px, to ${s.right}px)`));
  }
  return { text: lines.join("\n"), ok };
}

async function main(argv: string[]) {
  const args = [...argv];
  const take = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args.splice(i, 2)[1]; };
  const cookies = [take("--cookie") ?? process.env.DOVRE_COOKIE ?? ""].filter(Boolean);
  const width = Number(take("--width") ?? 390);
  const base = args.shift();
  if (!base || !/^https?:\/\//.test(base)) {
    console.error("usage: pnpm phone <base url> [--cookie name=value] [--width 390] [paths…]");
    process.exit(2);
  }
  const bin = chromium();
  if (!bin) {
    console.error("No Chromium: set CHROME, or `npx playwright install chromium-headless-shell`.");
    process.exit(2);
  }
  let paths = args;
  if (!paths.length) {
    const res = await fetch(new URL("/", base), { headers: { cookie: cookies.join("; ") }, redirect: "manual" });
    paths = pagesOf(await res.text());
    if (!paths.length) {
      console.error(`No pages in the sidebar at ${base} (${res.status}): is the cookie right?`);
      process.exit(2);
    }
  }
  const r = report(await checkPages({ base, paths, cookies, width, bin }));
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
}

if (import.meta.main) await main(process.argv.slice(2));
