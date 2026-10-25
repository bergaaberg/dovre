/**
 * /terminal…: the pack's routes, mounted by the app after its cookie and localhost checks, plus
 * the stricter guard (src/strict.ts; a terminal runs programs as me, so this is the one place that
 * must never be reachable from anywhere else):
 *  - every write (start, keys, resize, close) must say it comes from this app's own origin: the
 *    app's guard lets a request without Origin through, this one doesn't;
 *  - a request another site started (Sec-Fetch-Site cross-site / same-site) gets a 404, even with
 *    the cookie (which SameSite=Strict keeps from it anyway);
 *  - output goes out as Server-Sent Events on an ordinary route, so no WebSocket upgrade can slip
 *    past the guards.
 * Programs and folders are checked against fixed lists (programs.ts, terms.ts); no command line
 * comes from the page.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../../../env.ts";
import { strictOrigin } from "../../../strict.ts";
import type { PackContext } from "../../types.ts";
import { TERMINAL_JS, TERMINAL_JS_PATH, XTERM } from "./client.ts";
import type { Terminals } from "./terms.ts";
import { terminalPage, terminalsPage } from "./view.ts";

const ID = /^[0-9a-f-]{36}$/;

export function terminalRoutes(app: Hono<AppEnv>, terminals: Terminals, ctx: PackContext) {
  const require = createRequire(import.meta.url);
  const assets: [string, string, string][] = [
    [XTERM.js, require.resolve("@xterm/xterm/lib/xterm.js"), "text/javascript; charset=utf-8"],
    [XTERM.fit, require.resolve("@xterm/addon-fit/lib/addon-fit.js"), "text/javascript; charset=utf-8"],
    [XTERM.css, require.resolve("@xterm/xterm/css/xterm.css"), "text/css; charset=utf-8"],
  ];
  for (const [path, file, type] of assets) {
    const body = readFileSync(file);
    app.get(path, (c) => {
      c.header("Content-Type", type);
      c.header("Cache-Control", "private, max-age=31536000, immutable");
      return c.body(body);
    });
  }
  app.get(TERMINAL_JS_PATH, (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    return c.body(TERMINAL_JS);
  });

  app.use("/terminal", strictOrigin);
  app.use("/terminal/*", strictOrigin);

  const repos = () => terminals.repos();
  app.get("/terminal", async (c) => {
    const repo = c.req.query("repo");
    return ctx.page(c, terminalsPage({ terms: terminals.list(), programs: terminals.programs(), repos: repos(), repo: typeof repo === "string" ? repo : undefined, program: c.req.query("program") }));
  });
  app.post("/terminal", async (c) => {
    const form = await c.req.parseBody();
    const got = terminals.start({
      program: String(form.program ?? ""),
      repo: String(form.repo ?? ""),
      resume: typeof form.resume === "string" && form.resume ? form.resume : undefined,
      cols: Number(form.cols) || undefined,
      rows: Number(form.rows) || undefined,
    });
    if ("problem" in got) {
      const r = await ctx.page(c, terminalsPage({ terms: terminals.list(), programs: terminals.programs(), repos: repos(), problem: got.problem }));
      return new Response(r.body, { status: 400, headers: r.headers });
    }
    ctx.publish(["snapshot"]);
    return c.redirect(`/terminal/${got.id}`, 303);
  });
  app.post("/terminal/external", async (c) => {
    const form = await c.req.parseBody();
    const got = terminals.openExternal({
      app: form.app === "wt" ? "wt" : "warp",
      program: String(form.program ?? ""),
      repo: String(form.repo ?? ""),
      resume: typeof form.resume === "string" && form.resume ? form.resume : undefined,
    });
    if ("problem" in got) {
      const r = await ctx.page(c, terminalsPage({ terms: terminals.list(), programs: terminals.programs(), repos: repos(), problem: got.problem }));
      return new Response(r.body, { status: 400, headers: r.headers });
    }
    const back = c.req.header("referer");
    const path = back && new URL(back).host === new URL(c.req.url).host ? new URL(back).pathname + new URL(back).search : "/agents";
    return c.redirect(path, 303);
  });
  app.get("/terminal/:id", async (c) => {
    const id = c.req.param("id");
    const t = ID.test(id) ? terminals.get(id) : undefined;
    if (!t) return c.notFound();
    return ctx.page(c, terminalPage(t));
  });
  app.get("/terminal/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!ID.test(id) || !terminals.get(id)) return c.notFound();
    return streamSSE(c, async (stream) => {
      let open = true;
      // One write after another, in order: output can arrive faster than it's written.
      let chain: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: unknown) => {
        chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => (open = false));
      };
      const off = terminals.attach(id, (ch) => (ch.t === "out" ? send("out", ch.data) : send("exit", { code: ch.code, reason: ch.reason })));
      stream.onAbort(() => {
        open = false;
        off?.();
      });
      while (open) {
        await stream.sleep(20_000);
        if (open) send("ping", "");
      }
      off?.();
    });
  });
  app.post("/terminal/:id/input", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as { data?: unknown } | null;
    if (!ID.test(id) || typeof body?.data !== "string") return c.body(null, 400);
    return c.body(null, terminals.input(id, body.data) ? 204 : 404);
  });
  app.post("/terminal/:id/resize", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as { cols?: unknown; rows?: unknown } | null;
    if (!ID.test(id) || !body) return c.body(null, 400);
    return c.body(null, terminals.resize(id, Number(body.cols), Number(body.rows)) ? 204 : 404);
  });
  app.post("/terminal/:id/close", async (c) => {
    const id = c.req.param("id");
    if (ID.test(id)) terminals.close(id);
    ctx.publish(["snapshot"]);
    return c.redirect("/terminal", 303);
  });
}
