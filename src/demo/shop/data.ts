/**
 * Made-up data for the Northwind Shop demo pack (PLAN WP-H9 / demo#8).
 * Storefront ops data: metrics, funnel, orders by state, daily revenue, support tickets.
 * Times and dates are relative to `now`, so the data stays fresh each morning.
 */
import type { FunnelStep } from "../../ui/charts.view.ts";

export type ShopCustomer = {
  id: string;
  name: string;
  email: string;
  status: "active" | "locked";
  memberSince: string;
  freeShippingUntil: string;
};

export type ShopOrder = {
  id: string;
  customerId: string;
  total: string;
  totalCents: number;
  state: "paid" | "shipped" | "refunded" | "failed";
  createdAt: string;
  items: string[];
};

export type TicketMessage = {
  id: string;
  from: "customer" | "support" | "system";
  author: string;
  at: string;
  text: string;
};

export type ShopTicket = {
  id: string;
  subject: string;
  customer: ShopCustomer;
  order: ShopOrder;
  recentOrders: ShopOrder[];
  ageMinutes: number;
  state: "open" | "waiting" | "resolved";
  tone: "bad" | "warn" | "neutral" | "ok";
  thread: TicketMessage[];
};

export type OrderStateCount = {
  label: string;
  value: number;
  tone?: "ok" | "warn" | "bad" | "h2" | "h4" | "muted";
};

export type ShopStats = {
  customers: number;
  customersDelta: number;
  activeWeek: number;
  activeWeekMax: number;
  ordersToday: number;
  ordersTodayDelta: number;
  refundsWeek: number;
  refundsWeekDelta: number;
  funnel: FunnelStep[];
  ordersByState: OrderStateCount[];
  revenueDays: string[];
  revenueValues: number[];
  revenueTarget: number;
};

export type ShopData = {
  stats: ShopStats;
  tickets: ShopTicket[];
};

const dayStr = (now: number, daysAgo: number) => {
  const d = new Date(now - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
};

export function demoShopData(now: number = Date.now()): ShopData {
  // Customers
  const customerAstrid: ShopCustomer = {
    id: "c-101",
    name: "Astrid Lind",
    email: "astrid.lind@example.com",
    status: "active",
    memberSince: "12 Apr 2025",
    freeShippingUntil: "30 Nov 2026",
  };

  const customerLars: ShopCustomer = {
    id: "c-102",
    name: "Lars Holm",
    email: "lars.holm@example.com",
    status: "locked",
    memberSince: "18 Aug 2025",
    freeShippingUntil: "15 Jan 2027",
  };

  const customerSofie: ShopCustomer = {
    id: "c-103",
    name: "Sofie Dahl",
    email: "sofie.dahl@example.com",
    status: "active",
    memberSince: "05 Feb 2026",
    freeShippingUntil: "31 Dec 2026",
  };

  const customerMorten: ShopCustomer = {
    id: "c-104",
    name: "Morten Foss",
    email: "morten.foss@example.com",
    status: "active",
    memberSince: "19 Oct 2024",
    freeShippingUntil: "Expired yesterday",
  };


  // Orders
  const order9821: ShopOrder = {
    id: "ORD-9821",
    customerId: "c-101",
    total: "$149.00",
    totalCents: 14900,
    state: "failed",
    createdAt: "2 hours ago",
    items: ["Fjord Fleece Jacket (M)", "Merino Wool Beanie"],
  };

  const order9788: ShopOrder = {
    id: "ORD-9788",
    customerId: "c-102",
    total: "$89.50",
    totalCents: 8950,
    state: "paid",
    createdAt: "1 hour ago",
    items: ["Thermal Hiking Socks (Pack of 3)", "Waterproof Dry Bag 10L"],
  };

  const order9804: ShopOrder = {
    id: "ORD-9804",
    customerId: "c-103",
    total: "$234.00",
    totalCents: 23400,
    state: "paid",
    createdAt: "1 hour ago",
    items: ["Nordic Trail Backpack 35L", "Aluminium Trekking Poles"],
  };

  const order9840: ShopOrder = {
    id: "ORD-9840",
    customerId: "c-104",
    total: "$65.00",
    totalCents: 6500,
    state: "paid",
    createdAt: "22 min ago",
    items: ["Insulated Camp Mug 400ml", "Steel Carabiner Set"],
  };


  // Past orders for customers
  const pastAstrid: ShopOrder[] = [
    order9821,
    { id: "ORD-9104", customerId: "c-101", total: "$79.00", totalCents: 7900, state: "shipped", createdAt: "14 Oct 2026", items: ["Base Layer Top"] },
    { id: "ORD-8712", customerId: "c-101", total: "$195.00", totalCents: 19500, state: "paid", createdAt: "28 Aug 2026", items: ["Mountain Shell Jacket"] },
  ];

  const pastLars: ShopOrder[] = [
    order9788,
    { id: "ORD-8942", customerId: "c-102", total: "$45.00", totalCents: 4500, state: "shipped", createdAt: "03 Sep 2026", items: ["Camping Lantern"] },
  ];

  const pastSofie: ShopOrder[] = [
    order9804,
    { id: "ORD-9310", customerId: "c-103", total: "$120.00", totalCents: 12000, state: "shipped", createdAt: "20 Sep 2026", items: ["Hiking Boots Wax", "Gaiters"] },
  ];

  const pastMorten: ShopOrder[] = [
    order9840,
    { id: "ORD-8511", customerId: "c-104", total: "$310.00", totalCents: 31000, state: "paid", createdAt: "15 Jul 2026", items: ["2-Person Tunnel Tent"] },
  ];

  // Tickets: oldest first
  // 3 tickets waiting over an hour: t-101 (135m), t-102 (78m), t-103 (64m)
  const tickets: ShopTicket[] = [
    {
      id: "t-101",
      subject: "Payment failed on checkout for order #ORD-9821",
      customer: customerAstrid,
      order: order9821,
      recentOrders: pastAstrid,
      ageMinutes: 135,
      state: "open",
      tone: "bad",
      thread: [
        {
          id: "m-1",
          from: "customer",
          author: "Astrid Lind",
          at: "2 hours ago",
          text: "My credit card was charged $149.00 but the checkout screen showed 'Gateway Timeout'. Can you check if order #ORD-9821 was placed, or refund the charge?",
        },
        {
          id: "m-2",
          from: "system",
          author: "Checkout Gateway",
          at: "2 hours ago",
          text: "Payment intent pi_9821 timed out after 30s. Transaction flagged for manual support review.",
        },
      ],
    },
    {
      id: "t-102",
      subject: "Account locked after password reset attempts",
      customer: customerLars,
      order: order9788,
      recentOrders: pastLars,
      ageMinutes: 78,
      state: "waiting",
      tone: "warn",
      thread: [
        {
          id: "m-3",
          from: "customer",
          author: "Lars Holm",
          at: "1 hour ago",
          text: "I tried logging into my account to check delivery status for order #ORD-9788 and it said my account is locked. Please unlock it.",
        },
      ],
    },
    {
      id: "t-103",
      subject: "Receipt not received for order #ORD-9804",
      customer: customerSofie,
      order: order9804,
      recentOrders: pastSofie,
      ageMinutes: 64,
      state: "open",
      tone: "warn",
      thread: [
        {
          id: "m-4",
          from: "customer",
          author: "Sofie Dahl",
          at: "1 hour ago",
          text: "I need an itemized purchase receipt for company expense reimbursement on order #ORD-9804. Could you please resend it to my email?",
        },
      ],
    },
    {
      id: "t-104",
      subject: "Extend free shipping membership",
      customer: customerMorten,
      order: order9840,
      recentOrders: pastMorten,
      ageMinutes: 22,
      state: "open",
      tone: "neutral",
      thread: [
        {
          id: "m-5",
          from: "customer",
          author: "Morten Foss",
          at: "22 min ago",
          text: "My free shipping tier expired yesterday right before placing order #ORD-9840. Could you please extend it by 30 days as a courtesy?",
        },
      ],
    },
  ];

  // 14 days of revenue
  const revenueDays = Array.from({ length: 14 }, (_, i) => dayStr(now, 13 - i));
  const revenueValues = [9400, 11200, 10800, 12400, 13100, 11900, 10500, 11800, 12600, 13400, 12900, 14200, 13800, 14500];

  const stats: ShopStats = {
    customers: 14820,
    customersDelta: 142,
    activeWeek: 3410,
    activeWeekMax: 5000,
    ordersToday: 412,
    ordersTodayDelta: 28,
    refundsWeek: 7,
    refundsWeekDelta: -2,
    funnel: [
      { label: "Store visits", value: 24500, note: "100 %", color: "s1" },
      { label: "Accounts created", value: 4800, note: "19.6 %", color: "s1" },
      { label: "Items added to cart", value: 2150, note: "8.8 %", color: "s2" },
      { label: "Checkout started", value: 1320, note: "5.4 %", color: "s2" },
      { label: "First order placed", value: 890, note: "3.6 %", color: "s3" },
    ],
    ordersByState: [
      { label: "Paid", value: 382, tone: "ok" },
      { label: "Shipped", value: 23, tone: "h4" },
      { label: "Refunded", value: 6, tone: "warn" },
      { label: "Failed", value: 1, tone: "bad" },
    ],
    revenueDays,
    revenueValues,
    revenueTarget: 12000,
  };

  return { stats, tickets };
}

let cached: { at: number; data: ShopData } | undefined;

/** The demo's shop, made fresh each minute so its times read as now. */
export function getShopData(now: number = Date.now()): ShopData {
  if (!cached || now - cached.at > 60_000) cached = { at: now, data: demoShopData(now) };
  return cached.data;
}

/** What the shop's lines say, counted from its data: tickets waiting over an hour (oldest first), failed payments. */
export function summaryOf(data: ShopData): { waiting: ShopTicket[]; failed: ShopTicket[] } {
  const waiting = data.tickets.filter((t) => t.state !== "resolved" && t.ageMinutes >= 60).sort((a, b) => b.ageMinutes - a.ageMinutes);
  const failed = data.tickets.filter((t) => t.order.state === "failed");
  return { waiting, failed };
}

/** "2h 15m". */
export const ageOf = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`);
