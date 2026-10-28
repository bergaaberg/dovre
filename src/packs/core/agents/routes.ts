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
import { diffHref } from "../../../pages/viewer.ts";
import type { PackContext } from "../../types.ts";
import { openSandboxPr } from "../../../actions/sandbox.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import type { Here } from "./here.ts";
import { sessionsOf } from "./index.ts";
import { agentPage, newAgentPage } from "./session.view.ts";
import { agentsPage, worktreesPage } from "./view.ts";

type C = Context<AppEnv>;

/** The diff page of the checkout an agent works in (dovre#105): only one directly under CODE_DIR, as /code has. */
export function diffOf(codeDir: string | undefined, cwd: string | undefined): string | undefined {
  if (!codeDir || !cwd) return undefined;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const at = norm(cwd);
  const i = at.lastIndexOf("/");
  const dir = at.slice(i + 1);
  return i > 0 && dir && at.slice(0, i) === norm(codeDir) ? diffHref(dir) : undefined;
}

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

export function agentRoutes(app: Hono<AppEnv>, ctx: PackContext, { desk, dismissed, here, github }: { desk: Desk; dismissed: Dismissed; here?: Here; github?: { ghe: Pick<Ghe, "rest">; owners: () => string } }) {
  /**
   * Hosted: the machines online or when each was last; with `id`, the one that session or run is
   * on (its page's forms go there). Locally nothing to say.
   */
  const macOf = (id?: string): MacStatus | undefined => {
    const v = desk.view();
    if (!v.remote) return undefined;
    const m = id ? desk.machineOf?.(id) : undefined;
    if (m) return { online: m.online, seen: m.seen, name: m.name };
    return { online: v.online, seen: v.seen, name: v.machines?.[0]?.name, machines: v.machines };
  };
  /** Hosted, with several machines online: the ones a new session may start on. */
  const machinesOf = () => desk.view().machines?.filter((m) => m.online);
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
    return ctx.page(c, newAgentPage({ repos: await desk.repos(), repo: c.req.query("repo"), prompt: c.req.query("prompt"), harnesses: v.harnesses, workDir: v.workDir, mac: macOf(), machines: machinesOf(), sandbox: v.sandbox, fields: (repo) => ctx.fill("agents.new", { repo }) }));
  });
  app.post("/agents/new", async (c) => {
    const form = await c.req.parseBody();
    const r = await desk.start({ repo: form.repo, prompt: form.prompt, harness: form.harness, mode: form.mode, model: form.model, machine: form.machine, sandbox: form.sandbox });
    if ("to" in r) return c.redirect(r.to, 303);
    const v = desk.view();
    const res = await ctx.page(c, newAgentPage({ repos: await desk.repos(), repo: String(form.repo ?? ""), prompt: String(form.prompt ?? ""), harnesses: v.harnesses, workDir: v.workDir, mac: macOf(), machines: machinesOf(), machine: typeof form.machine === "string" ? form.machine : undefined, error: r.error, sandbox: v.sandbox, sandboxed: form.sandbox === "on", fields: (repo) => ctx.fill("agents.new", { repo }) }));
    return new Response(res.body, { status: 400, headers: res.headers });
  });
  app.get("/agents/r/:run", async (c) => {
    const run = await desk.run(c.req.param("run"));
    if (!run) return c.notFound();
    if (run.sessionId) return c.redirect(`/agents/s/${run.sessionId}`, 303);
    const flash = flashes.get(run.id);
    flashes.delete(run.id);
    return ctx.page(c, agentPage({ sessionId: run.id, turns: [{ role: "user", text: run.prompt }], run, flash, mac: macOf(run.id), diff: ctx.hosted || run.sandbox ? undefined : diffOf(ctx.env.CODE_DIR, run.cwd) }));
  });
  app.get("/agents/s/:sid", async (c) => {
    const sid = c.req.param("sid");
    if (!SID.test(sid)) return c.notFound();
    const v = await desk.session(sid);
    if (!v) return c.notFound();
    const flash = flashes.get(sid);
    flashes.delete(sid);
    return ctx.page(c, agentPage({ sessionId: sid, session: v.session, turns: v.turns, run: v.run, flash, discardable: v.discardable, turnCost: v.turnCost, queued: v.queued, mac: macOf(sid), replyCopies: v.replyCopies, copies: v.copies, copyOf: v.copyOf, diff: ctx.hosted || v.run?.sandbox ? undefined : diffOf(ctx.env.CODE_DIR, v.session?.cwd ?? v.run?.cwd) }));
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
  /**
   * A sandbox run's commits as a draft PR (#206): the owners checked, the machine pushes its
   * branch, the forge's branch checked again, then the PR (src/actions/sandbox.ts). Its page says how it went.
   */
  app.post("/agents/r/:run/pr", async (c) => {
    const id = c.req.param("run");
    const run = await desk.run(id);
    if (!run?.sandbox) return c.notFound();
    const at = run.sessionId ?? run.id;
    const to = run.sessionId ? `/agents/s/${run.sessionId}` : `/agents/r/${run.id}`;
    if (!github) {
      flashes.set(at, "Dovre can't reach the forge here, so it can't open a PR.");
      return c.redirect(to, 303);
    }
    const r = await openSandboxPr({ db: ctx.db, ghe: github.ghe, owners: github.owners(), run, push: () => desk.pushSandbox(run.id) });
    if (r.ok) await desk.landed(run.id, { number: r.number, url: r.url });
    else flashes.set(at, r.error);
    return c.redirect(to, 303);
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
