/**
 * GitHub as the person (#523, src/hosted/login/tokens.ts): sealed user tokens, refreshed before
 * they expire, rotation written only over the refresh token it started from, a refused refresh
 * marks the row revoked, and the operator is GITHUB_USER's row, else ALLOWED_EMAILS in order.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { appTokens, grantOf, keepGrant, MISS_MS, REFRESH_BEFORE_MS } from "../src/hosted/login/tokens.ts";
import { seal, unseal } from "../src/seal.ts";
import { appTokenProvider } from "../src/worker.ts";

const SEAL = "k".repeat(40);
const APP = { clientId: "Iv23abc", clientSecret: "cs_secret" };
const T0 = Date.parse("2026-11-14T12:00:00Z");
const H = 3_600_000;
const grant = (n: string, at = T0) => ({ access: `ghu_${n}`, accessExpiresAt: at + 8 * H, refresh: `ghr_${n}`, refreshExpiresAt: at + 180 * 24 * H });

/** GitHub's token endpoint: hands out ghu_/ghr_ <n> for each refresh, or refuses. */
function fakeRefresh(o: { refuse?: string; down?: boolean } = {}) {
  const seen: URLSearchParams[] = [];
  let n = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://github.com/login/oauth/access_token");
    if (o.down) throw new Error("network down");
    seen.push(new URLSearchParams(String(init?.body)));
    if (o.refuse) return new Response(JSON.stringify({ error: o.refuse }));
    n++;
    return new Response(JSON.stringify({ access_token: `ghu_r${n}`, expires_in: 28800, refresh_token: `ghr_r${n}`, refresh_token_expires_in: 15897600 }));
  }) as typeof fetch;
  return { f, seen };
}

test("grantOf: GitHub's answer in ms, and nothing for a token that doesn't expire", () => {
  assert.deepEqual(grantOf({ access_token: "a", expires_in: 10, refresh_token: "r", refresh_token_expires_in: 20 }, 1000), { access: "a", accessExpiresAt: 11_000, refresh: "r", refreshExpiresAt: 21_000 });
  assert.equal(grantOf({ access_token: "a" }, 0), undefined);
  assert.equal(grantOf({ access_token: "a", refresh_token: "r", expires_in: -1, refresh_token_expires_in: 5 }, 0), undefined);
});

test("seal: opens only with its secret and in its own row", async () => {
  const s = await seal(SEAL, "a@x:access", "ghu_1");
  assert.equal(await unseal(SEAL, "a@x:access", s), "ghu_1");
  assert.equal(await unseal(SEAL, "b@x:access", s), undefined);
  assert.equal(await unseal("j".repeat(40), "a@x:access", s), undefined);
});

test("a token near its end is refreshed once, the rotated refresh token kept, and cached until then", async () => {
  const { DB } = openDb();
  let t = T0;
  await keepGrant(DB, SEAL, "Me@x.dev", "me", grant("1"), T0);
  const gh = fakeRefresh();
  const tokens = appTokens({ db: DB, secret: SEAL, app: APP, allowedEmails: ["me@x.dev"], fetch: gh.f, now: () => t });
  assert.equal(await tokens.forEmail("me@x.dev"), "ghu_1");
  assert.equal(gh.seen.length, 0);

  t = T0 + 8 * H - REFRESH_BEFORE_MS + 1;
  const [a, b] = await Promise.all([tokens.forEmail("me@x.dev"), tokens.forEmail("me@x.dev")]);
  assert.deepEqual([a, b], ["ghu_r1", "ghu_r1"], "one refresh for both");
  assert.equal(gh.seen.length, 1);
  assert.deepEqual([gh.seen[0]!.get("grant_type"), gh.seen[0]!.get("refresh_token"), gh.seen[0]!.get("client_secret")], ["refresh_token", "ghr_1", "cs_secret"]);
  const row = (await DB.prepare("SELECT * FROM github_tokens").first<{ refresh_sealed: string; access_expires_at: number }>())!;
  assert.equal(await unseal(SEAL, "me@x.dev:refresh", row.refresh_sealed), "ghr_r1");
  assert.equal(row.access_expires_at, t + 8 * H);
  assert.equal(await tokens.forEmail("me@x.dev"), "ghu_r1");
  assert.equal(gh.seen.length, 1, "cached");
});

test("refresh races: the row someone else rotated first is the one used; a refusal revokes only an unchanged row", async () => {
  const { DB } = openDb();
  const t = T0 + 8 * H - 60_000 * 5;
  await keepGrant(DB, SEAL, "me@x.dev", "me", grant("1"), T0);
  // Another isolate rotates between this one's read and its write: this one's write doesn't land.
  let raced = false;
  const f = (async () => {
    if (!raced) {
      raced = true;
      await keepGrant(DB, SEAL, "me@x.dev", "me", grant("theirs", t), t);
    }
    return new Response(JSON.stringify({ access_token: "ghu_mine", expires_in: 28800, refresh_token: "ghr_mine", refresh_token_expires_in: 15897600 }));
  }) as typeof fetch;
  assert.equal(await appTokens({ db: DB, secret: SEAL, app: APP, allowedEmails: ["me@x.dev"], fetch: f, now: () => t }).forEmail("me@x.dev"), "ghu_theirs");
  const row = (await DB.prepare("SELECT refresh_sealed FROM github_tokens").first<{ refresh_sealed: string }>())!;
  assert.equal(await unseal(SEAL, "me@x.dev:refresh", row.refresh_sealed), "ghr_theirs");

  // A refused refresh of a token that's still good for a few minutes: that one's used, and the row is revoked.
  const { DB: db2 } = openDb();
  await keepGrant(db2, SEAL, "me@x.dev", "me", grant("1"), T0);
  const tokens = appTokens({ db: db2, secret: SEAL, app: APP, allowedEmails: ["me@x.dev"], fetch: fakeRefresh({ refuse: "bad_refresh_token" }).f, now: () => t });
  assert.equal(await tokens.forEmail("me@x.dev"), "ghu_1");
  assert.equal((await db2.prepare("SELECT status FROM github_tokens").first<{ status: string }>())!.status, "revoked");
  const later = appTokens({ db: db2, secret: SEAL, app: APP, allowedEmails: ["me@x.dev"], fetch: fakeRefresh().f, now: () => t });
  assert.equal(await later.forEmail("me@x.dev"), undefined, "revoked until the next sign-in");
  await keepGrant(db2, SEAL, "me@x.dev", "me", grant("2", t), t);
  assert.equal(await appTokens({ db: db2, secret: SEAL, app: APP, allowedEmails: ["me@x.dev"], now: () => t }).forEmail("me@x.dev"), "ghu_2");

  // GitHub unreachable: a token with time left is still used; an expired one isn't.
  const { DB: db3 } = openDb();
  await keepGrant(db3, SEAL, "me@x.dev", "me", grant("1"), T0);
  assert.equal(await appTokens({ db: db3, secret: SEAL, app: APP, allowedEmails: ["me@x.dev"], fetch: fakeRefresh({ down: true }).f, now: () => t }).forEmail("me@x.dev"), "ghu_1");
  assert.equal(await appTokens({ db: db3, secret: SEAL, app: APP, allowedEmails: ["me@x.dev"], fetch: fakeRefresh({ down: true }).f, now: () => T0 + 9 * H }).forEmail("me@x.dev"), undefined);
  assert.equal((await db3.prepare("SELECT status FROM github_tokens").first<{ status: string }>())!.status, "ok", "a network failure revokes nothing");
});

test("the operator: GITHUB_USER's row, else ALLOWED_EMAILS in order; an email no longer allowed is never used", async () => {
  const { DB } = openDb();
  let t = T0;
  await keepGrant(DB, SEAL, "b@x.dev", "bee", grant("b"), T0);
  await keepGrant(DB, SEAL, "a@x.dev", "ay", grant("a"), T0);
  const mk = (allowedEmails: string[], operatorLogin?: string) => appTokens({ db: DB, secret: SEAL, app: APP, allowedEmails, operatorLogin, now: () => t });
  assert.equal(await mk(["a@x.dev", "b@x.dev"], "Bee").operator(), "ghu_b");
  assert.equal(await mk(["a@x.dev", "b@x.dev"]).operator(), "ghu_a");
  assert.equal(await mk(["b@x.dev", "a@x.dev"], "nobody").operator(), "ghu_b");
  assert.equal(await mk(["a@x.dev"], "bee").operator(), "ghu_a", "bee's email isn't allowed any more");
  assert.equal(await mk(["a@x.dev"]).forEmail("b@x.dev"), undefined);

  // Nobody yet: D1 is asked again only after MISS_MS, so a new sign-in shows within that.
  const { DB: empty } = openDb();
  let reads = 0;
  const counted = { prepare: (sql: string) => (reads++, empty.prepare(sql)), batch: empty.batch.bind(empty) };
  const none = appTokens({ db: counted, secret: SEAL, app: APP, allowedEmails: ["a@x.dev"], operatorLogin: "ay", now: () => t });
  assert.equal(await none.operator(), undefined);
  const after = reads;
  assert.equal(await none.operator(), undefined);
  assert.equal(reads, after, "no D1 read on every call");
  await keepGrant(empty, SEAL, "a@x.dev", "ay", grant("a", t), t);
  t += MISS_MS + 1;
  assert.equal(await none.operator(), "ghu_a");
});

test("the Worker's provider: a person's own token for their write, else the operator's, else GITHUB_TOKEN; off without the login, app or seal", async () => {
  const { DB } = openDb();
  const now = Date.now();
  await keepGrant(DB, SEAL, "op@x.dev", "op", grant("op", now), now);
  await keepGrant(DB, SEAL, "two@x.dev", "two", grant("two", now), now);
  const b = { DB, AUTH_MODE: "passkey", GITHUB_APP_CLIENT_ID: "Iv23abc", GITHUB_APP_CLIENT_SECRET: "cs", GITHUB_TOKEN_SEAL: SEAL, ALLOWED_EMAILS: "op@x.dev,two@x.dev,three@x.dev", GITHUB_USER: "op", GITHUB_TOKEN: "ghp_broad" };
  const p = appTokenProvider(b as never)!;
  assert.equal(await p(b as never, { email: "two@x.dev" }), "ghu_two");
  assert.equal(await p(b as never, { email: "three@x.dev" }), "ghu_op", "no token of their own: the instance's, as before");
  assert.equal(await p(b as never), "ghu_op");

  const { DB: empty } = openDb();
  const e = { ...b, DB: empty };
  assert.equal(await appTokenProvider(e as never)!(e as never), "ghp_broad");
  const bare = { ...e, GITHUB_TOKEN: undefined };
  await assert.rejects(appTokenProvider(bare as never)!(bare as never), /sign in with GitHub once/);

  assert.equal(appTokenProvider({ ...b, AUTH_MODE: undefined } as never), undefined);
  assert.equal(appTokenProvider({ ...b, GITHUB_TOKEN_SEAL: "short" } as never), undefined);
  assert.equal(appTokenProvider({ ...b, GITHUB_APP_CLIENT_SECRET: undefined } as never), undefined);
});
