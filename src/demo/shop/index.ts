/**
 * Northwind Shop (#8): the demo's custom app pack, for a storefront. It shows ops metrics
 * (customers, 7-day active, orders today, refunds), the sign-up funnel, orders by state, daily
 * revenue against target, and the support queue. Support actions sit behind Confirm.
 *
 * Its writes work as every pack write to its own app does: each re-checks the current state
 * first (you can't refund an order that's already refunded or never paid), logs to the actions
 * table either way, and refuses with the reason. The demo refuses every POST before the app sees
 * it, so on demo.dovre.dev the Confirm button stops at the read-only page. The pack's shop here
 * is made-up data (`data`), and a write changes only what this pack shows afterwards.
 */
import type { Context } from "hono";
import { logAction } from "../../actions/deploys.ts";
import type { AppEnv } from "../../env.ts";
import { type Pack, PACK_API, type PackContext, type PackNeed } from "../../packs/types.ts";
import { html, PageHeader } from "../../ui/kit.ts";
import { ageOf, getShopData, type ShopData, summaryOf } from "./data.ts";
import { shopPage, shopTodayCard, ticketPage } from "./view.ts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What this pack's writes changed, laid over the shop's data. */
type Done = { refunded: Set<string>; unlocked: Set<string>; extended: Set<string>; replied: Set<string> };

function withDone(data: ShopData, d: Done): ShopData {
  return {
    ...data,
    tickets: data.tickets.map((t) => {
      const order = (o: typeof t.order) => (d.refunded.has(o.id) ? { ...o, state: "refunded" as const } : o);
      const customer = { ...t.customer, ...(d.unlocked.has(t.customer.id) ? { status: "active" as const } : {}), ...(d.extended.has(t.customer.id) ? { freeShippingUntil: "Extended 30 days" } : {}) };
      return { ...t, customer, order: order(t.order), recentOrders: t.recentOrders.map(order), ...(d.replied.has(t.id) ? { state: "waiting" as const } : {}) };
    }),
  };
}

export function northwindShopPack(o: { /** The shop's data (default: the demo's made-up shop). */ data?: (now: number) => ShopData } = {}): Pack {
  const source = o.data ?? getShopData;
  const done: Done = { refunded: new Set(), unlocked: new Set(), extended: new Set(), replied: new Set() };
  const current = () => withDone(source(Date.now()), done);
  const ticketOf = (id: string) => current().tickets.find((t) => t.id === id);
  const customerOf = (id: string) => current().tickets.find((t) => t.customer.id === id)?.customer;

  /** One write: re-checks (`why` says why not), logs either way, then goes back. */
  async function write(c: Context<AppEnv>, ctx: PackContext, w: { kind: string; target: string; detail?: string; why: string | undefined; apply: () => void; back: string }) {
    if (w.why) {
      await logAction(ctx.db, { kind: w.kind, target: w.target, ok: false, error: w.why });
      const res = await ctx.page(c, { title: "Not done · Northwind Shop · Dovre", current: "/shop", body: html`${PageHeader({ title: "Not done", sub: w.why })}<p><a href="${w.back}">Back</a></p>` });
      return new Response(res.body, { status: 409, headers: res.headers });
    }
    w.apply();
    await logAction(ctx.db, { kind: w.kind, target: w.target, detail: w.detail, ok: true });
    ctx.publish(["shop"]);
    return c.redirect(w.back, 303);
  }

  return {
    manifest: {
      api: PACK_API,
      id: "shop",
      name: "Northwind Shop",
      description: "Storefront ops: metrics, support tickets & actions",
      domain: "work",
      execution: "any",
      paths: [],
      rings: [{ kind: "tickets", label: "Support tickets waiting over an hour", hint: "Rings when a customer ticket has been waiting over an hour without reply" }],
    },
    nav: () => [{ href: "/shop", title: "Shop", icon: "box", group: "Ops" }],
    pages: () => [{ title: "Northwind Shop", href: "/shop", icon: "box", about: "Storefront ops: metrics, support tickets & actions", also: ["shop", "store", "orders", "tickets", "refunds", "support", "customers", "northwind"] }],
    finds: () =>
      current().tickets.map((t) => ({
        title: `Ticket #${t.id}: ${t.subject}`,
        sub: `${t.customer.name} · Order ${t.order.id} (${t.order.total})`,
        href: `/shop/tickets/${t.id}`,
        also: [t.id, t.order.id, t.customer.name, t.customer.email],
      })),
    today: () => [shopTodayCard(current())],
    glance: () => [{ label: "Shop orders", value: current().stats.ordersToday }],
    brief: () => {
      const { waiting, failed } = summaryOf(current());
      const parts: Array<string | { text: string; href: string; tone: "warn" | "bad" }> = [];
      if (waiting.length) parts.push({ text: `${plural(waiting.length, "support ticket waits", "support tickets wait")} over an hour`, href: "/shop#queue", tone: "warn" });
      if (failed.length) {
        if (parts.length) parts.push(", and ");
        parts.push({ text: plural(failed.length, "failed payment", "failed payments"), href: `/shop/tickets/${failed[0]!.id}`, tone: "bad" });
        parts.push(failed.length === 1 ? " needs attention." : " need attention.");
      } else if (parts.length) parts.push(".");
      return parts;
    },
    bino: () => {
      const data = current();
      const { waiting, failed } = summaryOf(data);
      const wait = waiting.length ? `${plural(waiting.length, "support ticket", "support tickets")} waiting over an hour (oldest ${ageOf(waiting[0]!.ageMinutes)}).` : "No support ticket waiting over an hour.";
      return `${wait} ${data.stats.ordersToday} orders today, ${plural(failed.length, "failed payment", "failed payments")}.`;
    },
    needs: (): PackNeed[] =>
      summaryOf(current()).waiting.map((t) => ({
        key: `shop-ticket-${t.id}`,
        title: `Support ticket waiting over an hour: #${t.id} (${t.customer.name})`,
        line: `Waiting ${ageOf(t.ageMinutes)} · Order ${t.order.id} · ${t.subject}`,
        href: `/shop/tickets/${t.id}`,
        tone: t.order.state === "failed" ? "bad" : "warn",
        at: Date.now() - t.ageMinutes * 60_000,
        ring: "tickets",
        label: "Shop",
      })),
    acts: () => [
      {
        kind: "reply-ticket",
        title: "Draft reply to support ticket",
        when: "When a customer support ticket is waiting for reply or needs follow-up.",
        fields: [
          { name: "ticket", about: "Ticket ID to reply to", required: true, max: 32 },
          { name: "reply", about: "Draft reply text", required: true, max: 1000, text: true },
        ],
        button: "Send reply",
        inputs: (act, kept) => html`
          <div class="field">
            <span class="label">Ticket ID</span>
            <input type="text" name="ticket" value="${kept?.ticket ?? act.ticket ?? ""}" required>
          </div>
          <div class="field">
            <span class="label">Draft reply</span>
            <textarea name="reply" rows="3" required>${kept?.reply ?? act.reply ?? ""}</textarea>
          </div>
        `,
        async run(form, _act, ctx) {
          const id = (form.ticket ?? "").trim();
          const t = ticketOf(id);
          const target = `ticket #${id}`;
          // Never the reply's text on the log: what was written stays with the ticket.
          const why = !t ? "No such ticket." : t.state === "resolved" ? "That ticket is resolved." : !(form.reply ?? "").trim() ? "Write a reply first." : undefined;
          if (why) {
            await logAction(ctx.db, { kind: "shop.reply", target, ok: false, error: why });
            return { ok: false, error: why };
          }
          done.replied.add(t!.id);
          await logAction(ctx.db, { kind: "shop.reply", target, ok: true });
          ctx.publish(["shop"]);
          return { ok: true, done: `Reply sent on ticket #${t!.id}`, href: `/shop/tickets/${t!.id}` };
        },
      },
    ],
    routes(app, ctx) {
      app.get("/shop", async (c) => ctx.page(c, { title: "Northwind Shop · Dovre", current: "/shop", body: shopPage(current()) }));

      app.get("/shop/tickets/:id", async (c) => {
        const ticket = ticketOf(c.req.param("id"));
        if (!ticket) return c.text("Ticket not found", 404);
        return ctx.page(c, { title: `Ticket #${ticket.id}: ${ticket.subject} · Northwind Shop · Dovre`, current: "/shop", body: ticketPage(ticket) });
      });

      // The support actions (Confirm on the ticket page): each re-checks, logs, and refuses with why.
      app.post("/shop/tickets/:id/resend-receipt", async (c) => {
        const t = ticketOf(c.req.param("id"));
        const why = !t ? "No such ticket." : t.order.state === "failed" ? `Order ${t.order.id} was never paid: there's no receipt to send.` : undefined;
        return write(c, ctx, { kind: "shop.receipt", target: t ? `order ${t.order.id}` : "a ticket", why, apply: () => {}, back: t ? `/shop/tickets/${t.id}` : "/shop" });
      });

      app.post("/shop/tickets/:id/refund", async (c) => {
        const t = ticketOf(c.req.param("id"));
        const why = !t ? "No such ticket." : t.order.state === "refunded" ? `Order ${t.order.id} is already refunded.` : t.order.state === "failed" ? `Order ${t.order.id} was never paid: there's nothing to refund.` : undefined;
        return write(c, ctx, { kind: "shop.refund", target: t ? `order ${t.order.id}` : "a ticket", detail: t?.order.total, why, apply: () => done.refunded.add(t!.order.id), back: t ? `/shop/tickets/${t.id}` : "/shop" });
      });

      app.post("/shop/customers/:id/unlock", async (c) => {
        const cu = customerOf(c.req.param("id"));
        const why = !cu ? "No such customer." : cu.status !== "locked" ? `${cu.name}'s account isn't locked.` : undefined;
        return write(c, ctx, { kind: "shop.unlock", target: cu ? `customer ${cu.id}` : "a customer", why, apply: () => done.unlocked.add(cu!.id), back: "/shop" });
      });

      app.post("/shop/customers/:id/extend-shipping", async (c) => {
        const cu = customerOf(c.req.param("id"));
        const why = !cu ? "No such customer." : done.extended.has(cu.id) ? `${cu.name}'s free shipping is already extended.` : undefined;
        return write(c, ctx, { kind: "shop.shipping", target: cu ? `customer ${cu.id}` : "a customer", detail: "30 days", why, apply: () => done.extended.add(cu!.id), back: "/shop" });
      });
    },
  };
}
