/** New work: repo forms parse as GitHub reads them, dev tasks hang under a planned issue; every create is previewed, re-checked, logged; hostile text stays text. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { recentActions } from "../src/actions/deploys.ts";
import { openDb } from "../src/db.ts";
import { listTodos } from "../src/todo/store.ts";
import type { AppEnv, Env } from "../src/env.ts";
import { agentPrompt, composeBody, emptyDraft, formPairs, isValid, labelsOf, NOTHING_OFFERED, offeredLabels, readDraft, untouched, validate } from "../src/issues/compose.ts";
import { createCatalog, isPlanning, loadTemplates, OPEN_CHOOSER, parseConfig, parseTemplate, takesIssues } from "../src/issues/templates.ts";
import { createTask, parseRef, remoteRepo } from "../src/issues/tasks.ts";
import { createIssueRoutes } from "../src/pages/issues.ts";
import { H, assertInert, fakeGhe } from "./helpers.ts";

// Shaped on ACME/FORMS's real forms (read 2026-10-22): enhancement.yml, z2-feature.yml.
const ENHANCEMENT = `name: 💡 Forbedringsforslag
description: Så du noe som kan bli bedre? Kort er fint — triage tar resten.
title: "[Forbedring] "
type: Enhancement
projects: ["ACME/6"]
body:
  - type: markdown
    attributes:
      value: |
        ### 💡 Meld en forbedring
        Ingenting er for lite.
  - type: textarea
    id: what
    attributes:
      label: Hva så du?
      placeholder: Beskriv kort det du opplevde eller foreslår.
    validations:
      required: true
  - type: dropdown
    id: area
    attributes:
      label: Område
      options:
        - Vet ikke
        - Frontend / nettflyt
    validations:
      required: false
  - type: input
    id: env
    attributes:
      label: Hvor så du det? (valgfritt)
      placeholder: Chrome på mobil, test.
  - type: textarea
    id: links
    attributes:
      label: Lenke eller skjermbilde (valgfritt)
    validations:
      required: false
`;

const FEATURE = `name: 🔒 FORMS-trioen · Brukerhistorie
description: Én bruker-synlig leveranse.
title: "[Brukerhistorie] "
type: Story
labels: ["dev"]
body:
  - type: textarea
    id: story
    attributes:
      label: Brukerhistorie
      value: |
        Som <rolle>
        ønsker jeg <funksjon>
        slik at <nytte>.
    validations:
      required: true
`;

// Every field kind and option GitHub's schema has, in an advanced/ file.
const KITCHEN = `name: Alt
description: 'Every kind'
title: "[Alt] "
type: Task
labels: dev, design
body:
  - type: input
    id: one
    attributes: { label: En linje, value: start }
    validations: { required: true }
  - type: textarea
    id: log
    attributes:
      label: Logg
      render: shell
  - type: dropdown
    id: browsers
    attributes:
      label: Nettlesere
      multiple: true
      options: [Chrome, Edge, Firefox]
  - type: dropdown
    id: pick
    attributes:
      label: Velg
      options: [A, B]
      default: 1
    validations:
      required: true
  - type: checkboxes
    id: terms
    attributes:
      label: Bekreft
      options:
        - label: Jeg har sjekket
          required: true
        - label: Valgfritt
`;

const DIR = "/repos/ACME/FORMS/contents/.github/ISSUE_TEMPLATE";
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const b64 = (s: string) => ({ encoding: "base64", content: Buffer.from(s, "utf8").toString("base64") });
const TYPES = [
  { name: "Enhancement", description: "En forbedring av en eksisterende feature/design", node_id: "IT_enh", is_enabled: true },
  { name: "Story", description: "Bruker-synlig leveranse", node_id: "IT_story", is_enabled: true },
  { name: "Task", description: "Implementasjonsenhet", node_id: "IT_task", is_enabled: true },
  { name: "Bug", description: "Defekt", node_id: "IT_bug", is_enabled: true },
  { name: "Feature", description: "gone", node_id: "IT_old", is_enabled: false },
];

/** A FORMS with forms at the top, a planning one in advanced/, a config.yml and a broken file. */
function forms(extra: Record<string, unknown> = {}) {
  return {
    [`GET ${DIR}`]: [
      { type: "file", name: "config.yml" },
      { type: "file", name: "enhancement.yml" },
      { type: "file", name: "z2-feature.yml" },
      { type: "file", name: "broken.yml" },
      { type: "file", name: "README.md" },
      { type: "dir", name: "advanced" },
    ],
    [`GET ${DIR}/advanced`]: [{ type: "file", name: "kitchen.yml" }],
    [`GET ${DIR}/config.yml`]: b64("blank_issues_enabled: true\n"),
    [`GET ${DIR}/enhancement.yml`]: b64(ENHANCEMENT),
    [`GET ${DIR}/z2-feature.yml`]: b64(FEATURE),
    [`GET ${DIR}/broken.yml`]: b64("name: [unclosed"),
    [`GET ${DIR}/advanced/kitchen.yml`]: b64(KITCHEN),
    "GET /orgs/ACME/issue-types": TYPES,
    "GET /repos/ACME/FORMS/labels?per_page=100": [{ name: "dev" }, { name: "design" }, { name: "test" }],
    ...extra,
  };
}

const ENV = (db: ReturnType<typeof openDb>, extra: Partial<Env> = {}): Env => ({ DB: db.DB, GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", CODE_DIR: "x", CLAUDE_DIR: "x", SORTING_REPOS: "intake", FORM_REPOS: "FORMS", FORM_SKILL: "issue-forms", ...extra });
/** Local checkouts the tests pretend are in the code folder. */
const DIRS = [{ dir: "FORMS", repo: "ACME/forms" }, { dir: "shop-api", repo: "ACME/shop-api" }, { dir: "shop-api-pr803", repo: "ACME/shop-api" }, { dir: "intake", repo: "ACME/intake" }];

/** The routes on their own (auth is the parent app's), a fake GHE behind them. */
function mounted(routes: Record<string, unknown>, opts: { env?: Partial<Env> } = {}) {
  const db = openDb();
  const { ghe, calls } = fakeGhe(routes);
  const gql: string[] = [];
  ghe.graphql = async <T>(q: string) => {
    gql.push(q);
    return (q.includes("projectV2(number:") ? { organization: { projectV2: { id: "PVT_6" } } } : {}) as T;
  };
  const app = new Hono<AppEnv>();
  app.route("/", createIssueRoutes(ENV(db, opts.env), { ghe, frame: async () => ({ operator: "ola-nordmann", nav: [] }), checkouts: () => DIRS }));
  const get = (path: string) => app.request(`http://localhost${path}`);
  const post = (path: string, body: [string, string][] | Record<string, string>) =>
    app.request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  return { app, get, post, calls, gql, db, ghe };
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The hidden fields of the form posting to `action`, as the browser would send them. */
function hiddenOf(page: string, action: string): [string, string][] {
  const at = page.indexOf(`action="${action}"`);
  assert.ok(at >= 0, `a form posting to ${action}`);
  const form = page.slice(at, page.indexOf("</form>", at));
  // As a browser posts it: the hidden fields and the ticked boxes (My list, unless a test unticks it).
  return [...form.matchAll(/<input type="(?:hidden|checkbox)" name="([^"]*)" value="([^"]*)"( checked)?>/g)].filter((m) => !m[0].includes("checkbox") || m[3]).map((m) => [unescape(m[1]!), unescape(m[2]!)]);
}

// ── Parsing ───────────────────────────────────────────────────────────────────

test("an issue form parses: every field kind, required, labels, type, projects, prefill", () => {
  const e = parseTemplate("enhancement.yml", ENHANCEMENT);
  assert.equal(e.name, "💡 Forbedringsforslag");
  assert.equal(e.title, "[Forbedring] ");
  assert.equal(e.type, "Enhancement");
  assert.deepEqual(e.labels, []);
  assert.deepEqual(e.projects, ["ACME/6"]);
  assert.equal(e.planning, false);
  assert.deepEqual(e.fields.map((f) => [f.kind, f.label, f.required]), [["markdown", "", false], ["textarea", "Hva så du?", true], ["dropdown", "Område", false], ["input", "Hvor så du det? (valgfritt)", false], ["textarea", "Lenke eller skjermbilde (valgfritt)", false]]);
  assert.match(e.fields[0]!.value!, /^### 💡 Meld en forbedring\nIngenting er for lite\.\n$/);
  assert.equal(e.fields[1]!.placeholder, "Beskriv kort det du opplevde eller foreslår.");
  assert.deepEqual(e.fields[2]!.options, ["Vet ikke", "Frontend / nettflyt"]);

  const k = parseTemplate("advanced/kitchen.yml", KITCHEN);
  assert.deepEqual(k.labels, ["dev", "design"], "a comma-separated labels string");
  assert.equal(k.planning, true, "advanced/ is planning");
  const [one, log, browsers, pick, terms] = k.fields;
  assert.deepEqual([one!.kind, one!.value, one!.required], ["input", "start", true]);
  assert.equal(log!.render, "shell");
  assert.deepEqual([browsers!.multiple, browsers!.options], [true, ["Chrome", "Edge", "Firefox"]]);
  assert.deepEqual([pick!.default, pick!.required], [1, true]);
  assert.deepEqual([terms!.kind, terms!.options, terms!.mustTick], ["checkboxes", ["Jeg har sjekket", "Valgfritt"], [true, false]]);

  assert.equal(parseTemplate("z2-feature.yml", FEATURE).fields[0]!.value, "Som <rolle>\nønsker jeg <funksjon>\nslik at <nytte>.\n");
  assert.throws(() => parseTemplate("config.yml", "blank_issues_enabled: false"), /isn't an issue form/);
});

test("planning forms: advanced/, a z1-…z9- file, or a 🔒 name", () => {
  assert.ok(isPlanning("advanced/epic.yml", "Epic"));
  assert.ok(isPlanning("z1-epic.yml", "Epic"), "intake's and FORMS's z-files");
  assert.ok(isPlanning("epic.yml", "🔒 Epic"));
  assert.ok(!isPlanning("bug.yml", "🐛 Feilrapport"));
  assert.ok(!isPlanning("zebra.yml", "Zebra"));
});

test("config.yml says whether a repo takes hand-made issues, and its other ways in", () => {
  // ACME/intake's, read 2026-10-22: tickets come from Jira, the sync closes anything else.
  const intake = parseConfig(`# Saker her kommer fra Jira
blank_issues_enabled: false
contact_links:
  - name: Ny sak i Jira (DEV)
    url: https://example.atlassian.net/browse/DEV
    about: Saken dukker opp her når den blir Plukkbar.
  - name: Ny utvikleroppgave
    url: https://acme.ghe.com/ACME/intake#readme
    about: Lag den i kode-repoet der arbeidet skjer.
  - name: broken
`);
  assert.equal(intake.blank, false);
  assert.deepEqual(intake.links.map((l) => l.name), ["Ny sak i Jira (DEV)", "Ny utvikleroppgave"], "a link without a url is dropped");
  assert.equal(takesIssues({ templates: [], config: intake }), false, "no forms, no blank issues: closed");
  assert.equal(takesIssues({ templates: [parseTemplate("bug.yml", ENHANCEMENT)], config: intake }), true, "FORMS: blank off, but forms");
  assert.equal(takesIssues({ templates: [], config: OPEN_CHOOSER }), true, "a code repo without the folder takes anything");
  assert.deepEqual(parseConfig("contact_links: nope"), { blank: true, links: [] });
});

test("templates load from the folder and advanced/, everyday first; config.yml and .md skipped; a broken file is reported", async () => {
  const { ghe } = fakeGhe(forms());
  const { templates, broken, config } = await loadTemplates(ghe, "ACME/FORMS");
  assert.equal(config.blank, true, "config.yml is read, not parsed as a form");
  assert.deepEqual(templates.map((t) => t.file), ["enhancement.yml", "advanced/kitchen.yml", "z2-feature.yml"]);
  assert.deepEqual(templates.map((t) => t.planning), [false, true, true]);
  assert.deepEqual(broken.map((b) => b.file), ["broken.yml"]);
});

test("a repo without issue forms has none (a 404 isn't a failure); other errors are", async () => {
  assert.deepEqual(await loadTemplates(fakeGhe({}).ghe, "ACME/shop-web"), { templates: [], broken: [], config: OPEN_CHOOSER });
  const { ghe } = fakeGhe({});
  ghe.rest = async () => {
    throw new Error("GHE GET x: 502 bad gateway");
  };
  await assert.rejects(loadTemplates(ghe, "ACME/FORMS"), /502/);
});

test("the catalog caches for ten minutes and forgets a failure", async () => {
  let t = 0;
  let fail = true;
  const { ghe, calls } = fakeGhe({ "GET /orgs/ACME/issue-types": () => {
    if (fail) throw new Error("GHE GET: 502");
    return TYPES;
  } });
  const cat = createCatalog(ghe, "ACME", { now: () => t });
  await assert.rejects(cat.types());
  fail = false;
  assert.equal((await cat.types()).length, 4, "only the enabled types");
  await cat.types();
  assert.equal(calls.length, 2, "the failure wasn't kept, the success was");
  t = 10 * 60e3;
  await cat.types();
  assert.equal(calls.length, 3);
});

// ── Composing ─────────────────────────────────────────────────────────────────

const NONE = NOTHING_OFFERED;

test("the body is what GitHub writes from the issue form", () => {
  const k = parseTemplate("advanced/kitchen.yml", KITCHEN);
  const d = readDraft("ACME/FORMS", k, { title: "[Alt] x", f0: "en ting", f1: "npm ERR!\r\nmore", f2: ["2", "0"], f3: "0", "f4.0": "on" }, NONE);
  assert.equal(
    composeBody(d),
    "### En linje\n\nen ting\n\n### Logg\n\n```shell\nnpm ERR!\nmore\n```\n\n### Nettlesere\n\nChrome, Firefox\n\n### Velg\n\nA\n\n### Bekreft\n\n- [X] Jeg har sjekket\n- [ ] Valgfritt",
  );
  const e = parseTemplate("enhancement.yml", ENHANCEMENT);
  assert.equal(
    composeBody(readDraft("ACME/FORMS", e, { title: "t", f1: "  Knappen er for liten.  " }, NONE)),
    "### Hva så du?\n\nKnappen er for liten.\n\n### Område\n\n_No response_\n\n### Hvor så du det? (valgfritt)\n\n_No response_\n\n### Lenke eller skjermbilde (valgfritt)\n\n_No response_",
    "markdown blocks are left out, empty optional fields say _No response_",
  );
});

test("required fields, the bare title prefix and a type the org lacks stop the draft", () => {
  const e = parseTemplate("enhancement.yml", ENHANCEMENT);
  const types = TYPES.filter((t) => t.is_enabled).map((t) => ({ name: t.name, description: t.description, nodeId: t.node_id }));
  const empty = validate(emptyDraft("ACME/FORMS", e, NONE), types);
  assert.match(empty.title!, /still the template's/);
  assert.equal(empty.fields[1], "Required.");
  assert.equal(empty.fields[2], undefined, "optional");
  assert.ok(isValid(validate(readDraft("ACME/FORMS", e, { title: "[Forbedring] Større knapp", f1: "x" }, NONE), types)));

  const k = parseTemplate("advanced/kitchen.yml", KITCHEN);
  const ke = validate(readDraft("ACME/FORMS", k, { title: "y", f0: "a" }, NONE), types);
  assert.equal(ke.fields[3], "Pick one.");
  assert.equal(ke.fields[4], "Tick the required boxes.");

  const old = { ...e, type: "Feature" };
  assert.match(validate(readDraft("ACME/FORMS", old, { title: "t", f1: "x" }, NONE), types).type!, /isn't an enabled Issue Type/);
  assert.equal(validate(readDraft("ACME/FORMS", null, { title: "t" }, NONE), types).type, "Pick a type.", "a blank issue needs a type");
  assert.ok(isValid(validate(readDraft("ACME/FORMS", null, { title: "t", type: "Bug" }, NONE), types)));
});

test("what the form says is checked against what was offered; the preview carries the draft back unchanged", () => {
  const k = parseTemplate("advanced/kitchen.yml", KITCHEN);
  const offered = { priority: ["priority:p1"], tracks: ["team:forms", "team:er"] };
  const d = readDraft("ACME/shop-web", k, { title: "t", f0: "a\nb", f2: ["9", "1", "1"], f3: ["1", "0"], priority: "priority:p9", track: ["team:forms", "team:er"] }, offered);
  assert.equal(d.values[0]!.text, "a b", "an input is one line");
  assert.deepEqual(d.values[2]!.picked, [1], "no option 9, no duplicates");
  assert.deepEqual(d.values[3]!.picked, [1], "a single dropdown keeps one");
  assert.deepEqual(d.extra, ["team:forms"], "no priority:p9 offered; one track");
  assert.deepEqual(labelsOf(d), ["dev", "design", "team:forms"]);
  assert.deepEqual(readDraft("ACME/x", k, { title: "t", track: "team:evil" }, offered).extra, [], "a track the repo hasn't is dropped");
  const back = readDraft("ACME/shop-web", k, Object.fromEntries(Object.entries(Object.groupBy(formPairs(d), ([n]) => n)).map(([n, v]) => [n, v!.map(([, x]) => x)])), offered);
  assert.deepEqual(back, d);
});

test("only labels the repo has are offered: priority:* if any, and one track from team:*/category:*", () => {
  assert.deepEqual(offeredLabels(["dev", "design"]), { priority: [], tracks: [] });
  assert.deepEqual(offeredLabels(["FORMS", "priority:p2", "priority:p0", "category:tech", "team:forms", "teamwork"]), { priority: ["priority:p0", "priority:p2"], tracks: ["category:tech", "team:forms"] });
});

const SETUP = { sortingRepos: ["ACME/intake"], formRepos: ["ACME/FORMS"], formSkill: "issue-forms" };

test("untouched scaffolds are flagged; the agent's prompt fits the kind of work", () => {
  const f = parseTemplate("z2-feature.yml", FEATURE);
  assert.deepEqual(untouched(emptyDraft("ACME/FORMS", f, NONE)), ["Brukerhistorie"]);
  assert.equal(agentPrompt(" rough idea ", { kind: "forms", repo: "ACME/FORMS", template: "Forbedringsforslag" }, SETUP), "/issue-forms rough idea (target repo: ACME/FORMS, template: Forbedringsforslag)");
  assert.equal(agentPrompt("x", { kind: "forms", repo: "ACME/FORMS" }, SETUP), "/issue-forms x (target repo: ACME/FORMS)");
  const task = agentPrompt("fiks", { kind: "task", parent: "ACME/intake#6", repo: "ACME/shop-api" }, SETUP);
  assert.match(task, /an issue in ACME\/shop-api.*sub-issue of ACME\/intake#6/s);
  const any = agentPrompt("hm", { kind: "any" }, SETUP);
  assert.doesNotMatch(any, /Ticket|Jira/);
  for (const kind of ["- Dev task:", "- Issue through a repo's own forms (ACME/FORMS)"]) assert.ok(any.includes(kind), kind);
  assert.match(any, /Never create issues in ACME\/intake itself/);
});

// ── Pages ─────────────────────────────────────────────────────────────────────

test("step 1: everyday forms, then planning under its own heading, a blank issue, and the types' live descriptions", async () => {
  const { get } = mounted(forms());
  const res = await get("/issues/new?repo=ACME/FORMS");
  assert.equal(res.status, 200);
  const out = await res.text();
  const at = (s: string) => out.indexOf(s);
  assert.ok(at("💡 Forbedringsforslag") > 0 && at("💡 Forbedringsforslag") < at(">Planning<") && at(">Planning<") < at("🔒 FORMS-trioen · Brukerhistorie"));
  assert.ok(!out.includes("FORMS-trioen)"), "no repo's names in the app's own headings");
  assert.match(out, /En forbedring av en eksisterende feature\/design/);
  assert.match(out, /Blank issue \(pick a type\)/);
  assert.match(out, /href="\/issues\/new\?repo=ACME%2FFORMS&amp;template=advanced%2Fkitchen\.yml"/);
  assert.match(out, /broken\.yml/, "a broken template shows as failed");
  assert.match(out, /href="\/issues\/new\?repo=ACME%2FFORMS" aria-current/, "the form repos as tabs, from FORM_REPOS");
});

test("step 2: the form's fields as controls, required marked, the title prefilled, labels shown", async () => {
  const { get } = mounted(forms());
  const out = await (await get("/issues/new?repo=ACME/FORMS&template=advanced/kitchen.yml")).text();
  assert.match(out, /<input type="text" id="title" name="title" value="\[Alt\] "/);
  assert.match(out, /<input type="text" id="f0" name="f0" value="start" required>/);
  assert.match(out, /<textarea id="f1" name="f1"/);
  assert.match(out, /<select id="f2" name="f2" multiple>/);
  assert.match(out, /<option value="1" selected>B<\/option>/, "the dropdown's default");
  assert.match(out, /<input type="checkbox" name="f4.0" value="on" required> Jeg har sjekket <abbr title="required">\*<\/abbr>/);
  assert.match(out, /Logg<\/label>/);
  assert.match(out, />dev<\/span>/);
  const e = await (await get("/issues/new?template=enhancement.yml")).text();
  assert.match(e, /placeholder="Beskriv kort det du opplevde eller foreslår\."/);
  assert.match(e, /Meld en forbedring/, "markdown blocks are help text");
  assert.match(e, /Hva så du\? <abbr title="required">\*<\/abbr>/);
  assert.match(e, /Added to project ACME\/6/);
  const blank = await (await get("/issues/new?template=blank")).text();
  assert.match(blank, /<select id="type" name="type" required>/);
  assert.match(blank, /<option value="Bug">Bug · Defekt<\/option>/);
  assert.ok(!blank.includes(">Feature"), "disabled types aren't offered");
});

test("a missing required field re-renders the form with the error and the values kept", async () => {
  const { post, calls } = mounted(forms());
  const res = await post("/issues/preview", { repo: "ACME/FORMS", template: "enhancement.yml", title: "[Forbedring] Større", f2: "1", f3: "kept text" });
  assert.equal(res.status, 422);
  const out = await res.text();
  assert.match(out, /<div class="field invalid">.*Hva så du\?.*<span class="error">Required\.<\/span>/s);
  assert.match(out, /value="kept text"/);
  assert.match(out, /<option value="1" selected>Frontend \/ nettflyt<\/option>/);
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("preview shows type, title, labels and the body, then Create files it in one call with the type and logs it", async () => {
  const { post, get, calls, db, gql } = mounted(
    forms({
      "POST /repos/ACME/FORMS/issues": (body: unknown) => ({ html_url: "https://acme.ghe.com/ACME/FORMS/issues/412", number: 412, id: 9, node_id: "I_412", type: { name: (body as { type: string }).type }, labels: [{ name: "dev" }] }),
    }),
  );
  const fields = { repo: "ACME/FORMS", template: "z2-feature.yml", title: "[Brukerhistorie] Se kjøretøyene mine", f0: "Som kunde\nønsker jeg å se bilene mine\nslik at jeg slipper å taste." };
  const res = await post("/issues/preview", fields);
  assert.equal(res.status, 200);
  const preview = await res.text();
  assert.match(preview, />Story<\/span>/);
  assert.match(preview, /<strong>\[Brukerhistorie\] Se kjøretøyene mine<\/strong>/);
  assert.match(preview, /Brukerhistorie<\/h5>/, "the body rendered as markdown");
  assert.match(preview, /Sammensatte ord i ett/, "the prose checklist beside it");
  assert.match(preview, /<button type="submit" class="primary">Create issue<\/button>/);
  assert.ok(!calls.some((c) => c.method === "POST"), "preview creates nothing");

  const form = hiddenOf(preview, "/issues/create");
  const created = await post("/issues/create", form);
  assert.equal(created.status, 303);
  assert.equal(created.headers.get("location"), "/issues/done?repo=ACME%2FFORMS&number=412");
  const writes = calls.filter((c) => c.method === "POST");
  assert.deepEqual(writes.map((c) => c.path), ["/repos/ACME/FORMS/issues"]);
  assert.deepEqual(writes[0]!.body, {
    title: "[Brukerhistorie] Se kjøretøyene mine",
    body: "### Brukerhistorie\n\nSom kunde\nønsker jeg å se bilene mine\nslik at jeg slipper å taste.",
    type: "Story",
    labels: ["dev"],
  });
  assert.equal(gql.length, 0, "the type stuck, and this form names no project");
  assert.deepEqual((await recentActions(db.DB)).map((a) => [a.kind, a.target, a.ok]), [["issue.create", "ACME/FORMS#412", 1]]);

  const done = await (await get("/issues/done?repo=ACME%2FFORMS&number=412")).text();
  assert.match(done, /<a href="https:\/\/acme\.ghe\.com\/ACME\/FORMS\/issues\/412" target="_blank" rel="noopener noreferrer">ACME\/FORMS#412<\/a>/);
  assert.match(done, /href="\/issues\/new\?repo=ACME%2FFORMS">File another/);

  assert.equal((await post("/issues/create", form)).status, 303, "the same preview pressed twice");
  assert.equal(calls.filter((c) => c.method === "POST").length, 1, "files it once");
  assert.deepEqual((await listTodos(db.DB)).map((t) => [t.title, t.notes, t.state]), [["[Brukerhistorie] Se kjøretøyene mine", "ACME/FORMS#412", "next"]], "on My list too, once");
});

test("a dropped type is set again over GraphQL; the form's project gets the issue; what didn't stick is said", async () => {
  const { post, gql, db } = mounted(
    forms({ "POST /repos/ACME/FORMS/issues": { html_url: "https://acme.ghe.com/ACME/FORMS/issues/7", number: 7, id: 1, node_id: "I_7", type: null, labels: [] } }),
  );
  const preview = await (await post("/issues/preview", { repo: "ACME/FORMS", template: "enhancement.yml", title: "[Forbedring] x", f1: "y" })).text();
  const res = await post("/issues/create", hiddenOf(preview, "/issues/create"));
  assert.equal(res.status, 303);
  assert.match(gql[0]!, /updateIssue\(input:\{id:"I_7",issueTypeId:"IT_enh"\}\)/);
  assert.match(gql[1]!, /organization\(login:"ACME"\)\{projectV2\(number:6\)/);
  assert.match(gql[2]!, /addProjectV2ItemById\(input:\{projectId:"PVT_6",contentId:"I_7"\}\)/);
  assert.equal((await recentActions(db.DB))[0]!.ok, 1);
});

test("a failed create says why, keeps the preview, and is logged", async () => {
  const { post, db } = mounted(forms({ "POST /repos/ACME/FORMS/issues": () => { throw new Error("GHE POST /repos/ACME/FORMS/issues: 422 type invalid"); } }));
  const preview = await (await post("/issues/preview", { repo: "ACME/FORMS", template: "enhancement.yml", title: "[Forbedring] x", f1: "y" })).text();
  const res = await post("/issues/create", hiddenOf(preview, "/issues/create"));
  assert.equal(res.status, 502);
  assert.match(await res.text(), /Couldn&#39;t create the issue in ACME\/FORMS: .*422 type invalid/);
  assert.deepEqual((await recentActions(db.DB)).map((a) => [a.kind, a.target, a.ok]), [["issue.create", "ACME/FORMS", 0]]);
});

test("repos outside the org, and a create that skipped the preview, never reach GHE", async () => {
  const { post, get, calls } = mounted(forms());
  for (const repo of ["evil/repo", "ACME/a/../b", "ACMEX/FORMS"]) {
    assert.equal((await post("/issues/create", { repo, template: "blank", title: "t", type: "Bug", nonce: "00000000-0000-0000-0000-000000000000" })).status, 400);
    assert.equal((await post("/issues/preview", { repo, template: "blank", title: "t", type: "Bug" })).status, 400);
    assert.equal((await post("/issues/draft", { repo, note: "x" })).status, 400);
    assert.equal((await get(`/issues/new?repo=${encodeURIComponent(repo)}`)).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal((await post("/issues/create", { repo: "ACME/FORMS", template: "blank", title: "t", type: "Bug" })).status, 400);
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("the agent-draft form leads to /agents/new in the target repo's checkout, default mode, and the issue-forms prompt", async () => {
  const { get, post } = mounted(forms());
  for (const path of ["/issues/new", "/issues/new?repo=ACME/FORMS", "/issues/new?template=enhancement.yml"]) assert.match(await (await get(path)).text(), /<form method="post" action="\/issues\/draft">.*<textarea id="note" name="note"/s, path);
  const step2 = await (await get("/issues/new?template=enhancement.yml")).text();
  const sent = [...hiddenOf(step2, "/issues/draft"), ["note", "Knappen på steg 3 er for liten på mobil"]] as [string, string][];
  const out = await (await post("/issues/draft", sent)).text();
  assert.deepEqual(hiddenOf(out, "/agents/new"), [
    ["mode", "default"],
    ["prompt", "/issue-forms Knappen på steg 3 er for liten på mobil (target repo: ACME/FORMS, template: 💡 Forbedringsforslag)"],
  ]);
  assert.match(out, /<option value="FORMS" selected>FORMS<\/option>/, "runs in the target repo's checkout");
  assert.match(out, /<option value="shop-api-pr803">shop-api-pr803 \(shop-api\)<\/option>/, "a checkout named unlike its repo says which it is");
  const plain = await (await post("/issues/draft", { repo: "ACME/FORMS", note: "noe" })).text();
  assert.deepEqual(hiddenOf(plain, "/agents/new").find(([n]) => n === "prompt"), ["prompt", "/issue-forms noe (target repo: ACME/FORMS)"]);
  assert.equal((await post("/issues/draft", { repo: "ACME/FORMS", note: "  " })).status, 400);
  const any = await (await post("/issues/draft", { kind: "any", note: "noe" })).text();
  assert.match(any, /<option value="@dovre" selected>/, "no target: Dovre's own folder");
  assert.doesNotMatch(any, /<option value="intake" selected>/);
  assert.equal((await post("/issues/draft", { kind: "ticket", project: "EVIL", note: "x" })).status, 400);
  assert.equal((await post("/issues/draft", { kind: "nope", note: "x" })).status, 400);
});

test("every page renders hostile template, type and field text inert", async () => {
  const q = (s: string) => JSON.stringify(s);
  const HOSTILE = `name: ${q(H)}
description: ${q(H)}
title: ${q(H)}
type: ${q(H)}
labels: [${q(H)}]
projects: [${q(H)}]
body:
  - type: markdown
    attributes: { value: ${q(`${H} [x](javascript:alert(1))`)} }
  - type: input
    attributes: { label: ${q(H)}, description: ${q(H)}, placeholder: ${q(H)}, value: ${q(H)} }
    validations: { required: true }
  - type: textarea
    attributes: { label: ${q(H)}, placeholder: ${q(H)}, render: ${q(H)} }
  - type: dropdown
    attributes: { label: ${q(H)}, options: [${q(H)}] }
  - type: checkboxes
    attributes: { label: ${q(H)}, options: [{ label: ${q(H)} }] }
`;
  const file = `${H}.yml`;
  const { get, post } = mounted({
    [`GET ${DIR}`]: [{ type: "file", name: file }],
    [`GET ${enc(`.github/ISSUE_TEMPLATE/${file}`).replace(/^/, "/repos/ACME/FORMS/contents/")}`]: b64(HOSTILE),
    "GET /orgs/ACME/issue-types": [{ name: H, description: H, node_id: H, is_enabled: true }],
    "GET /repos/ACME/FORMS/labels?per_page=100": [{ name: H }],
    "POST /repos/ACME/FORMS/issues": { html_url: "javascript:alert(1)", number: 5, id: 1, node_id: H, type: { name: H }, labels: [{ name: H }] },
  });
  const pages: [string, Response][] = [];
  pages.push(["entry", await get("/issues/new")]);
  pages.push(["step 1", await get("/issues/new?repo=ACME/FORMS")]);
  pages.push(["step 2", await get(`/issues/new?repo=ACME/FORMS&template=${encodeURIComponent(file)}`)]);
  pages.push(["blank", await get("/issues/new?template=blank")]);
  pages.push(["unknown template", await get(`/issues/new?template=${encodeURIComponent(H)}`)]);
  const form = { repo: "ACME/FORMS", template: file, title: `${H} title`, f1: H, f2: H, f3: "0", "f4.0": "on" };
  pages.push(["invalid", await post("/issues/preview", { ...form, f1: "" })]);
  const preview = await post("/issues/preview", form);
  const previewText = await preview.text();
  pages.push(["preview", new Response(previewText, { status: preview.status })]);
  const created = await post("/issues/create", hiddenOf(previewText, "/issues/create"));
  assert.equal(created.status, 303);
  pages.push(["done", await get(created.headers.get("location")!)]);
  pages.push(["draft", await post("/issues/draft", { repo: "ACME/FORMS", template: file, note: H })]);
  assert.equal(pages[1]![1].status, 200, "the hostile form itself renders");
  for (const [name, res] of pages) {
    const out = await res.text();
    assert.ok(res.status < 500, `${name}: ${res.status}`);
    assertInert(name, out);
    assert.ok(!out.includes('href="javascript:'), `${name}: a javascript: link got through`);
  }
});

// ── Dev tasks ─────────────────────────────────────────────────────────────────

test("a parent reference: org/repo#n, repo#n or an issue URL; nothing outside the org, and no ticket keys", () => {
  assert.deepEqual(parseRef("ACME/intake#6", "ACME", "acme.ghe.com"), { repo: "ACME/intake", number: 6 });
  assert.deepEqual(parseRef(" intake#6 ", "ACME"), { repo: "ACME/intake", number: 6 });
  assert.deepEqual(parseRef("https://acme.ghe.com/ACME/FORMS/issues/512", "ACME", "acme.ghe.com"), { repo: "ACME/FORMS", number: 512 });
  assert.equal(parseRef("dev-4", "ACME"), null, "a ticket key isn't an issue here");
  for (const bad of ["evil/x#1", "https://evil.example/ACME/FORMS/issues/1", "ACME/../x#1", "#4", "intake", "ACME/x#1; rm"]) assert.equal(parseRef(bad, "ACME", "acme.ghe.com"), null, bad);
});

test("a checkout's org repo comes from its origin remote, https or ssh", () => {
  const cfg = (url: string) => `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://acme.ghe.com/ACME/wrong.git\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  assert.equal(remoteRepo(cfg("https://acme.ghe.com/ACME/shop-api.git"), "acme.ghe.com", "ACME"), "ACME/shop-api");
  assert.equal(remoteRepo(cfg("git@acme.ghe.com:ACME/Platform"), "acme.ghe.com", "ACME"), "ACME/Platform");
  assert.equal(remoteRepo(cfg("https://github.com/bergaaberg/memlet.git"), "acme.ghe.com", "ACME"), null);
  assert.equal(remoteRepo(cfg("https://acme.ghe.com/other/x.git"), "acme.ghe.com", "ACME"), null);
  assert.equal(remoteRepo("[core]\n", "acme.ghe.com", "ACME"), null);
});

const issue = (repo: string, n: number, title: string, o: Record<string, unknown> = {}) => ({ number: n, title, html_url: `https://acme.ghe.com/${repo}/issues/${n}`, state: "open", updated_at: "2026-10-20T00:00:00Z", assignees: [], repository_url: `https://acme.ghe.com/api/v3/repos/${repo}`, ...o });
const CLOSED_CONFIG = "blank_issues_enabled: false\ncontact_links:\n  - name: Ny sak i Jira (DEV)\n    url: https://example.atlassian.net/browse/DEV\n    about: Saken dukker opp her.\n  - name: Docs\n    url: javascript:alert(1)\n";
/** intake with two tickets (one mine), FORMS with one issue and a PR, a repo that takes no issues, and the org's types. */
function tracker(extra: Record<string, unknown> = {}) {
  return {
    "GET /repos/ACME/intake/issues?state=open&sort=updated&direction=desc&per_page=50": [issue("ACME/intake", 6, "DEV-4 Kritisk testfeil i Ledger", { updated_at: "2026-10-01T00:00:00Z", assignees: [{ login: "ola-nordmann" }] }), issue("ACME/intake", 9, "DEV-9 Nyere", { updated_at: "2026-10-21T00:00:00Z" })],
    "GET /repos/ACME/FORMS/issues?state=open&sort=updated&direction=desc&per_page=50": [issue("ACME/FORMS", 512, "[Forbedring] Knapp", { updated_at: "2026-10-22T00:00:00Z" }), issue("ACME/FORMS", 513, "A PR", { pull_request: {} })],
    "GET /repos/ACME/intake/issues/6": issue("ACME/intake", 6, "DEV-4 Kritisk testfeil i Ledger"),
    "GET /repos/ACME/intake/issues/7": issue("ACME/intake", 7, "DEV-6 Ferdig", { state: "closed" }),
    "GET /orgs/ACME/issue-types": TYPES,
    "GET /repos/ACME/closed-intake/contents/.github/ISSUE_TEMPLATE": [{ type: "file", name: "config.yml" }],
    "GET /repos/ACME/closed-intake/contents/.github/ISSUE_TEMPLATE/config.yml": b64(CLOSED_CONFIG),
    ...extra,
  };
}

test("dev task, step 1: open issues in the parent repos, mine first then newest, no PRs; or a reference", async () => {
  const { get } = mounted(tracker());
  const out = await (await get("/issues/new?kind=task")).text();
  const at = (s: string) => out.indexOf(s);
  assert.ok(at("Kritisk testfeil") > 0 && at("Kritisk testfeil") < at("[Forbedring] Knapp") && at("[Forbedring] Knapp") < at("DEV-9 Nyere"), "mine, then by update");
  assert.match(out, /href="\/issues\/new\?kind=task&amp;parent=ACME%2Fintake%236"/);
  assert.ok(!out.includes("A PR"));
  assert.match(out, /<form method="get" action="\/issues\/new"><input type="hidden" name="kind" value="task">/);
  const byKey = await (await get(`/issues/new?kind=task&parent=${encodeURIComponent("intake#6")}`)).text();
  assert.match(byKey, /Under .*intake#6/s);
  assert.match(byKey, /<option value="Task" selected>Task/, "Task when the org has it");
  assert.match(byKey, /<option value="ACME\/shop-api">shop-api<\/option>/);
  assert.ok(!byKey.includes('<option value="ACME/intake">'), "a sorting repo isn't offered as the code repo");
  assert.match(byKey, /name="assign" value="on" checked/);
  assert.equal((await get("/issues/new?kind=task&parent=DEV-4")).status, 400, "a ticket key isn't an issue reference");
  assert.equal((await get("/issues/new?kind=task&parent=ACME/intake%237")).status, 409, "a closed issue");
  assert.equal((await get(`/issues/new?kind=task&parent=${encodeURIComponent("evil/x#1")}`)).status, 400);
});

test("dev task: a repo that takes no hand-made issues is refused with its ways in; the sorting repo too", async () => {
  const { post, calls } = mounted(tracker());
  const base = { parent: "ACME/intake#6", title: "Lag endepunkt", type: "Task", assign: "on" };
  const closed = await post("/issues/task/preview", { ...base, repo: "", repo_other: "closed-intake" });
  assert.equal(closed.status, 422);
  const out = await closed.text();
  assert.match(out, /closed-intake takes no hand-made issues/);
  assert.match(out, /href="https:\/\/example\.atlassian\.net\/browse\/DEV"/, "the chooser's links stay links");
  assert.ok(!out.includes('href="javascript:'));
  const sorting = await post("/issues/task/preview", { ...base, repo: "ACME/intake" });
  assert.equal(sorting.status, 422);
  assert.match(await sorting.text(), /intake is where the work is planned/);
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("the forms flow shows a closed repo's ways in instead of forms, and won't file there", async () => {
  const { get, post, calls } = mounted(tracker());
  const out = await (await get("/issues/new?repo=ACME/closed-intake")).text();
  assert.match(out, /closed-intake takes issues another way/);
  assert.ok(!out.includes("Blank issue"));
  assert.equal((await post("/issues/preview", { repo: "ACME/closed-intake", template: "blank", title: "t", type: "Bug" })).status, 400);
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("dev task: preview, then the issue in the code repo, hung under the parent, assigned, logged; the done page has the PR line and an agent", async () => {
  const { post, get, calls, db } = mounted(
    tracker({
      "GET /repos/ACME/shop-api/contents/.github/ISSUE_TEMPLATE": [],
      "POST /repos/ACME/shop-api/issues": (b: unknown) => ({ html_url: "https://acme.ghe.com/ACME/shop-api/issues/45", number: 45, id: 4500, node_id: "I_45", type: { name: (b as { type: string }).type }, labels: [], assignees: [{ login: "ola-nordmann" }] }),
      "POST /repos/ACME/intake/issues/6/sub_issues": { number: 6 },
    }),
  );
  const res = await post("/issues/task/preview", { parent: "ACME/intake#6", repo: "ACME/shop-api", title: "Lag endepunkt", body: "Det **nye** endepunktet", type: "Task", assign: "on" });
  assert.equal(res.status, 200);
  const preview = await res.text();
  assert.match(preview, /<dt>Under<\/dt>/);
  assert.match(preview, /<strong>nye<\/strong>/, "the body as markdown");
  const created = await post("/issues/task/create", hiddenOf(preview, "/issues/task/create"));
  assert.equal(created.status, 303);
  const writes = calls.filter((c) => c.method === "POST");
  assert.deepEqual(writes.map((c) => [c.path, c.body]), [
    ["/repos/ACME/shop-api/issues", { title: "Lag endepunkt", body: "Det **nye** endepunktet", type: "Task", assignees: ["ola-nordmann"] }],
    ["/repos/ACME/intake/issues/6/sub_issues", { sub_issue_id: 4500 }],
  ]);
  assert.ok(calls.filter((c) => c.path === "/repos/ACME/intake/issues/6").length >= 2, "the parent is read again right before the write");
  assert.deepEqual((await recentActions(db.DB)).map((a) => [a.kind, a.target, a.ok]), [["task.create", "ACME/shop-api#45", 1]]);
  const done = await (await get(created.headers.get("location")!)).text();
  assert.match(done, /<code data-copy="Closes ACME\/shop-api#45">Closes ACME\/shop-api#45<\/code>/);
  assert.match(done, /href="\/agents\/new\?repo=shop-api&amp;prompt=Work%20on%20ACME%2Fshop-api%2345/, "an agent in the repo's main checkout");
  assert.match(done, /under ACME\/intake#6/);
  assert.equal((await post("/issues/task/create", hiddenOf(preview, "/issues/task/create"))).status, 303, "pressed twice");
  assert.equal(calls.filter((c) => c.method === "POST").length, 2, "created once");
  assert.deepEqual((await listTodos(db.DB)).map((t) => t.notes), ["ACME/shop-api#45, under ACME/intake#6"]);
});

test("dev task: a failed sub-issue link is a warning, not lost; a parent closed meanwhile creates nothing", async () => {
  let state = "open";
  const { post, get, calls, db } = mounted(
    tracker({
      "GET /repos/ACME/intake/issues/6": () => issue("ACME/intake", 6, "DEV-4 Kritisk testfeil i Ledger", { state }),
      "GET /repos/ACME/shop-api/contents/.github/ISSUE_TEMPLATE": [],
      "POST /repos/ACME/shop-api/issues": { html_url: "https://acme.ghe.com/ACME/shop-api/issues/46", number: 46, id: 4600, node_id: "I_46", type: { name: "Task" }, labels: [], assignees: [] },
      "POST /repos/ACME/intake/issues/6/sub_issues": () => {
        throw new Error("GHE POST: 422 sub-issue limit");
      },
    }),
  );
  const form = { parent: "ACME/intake#6", repo: "ACME/shop-api", title: "Lag endepunkt", body: "", type: "Task", assign: "on" };
  const preview = await (await post("/issues/task/preview", form)).text();
  const created = await post("/issues/task/create", hiddenOf(preview, "/issues/task/create"));
  const done = await (await get(created.headers.get("location")!)).text();
  assert.match(done, /not hung under ACME\/intake#6 \(GHE POST: 422 sub-issue limit\)/);
  assert.match(done, /Not assigned to ola-nordmann/);
  assert.ok(!done.includes(", under ACME/intake#6"), "doesn't claim the link");
  assert.equal((await recentActions(db.DB))[0]!.ok, 1);

  state = "closed";
  const before = calls.filter((c) => c.method === "POST").length;
  assert.equal((await post("/issues/task/preview", form)).status, 409, "the preview re-reads the parent too");
  const r = await createTask(fakeGhe(tracker({ "GET /repos/ACME/intake/issues/6": issue("ACME/intake", 6, "x", { state: "closed" }) })).ghe, db.DB, "ACME", { repo: "ACME/shop-api", title: "t", body: "", type: "Task", assignees: [], parent: { repo: "ACME/intake", number: 6 } });
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /is closed now: nothing was created/);
  assert.equal(calls.filter((c) => c.method === "POST").length, before);
});

test("the entry page offers the kinds from config, and a describe-it box; no tickets", async () => {
  const { get } = mounted({}, { env: { SORTING_REPOS: "intake", FORM_REPOS: "FORMS,evil/../x" } });
  const out = await (await get("/issues/new")).text();
  assert.ok(!/kind=ticket|Jira/.test(out), "tickets come from a pack, not core");
  assert.match(out, /href="\/issues\/new\?kind=task"/);
  assert.match(out, /href="\/issues\/new\?repo=ACME%2FFORMS"/);
  assert.ok(!out.includes("evil"), "a setting can't point outside the org");
  assert.match(out, /<input type="hidden" name="kind" value="any">/);
});

test("dev-task pages render hostile GHE text inert", async () => {
  const t = mounted(
    { ...tracker(), "GET /repos/ACME/intake/issues/6": issue("ACME/intake", 6, `DEV-4 ${H}`, { html_url: "javascript:alert(1)" }), "GET /orgs/ACME/issue-types": [{ name: H, description: H, node_id: "x", is_enabled: true }], "GET /repos/ACME/shop-api/contents/.github/ISSUE_TEMPLATE": [] },
  );
  const pages: [string, Response][] = [];
  pages.push(["entry", await t.get("/issues/new")]);
  pages.push(["task pick", await t.get("/issues/new?kind=task")]);
  pages.push(["task bad ref", await t.get(`/issues/new?kind=task&parent=${encodeURIComponent(H)}`)]);
  pages.push(["task form", await t.get("/issues/new?kind=task&parent=ACME/intake%236")]);
  const task = { parent: "ACME/intake#6", repo: "", repo_other: "closed-intake", title: H, body: H, type: H };
  pages.push(["task closed repo", await t.post("/issues/task/preview", task)]);
  const tv = await t.post("/issues/task/preview", { ...task, repo_other: "", repo: "ACME/shop-api" });
  assert.equal(tv.status, 200, "the hostile task reaches its preview");
  pages.push(["task preview", tv]);
  pages.push(["task draft", await t.post("/issues/draft", { kind: "task", parent: H, repo: H, note: H })]);
  pages.push(["ticket draft is refused", await t.post("/issues/draft", { kind: "ticket", project: "DEV", note: H })]);
  for (const [name, res] of pages) {
    const out = await res.text();
    assert.ok(res.status < 500, `${name}: ${res.status}`);
    assertInert(name, out);
    assert.ok(!out.includes('href="javascript:'), `${name}: a javascript: link got through`);
  }
});
