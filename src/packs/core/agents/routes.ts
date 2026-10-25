/**
 * The agents pack's pages and actions: the list, a session (its conversation, reply, answer,
 * allow, stop, clear away), a new session, a run without a session yet, and worktrees. Everything
 * that touches an agent goes through the desk (this machine's, or hosted the Mac's), which checks
 * what it's given as a route would; here is only what's about the page: flashes, back where I was,
 * sessions cleared away.
 */
import type { Context, Hono } from "hono";
import { type Done, type Desk, SID } from "../../../agents/desk.ts";
import type { Dismissed } from "../../../agents/dismissed.ts";
import type { AppEnv } from "../../../env.ts";
import type { Snapshot } from "../../../gather.ts";
import type { MacStatus } from "../../../pages/parts.ts";
import type { PackContext } from "../../types.ts";
import type { Here } from "./here.ts";
import { sessionsOf } from "./index.ts";
import { agentPage, newAgentPage } from "./session.view.ts";
import { agentsPage, worktreesPage } from "./view.ts";

type C = Context<AppEnv>;

/** This app's own page the form was on (path and query), else `to`. */
function refBack(c: C, to: string): string {
  try {
    const ref = c.req.header("referer");
    const u = ref ? new URL(ref) : undefined;
    if (u && u.host === new URL(c.req.url).host && u.pathname.startsWith("/") && !u.pathname.startsWith("//")) return u.pathname + u.search;
  } catch {}
  return to;
}

/** Back where the button was (Agents, Today), else `to`. */
function backTo(c: C, to: string): string {
  try {
    const ref = c.req.header("referer");
    const u = ref ? new URL(ref) : undefined;
    if (u && u.host === new URL(c.req.url).host && (u.pathname === "/" || u.pathname === "/agents")) return u.pathname;
  } catch {}
  return to;
}

const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);

export function agentRoutes(app: Hono<AppEnv>, ctx: PackContext, { desk, dismissed, here }: { desk: Desk; dismissed: Dismissed; here?: Here }) {
  /** Hosted: the Mac online or when it was last; locally nothing to say. */
  const macOf = (): MacStatus | undefined => {
    const v = desk.view();
    return v.remote ? { online: v.online, seen: v.seen } : undefined;
  };
  /** The snapshot the pages draw from (PRs, their states), once what I've cleared away is known. */
  const shown = async (): Promise<Snapshot | undefined> => {
    const s = await ctx.gathered();
    if (!s) return undefined;
    await dismissed.ready;
    return s;
  };
  /** Nothing gathered yet: the core's "Gathering" page, which fills itself in. */
  const gathering = (c: C) => ctx.page(c, { title: "Agents · Dovre", body: "" });
  const flashes = new Map<string, string>();
  /** What the desk said to do: a flash for the session's page, and back where the form was when asked. */
  const done = async (c: C, sid: string, d: Done, back?: unknown) => {
    if (d.flash) flashes.set(sid, d.flash);
    // Talking to a session I'd cleared away brings it back.
    if (d.started) await dismissed.remove(sid);
    return c.redirect(d.started && back === "1" ? refBack(c, d.to) : d.to, 303);
  };
  /** Sessions cleared away leave every list; the pages showing them redraw. */
  const cleared = async (sids: string[]) => {
    await dismissed.add(sids);
    ctx.publish(["snapshot"]);
  };

  app.get("/agents", async (c) => {
    const s = await shown();
    if (!s) return gathering(c);
    const v = desk.view();
    return ctx.page(c, agentsPage(s, sessionsOf(desk, here, dismissed), v.runs, { workDir: v.workDir, mac: macOf(), panels: ctx.fill("agents.panel", {}), resume: (session) => ctx.fill("session.resume", { session }) }));
  });
  app.get("/agents/new", async (c) => {
    const v = desk.view();
    return ctx.page(c, newAgentPage({ repos: await desk.repos(), repo: c.req.query("repo"), prompt: c.req.query("prompt"), harnesses: v.harnesses, workDir: v.workDir, mac: macOf(), fields: (repo) => ctx.fill("agents.new", { repo }) }));
  });
  app.post("/agents/new", async (c) => {
    const form = await c.req.parseBody();
    const r = await desk.start({ repo: form.repo, prompt: form.prompt, harness: form.harness, mode: form.mode, model: form.model });
    if ("to" in r) return c.redirect(r.to, 303);
    const v = desk.view();
    const res = await ctx.page(c, newAgentPage({ repos: await desk.repos(), repo: String(form.repo ?? ""), prompt: String(form.prompt ?? ""), harnesses: v.harnesses, workDir: v.workDir, mac: macOf(), error: r.error, fields: (repo) => ctx.fill("agents.new", { repo }) }));
    return new Response(res.body, { status: 400, headers: res.headers });
  });
  app.get("/agents/r/:run", async (c) => {
    const run = await desk.run(c.req.param("run"));
    if (!run) return c.notFound();
    if (run.sessionId) return c.redirect(`/agents/s/${run.sessionId}`, 303);
    return ctx.page(c, agentPage({ sessionId: run.id, turns: [{ role: "user", text: run.prompt }], run, mac: macOf() }));
  });
  app.get("/agents/s/:sid", async (c) => {
    const sid = c.req.param("sid");
    if (!SID.test(sid)) return c.notFound();
    const v = await desk.session(sid);
    if (!v) return c.notFound();
    const flash = flashes.get(sid);
    flashes.delete(sid);
    return ctx.page(c, agentPage({ sessionId: sid, session: v.session, turns: v.turns, run: v.run, flash, discardable: v.discardable, turnCost: v.turnCost, queued: v.queued, mac: macOf(), replyCopies: v.replyCopies, copies: v.copies, copyOf: v.copyOf }));
  });
  /** Answers to the agent's newest question (AskUserQuestion), as its next message. Only offered choices count. */
  app.post("/agents/s/:sid/answer", async (c) => {
    const sid = c.req.param("sid");
    if (!SID.test(sid)) return c.notFound();
    return done(c, sid, await desk.answer(sid, await c.req.parseBody({ all: true })));
  });
  app.post("/agents/s/:sid/reply", async (c) => {
    const sid = c.req.param("sid");
    if (!SID.test(sid)) return c.notFound();
    const form = await c.req.parseBody();
    // From the bar on another page: stay there.
    return done(c, sid, await desk.reply(sid, { prompt: form.prompt, mode: form.mode, model: form.model }), form.back);
  });
  /** One click allows the exact calls that were refused (each the narrowest rule), and the agent goes on. */
  app.post("/agents/s/:sid/allow", async (c) => {
    const sid = c.req.param("sid");
    if (!SID.test(sid)) return c.notFound();
    const form = await c.req.parseBody({ all: true });
    return done(c, sid, await desk.allow(sid, { specs: form.spec, mode: form.mode, model: form.model }), one(form.back));
  });
  app.post("/agents/s/:sid/queue/:id/remove", async (c) => {
    const sid = c.req.param("sid");
    if (!SID.test(sid)) return c.notFound();
    await desk.dequeue(sid, c.req.param("id"));
    return c.redirect(`/agents/s/${sid}`, 303);
  });
  app.post("/agents/s/:sid/stop", async (c) => {
    const sid = c.req.param("sid");
    await desk.stop(sid);
    return c.redirect(backTo(c, `/agents/s/${sid}`), 303);
  });
  /**
   * Clearing away sessions started here: the desk drops the runs' own files, and the sessions
   * leave Dovre's lists. A session still working, or open in a terminal, isn't cleared.
   */
  app.post("/agents/s/:sid/discard", async (c) => {
    const sid = c.req.param("sid");
    if (!SID.test(sid)) return c.notFound();
    const r = await desk.discard(sid);
    if ("flash" in r) {
      flashes.set(sid, r.flash);
      return c.redirect(`/agents/s/${sid}`, 303);
    }
    await cleared(r.cleared);
    return c.redirect(backTo(c, "/agents"), 303);
  });
  app.post("/agents/r/:run/discard", async (c) => {
    const r = await desk.discardRun(c.req.param("run"));
    if (r.cleared.length) await cleared(r.cleared);
    return c.redirect(backTo(c, "/agents"), 303);
  });
  app.post("/agents/r/:run/stop", async (c) => {
    await desk.stopRun(c.req.param("run"));
    return c.redirect(backTo(c, "/agents"), 303);
  });
  /** Everything started here that has ended: runs, and sessions in Dovre's folder. */
  app.post("/agents/clear", async (c) => {
    await cleared((await desk.clear()).cleared);
    return c.redirect("/agents", 303);
  });
  // Worktrees are this machine's checkouts: not there hosted.
  if (!ctx.hosted)
    app.get("/worktrees", async (c) => {
      const s = await shown();
      if (!s) return gathering(c);
      return ctx.page(c, worktreesPage(s, here?.worktrees() ?? [], (name) => ctx.fill("worktree.actions", { name })));
    });
}
