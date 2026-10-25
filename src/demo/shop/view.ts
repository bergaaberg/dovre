/**
 * Views for the Northwind Shop demo pack (PLAN WP-H9 / demo#8).
 * Pure rendering: kit and chart components, escaping via html``, no custom CSS.
 */
import { count } from "../../format.ts";
import { ColumnChart, FunnelDiagram, StackedBar } from "../../ui/charts.view.ts";
import {
  Card,
  Confirm,
  Delta,
  Gauge,
  Grid2,
  type Html,
  html,
  icon,
  Item,
  KeyValues,
  List,
  PageHeader,
  Panel,
  Stat,
  Stats,
} from "../../ui/kit.ts";
import { ageOf, type ShopData, type ShopTicket, summaryOf } from "./data.ts";

export function shopPage(data: ShopData): Html {
  const visibleTickets = data.tickets;

  return html`
    ${PageHeader({
      title: "Northwind Shop",
      sub: "Storefront ops: metrics, support tickets & actions",
      crumbs: [{ label: "Ops", href: "/shop" }, { label: "Northwind Shop" }],
    })}

    ${Stats([
      Stat({
        label: "Customers",
        value: count(data.stats.customers),
        delta: Delta({ value: data.stats.customersDelta, good: "up" }),
      }),
      Stat({
        label: "Active in 7 days",
        value: count(data.stats.activeWeek),
        viz: Gauge({ value: data.stats.activeWeek, max: data.stats.activeWeekMax, tone: "ok" }),
      }),
      Stat({
        label: "Orders today",
        value: count(data.stats.ordersToday),
        delta: Delta({ value: data.stats.ordersTodayDelta, good: "up" }),
      }),
      Stat({
        label: "Refunds this week",
        value: count(data.stats.refundsWeek),
        delta: Delta({ value: data.stats.refundsWeekDelta, good: "down" }),
        tone: "ok",
      }),
    ])}

    ${Grid2([
      Panel({
        title: "Daily revenue",
        meta: "14 days vs target ($12k)",
        children: ColumnChart({
          days: data.stats.revenueDays,
          values: data.stats.revenueValues,
          title: "Daily revenue",
          unit: "USD",
          format: (n) => `$${count(n)}`,
          limit: { value: data.stats.revenueTarget, label: "Target" },
          half: true,
        }),
      }),
      Panel({
        title: "Orders by state",
        meta: "Today",
        children: StackedBar({
          parts: data.stats.ordersByState,
          label: "Orders by state",
        }),
      }),
    ])}

    ${Panel({
      title: "Sign-up → first-order funnel",
      meta: "Storefront conversion",
      children: FunnelDiagram({
        steps: data.stats.funnel,
        title: "Sign-up to first-order funnel",
      }),
    })}

    ${Panel({
      id: "queue",
      title: "Support queue",
      meta: `${visibleTickets.length} open tickets · oldest first`,
      flush: true,
      children: List(
        visibleTickets.map((t) =>
          Item({
            href: `/shop/tickets/${t.id}`,
            lead: icon("ticket"),
            leadTone: t.tone,
            title: t.subject,
            line: html`${t.customer.name} (${t.customer.email}) · Order ${t.order.id} (${t.order.total})`,
            trail: html`<span class="pill ${t.tone}">${t.state}</span> <span class="t2">${t.ageMinutes}m</span>`,
          }),
        ),
      ),
    })}
  `;
}

export function ticketPage(ticket: ShopTicket): Html {
  return html`
    ${PageHeader({
      title: `Ticket #${ticket.id}: ${ticket.subject}`,
      sub: html`Customer: <strong>${ticket.customer.name}</strong> (${ticket.customer.email}) · Age: ${ticket.ageMinutes}m · <span class="pill ${ticket.tone}">${ticket.state}</span>`,
      crumbs: [
        { label: "Shop", href: "/shop" },
        { label: "Support queue", href: "/shop#queue" },
        { label: `#${ticket.id}` },
      ],
      actions: html`
        ${Confirm({
          action: `/shop/tickets/${ticket.id}/resend-receipt`,
          label: "Resend receipt",
          question: `Resend purchase receipt for order ${ticket.order.id} (${ticket.order.total}) to ${ticket.customer.email}?`,
        })}
        ${Confirm({
          action: `/shop/tickets/${ticket.id}/refund`,
          label: "Refund order",
          question: `Refund ${ticket.order.total} on order ${ticket.order.id} back to customer's card?`,
          danger: true,
        })}
        ${Confirm({
          action: `/shop/customers/${ticket.customer.id}/unlock`,
          label: "Unlock account",
          question: `Unlock account access for ${ticket.customer.name} (${ticket.customer.email})?`,
        })}
        ${Confirm({
          action: `/shop/customers/${ticket.customer.id}/extend-shipping`,
          label: "Extend free shipping",
          question: `Extend 30 days of free shipping for ${ticket.customer.name}?`,
        })}
      `,
    })}

    ${Panel({
      title: "Customer details",
      children: KeyValues([
        ["Customer name", ticket.customer.name],
        ["Email address", ticket.customer.email],
        ["Account status", html`<span class="pill ${ticket.customer.status === "locked" ? "bad" : "ok"}">${ticket.customer.status}</span>`],
        ["Member since", ticket.customer.memberSince],
        ["Free shipping tier", ticket.customer.freeShippingUntil],
      ]),
    })}

    ${Panel({
      title: "Recent customer orders",
      flush: true,
      children: List(
        ticket.recentOrders.map((o) =>
          Item({
            lead: o.id,
            title: `${o.total} · ${o.items.join(", ")}`,
            line: `Placed ${o.createdAt}`,
            trail: html`<span class="pill ${o.state === "paid" ? "ok" : o.state === "failed" ? "bad" : o.state === "refunded" ? "warn" : "neutral"}">${o.state}</span>`,
          }),
        ),
      ),
    })}

    ${Panel({
      title: "Ticket thread",
      flush: true,
      children: List(
        ticket.thread.map((m) =>
          Item({
            lead: m.author,
            title: m.text,
            line: `${m.from} · ${m.at}`,
          }),
        ),
      ),
    })}
  `;
}

export function shopTodayCard(data: ShopData) {
  const { waiting, failed } = summaryOf(data);
  const oldest = waiting[0];
  const items = [
    ...(oldest
      ? [
          Item({
            href: "/shop#queue",
            leadTone: "warn",
            title: `${waiting.length} ${waiting.length === 1 ? "ticket" : "tickets"} waiting over an hour`,
            line: `Oldest ${ageOf(oldest.ageMinutes)} (${oldest.customer.name}: ${oldest.subject})`,
            trail: html`<span class="pill warn">${waiting.length} open</span>`,
          }),
        ]
      : []),
    ...failed.slice(0, 1).map((t) =>
      Item({
        href: `/shop/tickets/${t.id}`,
        leadTone: "bad",
        title: `${failed.length} failed ${failed.length === 1 ? "payment" : "payments"}`,
        line: `Order #${t.order.id} (${t.order.total})`,
        trail: html`<span class="pill bad">failed</span>`,
      }),
    ),
  ];
  return {
    id: "shop-ops",
    column: "right" as const,
    order: 2,
    render: Card({
      id: "shop-ops",
      title: "Northwind Shop",
      meta: "Storefront",
      foot: html`<a href="/shop">View shop ops →</a>`,
      children: items.length ? List(items) : html`<p class="t2">Nothing waiting.</p>`,
    }),
  };
}
