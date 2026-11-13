/**
 * Cloudflare Access for an instance (#98): the Zero Trust team, a login method, the Access app on
 * the instance's host, its two policies (people by email, the bridge by service token) and the
 * bridge's service token. Each is found by a stable key and then reused, created or fixed, so a
 * second run changes nothing and a run after a half-finished one fills in only what's missing.
 * It never deletes, and it touches only what it finds by those keys: an account that already has a
 * team, login methods or other apps keeps them as they are.
 *
 * `apply: false` only looks (`pnpm instance provision --plan`): every step says what it would do.
 */

export type CfApi = (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => Promise<unknown>;

/** A Cloudflare API refusal: the HTTP status and the API's error codes and messages. */
export class CfError extends Error {
  status: number;
  codes: number[];
  constructor(status: number, errors: { code?: number; message?: string; error?: string }[], path: string) {
    const detail = errors.map((e) => `${e.code ?? "?"} ${e.message ?? e.error ?? ""}`.trim()).join("; ") || "no detail";
    const need = status === 403 ? scopeFor(path) : undefined;
    super(`Cloudflare API ${status} on ${path}: ${detail}${need ? `. The API token needs "${need}": edit it in the dashboard (My Profile → API Tokens), and run this again` : ""}`);
    this.status = status;
    this.codes = errors.map((e) => e.code ?? 0);
  }
}

/** The token permission a path needs (TOKEN_SCOPES), to name it when Cloudflare says 403. */
export function scopeFor(path: string): string | undefined {
  if (/\/access\/service_tokens/.test(path)) return "Access: Service Tokens — Edit";
  if (/\/access\/(apps|policies)/.test(path)) return "Access: Apps and Policies — Edit";
  if (/\/access\/(organizations|identity_providers|groups)/.test(path)) return "Access: Organizations, Identity Providers, and Groups — Edit";
  if (/\/workers\/subdomain/.test(path)) return "Workers Scripts — Edit";
  if (/^\/accounts(\?|$)/.test(path)) return "Account Settings — Read";
  return undefined;
}

/** The API with a token. Lists come back whole (every page). */
export function cfApi(token: string, fetchFn: typeof fetch = fetch): CfApi {
  const one = async (method: string, path: string, body?: unknown) => {
    const res = await fetchFn(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: { code?: number; message?: string; error?: string }[]; result_info?: { total_pages?: number } };
    if (!res.ok || j.success === false) throw new CfError(res.status, j.errors ?? [], path);
    return j;
  };
  return async (method, path, body) => {
    if (method !== "GET" || !path.match(/\/(apps|policies|service_tokens|identity_providers)$/)) return (await one(method, path, body)).result;
    const all: unknown[] = [];
    for (let page = 1; page <= 50; page++) {
      const j = await one("GET", `${path}?page=${page}&per_page=100`);
      all.push(...((j.result as unknown[] | null) ?? []));
      if (page >= (j.result_info?.total_pages ?? 1)) break;
    }
    return all;
  };
}

export type Step = { what: string; action: "reuse" | "create" | "fix"; detail: string };

type Org = { auth_domain?: string; name?: string };
type Idp = { id: string; name?: string; type?: string };
type Rule = Record<string, Record<string, string>>;
type Policy = { id: string; name: string; decision: string; include?: Rule[] };
type Token = { id: string; name: string; client_id: string; expires_at?: string };
type App = { id: string; name?: string; aud?: string; domain?: string; self_hosted_domains?: string[]; destinations?: { type?: string; uri?: string }[]; policies?: { id: string; precedence?: number }[]; [k: string]: unknown };

export type AccessResult = {
  steps: Step[];
  /** The team's auth domain (`<team>.cloudflareaccess.com`), for CF_ACCESS_TEAM. */
  team?: string;
  /** The app's AUD tag, for CF_ACCESS_AUD; unknown on a plan that would create the app. */
  aud?: string;
  /** The bridge's service token. `secret` only when this run made or rotated it (shown once). */
  bridge?: { clientId: string; secret?: string };
};

export const peopleName = (worker: string) => `dovre ${worker}: people`;
export const bridgeName = (worker: string) => `dovre ${worker}: bridge`;
export const tokenName = (worker: string) => `dovre-bridge-${worker}`;
const DAY = 86_400_000;

/** "There's none": a 4xx that isn't about the token. A missing permission (401/403) still throws. */
const notFound = (e: unknown) => e instanceof CfError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403;

/** Covers `host`: its domain, one of its self-hosted domains, or a destination for it. */
export function appCovers(app: App, host: string): boolean {
  const bare = (d?: string) => (d ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const h = host.toLowerCase();
  return bare(app.domain) === h || (app.self_hosted_domains ?? []).some((d) => bare(d) === h) || (app.destinations ?? []).some((d) => bare(d.uri) === h);
}

const emailsOf = (p: Policy) => (p.include ?? []).flatMap((r) => (r.email?.email ? [r.email.email.toLowerCase()] : [])).sort();
const tokensOf = (p: Policy) => (p.include ?? []).flatMap((r) => (r.service_token?.token_id ? [r.service_token.token_id] : []));

export async function reconcileAccess(o: {
  api: CfApi;
  account: string;
  host: string;
  worker: string;
  emails: string[];
  /** The team to make when the account has none (its auth domain is `<team>.cloudflareaccess.com`). */
  team: string;
  /** The bridge's client id whose secret is already on this machine, if any. */
  localClientId?: string;
  /** Set up the bridge's token and policy (false when this machine's bridge belongs elsewhere). */
  bridge?: boolean;
  apply: boolean;
  now?: number;
}): Promise<AccessResult> {
  const { api, apply } = o;
  const a = `/accounts/${o.account}/access`;
  const steps: Step[] = [];
  const out: AccessResult = { steps };
  const emails = [...new Set(o.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].sort();
  if (!emails.length) throw new Error("no email to let in: pass --email");

  // 1. The team. One per account: an existing one is used as it is, never renamed.
  let org: Org | undefined;
  try {
    org = (await api("GET", `${a}/organizations`)) as Org | undefined;
  } catch (e) {
    if (!notFound(e)) throw e;
  }
  if (org?.auth_domain) {
    out.team = org.auth_domain;
    steps.push({ what: "Zero Trust team", action: "reuse", detail: org.auth_domain });
  } else {
    const auth = `${o.team}.cloudflareaccess.com`;
    steps.push({ what: "Zero Trust team", action: "create", detail: auth });
    if (apply) {
      try {
        org = (await api("POST", `${a}/organizations`, { name: o.team, auth_domain: auth })) as Org;
      } catch (e) {
        throw new Error(
          `Couldn't make the Zero Trust team ${auth} (${(e as Error).message}). If the name is taken, pass --team <another>. ` +
            `If this account has never used Zero Trust, open https://one.dash.cloudflare.com/ once, pick the Free plan, then run this again.`,
        );
      }
      out.team = org.auth_domain ?? auth;
    } else out.team = auth;
  }

  // 2. A way to log in. Only when there's none: an account's own (Google, GitHub…) stay as they are.
  const idps = apply || org?.auth_domain ? ((await api("GET", `${a}/identity_providers`)) as Idp[]) : [];
  if (idps.length) steps.push({ what: "Login method", action: "reuse", detail: idps.map((i) => i.type ?? i.name).join(", ") });
  else {
    steps.push({ what: "Login method", action: "create", detail: "one-time PIN by email" });
    if (apply) await api("POST", `${a}/identity_providers`, { name: "One-time PIN", type: "onetimepin", config: {} });
  }

  // 3. The bridge's service token. Its secret is shown only when made, so one this machine doesn't
  //    hold is rotated (same client id, new secret) rather than a second one made beside it.
  const withBridge = o.bridge !== false;
  const tokens = withBridge ? ((await api("GET", `${a}/service_tokens`)) as Token[]) : [];
  let token = tokens.find((t) => t.name === tokenName(o.worker));
  if (withBridge && !token) {
    steps.push({ what: "Bridge service token", action: "create", detail: tokenName(o.worker) });
    if (apply) {
      const made = (await api("POST", `${a}/service_tokens`, { name: tokenName(o.worker), duration: "8760h" })) as Token & { client_secret: string };
      token = made;
      out.bridge = { clientId: made.client_id, secret: made.client_secret };
    }
  } else if (token && token.client_id !== o.localClientId) {
    steps.push({ what: "Bridge service token", action: "fix", detail: `${tokenName(o.worker)}: its secret isn't on this machine, so a new one` });
    if (apply) {
      const rot = (await api("POST", `${a}/service_tokens/${token.id}/rotate`)) as Token & { client_secret: string };
      out.bridge = { clientId: rot.client_id ?? token.client_id, secret: rot.client_secret };
    }
  } else if (token) {
    const soon = token.expires_at && Date.parse(token.expires_at) - (o.now ?? Date.now()) < 30 * DAY;
    steps.push({ what: "Bridge service token", action: soon ? "fix" : "reuse", detail: soon ? `${tokenName(o.worker)} expires ${token.expires_at}: a year more` : tokenName(o.worker) });
    if (soon && apply) await api("POST", `${a}/service_tokens/${token.id}/refresh`);
    out.bridge = { clientId: token.client_id };
  }

  // 4. The two policies, reusable and named for this instance.
  const policies = (await api("GET", `${a}/policies`)) as Policy[];
  const ensurePolicy = async (name: string, decision: string, include: Rule[], same: (p: Policy) => boolean, detail: string): Promise<string | undefined> => {
    const p = policies.find((x) => x.name === name);
    const body = { name, decision, include, session_duration: "24h" };
    if (!p) {
      steps.push({ what: `Policy "${name}"`, action: "create", detail });
      return apply ? ((await api("POST", `${a}/policies`, body)) as Policy).id : undefined;
    }
    if (p.decision !== decision || !same(p)) {
      steps.push({ what: `Policy "${name}"`, action: "fix", detail });
      if (apply) await api("PUT", `${a}/policies/${p.id}`, body);
    } else steps.push({ what: `Policy "${name}"`, action: "reuse", detail });
    return p.id;
  };
  const people = await ensurePolicy(peopleName(o.worker), "allow", emails.map((email) => ({ email: { email } })), (p) => emailsOf(p).join() === emails.join(), `allow ${emails.join(", ")}`);
  const bridge = !withBridge ? undefined : await ensurePolicy(
    bridgeName(o.worker),
    "non_identity",
    token ? [{ service_token: { token_id: token.id } }] : [],
    (p) => !!token && tokensOf(p).join() === token.id,
    `service auth for ${tokenName(o.worker)}`,
  );

  // 5. The app on the host. One that's there (made by hand, say) is adopted: its other policies stay
  //    and ours join them.
  const apps = (await api("GET", `${a}/apps`)) as App[];
  const app = apps.find((x) => appCovers(x, o.host));
  const ours = [people, bridge].filter((x): x is string => !!x);
  const want = withBridge ? 2 : 1;
  if (!app) {
    steps.push({ what: "Access app", action: "create", detail: `self-hosted, ${o.host}` });
    if (apply) {
      const made = (await api("POST", `${a}/apps`, {
        type: "self_hosted",
        name: `Dovre (${o.worker})`,
        domain: o.host,
        session_duration: "24h",
        app_launcher_visible: true,
        policies: ours.map((id, i) => ({ id, precedence: i + 1 })),
      })) as App;
      out.aud = made.aud;
    }
  } else {
    out.aud = app.aud;
    const have = (app.policies ?? []).map((p) => p.id);
    const missing = ours.filter((id) => !have.includes(id));
    if (missing.length || ours.length < want) {
      steps.push({ what: "Access app", action: "fix", detail: `${app.name ?? app.id} on ${o.host}: add our policies, keep its own` });
      if (apply && missing.length) {
        const { id, aud, created_at, updated_at, policies: _p, ...rest } = app;
        void aud;
        void created_at;
        void updated_at;
        const list = [...have, ...missing].map((pid, i) => ({ id: pid, precedence: i + 1 }));
        await api("PUT", `${a}/apps/${id}`, { ...rest, policies: list });
      }
    } else steps.push({ what: "Access app", action: "reuse", detail: `${app.name ?? app.id} on ${o.host}` });
  }
  return out;
}

/**
 * The account's workers.dev subdomain, made when it has none (a new account). `<worker>.<sub>.workers.dev`
 * is the instance's host when it has no domain of its own.
 */
export async function workersSubdomain(api: CfApi, account: string, want: string, apply: boolean): Promise<{ sub: string; step: Step }> {
  try {
    const r = (await api("GET", `/accounts/${account}/workers/subdomain`)) as { subdomain?: string } | undefined;
    if (r?.subdomain) return { sub: r.subdomain, step: { what: "workers.dev subdomain", action: "reuse", detail: `${r.subdomain}.workers.dev` } };
  } catch (e) {
    if (!notFound(e)) throw e;
  }
  if (apply) {
    try {
      await api("PUT", `/accounts/${account}/workers/subdomain`, { subdomain: want });
    } catch (e) {
      throw new Error(`Couldn't claim ${want}.workers.dev (${(e as Error).message}). Pass --subdomain <another>.`);
    }
  }
  return { sub: want, step: { what: "workers.dev subdomain", action: "create", detail: `${want}.workers.dev` } };
}

/** The dashboard link that makes a token with what provision needs, the scopes filled in. */
export function tokenLink(name = "Dovre provision"): string {
  const keys = [
    { key: "access", type: "edit" },
    { key: "access_acct", type: "edit" },
    { key: "workers_scripts", type: "edit" },
    { key: "account_settings", type: "read" },
  ];
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}&accountId=*&zoneId=all&name=${encodeURIComponent(name)}`;
}

export const TOKEN_SCOPES = [
  "Access: Apps and Policies — Edit",
  "Access: Service Tokens — Edit",
  "Access: Organizations, Identity Providers, and Groups — Edit",
  "Workers Scripts — Edit (the workers.dev subdomain)",
  "Account Settings — Read",
];
