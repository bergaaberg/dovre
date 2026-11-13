/**
 * #98: provision on a new Cloudflare account and on one already set up, against an in-memory API.
 * A second run changes nothing; a half-done one is finished; what isn't ours is left as it is.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appCovers, type CfApi, CfError, peopleName, reconcileAccess, tokenLink, tokenName } from "../src/cfaccess.ts";
import { instanceFiles, writeInstance } from "../src/instance-new.ts";
import { extractD1Uuid, parseWhoami, patchWranglerConfig, provisionInstance, readWranglerInfo } from "../src/instance-provision.ts";

const ACC = "0123456789abcdef0123456789abcdef";

type State = {
  org?: { auth_domain: string; name: string };
  idps: { id: string; type: string }[];
  tokens: { id: string; name: string; client_id: string; expires_at?: string }[];
  policies: { id: string; name: string; decision: string; include: Record<string, Record<string, string>>[] }[];
  apps: { id: string; name: string; domain: string; aud: string; policies: { id: string; precedence: number }[] }[];
  sub?: string;
  orgDenied?: boolean;
};

function fakeCf(st: State) {
  const writes: string[] = [];
  let n = 0;
  const id = () => `id${++n}`;
  const api: CfApi = async (method, path, body) => {
    const p = path.replace(`/accounts/${ACC}`, "");
    const b = body as Record<string, unknown>;
    if (method !== "GET") writes.push(`${method} ${p}`);
    if (p === "/access/organizations") {
      if (st.orgDenied) throw new CfError(403, [{ code: 10000, message: "Authentication error" }], path);
      if (method === "GET") {
        if (!st.org) throw new CfError(404, [{ code: 12130, message: "not found" }], path);
        return st.org;
      }
      st.org = { auth_domain: b.auth_domain as string, name: b.name as string };
      return st.org;
    }
    if (p === "/access/identity_providers") {
      if (method === "GET") return st.idps;
      const i = { id: id(), type: b.type as string };
      st.idps.push(i);
      return i;
    }
    if (p === "/access/service_tokens") {
      if (method === "GET") return st.tokens.map(({ ...t }) => t);
      const t = { id: id(), name: b.name as string, client_id: `${id()}.access` };
      st.tokens.push(t);
      return { ...t, client_secret: "secret-new" };
    }
    const rot = p.match(/^\/access\/service_tokens\/(\w+)\/(rotate|refresh)$/);
    if (rot) {
      const t = st.tokens.find((x) => x.id === rot[1])!;
      return rot[2] === "rotate" ? { ...t, client_secret: "secret-rotated" } : t;
    }
    if (p === "/access/policies") {
      if (method === "GET") return st.policies;
      const pol = { id: id(), ...(b as { name: string; decision: string; include: [] }) };
      st.policies.push(pol);
      return pol;
    }
    const pu = p.match(/^\/access\/policies\/(\w+)$/);
    if (pu) return Object.assign(st.policies.find((x) => x.id === pu[1])!, b);
    if (p === "/access/apps") {
      if (method === "GET") return st.apps;
      const app = { id: id(), aud: "aud-new", ...(b as { name: string; domain: string; policies: [] }) };
      st.apps.push(app);
      return app;
    }
    const au = p.match(/^\/access\/apps\/(\w+)$/);
    if (au) return Object.assign(st.apps.find((x) => x.id === au[1])!, b);
    if (p === "/workers/subdomain") {
      if (method === "GET") {
        if (!st.sub) throw new CfError(404, [{ code: 10007, message: "no subdomain" }], path);
        return { subdomain: st.sub };
      }
      st.sub = b.subdomain as string;
      return { subdomain: st.sub };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, writes };
}

const blank = (): State => ({ idps: [], tokens: [], policies: [], apps: [] });
const base = { account: ACC, host: "home.me.workers.dev", worker: "home", emails: ["Me@x.dev"], team: "home" };

test("access, new account: plan changes nothing; apply makes team, PIN login, token, policies, app; again changes nothing", async () => {
  const st = blank();
  const f = fakeCf(st);
  const plan = await reconcileAccess({ ...base, api: f.api, apply: false });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(plan.steps.map((s) => s.action), ["create", "create", "create", "create", "create", "create"]);
  assert.equal(plan.team, "home.cloudflareaccess.com");

  const r = await reconcileAccess({ ...base, api: f.api, apply: true });
  assert.equal(r.team, "home.cloudflareaccess.com");
  assert.equal(r.aud, "aud-new");
  assert.equal(r.bridge?.secret, "secret-new");
  assert.equal(st.idps[0].type, "onetimepin");
  assert.deepEqual(st.policies.find((p) => p.name === peopleName("home"))?.include, [{ email: { email: "me@x.dev" } }]);
  assert.equal(st.apps[0].domain, "home.me.workers.dev");
  assert.equal(st.apps[0].policies.length, 2);

  const n = f.writes.length;
  const again = await reconcileAccess({ ...base, api: f.api, apply: true, localClientId: r.bridge!.clientId });
  assert.equal(f.writes.length, n, `no writes the second time: ${f.writes.slice(n)}`);
  assert.ok(again.steps.every((s) => s.action === "reuse"), JSON.stringify(again.steps));
  assert.equal(again.bridge?.secret, undefined);
  assert.equal(st.tokens.length, 1);
});

test("access, account already set up: its team and login kept; a hand-made app on the host adopted, its own policy kept", async () => {
  const st: State = {
    org: { auth_domain: "acme.cloudflareaccess.com", name: "Acme" },
    idps: [{ id: "g", type: "google" }],
    tokens: [{ id: "other", name: "ci", client_id: "ci.access" }],
    policies: [{ id: "theirs", name: "Acme staff", decision: "allow", include: [{ email_domain: { domain: "acme.com" } }] }],
    apps: [{ id: "app1", name: "Dovre by hand", domain: "https://dovre.acme.com/", aud: "aud-old", policies: [{ id: "theirs", precedence: 1 }] }],
  };
  const f = fakeCf(st);
  const r = await reconcileAccess({ ...base, host: "dovre.acme.com", api: f.api, apply: true });
  assert.equal(r.team, "acme.cloudflareaccess.com");
  assert.equal(r.aud, "aud-old");
  assert.ok(!f.writes.some((w) => /organizations|identity_providers|\/apps$/.test(w)), f.writes.join());
  assert.deepEqual(
    st.apps[0].policies.map((p) => p.id),
    ["theirs", ...st.policies.filter((p) => p.name.startsWith("dovre home")).map((p) => p.id)],
  );
  assert.equal(st.apps.length, 1);
  assert.equal(st.tokens.find((t) => t.name === "ci")?.client_id, "ci.access");
});

test("access: a token whose secret isn't here is rotated, never a second one; no bridge, no token; a refused token throws", async () => {
  const st = blank();
  st.tokens.push({ id: "t1", name: tokenName("home"), client_id: "c1.access" });
  const f = fakeCf(st);
  const r = await reconcileAccess({ ...base, api: f.api, apply: true });
  assert.equal(r.bridge?.secret, "secret-rotated");
  assert.equal(st.tokens.length, 1);
  assert.ok(f.writes.includes("POST /access/service_tokens/t1/rotate"));

  const st2 = blank();
  const f2 = fakeCf(st2);
  await reconcileAccess({ ...base, api: f2.api, apply: true, bridge: false });
  assert.equal(st2.tokens.length, 0);
  assert.equal(st2.apps[0].policies.length, 1);

  const st3 = { ...blank(), orgDenied: true };
  await assert.rejects(reconcileAccess({ ...base, api: fakeCf(st3).api, apply: true }), /403/);
  assert.equal(st3.org, undefined);
});

test("access: a 403 names the token permission the call needs", () => {
  const e = new CfError(403, [{ code: 1010, error: "auth.forbidden" }], "/accounts/a1/access/service_tokens");
  assert.match(e.message, /1010 auth\.forbidden/);
  assert.match(e.message, /"Access: Service Tokens — Edit"/);
  assert.match(new CfError(403, [], "/accounts/a1/access/apps/x").message, /Apps and Policies/);
  assert.doesNotMatch(new CfError(400, [], "/accounts/a1/access/service_tokens").message, /needs/);
});

test("access: helpers", () => {
  assert.ok(appCovers({ id: "a", destinations: [{ type: "public", uri: "x.dev" }] }, "X.dev"));
  assert.ok(!appCovers({ id: "a", domain: "x.dev/admin" }, "x.dev"));
  assert.match(decodeURIComponent(tokenLink()), /"key":"access_acct","type":"edit"/);
  assert.deepEqual(parseWhoami(`👋 You are logged in with an OAuth Token, associated with the email me@x.dev.\n│ Me │ ${ACC} │`), { email: "me@x.dev", accounts: [ACC] });
});

function fakeRun(log: string[], o: { secrets?: string[] } = {}) {
  return (cmd: string, args: string[]) => {
    const line = `${cmd} ${args.join(" ")}`;
    log.push(line);
    if (line.endsWith("wrangler whoami")) return { status: 0, stdout: `associated with the email me@x.dev.\n│ ${ACC} │`, stderr: "" };
    if (line.includes("d1 create")) return { status: 0, stdout: `database_id = "5077de88-85f6-4678-96f5-00e2d0cb3850"`, stderr: "" };
    if (line.includes("d1 info")) return { status: 1, stdout: "", stderr: "not found" };
    if (line.includes("secret list")) return { status: 0, stdout: JSON.stringify((o.secrets ?? []).map((name) => ({ name, type: "secret_text" }))), stderr: "" };
    if (line.includes("gh api user")) return { status: 0, stdout: "octocat\n", stderr: "" };
    if (line.includes("gh auth token")) return { status: 0, stdout: "gho_x\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
}

test("provision, nothing yet: workers.dev, Access, bridge vars, secrets; the second run keeps the key and token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-prov-"));
  writeInstance(dir, instanceFiles({ name: "home" }));
  const vars = join(dir, "bridge.vars");
  const st = blank();
  const f = fakeCf(st);
  const ran: string[] = [];
  const planned = await provisionInstance({ dir, coreVarsFile: vars, api: f.api, plan: true, run: fakeRun(ran), log: () => {} });
  assert.equal(planned.host, "home.home.workers.dev");
  assert.deepEqual(f.writes, []);
  assert.ok(!ran.some((l) => /d1 create|secret put|migrations|deploy/.test(l)), ran.join("\n"));

  await provisionInstance({ dir, coreVarsFile: vars, api: f.api, deploy: true, run: fakeRun(ran), log: () => {}, platform: "linux" });
  const cfg = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  const info = readWranglerInfo(cfg);
  assert.equal(info.dbId, "5077de88-85f6-4678-96f5-00e2d0cb3850");
  assert.equal(info.domain, "");
  assert.match(cfg, /"workers_dev": true/);
  assert.match(cfg, /"WORKERS_DEV_HOST": "home\.home\.workers\.dev"/);
  assert.match(cfg, /"CF_ACCESS_TEAM": "home\.cloudflareaccess\.com"/);
  assert.match(cfg, /"CF_ACCESS_AUD": "aud-new"/);
  assert.match(cfg, /"ALLOWED_EMAILS": "me@x\.dev"/);
  assert.match(cfg, /"BRIDGE_CLIENT_ID": "id\d+\.access"/);
  assert.match(cfg, /"GITHUB_USER": "octocat"/);
  const v = readFileSync(vars, "utf8");
  assert.match(v, /BRIDGE_URL=wss:\/\/home\.home\.workers\.dev\/bridge/);
  assert.match(v, /BRIDGE_CLIENT_SECRET=secret-new/);
  const key = v.match(/BRIDGE_KEY=(\S+)/)?.[1];
  assert.ok(key && key.length >= 32);
  assert.ok(ran.some((l) => l.includes("secret put BRIDGE_KEY")));
  assert.ok(ran.some((l) => l.includes("secret put GITHUB_TOKEN")));
  assert.ok(ran.some((l) => l.endsWith("wrangler deploy")));
  assert.ok(!ran.some((l) => l.includes("install-bridge")), "not on linux");

  const ran2: string[] = [];
  const n = f.writes.length;
  const again = await provisionInstance({ dir, coreVarsFile: vars, api: f.api, run: fakeRun(ran2, { secrets: ["BRIDGE_KEY", "GITHUB_TOKEN"] }), log: () => {} });
  assert.equal(f.writes.length, n, f.writes.slice(n).join());
  assert.ok(!ran2.some((l) => /secret put|d1 create/.test(l)), ran2.join("\n"));
  assert.equal(readFileSync(vars, "utf8").match(/BRIDGE_KEY=(\S+)/)?.[1], key);
  assert.ok(again.steps.every((s) => s.action === "reuse"), JSON.stringify(again.steps));
});

test("provision: a .dev.vars whose bridge dials another instance is left alone, and no bridge token is made", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-prov-"));
  writeInstance(dir, instanceFiles({ name: "work", domain: "dovre.acme.com" }));
  const vars = join(dir, "bridge.vars");
  const before = "BRIDGE_URL=wss://dovre.elsewhere.dev/bridge\nBRIDGE_KEY=keep-me-keep-me-keep-me-keep-me-1\n";
  writeFileSync(vars, before);
  const st = blank();
  await provisionInstance({ dir, coreVarsFile: vars, api: fakeCf(st).api, run: fakeRun([]), log: () => {}, allowedEmails: "a@acme.com,b@acme.com" });
  assert.equal(readFileSync(vars, "utf8"), before);
  assert.equal(st.tokens.length, 0);
  assert.equal(st.apps[0].domain, "dovre.acme.com");
  const cfg = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  assert.match(cfg, /"pattern": "dovre\.acme\.com"/);
  assert.match(cfg, /"workers_dev": false/);
  assert.match(cfg, /"ALLOWED_EMAILS": "a@acme\.com,b@acme\.com"/);
});

test("provision: wrangler.jsonc helpers", () => {
  const cfg = instanceFiles({ name: "x", domain: "a.dev" })["wrangler.jsonc"];
  assert.match(patchWranglerConfig(cfg, { domain: "b.dev" }), /"pattern": "b\.dev"/);
  // An instance made before BRIDGE_CLIENT_ID was in the template.
  const old = cfg.replace(/"ALLOWED_EMAILS": "",\n[^\n]*\n\s*"BRIDGE_CLIENT_ID": ""/, '"ALLOWED_EMAILS": ""');
  assert.ok(!old.includes("BRIDGE_CLIENT_ID"));
  JSON.parse(old.replace(/^\s*\/\/.*$/gm, ""));
  const patched = patchWranglerConfig(old, { bridgeClientId: "c.access" });
  assert.match(patched, /"BRIDGE_CLIENT_ID": "c\.access"/);
  JSON.parse(patched.replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(extractD1Uuid("id: 5077DE88-85f6-4678-96f5-00e2d0cb3850"), "5077de88-85f6-4678-96f5-00e2d0cb3850");
});

test("provision, built-in login (no token): only wrangler's login; AUTH_MODE=passkey, a passkey link once, no Access touched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-prov-"));
  writeInstance(dir, instanceFiles({ name: "home" }));
  const vars = join(dir, "bridge.vars");
  const st = blank();
  const wf = fakeCf(st);
  let passkeys = 0;
  const sql: string[] = [];
  const run = (ran: string[], secrets: string[] = []) => {
    const base = fakeRun(ran, { secrets });
    return (cmd: string, args: string[], opts?: { cwd?: string; input?: string }) => {
      const line = `${cmd} ${args.join(" ")}`;
      if (line.includes("d1 execute") && line.includes("COUNT(*)")) return { status: 0, stdout: JSON.stringify([{ results: [{ n: passkeys }] }]), stderr: "" };
      if (line.includes("d1 execute")) {
        sql.push(args.at(-1)!);
        ran.push(line);
        return { status: 0, stdout: "", stderr: "" };
      }
      void opts;
      return base(cmd, args);
    };
  };
  const ran: string[] = [];
  const r = await provisionInstance({ dir, coreVarsFile: vars, wranglerApi: wf.api, deploy: true, run: run(ran), log: () => {}, platform: "linux" });
  assert.equal(r.host, "home.home.workers.dev");
  assert.match(r.link ?? "", /^https:\/\/home\.home\.workers\.dev\/_auth\/claim#[A-Za-z0-9_-]{43}$/);
  assert.equal(sql.length, 1);
  assert.ok(!sql[0]!.includes(r.link!.split("#")[1]!), "only the hash goes to D1");
  assert.deepEqual(wf.writes, ["PUT /workers/subdomain"], "the subdomain only: no Access");
  const cfg = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  assert.match(cfg, /"AUTH_MODE": "passkey"/);
  assert.match(cfg, /"CF_ACCESS_TEAM": ""/);
  assert.doesNotMatch(cfg, /WORKERS_DEV_HOST/);
  assert.match(cfg, /"ALLOWED_EMAILS": "me@x\.dev"/);
  const v = readFileSync(vars, "utf8");
  assert.match(v, /BRIDGE_URL=wss:\/\/home\.home\.workers\.dev\/bridge/);
  assert.doesNotMatch(v, /BRIDGE_CLIENT/);

  passkeys = 1;
  const again = await provisionInstance({ dir, coreVarsFile: vars, wranglerApi: wf.api, run: run([], ["BRIDGE_KEY", "GITHUB_TOKEN"]), log: () => {} });
  assert.equal(again.link, undefined);
  assert.equal(sql.length, 1);
  assert.ok(again.steps.every((s) => s.action === "reuse"), JSON.stringify(again.steps));
  const more = await provisionInstance({ dir, coreVarsFile: vars, wranglerApi: wf.api, loginLink: true, run: run([], ["BRIDGE_KEY", "GITHUB_TOKEN"]), log: () => {} });
  assert.ok(more.link);
  assert.equal(sql.length, 2);
});
