/**
 * Scripted Bino for the demo (#10): answers from a short script matched against the demo
 * snapshot, never calls a model or the network, and seeds two finished conversations. It keeps
 * nothing between requests (demoBino).
 */
import type { Route } from "../packs/core/assistant/bino/route.ts";
import { type Bino, type Conv, createBino, type Engine } from "../packs/core/assistant/bino/bino.ts";
import type { BinoMemory } from "../packs/core/assistant/bino/memory.ts";
import type { Snapshot } from "../gather.ts";

export const DEMO_FALLBACK = "In the demo I only know a few things. On your own Dovre I'd answer with your model of choice.";

export function answerRed(s: Snapshot): string {
  const red = s.red ?? [];
  const failingPrs = s.prs.ok ? s.prs.value.mine.filter((p) => p.checks === "FAILURE") : [];
  if (!red.length && !failingPrs.length) return "Nothing is red right now — all builds and checks are green.";
  const parts: string[] = [];
  for (const r of red) {
    parts.push(`**${r.repo}** on \`${r.branch}\`: \`${r.workflow}\` failed (${r.failures} failure${r.failures === 1 ? "" : "s"}).`);
  }
  for (const p of failingPrs) {
    parts.push(`PR #${p.number} (**${p.title}**) has failing checks and changes requested.`);
  }
  return `Here is what is currently red:\n\n${parts.map((p) => `• ${p}`).join("\n")}`;
}

export function answerFirst(s: Snapshot): string {
  const steps: string[] = [];
  const reviews = s.prs.ok ? s.prs.value.review : [];
  if (reviews.length) {
    steps.push(`**Review open PRs**: ${reviews.map((p) => `#${p.number} (${p.title})`).join(", ")}.`);
  }
  const approved = s.prs.ok ? s.prs.value.mine.filter((p) => p.review === "APPROVED" && p.checks === "SUCCESS") : [];
  if (approved.length) {
    steps.push(`**Merge approved work**: ${approved.map((p) => `#${p.number} (${p.title})`).join(", ")}.`);
  }
  const failing = s.prs.ok ? s.prs.value.mine.filter((p) => p.checks === "FAILURE") : [];
  if (failing.length) {
    steps.push(`**Investigate failing builds**: ${failing.map((p) => `#${p.number} (${p.title})`).join(", ")}.`);
  }
  if (!steps.length) return "Everything looks clear! Check your list or explore open work.";
  return `Here's what to look at first:\n\n${steps.map((st, i) => `${i + 1}. ${st}`).join("\n")}`;
}

export function answerPrs(s: Snapshot): string {
  const mine = s.prs.ok ? s.prs.value.mine : [];
  if (!mine.length) return "You have no open pull requests.";
  const lines = mine.map((p) => {
    const status = p.draft ? "draft" : p.checks === "FAILURE" ? "failing checks" : p.review === "APPROVED" ? "approved" : "in review";
    return `• **#${p.number}** ${p.title} (${p.repo}) — ${status}`;
  });
  return `You have ${mine.length} pull requests:\n\n${lines.join("\n")}`;
}

export function extractLastUserMessage(user: string): string {
  const parts = user.split(/\n(?=User: )/);
  const lastUserPart = parts.reverse().find((p) => p.startsWith("User: "));
  if (!lastUserPart) return user.trim();
  return lastUserPart.replace(/^User:\s*/, "").replace(/\n\nReply as Bino to the user's last message\.?$/, "").trim();
}

/** A scripted answer a demo adds: when the question matches, Bino says this. */
export type DemoAnswer = { match: RegExp; answer: (s: Snapshot) => string };

export function matchScriptedAnswer(prompt: string, s: Snapshot, answers: DemoAnswer[] = []): string {
  const clean = prompt.replace(/^\[Looking at [^\]]+\]\s*/i, "").trim().toLowerCase();
  const own = answers.find((a) => a.match.test(clean));
  if (own) return own.answer(s);
  if (/(what'?s|what is|any(thing)?)\s+red/i.test(clean) || /\bred\b/i.test(clean)) {
    return answerRed(s);
  }
  if (/(what\s+(should|do)\s+i\s+do\s+first|what\s+first|priorit(y|ies)|what should i do)/i.test(clean)) {
    return answerFirst(s);
  }
  if (/(summari[sz]e(\s+my)?\s+prs?|my\s+prs?)/i.test(clean)) {
    return answerPrs(s);
  }
  return DEMO_FALLBACK;
}

export function demoScriptRoute(opts: { snapshot: () => Snapshot; answers?: DemoAnswer[] }): Route {
  return {
    via: "api-key",
    ready: true,
    model: "demo-scripted",
    reflectModel: "demo-scripted",
    ask: async ({ user }) => {
      const last = extractLastUserMessage(user);
      const text = matchScriptedAnswer(last, opts.snapshot(), opts.answers);
      return { text, cost: 0 };
    },
  };
}

export function demoSeedConvs(s: Snapshot, now = Date.now()): Conv[] {
  return [
    {
      id: "d0e0b001-0000-4000-8000-000000000001",
      title: "What's red this morning?",
      at: now - 25 * 60_000,
      thinking: false,
      msgs: [
        { role: "user", text: "What's red this morning?", at: now - 25 * 60_000 },
        { role: "assistant", text: answerRed(s), at: now - 25 * 60_000 + 1000, cost: 0 },
      ],
    },
    {
      id: "d0e0b001-0000-4000-8000-000000000002",
      title: "Summarise my PRs",
      at: now - 50 * 60_000,
      thinking: false,
      msgs: [
        { role: "user", text: "Summarise my PRs", at: now - 50 * 60_000 },
        { role: "assistant", text: answerPrs(s), at: now - 50 * 60_000 + 1000, cost: 0 },
      ],
    },
  ];
}

/** The longest question the demo keeps, in characters. */
export const DEMO_CHARS = 500;

/** A fresh scripted Bino with only the seeded conversations: the demo makes one per request. */
export function demoEngine(o: { route: Route; memory: BinoMemory; seed: () => Conv[] }): Engine {
  return createBino({ route: o.route, memory: o.memory, store: { load: o.seed, save: () => {} }, context: async (_c, given) => given ?? "", kinds: () => [] });
}

/**
 * Bino as the demo's pages see it: each call goes to this request's engine (`engine()`). The
 * demo runs on many isolates at once, so nothing is kept between requests. What a visitor asks
 * is answered in the same response (worker.ts), and nobody ever sees another visitor's question.
 */
export function demoBino(o: { route: Route; memory: BinoMemory; engine: () => Engine }): Bino {
  const cut = (text: string) => text.slice(0, DEMO_CHARS);
  return {
    route: o.route,
    memory: o.memory,
    list: () => o.engine().list(),
    get: (id) => o.engine().get(id),
    start: (text, opts) => o.engine().start(cut(text), opts),
    say: (id, text, opts) => o.engine().say(id, cut(text), opts),
    stop: (id) => o.engine().stop(id),
    retry: (id, opts) => o.engine().retry(id, opts),
    added: (id, index, todo) => o.engine().added(id, index, todo),
    act: (id, index, n) => o.engine().act(id, index, n),
    setAct: (id, index, n, patch) => o.engine().setAct(id, index, n, patch),
  };
}
