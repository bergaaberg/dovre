/** The relay (launcher/relay.go): an MCP server's question, answered here and only here; and page loads, as the page measured them. */
import { logAction } from "../actions/deploys.ts";
import { routeOk } from "../speed.ts";
import type { App } from "../env.ts";
import type { AppScope } from "./scope.ts";

export function relayRoutes(app: App, s: Pick<AppScope, "env" | "deps" | "asks" | "perfLog" | "speed">) {
  const { env, deps, asks, perfLog, speed } = s;
  // ── The relay (launcher/relay.go): an MCP server's question, answered here and only here ──
  app.post("/relay/ask", async (c) => {
    const q = (await c.req.json().catch(() => null)) as { server?: unknown; message?: unknown; schema?: unknown } | null;
    if (!q || typeof q.message !== "string") return c.json({ error: "a question has a message" }, 400);
    return c.json({ id: asks.put({ server: q.server, message: q.message, schema: q.schema }).id });
  });
  app.get("/relay/ask/:id", async (c) => c.json(await asks.wait(c.req.param("id"), 25_000)));

  // ── Page loads, as the page measured them (src/ui/app.js.ts): numbers, a path and its route, nothing else ──
  app.post("/perf", async (c) => {
    const j = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const path = typeof j?.path === "string" && /^\/[\w\-\/.]{0,200}$/.test(j.path) ? j.path : null;
    if (!j || !path) return c.body(null, 204);
    const num = (k: string) => (typeof j[k] === "number" && Number.isFinite(j[k]) ? Math.round(j[k] as number) : -1);
    // A page reloaded from the back/forward cache or a prerender says nothing of the server.
    if (routeOk(j.route) && j.type !== "back_forward" && num("total") >= 0 && num("total") < 120_000) speed.record("page", j.route, num("total"));
    if (num("total") < 800) return c.body(null, 204);
    const line = [new Date().toISOString(), path, String(j.type).replace(/[^a-z_]/g, "").slice(0, 12), ...["total", "redirect", "worker", "connect", "wait", "download", "dom", "load"].map((k) => `${k}=${num(k)}`)].join(" ");
    perfLog(line);
    return c.body(null, 204);
  });
  /** One answer for a group of questions from the same server (the bar's "Allow all", "Deny all"): each answered, each logged. */
  app.post("/relay/asks/answer", async (c) => {
    const form = await c.req.parseBody();
    const ids = (typeof form.ids === "string" ? form.ids : "").split(",").filter((id) => /^[0-9a-f-]{36}$/.test(id)).slice(0, 20);
    const shown = asks.list().filter((q) => ids.includes(q.id));
    // Only a group the bar showed: one server, the same choices.
    const same = shown.length > 0 && shown.every((q) => q.server === shown[0]!.server && q.choices.map((x) => x.value).join() === shown[0]!.choices.map((x) => x.value).join());
    if (same)
      for (const q of shown) {
        const done = asks.answer(q.id, form.decline === "1" ? { decline: true } : { choice: typeof form.choice === "string" ? form.choice : undefined });
        if (done) await logAction(env.DB, { kind: "relay.answer", target: q.server, detail: `${form.decline === "1" ? "declined" : String(form.choice)} (all ${shown.length}) · ${q.message.split(String.fromCharCode(10))[0]!.slice(0, 160)}`, ok: true });
      }
    deps.hub?.publish(["snapshot"]);
    const back = c.req.header("referer");
    const path = back && new URL(back).host === new URL(c.req.url).host ? new URL(back).pathname + new URL(back).search : "/";
    return c.redirect(path, 303);
  });
  app.post("/relay/ask/:id/answer", async (c) => {
    const form = await c.req.parseBody();
    const id = c.req.param("id");
    const shown = asks.list().find((q) => q.id === id);
    const done = asks.answer(id, form.decline === "1" ? { decline: true } : { choice: typeof form.choice === "string" ? form.choice : undefined });
    if (shown && done) {
      const what = form.decline === "1" ? "declined" : String(form.choice);
      const firstLine = shown.message.split(String.fromCharCode(10))[0]!.slice(0, 160);
      await logAction(env.DB, { kind: "relay.answer", target: shown.server, detail: `${what} · ${firstLine}`, ok: true });
    }
    deps.hub?.publish(["snapshot"]);
    const back = c.req.header("referer");
    const path = back && new URL(back).host === new URL(c.req.url).host ? new URL(back).pathname + new URL(back).search : "/";
    return c.redirect(path, 303);
  });
}
