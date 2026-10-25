/**
 * The query agent: told the question and table names only, proposes one read-only query as a card I
 * run, and sees rows only when I press Review. Its model is a fake here; in Dovre it's a Copilot
 * model through omp, never Claude.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { createDataAgent, databasesPart, picksOf, pickPrompt, proposalOf, queryPrompt, reviewPrompt, schemaPart, sqlOk } from "../src/data/agent.ts";
import { createData } from "../src/data/db.ts";
import { createSchemas, schemaOf } from "../src/data/schema.ts";
import { openDb } from "../src/db.ts";
import { assertInert, fakeGhe, fixedGatherer, H, snapshot } from "./helpers.ts";
import { setDataNames } from "../src/data/db.ts";

// The names an org's db CLI uses: its test databases' prefix, and a DB2 database with no test copy.
setDataNames({ prefix: "acme-sqldb-", db2: "warehouse" });

const ROWS = [
  { s: "dbo", t: "Kunde", c: "KundeId", ty: "int" },
  { s: "dbo", t: "Kunde", c: "Navn", ty: "nvarchar" },
  { s: "dbo", t: "Abonnement", c: "AbonnementId", ty: "int" },
  { s: "dbo", t: "Abonnement", c: "KundeId", ty: "int" },
];
const SCHEMA = schemaOf(ROWS, "ledger:at", 1);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await tick();
  assert.ok(ok(), "timed out");
};

test("only one read-only query passes: SELECT or WITH, nothing that writes, one statement", () => {
  assert.equal(sqlOk("SELECT TOP 10 * FROM dbo.Kunde;"), "SELECT TOP 10 * FROM dbo.Kunde");
  assert.equal(sqlOk("with x as (select 1 a) select * from x"), "with x as (select 1 a) select * from x");
  assert.equal(sqlOk("SELECT * FROM dbo.Kunde WHERE Navn = 'delete me; now'"), "SELECT * FROM dbo.Kunde WHERE Navn = 'delete me; now'", "words inside a string are text");
  for (const bad of ["DELETE FROM dbo.Kunde", "SELECT * INTO dbo.Copy FROM dbo.Kunde", "SELECT 1; DROP TABLE dbo.Kunde", "EXEC sp_who", "UPDATE dbo.Kunde SET Navn = ''", "", "SELECT * FROM OPENROWSET('x')", 42])
    assert.equal(sqlOk(bad), undefined, String(bad));
});

test("the agent's answer: the JSON in its text, a query or a question back; anything else is nothing", () => {
  assert.deepEqual(proposalOf('Here:\n```json\n{"sql": "SELECT COUNT(*) FROM dbo.Abonnement", "says": "Antall abonnement"}\n```'), { proposal: { sql: "SELECT COUNT(*) FROM dbo.Abonnement", says: "Antall abonnement" } });
  assert.deepEqual(proposalOf('I think {so}. {"ask": "Hvilken periode?"}'), { back: "Hvilken periode?" });
  assert.equal(proposalOf('{"sql": "DELETE FROM dbo.Kunde"}'), null, "a write is no proposal");
  assert.equal(proposalOf("no json here"), null);
});

test("the prompt holds the question and names, never rows; a big schema sends the tables that fit", () => {
  const p = queryPrompt("Hvor mange abonnement har hver kunde?", "ledger:prod", SCHEMA);
  assert.match(p, /dbo\.Kunde\(KundeId int, Navn nvarchar\)/);
  assert.match(p, /ledger:prod; T-SQL/);
  const big = schemaOf(
    Array.from({ length: 3000 }, (_, i) => ({ s: "dbo", t: i === 2500 ? "Brukerlogg" : `Tabell${i}`, c: `Kolonne${i % 40}_${"x".repeat(20)}`, ty: "nvarchar" })),
    "x:at",
    1,
  );
  const part = schemaPart("Vis brukerlogger fra i går", big);
  assert.ok(part.length < 60_000, String(part.length));
  assert.match(part, /All tables: dbo\.Tabell0, /);
  assert.match(part, /Columns of the tables that seem to fit the question:\ndbo\.Brukerlogg\(/);
  const r = reviewPrompt("q", "SELECT 1", { columns: ["a"], rows: Array.from({ length: 300 }, (_, i) => ({ a: i })), capped: false, ms: 1 });
  assert.match(r, /300 rows, the first 100 shown/);
  assert.doesNotMatch(r, /\n150\n/);
});

/** A model that answers from a script, and remembers what it was told. */
function fakeAsker(answers: string[]) {
  const told: string[] = [];
  return { told, asker: { model: "github-copilot/fake", why: () => undefined, ask: async (p: string) => (told.push(p), answers.shift() ?? "{}") } };
}

test("through the app: a question becomes a card to run; Review gives that run's rows to the agent; prod stays shut until I open it", async () => {
  const f = fakeAsker([
    JSON.stringify({ sql: `SELECT TOP 100 k.Navn, COUNT(*) AS n FROM dbo.Kunde k JOIN dbo.Abonnement a ON a.KundeId = k.KundeId GROUP BY k.Navn -- ${H}`, says: `Abonnement per kunde ${H}` }),
    `Kari har flest. ${H}\n{"sql": "SELECT TOP 10 * FROM dbo.Kunde", "says": "Bare kundene"}`,
    JSON.stringify({ sql: "SELECT 1", says: "x" }),
  ]);
  const cli: { args: string[]; input?: string }[] = [];
  const data = createData({ bin: "db", run: async (_b, args, o) => (cli.push({ args, input: o.input }), { code: 0, stdout: args.some((a) => a.includes("LIMIT 60001")) ? JSON.stringify(ROWS) : args[0] === "ls" ? "acme-sqldb-ledger-at" : JSON.stringify([{ Navn: "SECRET-ROW-Kari", n: 3 }]), stderr: "" }) });
  const db = openDb();
  // Production, never opened here: every read refuses.
  const shut = async () => assert.fail("production was read");
  const prod = { state: () => ({ state: "closed" as const }), open() {}, close() {}, opened: () => [], asking: () => [], tables: shut, cols: shut, find: shut, peek: shut, query: shut };
  const app = createApp({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", DATA_PREFIX: "acme-sqldb-", DATA_DB2: "warehouse", DB: db.DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, data, prod, dataAsker: f.asker });
  const get = (path: string) => app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });
  const post = (path: string, body: Record<string, string>) => app.request(`http://localhost${path}`, { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

  assert.match(await (await get("/data/db?t=ledger%3Aat")).text(), /Ask in plain words/);
  const asked = await post("/data/ask", { t: "ledger:at", question: "Hvor mange abonnement har hver kunde, f.eks. fnr 01017012345?" });
  const at = asked.headers.get("location")!;
  assert.match(at, /^\/data\/ask\/[0-9a-f-]{36}$/);
  await until(() => f.told.length === 1);
  await tick(30);
  assert.match(f.told[0]!, /fnr 01017012345/, "the question goes to the Copilot model");
  assert.match(f.told[0]!, /dbo\.Abonnement\(AbonnementId int, KundeId int\)/);
  assert.doesNotMatch(f.told[0]!, /SECRET-ROW/, "never a row with the question");
  const card = await (await get(at)).text();
  assertInert("ask page", card);
  assert.match(card, /action="\/data\/q"/);
  assert.match(card, /<input type="hidden" name="ask" value="[0-9a-f-]{36}">/);
  assert.match(card, /github-copilot\/fake/);

  const id = at.split("/").pop()!;
  const sql = "SELECT TOP 100 k.Navn FROM dbo.Kunde k";
  const result = await (await post("/data/q", { t: "ledger:at", sql, ask: id })).text();
  assert.match(result, /SECRET-ROW-Kari/, "I see the rows");
  assert.match(result, /Review this result/);
  assert.equal(f.told.length, 1, "running gives the agent nothing");
  assert.doesNotMatch(await (await post("/data/q", { t: "ledger:at", sql })).text(), /Review this result/, "no review for a query of my own");

  const reviewed = await post(`/data/ask/${id}/review`, { t: "ledger:at", sql });
  assert.equal(reviewed.headers.get("location"), `${at}#review`);
  await until(() => f.told.length === 2);
  assert.match(f.told[1]!, /SECRET-ROW-Kari\t3/, "Review gives it that run's rows");
  await tick(30);
  const after = await (await get(at)).text();
  assertInert("reviewed", after);
  assert.match(after, /What the result says/);
  assert.match(after, /A better query/);
  assert.equal((await post(`/data/ask/${id}/review`, { t: "shop:at", sql })).status, 404, "only on the database it was asked about");

  // The log: which database, never the question or rows.
  const log = await db.DB.prepare("SELECT kind, target, detail FROM actions ORDER BY id").all<{ kind: string; target: string; detail: string | null }>();
  assert.deepEqual(log.results.map((r) => [r.kind, r.target]), [["data.ask", "ledger:at"], ["data.review", "ledger:at"]]);
  assert.doesNotMatch(JSON.stringify(log.results), /fnr|SECRET/);

  // Production: the names come from at; a review needs the database open, and nothing reaches the model before.
  const prodAsk = (await post("/data/ask", { t: "ledger:prod", question: "Antall kunder" })).headers.get("location")!;
  await until(() => f.told.length === 3);
  const pid = prodAsk.split("/").pop()!;
  const gate = await (await post(`/data/ask/${pid}/review`, { t: "ledger:prod", sql: "SELECT 1" })).text();
  assert.match(gate, /Ask to open ledger:prod/);
  assert.equal(f.told.length, 3);
  assert.ok(cli.every((c) => !c.args.some((a) => /prod/.test(a))), "the CLI never touched production");
  assert.equal((await post("/data/ask", { t: "ledger:pre", question: "x" })).status, 404, "never pre");
});

test("an agent that can't run says why, and nothing is asked", async () => {
  const schemas = createSchemas({ read: async () => JSON.stringify(ROWS) });
  let asked = 0;
  const a = createDataAgent({ asker: { model: "x", why: () => "Set up the omp profile dovre-copilot once", ask: async () => (asked++, "") }, schemas });
  const j = a.start("ledger:at", "x");
  assert.equal(j.state, "failed");
  assert.match(j.error!, /omp profile/);
  assert.equal(createDataAgent({ schemas }).start("ledger:at", "x").error, "The query agent is off (DATA_AGENT=off).");
  assert.equal(createDataAgent({ asker: { model: "x", why: () => undefined, ask: async () => "" }, schemas }).start("warehouse:prod", "x").state, "failed");
  assert.equal(asked, 0);
});

// ── One question across databases (WP-A21) ──

test("the pick prompt: the question and each app's table names, never columns; production only when it may be picked", () => {
  const dbs = [{ app: "ledger", tables: ["dbo.Kunde", "dbo.Abonnement"] }, { app: "shop", tables: [] }];
  const p = pickPrompt("Hvor ligger samtykker?", dbs, ["at", "prod"]);
  assert.match(p, /Hvor ligger samtykker\?/);
  assert.match(p, /ledger: dbo\.Kunde, dbo\.Abonnement\nshop: \(no tables\)/);
  assert.match(p, /"prod" \(production, real customer data/);
  assert.match(p, /at most 4/);
  assert.doesNotMatch(pickPrompt("x", dbs, ["at"]), /production, real customer data/);
  const long = databasesPart([{ app: "big", tables: Array.from({ length: 2000 }, (_, i) => `dbo.Tabell${i}`) }]);
  assert.ok(long.length < 4100, String(long.length));
  assert.match(long, /dbo\.Tabell\d+, …$/);
});

test("picks: apps from the list in allowed environments, each once, at most four; else the question back, or nothing", () => {
  const apps = ["ledger", "shop", "billing", "external", "people"];
  assert.deepEqual(
    picksOf(
      JSON.stringify({
        picks: [
          { app: "ledger", env: "at", why: "Kunder" },
          { app: "Ledger:at", env: "at", why: "twice" },
          { app: "ledger", env: "prod", why: "Ekte tall" },
          { app: "nope", env: "at" },
          { app: "shop", env: "pre" },
          { app: "shop" },
          { app: "billing", env: "at" },
          { app: "external", env: "at" },
        ],
      }),
      apps,
      ["at", "prod"],
    ),
    { picks: [{ t: "ledger:at", why: "Kunder" }, { t: "ledger:prod", why: "Ekte tall" }, { t: "shop:at", why: "" }, { t: "billing:at", why: "" }] },
  );
  assert.deepEqual(picksOf('{"picks": [{"app": "ledger", "env": "prod"}]}', apps, ["at"]), null, "no production when it can't be opened here");
  assert.deepEqual(picksOf('{"picks": [], "ask": "Hvilket produkt?"}', apps, ["at"]), { back: "Hvilket produkt?" });
  assert.equal(picksOf("no json", apps, ["at"]), null);
});

test("through the app: one question, the agent picks databases from their table names, each gets a card to run; prod stays shut", async () => {
  const f = fakeAsker([
    JSON.stringify({ picks: [{ app: "ledger", env: "at", why: `Kunder og abonnement ${H}` }, { app: "ledger", env: "prod", why: "Ekte tall" }, { app: "nope", env: "at" }] }),
    JSON.stringify({ sql: "SELECT COUNT(*) AS n FROM dbo.Kunde", says: `Antall kunder ${H}` }),
    JSON.stringify({ sql: "SELECT COUNT(*) AS n FROM dbo.Kunde", says: "Antall kunder" }),
  ]);
  const cli: string[][] = [];
  const data = createData({
    bin: "db",
    run: async (_b, args) => {
      cli.push(args);
      if (args[0] === "ls") return { code: 0, stdout: "acme-sqldb-ledger-at\nacme-sqldb-shop-at\nacme-sqldb-broken-at", stderr: "" };
      if (args[0] === "broken:at") return { code: 1, stdout: "", stderr: "db: login failed" };
      if (args.some((a) => a.includes("LIMIT 60001"))) return { code: 0, stdout: JSON.stringify(args[0] === "ledger:at" ? ROWS : [{ s: "web", t: "Samtykke", c: "Id", ty: "int" }]), stderr: "" };
      return { code: 0, stdout: JSON.stringify([{ SECRET: "ROW" }]), stderr: "" };
    },
  });
  const db = openDb();
  const shut = async () => assert.fail("production was read");
  const prod = { state: () => ({ state: "closed" as const }), open() {}, close() {}, opened: () => [], asking: () => [], tables: shut, cols: shut, find: shut, peek: shut, query: shut };
  const app = createApp({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", DATA_PREFIX: "acme-sqldb-", DATA_DB2: "warehouse", DB: db.DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, data, prod, dataAsker: f.asker });
  const get = (path: string) => app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });
  const post = (path: string, body: Record<string, string>) => app.request(`http://localhost${path}`, { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

  const home = await (await get("/data")).text();
  assert.match(home, /Ask across databases/);
  assert.match(home, /action="\/data\/across"/);
  const asked = await post("/data/across", { question: `Hvor mange kunder har vi? ${H}` });
  const at = asked.headers.get("location")!;
  assert.match(at, /^\/data\/across\/[0-9a-f-]{36}$/);
  await until(() => f.told.length === 3);
  await tick(30);
  assert.match(f.told[0]!, /ledger: dbo\.Kunde, dbo\.Abonnement\nshop: web\.Samtykke/, "each app's table names");
  assert.doesNotMatch(f.told[0]!, /KundeId int|broken|SECRET/, "no columns, no rows, nothing of what couldn't be read");
  assert.match(f.told[1]!, /ledger:(at|prod); T-SQL/, "each card is written from its database's names");

  const page = await (await get(at)).text();
  assertInert("across", page);
  assert.equal((page.match(/action="\/data\/q"/g) ?? []).length, 2, "a card per pick; the unknown app is dropped");
  assert.match(page, /href="\/data\/db\?t=ledger%3Aat">ledger:at<\/a>/);
  assert.match(page, /ledger:prod<\/a> <span class="pill[^"]*"[^>]*>production/);
  assert.match(page, /<input type="hidden" name="ask" value="[0-9a-f-]{36}">/, "each card is reviewable like any");
  assert.match(page, /Couldn.t read the tables of broken/);
  assert.ok(cli.every((c) => !c.some((a) => /prod/.test(a))), "nothing touched production");

  const log = await db.DB.prepare("SELECT kind, target FROM actions ORDER BY id").all<{ kind: string; target: string }>();
  assert.deepEqual(log.results.map((r) => [r.kind, r.target]), [["data.ask-across", "3 databases"]]);
  assert.doesNotMatch(JSON.stringify(log.results), /kunder/i, "never the question");
  assert.equal((await get("/data/across/nope")).status, 404);
});

test("across, the agent asks back: the page has a box to answer, and the answer goes with the question", async () => {
  const schemas = createSchemas({ read: async () => JSON.stringify(ROWS) });
  const f = fakeAsker(['{"ask": "Hvilket produkt?"}']);
  const a = createDataAgent({ asker: f.asker, schemas });
  const x = a.across("Hvor mange?", { apps: ["ledger"], envs: ["at"] });
  await until(() => a.getAcross(x.id)!.state !== "picking");
  assert.equal(a.getAcross(x.id)!.state, "asks");
  assert.equal(a.getAcross(x.id)!.back, "Hvilket produkt?");
  assert.equal(a.across("x", { apps: ["warehouse"], envs: ["at"] }).state, "failed", "no test copy, nothing to pick from");
  assert.equal(f.told.length, 1);
});
