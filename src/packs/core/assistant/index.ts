/**
 * The assistant, a core pack (PLAN WP-M4): Bino, and Repo Atlas, what Bino and the pages know
 * about each repo. Both live in ./bino/. PACK_ASSISTANT=off switches both off.
 *
 * Bino (conversations, memory, its model route, the dock) is still wired by the core (src/app.ts,
 * src/hosted/hub.ts); this pack is its switch and its place on /packs.
 *
 * Atlas (PLAN D18, D19, WP-H9b): the range.yaml manifests in the checkouts right under CODE_DIR, its
 * page (/atlas), and what it puts in core pages through slots: the component picker on
 * /agents/new, a PR's tier and docs on /prs, the Projects on New work. Only with a code folder
 * (local); PACK_ATLAS=off leaves it out and keeps Bino.
 */
import { listRepos } from "../../../sources/claude.ts";
import { WORK } from "../../../agents/workdir.ts";
import { type Pack, PACK_API } from "../../types.ts";
import { AtlasScanner } from "./bino/scan.ts";
import { atlasPage, binoLines, componentField, prFacts, prLead, projectsPanel } from "./bino/atlas.view.ts";

export type AssistantOpts = {
  /** Where the checkouts are (CODE_DIR); without one (hosted, or PACK_ATLAS=off) there's no Atlas. */
  codeDir?: string;
  /** Keeps what it read for 30 s. */
  scanner?: AtlasScanner;
};

const MANIFEST = {
  api: PACK_API,
  id: "assistant",
  name: "Assistant",
  description: "Bino, and what each repo is (Atlas, from range.yaml): tier, components, rules and docs",
  domain: "general",
} as const;

export function assistantPack(opts: AssistantOpts = {}): Pack {
  const { codeDir } = opts;
  if (!codeDir) return { manifest: { ...MANIFEST } };
  const scanner = opts.scanner ?? new AtlasScanner(codeDir);
  return {
    manifest: { ...MANIFEST, paths: ["atlas"] },
    nav: () => [{ href: "/atlas", title: "Atlas", icon: "atlas", group: "Code" }],
    pages: () => [{ title: "Atlas", href: "/atlas", icon: "⎈", about: "Repository atlas, components, rules, and docs", also: ["atlas", "range", "catalog", "manifest", "repos"] }],
    bino: () => binoLines(scanner.list()),
    slots: () => ({
      "agents.new": ({ repo }) => componentField(repo, scanner.get(repo)),
      "pr.lead": ({ repo }) => prLead(scanner.get(repo)),
      "pr.facts": ({ repo }) => prFacts(repo, scanner.get(repo)),
      "work.new": () => projectsPanel(scanner.list()),
    }),
    routes: (app, ctx) => {
      app.get("/atlas", (c) => {
        if (c.req.query("refresh") === "1" || c.req.query("fresh") === "1") scanner.scan(true);
        const entries = scanner.list();
        const bare = listRepos(codeDir).filter((r) => r !== WORK && !scanner.get(r));
        return ctx.page(c, { title: "Repo Atlas · Dovre", current: "/atlas", body: atlasPage({ entries, bare, filter: c.req.query("tier") }) });
      });
    },
  };
}
