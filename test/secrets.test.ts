import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { html } from "hono/html";
import { activePacks } from "../src/packs/registry.ts";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { type Cli, createKeys, readRef, refOf } from "../src/secrets.ts";
import { createHmac, createHash, generateKeyPairSync, createVerify } from "node:crypto";
import { hostedKeys } from "../src/hostedkeys.ts";
import { createWorker } from "../src/worker.ts";
import type { D1 } from "../src/db.ts";
import { H, assertInert, signedIn, snapshot } from "./helpers.ts";

/** A store's CLI: answers from `keys` by the reference it was asked for, and records each call. */
function fakeCli(keys: Record<string, string | { why: string }>) {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const cli: Cli = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    if (cmd === "security" && args[0] === "-i") return { ok: true, out: "" };
    if (cmd === "security" && args[0] === "delete-generic-password") return { ok: true, out: "" };
    const asked = args.find((a) => Object.hasOwn(keys, a)) ?? (cmd === "security" ? `keychain://${args[2]}/${args[4]}` : undefined);
    const k = asked !== undefined ? keys[asked] : undefined;
    if (k === undefined) return { ok: false, why: `${cmd}: not found` };
    return typeof k === "string" ? { ok: true, out: `${k}\n` } : { ok: false, why: k.why };
  };
  return { cli, calls };
}

test("refOf: each store's reference and the command that reads it; anything else is the key itself", () => {
  assert.deepEqual(refOf("op://Private/My Linear/credential"), { store: "op", cmd: "op", args: ["read", "--no-newline", "op://Private/My Linear/credential"] });
  assert.equal(refOf("op://Private/Linear/section/field")?.store, "op");
  assert.deepEqual(refOf("https://acme-kv.vault.azure.net/secrets/linear-key")?.args, ["keyvault", "secret", "show", "--id", "https://acme-kv.vault.azure.net/secrets/linear-key", "--query", "value", "--output", "tsv"]);
  assert.equal(refOf("arn:aws:secretsmanager:eu-north-1:123456789012:secret:linear-AbCdEf")?.store, "aws");
  assert.deepEqual(refOf("aws://prod/linear")?.args, ["secretsmanager", "get-secret-value", "--secret-id", "prod/linear", "--query", "SecretString", "--output", "text"]);
  assert.deepEqual(refOf("projects/acme-prod/secrets/linear")?.args, ["secrets", "versions", "access", "latest", "--secret=linear", "--project=acme-prod"]);
  assert.equal(refOf("projects/acme-prod/secrets/linear/versions/3")?.args[3], "3");
  assert.deepEqual(refOf("bw://be8e0ad8-d545-4017-a55a-b02f014d4158"), { store: "bw", cmd: "bws", args: ["secret", "get", "be8e0ad8-d545-4017-a55a-b02f014d4158", "--output", "json"], json: true });
  assert.equal(refOf("keychain://dovre/LINEAR_API_KEY")?.store, "keychain");
  // The key itself, or something that only looks like a reference: never a command.
  for (const v of ["lin_api_12345", "", "op://vault", "op://-v/x/y\nz", "https://evil.example/secrets/x", "https://a.vault.azure.net/secrets/x --query", "aws://", "aws://a b", "projects/--x/secrets/y", "bw://not-a-uuid", "keychain://a/b/c", `op://${"v".repeat(700)}/i/f`])
    assert.equal(refOf(v), undefined, v);
});

test("readRef: the key without the newline; bws's JSON value; an empty one or a refusal says why", async () => {
  const { cli } = fakeCli({ "op://P/L/f": "k1", "be8e0ad8-d545-4017-a55a-b02f014d4158": JSON.stringify({ value: "k2" }), "op://P/E/f": "", "op://P/N/f": { why: "op: item not found" } });
  assert.deepEqual(await readRef(refOf("op://P/L/f")!, cli), { ok: true, value: "k1" });
  assert.deepEqual(await readRef(refOf("bw://be8e0ad8-d545-4017-a55a-b02f014d4158")!, cli), { ok: true, value: "k2" });
  assert.deepEqual(await readRef(refOf("op://P/E/f")!, cli), { ok: false, why: "it's empty in 1Password" });
  assert.deepEqual(await readRef(refOf("op://P/N/f")!, cli), { ok: false, why: "op: item not found" });
});

test("createKeys: references are read into env; an unread one is taken out, with why; the plain ones stay", async () => {
  const env: Record<string, string | undefined> = { A_KEY: "op://P/A/f", B_KEY: "op://P/B/f", PLAIN: "lin_api_1" };
  const { cli, calls } = fakeCli({ "op://P/A/f": "key-a", "op://P/B/f": { why: "op: not signed in" } });
  const keys = createKeys(env, { cli });
  assert.equal(env.A_KEY, undefined, "never the reference, even before it's read");
  await keys.read();
  assert.deepEqual(env, { A_KEY: "key-a", PLAIN: "lin_api_1" });
  assert.deepEqual(keys.state("A_KEY"), { from: "op" });
  assert.deepEqual(keys.state("B_KEY"), { unread: "op: not signed in" });
  assert.equal(keys.state("PLAIN"), undefined);
  assert.deepEqual(keys.unread(), { B_KEY: "op: not signed in" });
  assert.equal(calls.length, 2);
  // A pack needing B is off, saying why.
  const p: Pack = { manifest: { api: PACK_API, id: "b", name: "B", description: "", domain: "work", settings: [{ key: "B_KEY", label: "Key", secret: true, required: true }] } };
  assert.equal(activePacks([p], { env, unread: keys.unread(), hosted: false }).off[0]?.why, "can't read B_KEY: op: not signed in");
});

test("createKeys.save: a reference is kept in .dev.vars; a pasted key goes to the Keychain over stdin, on a Mac only", async () => {
  const varsFile = join(mkdtempSync(join(tmpdir(), "dovre-keys-")), ".dev.vars");
  writeFileSync(varsFile, "");
  const env: Record<string, string | undefined> = {};
  const { cli, calls } = fakeCli({ "op://P/A/f": "key-a" });
  const keys = createKeys(env, { varsFile, cli, mac: true });

  await keys.save("A_KEY", "op://P/A/f");
  assert.equal(env.A_KEY, "key-a");
  assert.match(readFileSync(varsFile, "utf8"), /^A_KEY=op:\/\/P\/A\/f$/m);

  const pasted = `p"a\\s$s'w`;
  await keys.save("B_KEY", pasted);
  assert.equal(env.B_KEY, pasted);
  const put = calls.find((c) => c.args[0] === "-i")!;
  assert.equal(put.input, `add-generic-password -U -s dovre -a B_KEY -w "p\\"a\\\\s$s'w"\n`);
  assert.ok(!put.args.some((a) => a.includes("p\"a")), "never on the command line");
  const vars = readFileSync(varsFile, "utf8");
  assert.match(vars, /^B_KEY=keychain:\/\/dovre\/B_KEY$/m);
  assert.doesNotMatch(vars, /p"a/);
  assert.deepEqual(keys.state("B_KEY"), { from: "keychain" });

  await keys.clear("B_KEY");
  assert.ok(calls.some((c) => c.args[0] === "delete-generic-password" && c.args.includes("B_KEY")));
  assert.equal(env.B_KEY, undefined);
  assert.doesNotMatch(readFileSync(varsFile, "utf8"), /B_KEY/);

  await assert.rejects(keys.save("b; rm", "x"), /isn't a setting's name/);

  // Not a Mac: the pasted key goes to .dev.vars, as before.
  const elsewhere = createKeys({}, { varsFile, cli, mac: false });
  await elsewhere.save("C_KEY", "plain-c");
  assert.match(readFileSync(varsFile, "utf8"), /^C_KEY=plain-c$/m);
  assert.equal(elsewhere.state("C_KEY"), undefined);
});

/** A store's REST API: each call recorded, answered by `answer` (a JSON body, or a status). */
function fakeFetch(answer: (url: string, init: RequestInit) => unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const a = answer(url, init);
    return typeof a === "number" ? Response.json({ error: { code: "Forbidden", message: `nope ${H}` } }, { status: a }) : Response.json(a);
  };
  return { fetch, calls };
}
const header = (init: RequestInit, k: string) => (init.headers as Record<string, string>)[k];

test("hostedKeys: references are taken out of the vars; a store without its secrets, or machine-only, says so", async () => {
  const env: Record<string, string | undefined> = { A_KEY: "https://dv1.vault.azure.net/secrets/a", B_KEY: "bw://00000000-0000-0000-0000-000000000000", C_KEY: "keychain://dovre/C", PLAIN: "x" };
  const { fetch, calls } = fakeFetch(() => 500);
  const keys = hostedKeys(env, { fetch });
  assert.deepEqual(env, { PLAIN: "x" });
  assert.match(keys.unread().A_KEY!, /not read yet from Azure Key Vault/);
  await keys.read();
  assert.equal(calls.length, 0, "no credential, no call");
  assert.match(keys.unread().A_KEY!, /set AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET as the Worker's secrets/);
  assert.match(keys.unread().B_KEY!, /Bitwarden reference, read only on a machine/);
  assert.match(keys.unread().C_KEY!, /the Keychain reference, read only on a machine/);
  await assert.rejects(keys.save("A_KEY", "x"));
});

test("hostedKeys: Azure Key Vault, one sign-in for two keys, a refusal by its code only", async () => {
  const env: Record<string, string | undefined> = { A_KEY: "https://dv1.vault.azure.net/secrets/a", B_KEY: "https://dv1.vault.azure.net/secrets/b/", AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c", AZURE_CLIENT_SECRET: "s" };
  const { fetch, calls } = fakeFetch((url) => (url.includes("login.microsoftonline.com/t/") ? { access_token: "tok", expires_in: 3600 } : url.includes("/secrets/a?") ? { value: "a-key" } : 403));
  const keys = hostedKeys(env, { fetch });
  assert.equal(await keys.read(), true);
  assert.equal(env.A_KEY, "a-key");
  assert.deepEqual(keys.state("A_KEY"), { from: "akv" });
  assert.equal(calls.filter((c) => c.url.includes("login")).length, 1);
  assert.equal(String(calls[0]!.init.body).includes("scope=https%3A%2F%2Fvault.azure.net%2F.default"), true);
  assert.equal(header(calls[1]!.init, "authorization"), "Bearer tok");
  assert.match(calls.find((c) => c.url.includes("/secrets/b"))!.url, /\/secrets\/b\?api-version=7\.4$/);
  assert.equal(keys.unread().B_KEY, "Azure Key Vault answered 403 (Forbidden)");
  assert.doesNotMatch(JSON.stringify(keys.unread()), /nope/, "never the body");
});

test("hostedKeys: GCP Secret Manager, a service account's signed assertion", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = JSON.stringify({ client_email: "dovre@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://evil.example/token" });
  const env: Record<string, string | undefined> = { G_KEY: "projects/my-proj/secrets/linear/versions/3", GCP_SERVICE_ACCOUNT: sa };
  const { fetch, calls } = fakeFetch((url) => (url === "https://oauth2.googleapis.com/token" ? { access_token: "gtok", expires_in: 3600 } : { payload: { data: Buffer.from("g-key ✓").toString("base64") } }));
  const keys = hostedKeys(env, { fetch });
  await keys.read();
  assert.equal(env.G_KEY, "g-key ✓");
  const jwt = new URLSearchParams(String(calls[0]!.init.body)).get("assertion")!;
  const [h, c, sig] = jwt.split(".");
  assert.equal(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, "base64url")), true);
  assert.equal(JSON.parse(Buffer.from(c!, "base64url").toString()).iss, "dovre@p.iam.gserviceaccount.com");
  assert.equal(calls[1]!.url, "https://secretmanager.googleapis.com/v1/projects/my-proj/secrets/linear/versions/3:access");
  assert.ok(!calls.some((x) => x.url.includes("evil")), "the key file's token_uri is never used");

  const bad = { G_KEY: "projects/my-proj/secrets/linear", GCP_SERVICE_ACCOUNT: "{" };
  const k2 = hostedKeys(bad, { fetch });
  await k2.read();
  assert.match(k2.unread().G_KEY!, /isn't a service account's JSON key/);
});

test("hostedKeys: AWS Secrets Manager, signed as SigV4 has it; the region from the ARN or AWS_REGION", async () => {
  const at = Date.UTC(2026, 10, 8, 12, 0, 0);
  const env: Record<string, string | undefined> = { A_KEY: "arn:aws:secretsmanager:eu-north-1:123456789012:secret:linear-AbCdEf", B_KEY: "aws://other", AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "SECRET" };
  const { fetch, calls } = fakeFetch(() => ({ SecretString: "aws-key" }));
  const keys = hostedKeys(env, { fetch, now: () => at });
  await keys.read();
  assert.equal(env.A_KEY, "aws-key");
  assert.match(keys.unread().B_KEY!, /set AWS_REGION/);
  const { url, init } = calls[0]!;
  assert.equal(url, "https://secretsmanager.eu-north-1.amazonaws.com/");
  assert.equal(header(init, "x-amz-target"), "secretsmanager.GetSecretValue");
  // The signature, worked out again here with node:crypto.
  const body = String(init.body);
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();
  const canonical = `POST\n/\n\ncontent-type:application/x-amz-json-1.1\nhost:secretsmanager.eu-north-1.amazonaws.com\nx-amz-date:20261108T120000Z\nx-amz-target:secretsmanager.GetSecretValue\n\ncontent-type;host;x-amz-date;x-amz-target\n${sha(body)}`;
  const scope = "20261108/eu-north-1/secretsmanager/aws4_request";
  const kSign = hmac(hmac(hmac(hmac("AWS4SECRET", "20261108"), "eu-north-1"), "secretsmanager"), "aws4_request");
  const sig = createHmac("sha256", kSign).update(`AWS4-HMAC-SHA256\n20261108T120000Z\n${scope}\n${sha(canonical)}`).digest("hex");
  assert.equal(header(init, "authorization"), `AWS4-HMAC-SHA256 Credential=AKID/${scope}, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=${sig}`);
  assert.deepEqual(JSON.parse(body), { SecretId: env.A_KEY === "aws-key" ? "arn:aws:secretsmanager:eu-north-1:123456789012:secret:linear-AbCdEf" : "" });

  env.AWS_REGION = "eu-west-1";
  await keys.read(["B_KEY"]);
  assert.equal(env.B_KEY, "aws-key");
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { SecretId: "other" });
});

test("hostedKeys: 1Password Connect, vault and item by name, a field in a section", async () => {
  const env: Record<string, string | undefined> = { A_KEY: 'op://Private/My "Linear"/api/credential', B_KEY: "op://Private/Nope/credential", OP_CONNECT_HOST: "https://connect.example.dev/", OP_CONNECT_TOKEN: "ctok" };
  const { fetch, calls } = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === "/v1/vaults") return u.searchParams.get("filter") === 'name eq "Private"' ? [{ id: "v1" }] : [];
    if (u.pathname === "/v1/vaults/v1/items") return u.searchParams.get("filter") === 'title eq "My \\"Linear\\""' ? [{ id: "i1" }] : [];
    if (u.pathname === "/v1/vaults/v1/items/i1") return { sections: [{ id: "s1", label: "api" }], fields: [{ id: "credential", label: "credential", value: "wrong" }, { id: "f2", label: "credential", value: "op-key", section: { id: "s1" } }] };
    return 404;
  });
  const keys = hostedKeys(env, { fetch });
  await keys.read();
  assert.equal(env.A_KEY, "op-key");
  assert.match(keys.unread().B_KEY!, /1Password Connect has no item "Nope"/);
  assert.ok(calls.every((c) => c.url.startsWith("https://connect.example.dev/v1/") && header(c.init, "authorization") === "Bearer ctok"));

  const plain = { A_KEY: "op://P/I/f", OP_CONNECT_HOST: "http://connect.example.dev", OP_CONNECT_TOKEN: "t" };
  const k2 = hostedKeys(plain, { fetch });
  await k2.read();
  assert.match(k2.unread().A_KEY!, /isn't an https:\/\/ address/);
});

test("createWorker: a pack whose key is a store's reference starts off, and is on once the start read it", async () => {
  const stmt = { bind: () => stmt, all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: { changes: 0, last_row_id: 0 } }) };
  const DB = { prepare: () => stmt, batch: async () => [] } as unknown as D1;
  const seen: string[] = [];
  const linear: Pack = { manifest: { api: PACK_API, id: "linear", name: "Linear", description: "", domain: "work", execution: "any", settings: [{ key: "LINEAR_API_KEY", label: "API key", secret: true, required: true }] }, init: (c) => void seen.push(`init ${c.env.LINEAR_API_KEY}`) };
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "tok", expires_in: 3600 });
    if (url.startsWith("https://dv1.vault.azure.net/")) return Response.json({ value: "lin-key" });
    return real(input as RequestInfo);
  }) as typeof fetch;
  try {
    const worker = createWorker({ packs: [linear] });
    await worker.fetch(new Request("https://dovre.example.dev/"), { DB, IS_HOSTED: "1", CF_ACCESS_TEAM: "team", CF_ACCESS_AUD: "aud", LINEAR_API_KEY: "https://dv1.vault.azure.net/secrets/linear", AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c", AZURE_CLIENT_SECRET: "s" } as never);
    assert.deepEqual(seen, ["init lin-key"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("Settings → a pack: a key's store, why one can't be read (escaped), Read again turns it on", async () => {
  const varsFile = join(mkdtempSync(join(tmpdir(), "dovre-keys-")), ".dev.vars");
  writeFileSync(varsFile, "LINEAR_API_KEY=op://P/Linear/f\n");
  const answers: Record<string, string | { why: string }> = { "op://P/Linear/f": { why: `op: ${H}` }, "op://P/Other/f": "other-key" };
  const { cli } = fakeCli(answers);
  const packEnv: Record<string, string> = { LINEAR_API_KEY: "op://P/Linear/f", OTHER_KEY: "op://P/Other/f" };
  const keys = createKeys(packEnv, { varsFile, cli, mac: true });
  await keys.read();
  const linear: Pack = {
    manifest: { api: PACK_API, id: "linear", name: "Linear", description: "", domain: "work", settings: [{ key: "LINEAR_API_KEY", label: "API key", secret: true, required: true }, { key: "OTHER_KEY", label: "Other", secret: true }] },
    routes: (app, ctx) => app.get("/linear", (c) => ctx.page(c, { title: "Linear", body: html`<p>on</p>` })),
  };
  const { get, post, app } = signedIn(snapshot(), {}, { packs: [linear], packEnv, varsFile, keys });

  assert.equal((await get("/linear")).status, 404);
  const page = await (await get("/settings/packs/linear")).text();
  assertInert("settings with an unread key", page);
  assert.match(page, /can&#39;t read the key|can't read the key/);
  assert.match(page, /from 1Password/);
  assert.doesNotMatch(page, /other-key/, "a read key is never shown");
  assert.match(page, /action="\/packs\/linear\/keys"/);
  assertInert("packs page with an unread key", await (await get("/packs")).text());

  // Strict origin, as every write.
  assert.equal((await app.request("http://localhost/packs/linear/keys", { method: "POST", headers: { cookie: "u_tk=test-token", origin: "https://evil.example" } })).status, 403);
  // Signed in to 1Password now: Read again turns it on.
  answers["op://P/Linear/f"] = "lin-key";
  const again = await post("/packs/linear/keys", {});
  assert.equal(again.status, 303);
  assert.equal((await get("/linear")).status, 200);
  assert.equal(packEnv.LINEAR_API_KEY, "lin-key");
  // Nothing to read again for a pack without a stored key.
  assert.equal((await post("/packs/nope/keys", {})).status, 404);
});
