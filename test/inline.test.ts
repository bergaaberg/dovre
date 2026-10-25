/** Things shown in place: Markdown bodies, PR cards, what a deploy ships. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, groupChanges, parseCommit } from "../src/sources/changelog.ts";
import { checkState } from "../src/sources/ghe.ts";
import { areas, changelogBlock, prCard } from "../src/pages/inline.ts";
import { markdown } from "../src/ui/markdown.ts";
import { H, assertInert, pr } from "./helpers.ts";

const render = async (h: unknown) => String(await h);

test("markdown: the usual shapes render, comments vanish", async () => {
  const out = await render(markdown("## Sammendrag\n\nKunden kan **signere** `koden` [her](https://acme.ghe.com/x).\n\n- [x] ferdig\n- [ ] ikke\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<!-- template hint -->\n```\ncode <b>\n```"));
  assert.match(out, /<h4 class="md-h">Sammendrag<\/h4>/, "a body's ## sits below the card's own headings");
  assert.match(out, /<strong>signere<\/strong>/);
  assert.match(out, /<code>koden<\/code>/);
  assert.match(out, /<a href="https:\/\/acme.ghe.com\/x" target="_blank" rel="noopener noreferrer">her<\/a>/);
  assert.match(out, /class="task done"/);
  assert.match(out, /<td>1<\/td>/);
  assert.ok(!out.includes("template hint"));
  assert.match(out, /code &lt;b&gt;/);
});

test("markdown: hostile input stays text, and only http(s) links survive", async () => {
  const out = await render(markdown(`${H}\n\n[click](javascript:alert(1)) **${H}** \`${H}\`\n\n- ${H}\n\n> ${H}\n\n| ${H} |\n|---|\n| ${H} |`));
  assertInert("markdown", out);
  assert.ok(!out.includes("javascript:"));
});

test("commits are sorted into features, fixes, dependency bumps and the rest", () => {
  assert.equal(classify("feat(ung): skjul ulykkessum", "ola-nordmann"), "feature");
  assert.equal(classify("fix!: noe", "x"), "fix");
  assert.equal(classify("Chore(deps-dev): Bump vite from 8.3.3 to 8.3.4", "dependabot[bot]"), "deps");
  assert.equal(classify("Add accordion infobox to begunstigelse", "Anders-Hansen"), "other");
  const c = parseCommit({ sha: "0123456789", author: null, commit: { message: "feat: koble JSD-5257 til kvittering (#1112)\n\nbody DAT-12", author: { name: "Ola" } } });
  assert.deepEqual([c.pr, c.title, c.author, c.sha, c.text], [1112, "feat: koble JSD-5257 til kvittering", "Ola", "0123456", "feat: koble JSD-5257 til kvittering (#1112)\n\nbody DAT-12"]);
  assert.deepEqual(groupChanges([c, { ...c, kind: "deps" }]).map((g) => g.kind), ["feature", "deps"]);
});

test("checks: conclusions map to four states", () => {
  assert.equal(checkState({ conclusion: "SUCCESS" }), "ok");
  assert.equal(checkState({ conclusion: "TIMED_OUT" }), "bad");
  assert.equal(checkState({ status: "IN_PROGRESS", conclusion: null }), "pending");
  assert.equal(checkState({ state: "ERROR" }), "bad");
  assert.equal(checkState({ conclusion: "SKIPPED" }), "skipped");
});

test("a PR's areas are its busiest folders", () => {
  const a = areas([{ path: "src/app/x.ts", additions: 10, deletions: 0 }, { path: "src/app/y.ts", additions: 5, deletions: 5 }, { path: "README.md", additions: 1, deletions: 0 }]);
  assert.deepEqual(a.map((x) => [x.area, x.files, x.lines]), [["src/app/", 2, 20], ["(root)", 1, 1]]);
});

test("a PR card and a changelog render hostile content inert, links in new tabs", async () => {
  const card = await render(prCard(pr({ title: H, body: `# ${H}\n${H}`, branch: H, labels: [H], files: [{ path: H, additions: 1, deletions: 1 }], reviews: [{ login: H, state: H }], requested: [H], runs: [{ name: H, state: "bad", url: "javascript:x" }] }), { org: "ACME", summary: () => ({ state: "ready", text: H }) }));
  assertInert("prCard", card);
  assert.ok(!card.includes('href="javascript:'));
  assert.match(card, /Open on GitHub ↗<\/a>/);
  assert.match(card, /<a class="btn primary" href="\/prs\/ACME\/shop-api\/1">Open<\/a>/, "opens in Dovre's own viewer");
  for (const m of card.matchAll(/<a href="(https?:[^"]+)"([^>]*)>/g)) assert.match(m[2]!, /target="_blank"/, m[1]);
  const log = await render(
    changelogBlock(
      { ok: true, value: { repo: "ACME/a", env: "prod", prodSha: "abcdef0123", prodAt: "2026-10-19T00:00:00Z", head: "f", commits: 2, files: 3, additions: 4, deletions: 5, compareUrl: "https://acme.ghe.com/ACME/a/compare/x", changes: [{ kind: "feature", pr: 3, title: H, author: H, sha: "1", text: `JSD-1 ${H}` }, { kind: "deps", title: H, author: "dependabot[bot]", sha: "2", text: "" }] } },
      { summary: () => undefined, ghe: "acme.ghe.com", rules: [{ pattern: /\bJSD-\d+\b/, href: (k) => `https://example.atlassian.net/browse/${k}` }] },
    ),
  );
  assertInert("changelog", log);
  assert.match(log, /Ships 2 commits · 1 PR \+ 1 dependency bump/);
  assert.match(log, /Dependency bumps/);
  assert.match(log, /example.atlassian.net\/browse\/JSD-1/);
});
