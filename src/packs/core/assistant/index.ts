/**
 * The assistant, a core pack (PLAN WP-M4): Bino, and Topo, what Bino and the pages know
 * about each repo. Both live in ./bino/. PACK_ASSISTANT=off switches both off.
 *
 * Bino (conversations, memory, its model route, the dock) is still wired by the core (src/app.ts,
 * src/hosted/hub.ts); this pack is its switch and its place on /packs.
 *
 * Topo (PLAN D18, D19, WP-H9b): each checkout's peak.yaml (bergaaberg/peak; range.yaml is the old name) right under CODE_DIR, its
 * page (/topo), and what it puts in core pages through slots: the component picker on
 * /agents/new, a PR's tier and docs on /prs, the Projects on New work. Only with a code folder
 * (local); PACK_TOPO=off leaves it out and keeps Bino.
 */
import { listRepos } from "../../../sources/claude.ts";
import { WORK } from "../../../agents/workdir.ts";
import { type Pack, PACK_API } from "../../types.ts";
import { TopoScanner } from "./bino/scan.ts";
import { topoPage, binoLines, componentField, prFacts, prLead, projectsPanel } from "./bino/topo.view.ts";

export type AssistantOpts = {
  /** Where the checkouts are (CODE_DIR); without one (hosted, or PACK_TOPO=off) there's no Topo. */
  codeDir?: string;
  /** Keeps what it read for 30 s. */
  scanner?: TopoScanner;
};

const MANIFEST = {
  api: PACK_API,
  id: "assistant",
  name: "Assistant",
  description: "Bino, and what each repo is (Topo, from peak.yaml): tier, components, rules and docs",
  domain: "general",
} as const;

export function assistantPack(opts: AssistantOpts = {}): Pack {
  const { codeDir } = opts;
  if (!codeDir) return { manifest: { ...MANIFEST } };
  const scanner = opts.scanner ?? new TopoScanner(codeDir);
  return {
    manifest: { ...MANIFEST, paths: ["topo", "atlas"] },
    nav: () => [{ href: "/topo", title: "Topo", icon: "topo", group: "Code" }],
    pages: () => [{ title: "Topo", href: "/topo", icon: "⎈", about: "The map of your repos: what each is, its components, rules and docs", also: ["topo", "atlas", "map", "peak", "range", "catalog", "manifest", "repos"] }],
    bino: () => binoLines(scanner.list()),
    slots: () => ({
      "agents.new": ({ repo }) => componentField(repo, scanner.get(repo)),
      "pr.lead": ({ repo }) => prLead(scanner.get(repo)),
      "pr.facts": ({ repo }) => prFacts(repo, scanner.get(repo)),
      "work.new": () => projectsPanel(scanner.list()),
    }),
    routes: (app, ctx) => {
      // Topo was called Atlas: old links and bookmarks land here.
      app.get("/atlas", (c) => c.redirect(`/topo${new URL(c.req.url).search}`, 301));
      app.get("/topo", (c) => {
        if (c.req.query("refresh") === "1" || c.req.query("fresh") === "1") scanner.scan(true);
        const entries = scanner.list();
        const problems = scanner.problems();
        const broken = new Set(problems.map((p) => p.repo));
        const bare = listRepos(codeDir).filter((r) => r !== WORK && !scanner.get(r) && !broken.has(r));
        return ctx.page(c, { title: "Topo · Dovre", current: "/topo", body: topoPage({ entries, bare, problems, filter: c.req.query("tier") }) });
      });
    },
  };
}
