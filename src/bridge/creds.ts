/**
 * A paired machine's sign-in (H6, dovre-site#9): `dovre bridge login` writes the credentials file
 * once, after the device-code flow; this trades its refresh token for a short-lived JWT before
 * each dial. Every refresh rotates the refresh token, so the new one is written back at once
 * (atomically, 0600) before the JWT is used. `invalid_grant` means the machine was unpaired, or
 * its owner left the team: the bridge stops and says to log in again.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type Ledger, recorded } from "../sent.ts";
import { keyOk } from "./wire.ts";

export type Creds = {
  /** Where tokens are refreshed: https://dovre.dev */
  server: string;
  handle: string;
  machine: string;
  name: string;
  /** wss://<handle>.dovre.dev/bridge */
  hub: string;
  /** This machine's frame key (core machineKey(BRIDGE_KEY, machine)), handed over once at pairing. */
  frame_key: string;
  refresh_token: string;
};

/** The machine was unpaired (or its owner left the team): only a new login helps. */
export class Unpaired extends Error {}

export function parseCreds(text: string): Creds | undefined {
  let c: Partial<Creds>;
  try {
    c = JSON.parse(text);
  } catch {
    return undefined;
  }
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  if (!c || !str(c.server) || !str(c.handle) || !str(c.machine) || !str(c.hub) || !str(c.refresh_token) || !keyOk(c.frame_key)) return undefined;
  if (!c.server!.startsWith("https://") && !c.server!.startsWith("http://127.0.0.1")) return undefined;
  if (!c.hub!.startsWith("wss://") && !c.hub!.startsWith("ws://127.0.0.1")) return undefined;
  return { server: c.server!, handle: c.handle!, machine: c.machine!, name: c.name ?? "", hub: c.hub!, frame_key: c.frame_key!, refresh_token: c.refresh_token! };
}

/** Write the file whole, owner-only: a crash mid-write never leaves half a token. */
export function saveCreds(file: string, c: Creds): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {}
  renameSync(tmp, file);
}

export function loadCreds(file: string): Creds | undefined {
  try {
    return parseCreds(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * The headers for each dial: a JWT, refreshed when the one held has under a minute left.
 * `save` gets every rotated refresh token before the JWT is handed out.
 */
export function jwtHeaders(o: { creds: Creds; save: (c: Creds) => void; fetch?: Fetch; now?: () => number; ledger?: Ledger }): () => Promise<Record<string, string>> {
  // Each refresh is recorded (src/sent.ts): what was sent home, on this machine.
  const f: Fetch = recorded(o.ledger, "bridge.token", o.fetch);
  const now = o.now ?? Date.now;
  let creds = o.creds;
  let held: { jwt: string; until: number } | undefined;
  return async () => {
    if (!held || held.until - now() < 60_000) {
      const res = await f(`${creds.server}/bridge/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: creds.refresh_token }),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
      if (body.error === "invalid_grant") throw new Unpaired("this machine isn't paired any more: run `dovre bridge login` again");
      if (res.status !== 200 || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") throw new Error(`token refresh failed (${res.status}${body.error ? ` ${body.error}` : ""})`);
      creds = { ...creds, refresh_token: body.refresh_token };
      o.save(creds);
      held = { jwt: body.access_token, until: now() + Math.max(60, Number(body.expires_in) || 600) * 1000 };
    }
    return { "Cf-Access-Jwt-Assertion": held.jwt };
  };
}
