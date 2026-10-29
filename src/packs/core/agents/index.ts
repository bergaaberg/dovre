/**
 * Agents, a core pack (PLAN WP-H9d): the coding agents on this machine (or, hosted, on the Mac
 * over the bridge) and the agents desk that talks to them (src/agents/desk.ts). What it adds to
 * core pages goes through hooks like any pack's: Agents and Worktrees in the menu (with how many
 * are live, and whether one waits), the agents that need me (`needs`, ringing "agent-ask"), and
 * the bar on every page when an agent started here stopped on a tool it needs my OK for (`banner`),
 * on Today its card, numbers, sentence, horizon row and feed events (today.ts), and in search its
 * pages, sessions and worktrees (finds.ts); for Bino, the agents running and what its pages are (bino.ts).
 * Its pages: /agents (the list, a session, a new one) and /worktrees (routes.ts), on whose places
 * other packs put theirs through slots (terminal: its panel, a worktree's button, resume here).
 * It keeps this machine's sessions and worktrees itself (here.ts: read every 15 s and when Claude
 * Code's session files change), asks the gather for the PRs they link (`linked`), adds its
 * counts to the pulse (`pulse`), and rings when a turn started here ends (turns.ts).
 * Runs locally and hosted ("any"); hosted, the sessions are the Mac's over the desk (brought up to
 * date before each page, `beforePage`), and worktrees aren't there to show.
 */
import { html } from "hono/html";
import type { Desk } from "../../../agents/desk.ts";
import type { Dismissed } from "../../../agents/dismissed.ts";
import type { Run } from "../../../agents/runner.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import { type Pack, PACK_API, type PackContext } from "../../types.ts";
import { loadPolicy } from "../../../notify.ts";
import type { Quiet } from "../../../quiet.ts";
import { agentAsksOf } from "./asks.ts";
import { aboutAgentPage, agentsForBino } from "./bino.ts";
import { agentFinds, agentPages } from "./finds.ts";
import type { Here, Sessions } from "./here.ts";
import { agentNeeds } from "./needs.ts";
import { agentRoutes } from "./routes.ts";
import { agentBrief, agentFeed, agentGlance, agentLane, agentsCard } from "./today.ts";
import { agentActivity, turnNote, turnWatch } from "./turns.ts";
import { askBar } from "./view.ts";
import { type AutoPass, autoTick, labelForAuto, runAgain } from "../../../actions/auto.ts";
import { type AutoSettings, DEFAULT_AUTO, autoSettingsOf, loadAutoSettings, repoOn, saveAutoSettings } from "../../../agents/auto.ts";
import { issuePicks } from "./picks.ts";
import { writeClicksStore } from "../../../writes.ts";
import { alonePanel, autoNeeds, autoPanel } from "./auto.ts";

export type AgentsDeps = {
  /** This machine's desk, or hosted the Mac's over the bridge. */
  desk: Desk;
  /** Sessions I've cleared away from Dovre's lists. */
  dismissed: Dismissed;
  /** This machine's sessions and worktrees (here.ts); hosted there are none, the Mac's come over the desk. */
  here?: Here;
  /** Hears every change to a turn started here (the runner's onChange): one that ends may ring. */
  onTurn?: (listen: (r: Run) => void) => void;
  /** How long a turn runs before its end rings (Settings → Notifications); default 10 min. */
  longTurnMs?: () => number;
  /** The forge, for a sandbox run's draft PR (#206) and auto runs (#207): absent, a run's commits stay a branch on its machine. */
  github?: { ghe: Pick<Ghe, "rest" | "graphql">; owners: () => string };
  /** Locally: the repo (owner/name) a checkout's origin is, for the quick picks (#243). Hosted, a checkout named like a repo is that repo. */
  repoOf?: (dir: string) => string | undefined;
};

const NONE: Sessions = { live: [], recent: [] };

/** The sessions the pages show: hosted the Mac's as it last said, else this machine's; without the ended ones I cleared away. */
export function sessionsOf(desk: Desk, here: Here | undefined, dismissed?: Pick<Dismissed, "has">): Sessions {
  const all = desk.view().sessions ?? here?.sessions() ?? NONE;
  return dismissed ? { live: all.live, recent: all.recent.filter((x) => !dismissed.has(x.sessionId)) } : all;
}

export function agentsPack({ desk, dismissed, here, onTurn, longTurnMs, github, repoOf }: AgentsDeps): Pack {
  const sessions = (cleared?: boolean) => sessionsOf(desk, here, cleared ? dismissed : undefined);
  let stop = () => {};
  // Auto runs (#207): the limits and the last pass, kept for needs and the Settings panel.
  let auto: AutoSettings = { ...DEFAULT_AUTO };
  /** Notifications' quiet hours, shown beside auto runs' choice (#272). */
  let notifyQuiet: Quiet | null = null;
  const readSettings = async (db: PackContext["db"]) => {
    auto = await loadAutoSettings(db);
    notifyQuiet = (await loadPolicy(db).catch(() => undefined))?.quiet ?? null;
  };
  let pass: AutoPass | undefined;
  const picks = github ? issuePicks({ ghe: github.ghe, owners: github.owners, repoOf }) : undefined;
  return {
    manifest: {
      api: PACK_API,
      id: "agents",
      name: "Agents",
      description: "Coding agents on this machine, or the Mac's from anywhere: start, follow, answer",
      domain: "general",
      execution: "any",
      paths: ["worktrees"],
      rings: [
        { kind: "agent-ask", label: "An agent needs my OK", hint: "A permission question, or a tool it was refused" },
        { kind: "agent-done", label: "A long agent turn finishes", hint: "Only turns started here, longer than Settings → Agents says" },
        { kind: "agent-auto", label: "An auto run needs me", hint: "A dovre:auto issue's draft PR waits for my OK, or its run got stuck" },
      ],
      // Auto runs' pass: following runs, and a search for newly labelled issues.
      everyMs: 2 * 60_000,
    },
    async refresh(ctx) {
      if (!github) return;
      await readSettings(ctx.db);
      const before = JSON.stringify(pass ?? null);
      pass = await autoTick({ db: ctx.db, ghe: github.ghe, owners: github.owners(), desk, clicks: () => writeClicksStore(ctx.db).get(), tz: ctx.env.TZ_NAME });
      if (JSON.stringify(pass) !== before) ctx.publish(["agents"]);
    },
    settings: (ctx) => (github ? autoPanel(auto, pass, ctx.env.GHE_HOST ?? "github.com", ctx.env.TZ_NAME, notifyQuiet) : ""),
    init(ctx) {
      if (github) void readSettings(ctx.db).catch(() => {});
      // Locally the sessions and worktrees are read here; a read that changed them redraws the pages (and what needs me rings).
      if (here && !ctx.hosted) stop = here.start(() => ctx.publish(["snapshot"]));
      const watch = turnWatch();
      onTurn?.((r) => {
        if (!watch.ended(r)) return;
        const note = turnNote(r, longTurnMs?.() ?? 10 * 60_000);
        if (note) ctx.ring(note);
      });
    },
    dispose: () => stop(),
    pulse: () => agentActivity(sessions().live, desk.view().runs),
    linked: () => [...sessions().live, ...sessions().recent].flatMap((x) => (x.prs ?? []).map((p) => p.url)),
    ...(desk.refresh ? { beforePage: () => desk.refresh!() } : {}),
    nav: (ctx) => {
      const { live } = sessions();
      const runs = desk.view().runs;
      const count = live.length + runs.filter((r) => r.status === "running").length;
      const hot = live.some((a) => a.status !== "busy") || runs.some((r) => r.status !== "running" && r.events.some((e) => e.t === "denied"));
      return [
        { href: "/agents", title: "Agents", icon: "spark", group: "Agents", order: 10, count, hot },
        ...(ctx.hosted ? [] : [{ href: "/worktrees", title: "Worktrees", icon: "branch" as const, group: "Code", order: 30 }]),
      ];
    },
    needs: (ctx) => [...agentNeeds(sessions().live), ...autoNeeds(pass, ctx.env.GHE_HOST ?? "github.com", Date.now())],
    today: async (ctx) => {
      const s = await ctx.gathered();
      return s ? [{ id: "live", column: "left", order: 10, render: agentsCard(s, sessions(true), desk.view().runs, Date.now()) }] : [];
    },
    glance: (ctx) => agentGlance(sessions(true), desk.view().runs, Date.now()),
    brief: (ctx) => agentBrief(sessions().live, desk.view().runs),
    lane: (ctx) => agentLane(sessions(true), Date.now()),
    pages: (ctx) => agentPages(ctx.hosted),
    bino: (ctx) => agentsForBino(sessions().live),
    about: (ctx, path) => aboutAgentPage(path, sessions()),
    finds: (ctx) => agentFinds(sessions(true), desk.view().runs, ctx.hosted ? [] : (here?.worktrees() ?? [])),
    feed: (ctx) => agentFeed(sessions(true), desk.view().runs, Date.now()),
    routes: (app, ctx) => {
      agentRoutes(app, ctx, { desk, dismissed, here, github, picks, autoOn: (r) => repoOn(auto, r), ...(github ? { alone: () => alonePanel(auto, pass, ctx.env.GHE_HOST ?? "github.com", Date.now()) } : {}) });
      // Quick picks → Run in sandbox (#243): the issue labelled dovre:auto, for the next pass.
      if (github)
        app.post("/agents/auto/label", async (c) => {
          const form = await c.req.parseBody();
          const dir = String(form.dir ?? "");
          const r = await labelForAuto({ db: ctx.db, ghe: github.ghe, owners: github.owners(), settings: auto, repo: form.repo, number: form.number });
          const q = new URLSearchParams({ repo: dir, ...(r.ok ? { labelled: String(Number(form.number)) } : { error: r.error }) });
          return c.redirect(`/agents/new?${q}`, 303);
        });
      // Settings → Agents: the auto runs' limits.
      if (github)
        app.post("/agents/auto", async (c) => {
          auto = autoSettingsOf(await c.req.parseBody());
          await saveAutoSettings(ctx.db, auto);
          return c.redirect("/settings/agents#auto", 303);
        });
      // "Working alone" → Run again (#209): a stuck issue labelled dovre:auto again and queued.
      if (github)
        app.post("/agents/auto/again", async (c) => {
          const key = String((await c.req.parseBody()).key ?? "");
          const r = await runAgain({ db: ctx.db, ghe: github.ghe, owners: github.owners(), key });
          // Shown on its row until the next pass; it's in the actions log too.
          if (pass) pass = { ...pass, rows: pass.rows.map((x) => (x.key !== key ? x : r.ok ? { ...x, state: "queued", why: null } : { ...x, why: `Run again didn't go: ${r.error}` })) };
          ctx.publish(["agents"]);
          return c.redirect("/agents", 303);
        });
    },
    // Not on the session's own page: it asks there itself.
    banner: (_ctx, { path }) => {
      const asks = agentAsksOf(desk.view().runs, (sid) => dismissed.has(sid)).filter((a) => path !== `/agents/s/${a.sid}`);
      return asks.length ? html`${asks.map(askBar)}` : "";
    },
  };
}
