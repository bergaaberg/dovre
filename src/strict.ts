/**
 * The stricter guard for routes that run things as me (terminals, the Docker engine), on top of
 * the app's cookie and localhost checks:
 *  - a request another site started (Sec-Fetch-Site cross-site / same-site) gets a 404, even with
 *    the cookie (which SameSite=Strict keeps from it anyway);
 *  - every write must say it comes from this app's own origin: the app's guard lets a request
 *    without Origin through, this one doesn't. Behind PUBLIC_ORIGIN (#74), exactly that origin
 *    counts as this app's own too (the app puts it on the request as `publicOrigin`).
 */
import type { MiddlewareHandler } from "hono";
import { isOwnOrigin } from "./access.ts";

export const strictOrigin: MiddlewareHandler = async (c, next) => {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return c.notFound();
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (!isOwnOrigin(c.req.raw, origin, c.get("publicOrigin") as string | undefined)) return c.text("This takes a request from Dovre itself.", 403);
  }
  await next();
};
