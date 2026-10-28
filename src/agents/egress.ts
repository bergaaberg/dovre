/**
 * Sandbox runs' way out (#208): one proxy on the host, reached from the sandbox network's
 * gateway. A box reaches nothing else (its network is host-only). Each run has a random key: in
 * its model API base URL (`/r/<key>`) and as the user of its proxy URL, so the proxy knows whose
 * call it is. An unknown key gets nothing.
 *
 * - The model API: plain HTTP from the box to `POST /r/<key>/v1/messages…` only, forwarded over
 *   TLS to Anthropic with the subscription token put in here. The box holds a placeholder, never the token.
 * - Everything else: `CONNECT host:443` tunnels to the hosts the repo allows (`.dovre/sandbox.json`),
 *   an exact name or `*.suffix`. Any other host is refused and reported (`onDeny`), so the list can
 *   be tuned from the run's page.
 * - Only connections from the sandbox subnet are served: it listens on all addresses, because the
 *   network's interface only exists while a container is on it.
 */
import { type ClientRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, isIPv4, type Socket } from "node:net";

/** What the box's Claude Code is given instead of the token: it sends it, the proxy swaps it. */
export const PLACEHOLDER_TOKEN = "sk-ant-oat01-dovre-sandbox-placeholder";

/** The model API paths the box may call with the token. */
const MODEL_PATH = /^\/v1\/messages(?:\/count_tokens)?(?:\?[\w=&.,-]*)?$/;
/** A hostname a repo may allow: `registry.npmjs.org`, or `*.example.com`. */
const HOST_RULE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A repo's allow list from its `.dovre/sandbox.json` text: lowercased, valid names only, at most 50. */
export function allowOf(text: string | undefined): string[] {
  if (!text) return [];
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return [];
  }
  const list = v && typeof v === "object" && Array.isArray((v as { allow?: unknown }).allow) ? ((v as { allow: unknown[] }).allow as unknown[]) : [];
  return [...new Set(list.filter((h): h is string => typeof h === "string").map((h) => h.trim().toLowerCase()).filter((h) => HOST_RULE.test(h)))].slice(0, 50);
}

/** Whether `host` is on the list: an exact name, or under a `*.` rule (not the bare suffix). */
export function allowed(allow: string[], host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((r) => (r.startsWith("*.") ? h.endsWith(r.slice(1)) : h === r));
}

/** Whether `addr` (maybe IPv4-mapped IPv6) is in the IPv4 `cidr`. */
export function inSubnet(addr: string | undefined, cidr: string): boolean {
  const ip = (addr ?? "").replace(/^::ffff:/, "");
  const [net, bits] = cidr.split("/");
  if (!isIPv4(ip) || !net || !isIPv4(net)) return false;
  const n = Number(bits);
  if (!Number.isInteger(n) || n < 8 || n > 32) return false;
  const num = (s: string) => s.split(".").reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
  const mask = n === 32 ? 0xffffffff : (~((1 << (32 - n)) - 1)) >>> 0;
  return (num(ip) & mask) === (num(net) & mask);
}

/** One run as the proxy knows it. */
export type EgressRun = { token: string; allow: string[]; onDeny?: (host: string) => void };

export type Egress = {
  port: number;
  /** Lets a run out: its key (random, URL-safe) and what it may reach. */
  add(key: string, run: EgressRun): void;
  /** The run ended: its key gets nothing any more. */
  drop(key: string): void;
  close(): void;
};

/** For tests: where model calls and tunnels really go. */
export type Upstream = {
  model?: (o: { path: string; method: string; headers: Record<string, string | string[] | undefined> }, res: (r: IncomingMessage) => void) => ClientRequest;
  tunnel?: (host: string, port: number) => Socket;
};

const KEY = /^[\w-]{16,64}$/;

/** The run key from a CONNECT's `Proxy-Authorization: Basic base64(key:…)`. */
function proxyKey(h: string | string[] | undefined): string | undefined {
  const m = /^Basic\s+([A-Za-z0-9+/=]{1,400})$/i.exec(typeof h === "string" ? h.trim() : "");
  if (!m) return undefined;
  const user = Buffer.from(m[1]!, "base64").toString("utf8").split(":")[0] ?? "";
  return KEY.test(user) ? user : undefined;
}

/**
 * Starts the proxy on a free port. `subnet`: who may use it (it listens on all addresses: the
 * network's interface only exists while a container is on it). Rejects when it can't listen.
 */
export function openEgress(o: { subnet: string; upstream?: Upstream; listen?: string }): Promise<Egress> {
  const model = o.upstream?.model ?? ((r, cb) => httpsRequest({ host: "api.anthropic.com", port: 443, path: r.path, method: r.method, headers: r.headers }, cb));
  const tunnel = o.upstream?.tunnel ?? ((host, port) => connect({ host, port }));
  const runs = new Map<string, EgressRun & { told: Set<string> }>();
  const deny = (key: string | undefined, host: string) => {
    const r = key ? runs.get(key) : undefined;
    if (!r || r.told.has(host) || r.told.size >= 200) return;
    r.told.add(host);
    r.onDeny?.(host);
  };
  const ours = (s: Socket) => inSubnet(s.remoteAddress, o.subnet);
  /** Open tunnels, ended on close (closeAllConnections doesn't reach them). */
  const tunnels = new Set<Socket>();

  const server: Server = createServer((q: IncomingMessage, s: ServerResponse) => {
    if (!ours(q.socket)) return void q.socket.destroy();
    const url = q.url ?? "";
    // A proxied plain-HTTP request names its host: never served, only reported.
    if (/^[a-z]+:\/\//i.test(url)) {
      try {
        deny(proxyKey(q.headers["proxy-authorization"]), new URL(url).hostname.toLowerCase());
      } catch {}
      s.writeHead(403).end("Dovre's sandbox allows no plain HTTP.\n");
      return;
    }
    const m = /^\/r\/([\w-]{16,64})(\/.*)$/.exec(url);
    const run = m ? runs.get(m[1]!) : undefined;
    const path = m?.[2] ?? "";
    if (!run || q.method !== "POST" || !MODEL_PATH.test(path)) {
      s.writeHead(403).end("Only the model API goes through here.\n");
      return;
    }
    const headers: Record<string, string | string[] | undefined> = { ...q.headers, authorization: `Bearer ${run.token}` };
    delete headers.host;
    delete headers["x-api-key"];
    delete headers["proxy-authorization"];
    delete headers.connection;
    const up = model({ path, method: "POST", headers }, (r) => {
      s.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(s);
    });
    up.on("error", () => (s.headersSent ? s.destroy() : s.writeHead(502).end("The model API couldn't be reached.\n")));
    q.pipe(up);
  });

  server.on("connect", (q: IncomingMessage, sock: Socket, head: Buffer) => {
    sock.on("error", () => {});
    if (!ours(sock)) return void sock.destroy();
    const key = proxyKey(q.headers["proxy-authorization"]);
    const run = key ? runs.get(key) : undefined;
    const m = /^([a-z0-9.-]{1,253}):(\d{1,5})$/i.exec(q.url ?? "");
    const host = m?.[1]?.toLowerCase();
    if (!run || !m || !host || m[2] !== "443" || !allowed(run.allow, host)) {
      if (host) deny(key, host);
      sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const up = tunnel(host, 443);
    tunnels.add(sock);
    up.on("error", () => sock.destroy());
    up.on("connect", () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    sock.on("close", () => (tunnels.delete(sock), up.destroy()));
  });
  server.on("clientError", (_e, sock) => sock.destroy());

  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, o.listen ?? "0.0.0.0", () => {
      const a = server.address();
      res({
        port: typeof a === "object" && a ? a.port : 0,
        add: (key, run) => {
          if (KEY.test(key)) runs.set(key, { ...run, told: new Set() });
        },
        drop: (key) => void runs.delete(key),
        close: () => {
          server.close();
          server.closeAllConnections?.();
          for (const t of tunnels) t.destroy();
        },
      });
    });
  });
}
