/**
 * What keeps a pack's markup and styles inside the pack. Packs are code the owner chose to
 * run, so this guards against mistakes, not malice: a pack's slip should break only that pack.
 *
 * - `checkHtml`: a fragment that closes what it didn't open (`</main>`), leaves a container open,
 *   or carries a tag that belongs to the page (`<base>`, `<body>`) would reshape the shell around it.
 *   A `<style>` would reach past the pack (its `styles` are scoped instead).
 * - `guardHtml`: a pack's fragment, checked, or a short note in its place; an async fragment that
 *   fails becomes the note too, instead of failing the whole page.
 * - `boxed`: the fragment in `.pack-box` (src/ui/style.ts), which clips its own width, so nothing in
 *   it can push the page wider than the screen.
 * - `scopeCss`: a pack's stylesheet keeps only rules that style the pack's own markup. A selector
 *   passes when it names a class of the pack's own (one core's stylesheet doesn't use) on the element
 *   it styles or on an ancestor of it. `body`, `:root`, `.panel` or `.foo ~ .item` restyle core, and go.
 */
import { html } from "hono/html";
import type { Html } from "../ui/kit.ts";

/** Tags with no end tag. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param"]);
/** Tags a browser closes by itself when their parent closes (so a pack may leave them open). */
const SELF_CLOSING = new Set(["p", "li", "dt", "dd", "option", "optgroup", "tr", "td", "th", "thead", "tbody", "tfoot", "colgroup", "rp", "rt"]);
/** Tags whose content isn't markup. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
/** Tags that belong to the page, never to a fragment of it. */
const PAGE_ONLY = new Set(["html", "head", "body", "base"]);
const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/** Why a fragment would reshape the page around it, or undefined when it's well-formed. */
export function checkHtml(s: string): string | undefined {
  const open: string[] = [];
  TAG.lastIndex = 0;
  for (let m = TAG.exec(s); m; m = TAG.exec(s)) {
    if (!m[2]) continue;
    const name = m[2].toLowerCase();
    if (PAGE_ONLY.has(name)) return `<${name}> belongs to the page`;
    // Its rules would reach the whole page: a pack's styles go in its `styles`, which are scoped.
    if (name === "style") return "<style> isn't scoped: use the pack's styles";
    if (m[1]) {
      if (VOID.has(name)) continue;
      // Close what the browser would close on its own, up to the match.
      while (open.length && open[open.length - 1] !== name && SELF_CLOSING.has(open[open.length - 1]!)) open.pop();
      if (open[open.length - 1] !== name) return `</${name}> closes what it didn't open`;
      open.pop();
      continue;
    }
    if (VOID.has(name) || /\/\s*$/.test(m[3] ?? "")) continue;
    if (RAW_TEXT.has(name)) {
      const end = s.toLowerCase().indexOf(`</${name}`, TAG.lastIndex);
      if (end < 0) return `<${name}> isn't closed`;
      TAG.lastIndex = end;
    }
    open.push(name);
  }
  const left = open.filter((t) => !SELF_CLOSING.has(t));
  return left.length ? `<${left[left.length - 1]}> isn't closed` : undefined;
}

type Log = (line: string) => void;
export const isHtml = (v: unknown): v is Html => v instanceof Promise || (v instanceof String && (v as { isEscaped?: boolean }).isEscaped === true);
const broke = (name: string) => html`<p class="pack-broke t3">${name} couldn't draw this part.</p>`;

/**
 * A pack's fragment as it may go on a page: checked, or a note in its place (logged). Plain strings
 * pass as they are: they're escaped where they're drawn.
 */
export function guardHtml<T>(v: T, name: string, where: string, log: Log): T | Html {
  if (!isHtml(v)) return v;
  const check = (s: { toString(): string }) => {
    const why = checkHtml(s.toString());
    if (!why) return s;
    log(`${where}: markup refused: ${why}`);
    return broke(name);
  };
  if (v instanceof Promise)
    return v.then(check, (e: unknown) => {
      log(`${where}: ${(e as Error)?.message ?? e}`);
      return broke(name);
    }) as Html;
  return check(v) as Html;
}

/** A pack's block-level fragment in its own box: checked, its width clipped to the box. */
export function boxed(v: Html | string, id: string, name: string, where: string, log: Log): Html {
  return html`<div class="pack-box" data-pack="${id}">${guardHtml(v, name, where, log)}</div>`;
}

/** Every class core's stylesheet uses: a pack styling only these restyles core. */
export function classesOf(css: string): Set<string> {
  return new Set([...stripComments(css).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!));
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The classes that make a selector's subject the pack's: those on the subject and on its ancestors,
 * each compound read outside :is(), :not(), :has() and attribute values. A sibling's classes don't
 * count (`.av ~ .panel` styles core's panel), but the ancestors of a sibling are the subject's too
 * (`.skribb * + .buttons` stays inside `.skribb`).
 */
function ownerClasses(sel: string): string[] {
  let s = sel;
  for (let i = 0; i < 4 && /\([^()]*\)/.test(s); i++) s = s.replace(/\([^()]*\)/g, "");
  s = s.replace(/\[[^\]]*\]/g, "[]");
  const parts = s.trim().split(/\s*([>+~])\s*|\s+/).filter((p) => p !== undefined && p !== "");
  const out: string[] = [];
  let counts = true;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (p === "+" || p === "~") counts = false;
    else if (p === ">") counts = true;
    else {
      if (counts) out.push(...[...p.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!));
      // Two compounds side by side were joined by a descendant combinator: the next one left is an ancestor.
      counts = true;
    }
  }
  return out;
}

/** Whether a selector only styles markup that carries a class of the pack's own. */
export function ownsSelector(sel: string, core: Set<string>): boolean {
  return ownerClasses(sel).some((c) => !core.has(c));
}

/** At-rules whose blocks hold rules (checked inside); others' blocks are kept whole (@font-face, @keyframes). */
const NESTING = /^@(media|supports|container|layer|scope|starting-style|document)\b/i;

/**
 * A pack's stylesheet with only the rules that style its own markup. Each selector that would
 * restyle core is dropped (the rest of its rule stays), and each drop is named in `dropped`.
 * `@import` goes too: a pack's styles are its own file.
 */
export function scopeCss(css: string, core: Set<string>): { css: string; dropped: string[] } {
  const src = stripComments(css);
  const dropped: string[] = [];
  let i = 0;
  const block = (): string => {
    let out = "";
    while (i < src.length) {
      const close = src.indexOf("}", i);
      const open = src.indexOf("{", i);
      const semi = src.indexOf(";", i);
      if (close >= 0 && (open < 0 || close < open)) {
        // The end of this block (any statement before it without a body is dropped as junk).
        i = close + 1;
        return out;
      }
      if (open < 0) {
        i = src.length;
        return out;
      }
      // A statement at-rule (@import, @charset, @layer a, b;) before the next block.
      if (semi >= 0 && semi < open && /^\s*@/.test(src.slice(i, semi))) {
        const stmt = src.slice(i, semi).trim();
        if (/^@import\b/i.test(stmt)) dropped.push(stmt.slice(0, 80));
        else if (!/^@charset\b/i.test(stmt)) out += `${stmt};\n`;
        i = semi + 1;
        continue;
      }
      const head = src.slice(i, open).trim();
      i = open + 1;
      if (head.startsWith("@")) {
        if (NESTING.test(head)) {
          const inner = block();
          if (inner.trim()) out += `${head} {\n${inner}}\n`;
        } else out += `${head} {${rawBlock()}}\n`;
        continue;
      }
      const body = rawBlock();
      const keep = head.split(",").map((x) => x.trim()).filter((sel) => {
        if (ownsSelector(sel, core)) return true;
        dropped.push(sel.slice(0, 80));
        return false;
      });
      if (keep.length) out += `${keep.join(", ")} {${body}}\n`;
    }
    return out;
  };
  /** A block kept as written, nested braces and all (the opening brace already read). */
  const rawBlock = (): string => {
    let depth = 1;
    const from = i;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"' || ch === "'") {
        const end = src.indexOf(ch, i + 1);
        i = end < 0 ? src.length : end;
      } else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return src.slice(from, i++);
    }
    return src.slice(from);
  };
  let out = "";
  // A stray "}" ends a block early: go on after it.
  while (i < src.length) out += block();
  return { css: out, dropped };
}

/** A pack's script, so a throw in it stops only it. */
export function scriptOf(id: string, js: string, files: Record<string, string> = {}): string {
  return `// ${id}\ntry {\nconst dovreFiles = Object.freeze(${JSON.stringify(files)});\n${js}\n} catch (e) { console.error("pack ${id}:", e); }\n`;
}
