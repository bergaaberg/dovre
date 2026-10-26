/**
 * Pack ingest (dovre#109): apps POST data into a pack's /<id>/ingest/<path> (an OTLP sink), with a
 * token made on Settings instead of Dovre's cookie or Cloudflare Access. Core checks the token, the
 * size and the rate before the pack sees anything; the pack gets the body and the source's name,
 * never the token or the request's other headers. Write-only: nothing here reads data back.
 */
import type { Hono } from "hono";
import type { D1 } from "../db.ts";
import { html, type Html, Confirm, List, Item, Notice } from "../ui/kit.ts";
import type { IngestInput, Pack, PackContext } from "./types.ts";

/** Default body cap, when the pack names none. */
export const INGEST_MAX_BYTES = 4 * 1024 * 1024;
/** Requests per token per minute, when the pack names none. Per process (hosted: per isolate). */
export const INGEST_PER_MINUTE = 600;

export type IngestToken = { id: number; source: string; created_at: string; last_used_at: string | null; revoked_at: string | null };

const PREFIX = "dvi_";

async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

function freshToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return PREFIX + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A source's name: what the token is for (an app, a service), shown on Settings and handed to the pack. */
export function sourceOk(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(s);
}

/** Makes a token for this pack and source; the token itself is returned once and never kept. */
export async function createToken(db: D1, pack: string, source: string, now = new Date()): Promise<string> {
  if (!sourceOk(source)) throw new Error("A source is 1–64 letters, digits, spaces, dots, dashes or underscores.");
  const token = freshToken();
  await db.prepare("INSERT INTO ingest_tokens (pack, source, hash, created_at) VALUES (?, ?, ?, ?)").bind(pack, source, await sha256(token), now.toISOString()).run();
  return token;
}

export async function listTokens(db: D1, pack: string): Promise<IngestToken[]> {
  const { results } = await db.prepare("SELECT id, source, created_at, last_used_at, revoked_at FROM ingest_tokens WHERE pack = ? ORDER BY id").bind(pack).all<IngestToken>();
  return results;
}

/** Revokes one of this pack's tokens; true when one was live. */
export async function revokeToken(db: D1, pack: string, id: number, now = new Date()): Promise<boolean> {
  const r = await db.prepare("UPDATE ingest_tokens SET revoked_at = ? WHERE id = ? AND pack = ? AND revoked_at IS NULL").bind(now.toISOString(), id, pack).run();
  return r.meta.changes > 0;
}

/** The live token's row for this pack, or undefined. Marks it used (at most once a minute). */
export async function checkToken(db: D1, pack: string, token: string | undefined, now = new Date()): Promise<{ id: number; source: string; hash: string } | undefined> {
  if (!token || !token.startsWith(PREFIX) || token.length > 128) return undefined;
  const hash = await sha256(token);
  const row = await db.prepare("SELECT id, source, last_used_at FROM ingest_tokens WHERE hash = ? AND pack = ? AND revoked_at IS NULL").bind(hash, pack).first<{ id: number; source: string; last_used_at: string | null }>();
  if (!row) return undefined;
  if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) > 60_000)
    await db.prepare("UPDATE ingest_tokens SET last_used_at = ? WHERE id = ?").bind(now.toISOString(), row.id).run();
  return { id: row.id, source: row.source, hash };
}

/** A fixed-window counter per token: true while under the limit. */
export function rateLimiter(now: () => number = Date.now) {
  const seen = new Map<string, { start: number; n: number }>();
  return (key: string, perMinute: number): boolean => {
    const t = now();
    const w = seen.get(key);
    if (!w || t - w.start >= 60_000) {
      if (seen.size > 10_000) seen.clear();
      seen.set(key, { start: t, n: 1 });
      return true;
    }
    w.n++;
    return w.n <= perMinute;
  };
}

/** Reads the body up to `max` bytes; undefined when it's bigger. */
async function bodyCapped(req: Request, max: number): Promise<Uint8Array | undefined> {
  const said = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(said) && said > max) return undefined;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.byteLength));
  return out;
}

const plain = (status: number, text: string, extra: Record<string, string> = {}) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra } });

/**
 * Mounts POST /<id>/ingest/* for each pack with `ingest`, before the sign-in check. Local: on this
 * machine's own address only. Hosted: Access must let the path through (a bypass policy); the token
 * is the only check here. A pack that's hidden, or not shown, answers 404.
 */
export function mountIngest(app: Hono<any>, opts: { packs: Pack[]; shown: () => Pack[]; ctxOf: (p: Pack) => PackContext; db: () => D1 | undefined; hosted: boolean; isLocal: (req: Request) => boolean; log: (id: string, line: string) => void; limit?: (key: string, perMinute: number) => boolean }) {
  const limit = opts.limit ?? rateLimiter();
  for (const p of opts.packs) {
    if (!p.ingest) continue;
    const id = p.manifest.id;
    const spec = p.ingest;
    app.post(`/${id}/ingest/*`, async (c) => {
      const req = c.req.raw;
      if ((!opts.hosted && !opts.isLocal(req)) || !opts.shown().includes(p)) return c.notFound();
      const db = opts.db();
      if (!db) return c.notFound();
      const auth = req.headers.get("authorization") ?? "";
      const m = /^Bearer\s+(\S+)$/i.exec(auth);
      const tok = await checkToken(db, id, m?.[1]).catch(() => undefined);
      if (!tok) return plain(401, "A live ingest token for this pack, as Authorization: Bearer <token>.", { "www-authenticate": "Bearer" });
      if (!limit(tok.hash, spec.perMinute ?? INGEST_PER_MINUTE)) return plain(429, "Too many requests for this token.", { "retry-after": "60" });
      const body = await bodyCapped(req, spec.maxBytes ?? INGEST_MAX_BYTES);
      if (!body) return plain(413, "Too large.");
      const path = new URL(req.url).pathname.slice(`/${id}/ingest/`.length);
      const input: IngestInput = { path, body, contentType: req.headers.get("content-type") ?? "", contentEncoding: req.headers.get("content-encoding") ?? "", source: tok.source };
      try {
        const out = await spec.handle(input, opts.ctxOf(p));
        return new Response((out.body ?? null) as BodyInit | null, { status: out.status, headers: { "content-type": out.contentType ?? "text/plain; charset=utf-8", "cache-control": "no-store" } });
      } catch (e) {
        opts.log(id, `ingest: ${(e as Error)?.message ?? e}`);
        return plain(500, "Not taken in.");
      }
    });
  }
}

/** Settings: the tokens for a pack's ingest, make one, revoke one. */
export function tokensPanel(p: Pack, rows: IngestToken[], o: { hosted: boolean; made?: { source: string; token: string } }): Html {
  const id = p.manifest.id;
  const live = rows.filter((r) => !r.revoked_at);
  return html`<div class="ingest" id="ingest-${id}">
<h3>Ingest tokens</h3>
<p class="notes">Apps send data in with <code>POST /${id}/ingest/…</code> and <code>Authorization: Bearer &lt;token&gt;</code>. A token can only send, never read.${o.hosted ? html` Hosted, Cloudflare Access must let <code>/${id}/ingest/</code> through: add a Bypass policy for that path.` : ""}</p>
${o.made ? Notice({ tone: "accent", children: html`Token for <strong>${o.made.source}</strong>, shown this once: <code class="secret">${o.made.token}</code>` }) : ""}
${live.length
  ? List(live.map((r) => Item({ title: r.source, line: html`made ${r.created_at.slice(0, 10)} · ${r.last_used_at ? html`last used ${r.last_used_at.slice(0, 16).replace("T", " ")}` : "not used yet"}`, trail: Confirm({ kind: "ingest.revoke", action: "/settings/ingest/revoke", fields: { pack: id, id: String(r.id) }, label: "Revoke", question: html`Revoke the token for ${r.source}? Apps using it stop getting in.`, danger: true }) })))
  : html`<p class="notes">No tokens yet.</p>`}
<form method="post" action="/settings/ingest/new" class="ingest-new"><input type="hidden" name="pack" value="${id}"><label>Source <input name="source" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9 ._\\-]{0,63}" placeholder="checkout-api"></label> <button type="submit" class="sm">Make a token</button></form>
</div>`;
}

