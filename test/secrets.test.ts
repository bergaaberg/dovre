import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { html } from "hono/html";
import { activePacks } from "../src/packs/registry.ts";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { type Cli, createKeys, readRef, refOf } from "../src/secrets.ts";
import { hostedKeys } from "../src/secretrefs.ts";
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

test("hostedKeys: a reference among the Worker's vars is taken out, its pack off saying why", () => {
  const env: Record<string, string | undefined> = { A_KEY: "op://P/A/f", PLAIN: "x" };
  const keys = hostedKeys(env);
  assert.deepEqual(env, { PLAIN: "x" });
  assert.match(keys.unread().A_KEY!, /1Password reference, read only on a machine for now/);
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
