/**
 * The terminal page's script (served as /terminal/term.<hash>.js under CSP script-src 'self'),
 * with xterm.js from node_modules (/terminal/xterm-<version>/…): both under /terminal, as a
 * pack's routes must be. Keys go to the server in small batches (POST …/input), output comes
 * back over Server-Sent Events (GET …/stream), sizes follow the window. Ctrl+C copies when there's a selection (else it's ^C); Ctrl+V and Ctrl+Shift+V paste.
 * Plain JS in a String.raw template: no backticks or dollar-brace in it.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hashOf } from "../../../ui/style.ts";

let version: string | undefined;
/** Read on first use, not at import: the hosted Worker loads this module but has no node_modules. */
const xtermVersion = (): string =>
  (version ??= JSON.parse(readFileSync(createRequire(import.meta.url).resolve("@xterm/xterm/package.json"), "utf8")).version);
/** xterm.js and its fit addon, served from node_modules under a versioned path. */
export const XTERM = {
  get js() { return `/terminal/xterm-${xtermVersion()}/xterm.js`; },
  get fit() { return `/terminal/xterm-${xtermVersion()}/addon-fit.js`; },
  get css() { return `/terminal/xterm-${xtermVersion()}/xterm.css`; },
};

export const TERMINAL_JS = String.raw`
const box = document.getElementById("term");
const id = box.dataset.id;
const state = document.getElementById("term-state");
const css = getComputedStyle(document.documentElement);
const v = (n, d) => css.getPropertyValue(n).trim() || d;
const term = new Terminal({
  fontFamily: '"Nordwand Mono", "Cascadia Mono", Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.15,
  cursorBlink: true,
  scrollback: 5000,
  theme: { background: v("--term-bg", "#0e1922"), foreground: v("--term-ink", "#e6ecf0"), cursor: v("--accent", "#84b9df"), selectionBackground: v("--term-sel", "#2d4a60") },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(box);
try { fit.fit(); } catch {}
term.focus();

const post = (what, body) => fetch("/terminal/" + id + "/" + what, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" }).catch(() => null);
let pending = "";
let timer = 0;
function flush() {
  timer = 0;
  if (!pending) return;
  const data = pending;
  pending = "";
  post("input", { data });
}
term.onData((d) => { pending += d; if (!timer) timer = setTimeout(flush, 8); });

let sized = 0;
const sendSize = () => post("resize", { cols: term.cols, rows: term.rows });
term.onResize(() => { clearTimeout(sized); sized = setTimeout(sendSize, 120); });
new ResizeObserver(() => { try { fit.fit(); } catch {} }).observe(box);

term.attachCustomKeyEventHandler((e) => {
  if (e.type !== "keydown") return true;
  if (e.ctrlKey && (e.key === "c" || e.key === "C") && term.hasSelection()) {
    navigator.clipboard.writeText(term.getSelection()).catch(() => {});
    term.clearSelection();
    return false;
  }
  if (e.ctrlKey && (e.key === "v" || e.key === "V")) {
    navigator.clipboard.readText().then((t) => { if (t) term.paste(t); }).catch(() => {});
    e.preventDefault();
    return false;
  }
  return true;
});

const es = new EventSource("/terminal/" + id + "/stream");
es.addEventListener("out", (e) => { try { term.write(JSON.parse(e.data)); } catch {} });
es.addEventListener("exit", (e) => {
  let x = {};
  try { x = JSON.parse(e.data); } catch {}
  term.write("\r\n\x1b[2m[ended" + (typeof x.code === "number" ? ", exit code " + x.code : "") + "]\x1b[0m\r\n");
  if (state) state.textContent = "Ended" + (x.reason ? ": " + x.reason : "");
  es.close();
});
es.addEventListener("open", () => sendSize());
`;

export const TERMINAL_JS_PATH = `/terminal/term.${hashOf(TERMINAL_JS)}.js`;
