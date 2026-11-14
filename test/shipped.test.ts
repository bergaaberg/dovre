/** GitHub's answer to Forge.shipped (pack API 2.6): merged PRs, releases and tags with no release, read narrowly. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ghe } from "../src/sources/ghe.ts";
import { packReads } from "../src/sources/files.ts";
import { loadShipped, shippedOf } from "../src/sources/shipped.ts";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { signedIn, snapshot } from "./helpers.ts";

const pr = (repo: string, number: number, mergedAt: string, title = `feat: ${number}`) => ({ number, title, url: `https://github.com/${repo}/pull/${number}`, mergedAt, author: { login: "kari" }, repository: { nameWithOwner: repo } });

test("shipped: one paged search and one query per owner; newest first, the owners' repos only, since the day", async () => {
  const queries: string[] = [];
  const ghe: Ghe = {
    host: "github.com",
    rest: async () => assert.fail("no REST"),
    async graphql<T>(q: string) {
      queries.push(q);
      if (q.includes("merged:2026-11-01..2026-11-07")) return { shipped: { issueCount: 1, pageInfo: { hasNextPage: false }, nodes: [pr("acme/site", 4, "2026-11-03T08:00:00Z")] } } as T;
      if (q.includes("search(type: ISSUE")) {
        const second = q.includes('after: "c1"');
        return { shipped: { issueCount: 6, pageInfo: { hasNextPage: !second, endCursor: second ? null : "c1" }, nodes: second ? [pr("acme/api", 7, "2026-11-12T09:00:00Z"), pr("evil/x", 1, "2026-11-12T09:00:00Z"), null, { number: "x" }] : [pr("acme/site", 3, "2026-11-10T08:00:00Z"), pr("acme/site", 2, "2026-10-30T08:00:00Z")] } } as T;
      }
      return {
        shipped0: {
          repositories: {
            nodes: [
              {
                nameWithOwner: "acme/site",
                releases: { nodes: [{ tagName: "v2", name: "", url: "https://github.com/acme/site/releases/tag/v2", publishedAt: "2026-11-11T10:00:00Z", createdAt: "2026-11-01T10:00:00Z", isPrerelease: true }, { tagName: "v1", name: "One", url: "u", publishedAt: "2026-10-01T10:00:00Z" }, { tagName: "v3", isDraft: true, createdAt: "2026-11-12T10:00:00Z" }] },
                refs: {
                  nodes: [
                    { name: "v2", target: { committedDate: "2026-11-11T09:00:00Z" } },
                    { name: "themes@0.1.0", target: { tagger: { date: "2026-11-13T12:00:00+01:00" }, target: { committedDate: "2026-11-01T00:00:00Z" } } },
                    { name: "a/b c", target: { committedDate: "2026-11-09T00:00:00Z" } },
                    { name: "old", target: { committedDate: "2026-10-01T00:00:00Z" } },
                    { name: "odd", target: {} },
                  ],
                },
              },
              { nameWithOwner: "evil/x", releases: { nodes: [{ tagName: "v9", publishedAt: "2026-11-11T10:00:00Z" }] } },
            ],
          },
        },
        shipped1: null,
      } as T;
    },
  };
  const got = await loadShipped(ghe, "acme, me", "2026-11-01", Date.parse("2026-11-14T12:00:00Z"));
  assert.deepEqual(got, {
    prs: [
      { repo: "acme/api", number: 7, title: "feat: 7", url: "https://github.com/acme/api/pull/7", mergedAt: "2026-11-12T09:00:00Z", author: "kari" },
      { repo: "acme/site", number: 3, title: "feat: 3", url: "https://github.com/acme/site/pull/3", mergedAt: "2026-11-10T08:00:00Z", author: "kari" },
      { repo: "acme/site", number: 4, title: "feat: 4", url: "https://github.com/acme/site/pull/4", mergedAt: "2026-11-03T08:00:00Z", author: "kari" },
    ],
    releases: [{ repo: "acme/site", tag: "v2", name: "v2", url: "https://github.com/acme/site/releases/tag/v2", at: "2026-11-11T10:00:00Z", pre: true }],
    tags: [
      { repo: "acme/site", tag: "themes@0.1.0", url: "https://github.com/acme/site/releases/tag/themes%400.1.0", at: "2026-11-13T11:00:00Z" },
      { repo: "acme/site", tag: "a/b c", url: "https://github.com/acme/site/releases/tag/a/b%20c", at: "2026-11-09T00:00:00Z" },
    ],
  });
  const search = queries.filter((q) => q.includes("search(type: ISSUE"));
  assert.equal(search.length, 3, "a week at a time, and a page without a next is a week's last");
  assert.match(search[0]!, /user:acme user:me is:pr is:merged merged:2026-11-01\.\.2026-11-07 /);
  assert.match(search[1]!, /merged:>=2026-11-08 /);
  assert.equal(got.more, undefined, "every PR the search counted was read");
  const repos = queries.filter((q) => q.includes("repositoryOwner"));
  assert.equal(repos.length, 1);
  assert.match(repos[0]!, /shipped0: repositoryOwner\(login: "acme"\).*shipped1: repositoryOwner\(login: "me"\)/s);
  assert.match(repos[0]!, /isArchived: false/);
  assert.deepEqual(await loadShipped({ ...ghe, graphql: async () => assert.fail("not asked") }, "", "2026-11-01"), { prs: [], releases: [], tags: [] }, "no owners, nothing asked");
});

test("shipped: a week with more than the search gives says so", async () => {
  let asked = 0;
  const ghe: Ghe = {
    host: "github.com",
    rest: async () => assert.fail("no REST"),
    graphql: async <T>(q: string) => (q.includes("search(") ? (asked++, { shipped: { issueCount: 1200, pageInfo: { hasNextPage: asked < 10, endCursor: `c${asked}` }, nodes: [pr("acme/site", asked, "2026-11-13T08:00:00Z")] } }) : {}) as T,
  };
  const got = await loadShipped(ghe, "acme", "2026-11-12", Date.parse("2026-11-14T12:00:00Z"));
  assert.equal(asked, 10, "ten pages, as far as the search goes");
  assert.equal(got.more, true);
  assert.equal(got.prs.length, 10);
});

test("shipped: more than the search gives is said; hostile text is cut to size, never made a link of ours", () => {
  const got = shippedOf({ nodes: [{ ...pr("acme/site", 1, "2026-11-10T08:00:00Z", "x".repeat(900)), url: "javascript:alert(1)" }, pr("acme/../x", 2, "2026-11-10T08:00:00Z"), pr("acme/site", 3, "soon")], more: true }, { o0: { repositories: { nodes: [{ nameWithOwner: 'acme/"><script>', refs: { nodes: [{ name: "v1", target: { committedDate: "2026-11-10T08:00:00Z" } }] } }] } } }, { owners: "acme", since: "2026-11-01", host: "github.com" });
  assert.equal(got.more, true);
  assert.equal(got.prs.length, 1, "a repo that isn't owner/name and a time that isn't one are left out");
  assert.equal(got.prs[0]!.title.length, 300);
  assert.equal(got.prs[0]!.url, "javascript:alert(1)", "the forge's link as it gave it: a page puts it through safeUrl");
  assert.deepEqual(got.tags, []);
});

test("shipped: packs ask by day, 92 days back at most, and the answer is kept by owners and day", async () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const calls: string[] = [];
  const reads = packReads({ shipped: async (o, since) => (calls.push(`${o} ${since}`), { prs: [], releases: [], tags: [] }) }, () => "acme", { now: () => now });
  await reads.shipped!("2026-11-01");
  await reads.shipped!("2026-11-01");
  await reads.shipped!("2026-08-14");
  assert.deepEqual(calls, ["acme 2026-11-01", "acme 2026-08-14"]);
  for (const bad of ["2026-08-13", "2026-11-15", "2026-11-01T00:00:00Z", "2026-02-30", "yesterday", "", 7 as never]) await assert.rejects(reads.shipped!(bad), /Not a day to read from/, String(bad));
  assert.equal(packReads({}, () => "acme").shipped, undefined, "a forge that doesn't say has no call");
});

test("shipped: a pack reads it through ctx.forge()", async () => {
  const reader: Pack = {
    manifest: { api: PACK_API, id: "reader", name: "reader", description: "", domain: "personal" },
    routes: (app, ctx) => {
      app.get("/reader", async (c) => c.json(await ctx.forge()?.shipped?.(new Date().toISOString().slice(0, 10))));
    },
  };
  const { get } = signedIn(snapshot(), {}, { packs: [reader], forge: { id: "github", name: "GitHub", can: [], host: "github.com", shipped: async (o) => ({ prs: [], releases: [], tags: [{ repo: `${o}/site`, tag: "v1", url: "u", at: "t" }] }) } });
  assert.deepEqual(await (await get("/reader")).json(), { prs: [], releases: [], tags: [{ repo: "ACME/site", tag: "v1", url: "u", at: "t" }] });
});
