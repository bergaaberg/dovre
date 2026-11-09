/**
 * Secret references hosted (#428): the Worker reads a store's key over its REST API with `fetch`
 * and WebCrypto, never a CLI. No Node here. Each store takes a scoped credential of its own, set
 * as the Worker's secrets; the key it reads stays in this isolate's memory, never in D1.
 *
 * | Store | Worker secrets |
 * |---|---|
 * | Azure Key Vault | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (an app registration) |
 * | GCP Secret Manager | `GCP_SERVICE_ACCOUNT` (a service account's JSON key) |
 * | AWS Secrets Manager | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`), `AWS_REGION` for `aws://` |
 * | 1Password | `OP_CONNECT_HOST`, `OP_CONNECT_TOKEN` (a 1Password Connect server) |
 *
 * Bitwarden and the Keychain are read on a machine only.
 */
import { type Keys, type Ref, refOf, type StoreId, STORES } from "./secretrefs.ts";

type Env = Record<string, string | undefined>;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Read = { ok: true; value: string } | { ok: false; why: string };
type Opts = { fetch?: Fetch; now?: () => number; log?: (line: string) => void };

/** Each store's credential, as the Worker's secrets name it. */
export const CREDS: Partial<Record<StoreId, string[]>> = {
  akv: ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"],
  gcp: ["GCP_SERVICE_ACCOUNT"],
  aws: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  op: ["OP_CONNECT_HOST", "OP_CONNECT_TOKEN"],
};

const MS = 10_000;
const and = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Why a store said no: its status and its own error code, never the body whole. */
async function refusal(store: StoreId, r: Response): Promise<string> {
  let code = "";
  try {
    const j = (await r.json()) as { error?: { code?: unknown; status?: unknown; message?: unknown } | string; __type?: unknown; message?: unknown };
    const e = j.error;
    const c = typeof e === "string" ? e : (e?.code ?? e?.status) ?? j.__type ?? j.message;
    if (typeof c === "string") code = c.replace(/^.*#/, "").replace(/[^\w .:-]/g, "").slice(0, 80);
  } catch {}
  return `${STORES[store]} answered ${r.status}${code ? ` (${code})` : ""}`;
}

/** Why a credential secret is unusable, before any call. */
const missing = (store: StoreId, env: Env): string | undefined => {
  const lack = (CREDS[store] ?? []).filter((k) => !env[k]?.trim());
  return lack.length ? `set ${and(lack)} as the Worker's secrets to read ${STORES[store]}, or set the key itself` : undefined;
};

/** A bearer token per store, reused until a minute before it ends. */
type Token = { token: string; until: number };

function hostedReaders(env: Env, o: Opts = {}) {
  const f: Fetch = o.fetch ?? ((i, init) => fetch(i, init));
  const now = o.now ?? Date.now;
  const tokens = new Map<string, Promise<Token>>();
  const go = (url: string, init: RequestInit = {}) => f(url, { ...init, signal: AbortSignal.timeout(MS) });
  const tokenOf = (id: string, get: () => Promise<Token>): Promise<Token> => {
    const had = tokens.get(id);
    const p = had ?? get();
    if (!had) tokens.set(id, p);
    return p.then(
      (t) => {
        if (t.until > now()) return t;
        tokens.delete(id);
        return tokenOf(id, get);
      },
      (e) => {
        tokens.delete(id);
        throw e;
      },
    );
  };

  const akv = async (raw: string): Promise<Read> => {
    const t = await tokenOf("akv", async () => {
      const r = await go(`https://login.microsoftonline.com/${encodeURIComponent(env.AZURE_TENANT_ID!.trim())}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.AZURE_CLIENT_ID!.trim(), client_secret: env.AZURE_CLIENT_SECRET!.trim(), scope: "https://vault.azure.net/.default" }),
      });
      if (!r.ok) throw new Error(`Azure sign-in ${(await refusal("akv", r)).replace(/^Azure Key Vault /, "")}`);
      const j = (await r.json()) as { access_token?: string; expires_in?: number };
      if (!j.access_token) throw new Error("Azure sign-in gave no token");
      return { token: j.access_token, until: now() + Math.max(0, (j.expires_in ?? 3600) - 60) * 1000 };
    });
    const r = await go(`${raw.replace(/\/$/, "")}?api-version=7.4`, { headers: { authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, why: await refusal("akv", r) };
    const v = ((await r.json()) as { value?: unknown }).value;
    return typeof v === "string" ? { ok: true, value: v } : { ok: false, why: "Azure Key Vault gave no value" };
  };

  const gcp = async (raw: string): Promise<Read> => {
    const t = await tokenOf("gcp", async () => {
      let sa: { client_email?: string; private_key?: string; token_uri?: string };
      try {
        sa = JSON.parse(env.GCP_SERVICE_ACCOUNT!);
      } catch {
        throw new Error("GCP_SERVICE_ACCOUNT isn't a service account's JSON key");
      }
      if (!sa.client_email || !sa.private_key) throw new Error("GCP_SERVICE_ACCOUNT lacks client_email or private_key");
      const aud = "https://oauth2.googleapis.com/token";
      const iat = Math.floor(now() / 1000);
      const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
      const claims = b64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud, iat, exp: iat + 3600 })));
      const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
      let key: CryptoKey;
      try {
        key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
      } catch {
        throw new Error("GCP_SERVICE_ACCOUNT's private_key isn't a PKCS#8 RSA key");
      }
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${claims}`));
      // Always Google's own token address: a key file can't send the assertion elsewhere.
      const r = await go(aud, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${b64url(sig)}` }) });
      if (!r.ok) throw new Error(`Google sign-in ${(await refusal("gcp", r)).replace(/^GCP Secret Manager /, "")}`);
      const j = (await r.json()) as { access_token?: string; expires_in?: number };
      if (!j.access_token) throw new Error("Google sign-in gave no token");
      return { token: j.access_token, until: now() + Math.max(0, (j.expires_in ?? 3600) - 60) * 1000 };
    });
    const [, p, s, v] = /^projects\/([^/]+)\/secrets\/([^/]+)(?:\/versions\/([^/]+))?$/.exec(raw)!;
    const r = await go(`https://secretmanager.googleapis.com/v1/projects/${p}/secrets/${s}/versions/${v ?? "latest"}:access`, { headers: { authorization: `Bearer ${t.token}` } });
    if (!r.ok) return { ok: false, why: await refusal("gcp", r) };
    const data = ((await r.json()) as { payload?: { data?: unknown } }).payload?.data;
    if (typeof data !== "string") return { ok: false, why: "GCP Secret Manager gave no payload" };
    return { ok: true, value: new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0))) };
  };

  const aws = async (id: string): Promise<Read> => {
    const region = /^arn:aws[a-z-]*:secretsmanager:([a-z0-9-]+):/.exec(id)?.[1] ?? env.AWS_REGION?.trim();
    if (!region || !/^[a-z0-9-]{1,30}$/.test(region)) return { ok: false, why: "set AWS_REGION as the Worker's var to read an aws:// reference (an ARN names its own)" };
    const host = `secretsmanager.${region}.amazonaws.com`;
    const body = JSON.stringify({ SecretId: id });
    const at = new Date(now()).toISOString().replace(/[-:]|\.\d{3}/g, "");
    const day = at.slice(0, 8);
    const token = env.AWS_SESSION_TOKEN?.trim();
    const headers: Record<string, string> = { "content-type": "application/x-amz-json-1.1", host, "x-amz-date": at, "x-amz-target": "secretsmanager.GetSecretValue", ...(token ? { "x-amz-security-token": token } : {}) };
    const names = Object.keys(headers).sort();
    const sha = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
    const hmac = async (k: ArrayBuffer | Uint8Array<ArrayBuffer>, s: string) => crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(s));
    const canonical = ["POST", "/", "", ...names.map((n) => `${n}:${headers[n]}`), "", names.join(";"), await sha(body)].join("\n");
    const scope = `${day}/${region}/secretsmanager/aws4_request`;
    let k: ArrayBuffer = await hmac(enc.encode(`AWS4${env.AWS_SECRET_ACCESS_KEY!.trim()}`), day);
    for (const part of [region, "secretsmanager", "aws4_request"]) k = await hmac(k, part);
    const sig = hex(await hmac(k, ["AWS4-HMAC-SHA256", at, scope, await sha(canonical)].join("\n")));
    const { host: _h, ...sent } = headers;
    const r = await go(`https://${host}/`, { method: "POST", body, headers: { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID!.trim()}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` } });
    if (!r.ok) return { ok: false, why: await refusal("aws", r) };
    const v = ((await r.json()) as { SecretString?: unknown }).SecretString;
    return typeof v === "string" ? { ok: true, value: v } : { ok: false, why: "AWS Secrets Manager gave no SecretString (a binary secret isn't read)" };
  };

  /** op://vault/item/[section/]field through Connect: each part by its name, or its id. */
  const op = async (raw: string): Promise<Read> => {
    const base = env.OP_CONNECT_HOST!.trim().replace(/\/+$/, "");
    if (!/^https:\/\/[^/\s?#]+(\/[^\s?#]*)?$/.test(base)) return { ok: false, why: "OP_CONNECT_HOST isn't an https:// address" };
    const auth = { authorization: `Bearer ${env.OP_CONNECT_TOKEN!.trim()}` };
    const parts = raw.slice("op://".length).split("/");
    const [vault, item] = [parts[0]!, parts[1]!];
    const field = parts.at(-1)!;
    const section = parts.length === 4 ? parts[2] : undefined;
    const get = async <T>(path: string): Promise<{ ok: true; v: T } | { ok: false; why: string }> => {
      const r = await go(`${base}/v1/${path}`, { headers: auth });
      return r.ok ? { ok: true, v: (await r.json()) as T } : { ok: false, why: await refusal("op", r) };
    };
    const ID = /^[a-z0-9]{26}$/;
    const q = (k: string, v: string) => `filter=${encodeURIComponent(`${k} eq "${v.replace(/["\\]/g, (c) => `\\${c}`)}"`)}`;
    const pick = async (path: string, key: string, name: string, what: string): Promise<{ ok: true; id: string } | { ok: false; why: string }> => {
      const r = await get<{ id: string }[]>(`${path}?${q(key, name)}`);
      if (!r.ok) return r;
      if (r.v[0]?.id) return { ok: true, id: r.v[0].id };
      return ID.test(name) ? { ok: true, id: name } : { ok: false, why: `1Password Connect has no ${what} "${name}"` };
    };
    const v = await pick("vaults", "name", vault, "vault");
    if (!v.ok) return v;
    const i = await pick(`vaults/${v.id}/items`, "title", item, "item");
    if (!i.ok) return i;
    const full = await get<{ fields?: { id?: string; label?: string; value?: string; section?: { id?: string } }[]; sections?: { id?: string; label?: string }[] }>(`vaults/${v.id}/items/${i.id}`);
    if (!full.ok) return full;
    const sec = section === undefined ? undefined : full.v.sections?.find((s) => s.label === section || s.id === section);
    if (section !== undefined && !sec) return { ok: false, why: `that 1Password item has no section "${section}"` };
    const fs = (full.v.fields ?? []).filter((x) => !sec || x.section?.id === sec.id);
    const hit = fs.find((x) => x.label === field) ?? fs.find((x) => x.id === field);
    return typeof hit?.value === "string" ? { ok: true, value: hit.value } : { ok: false, why: `that 1Password item has no field "${field}"` };
  };

  /** Reads one reference: the key, or why not. */
  return async (ref: Ref, raw: string): Promise<Read> => {
    const lack = missing(ref.store, env);
    if (lack) return { ok: false, why: lack };
    try {
      const r = ref.store === "akv" ? await akv(raw) : ref.store === "gcp" ? await gcp(raw) : ref.store === "aws" ? await aws(ref.args[3]!) : ref.store === "op" ? await op(raw) : { ok: false as const, why: "read only on a machine" };
      return r.ok && !r.value.trim() ? { ok: false, why: `it's empty in ${STORES[ref.store]}` } : r;
    } catch (e) {
      const m = (e as Error)?.name === "TimeoutError" ? `${STORES[ref.store]} didn't answer in ${MS / 1000} s` : String((e as Error)?.message ?? e);
      return { ok: false, why: m.slice(0, 200) };
    }
  };
}

/**
 * Hosted keys: the references among the Worker's vars, taken out of `env` and read into it by
 * `read()` (the Worker calls it while it starts). Settings can't change them: they're the Worker's.
 */
export function hostedKeys(env: Env, o: Opts = {}): Keys {
  const refs = new Map<string, string>();
  const why = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) {
    const ref = refOf(v);
    if (!ref) continue;
    refs.set(k, v!.trim());
    delete env[k];
    why.set(k, CREDS[ref.store] ? `not read yet from ${STORES[ref.store]}` : `a ${STORES[ref.store]} reference, read only on a machine. Set the key itself as the Worker's secret`);
  }
  const readOne = hostedReaders(env, o);
  const no = () => Promise.reject(new Error("hosted keys are the Worker's secrets"));
  return {
    state(k) {
      const raw = refs.get(k);
      if (!raw) return undefined;
      return why.has(k) ? { unread: why.get(k)! } : { from: refOf(raw)!.store };
    },
    unread: () => Object.fromEntries(why),
    async read(keys) {
      const list = (keys ?? [...refs.keys()]).filter((k) => refs.has(k) && CREDS[refOf(refs.get(k))!.store]);
      const changed = await Promise.all(
        list.map(async (k) => {
          const raw = refs.get(k)!;
          const ref = refOf(raw)!;
          const r = await readOne(ref, raw);
          if (r.ok) {
            why.delete(k);
            const was = env[k];
            env[k] = r.value;
            return was !== r.value;
          }
          why.set(k, r.why);
          o.log?.(`${k}: can't read it from ${STORES[ref.store]}: ${r.why}`);
          const had = k in env;
          delete env[k];
          return had;
        }),
      );
      return changed.some(Boolean);
    },
    save: no,
    clear: no,
  };
}
