/**
 * What Bino knows when it answers, and how it answers: the stable part of its system prompt, then
 * what's on my plate right now (given to it as text, not as tools), then its memories.
 *
 * What goes in is only what Dovre itself shows as names and states: my list, my PRs and the
 * ones asking for my review (repo, number, title, review and check state), and what each pack says Bino may know about its app (the agents pack: the titles of agents running)
 * (its `bino` hook: states and counts, from memory). Never a PR body, a tool result, anything from a
 * database or from data/lab: those can hold customer data, and a model's context is no place
 * for them.
 */
import type { Snapshot } from "../../../../gather.ts";
import { type State, STATES, type Todo, treeOf } from "../../../../todo/store.ts";
import { ACT_FENCE, type ActSpec, MAX_ACTS } from "./acts.ts";

export const PLAN_FENCE = "bino-plan";
export const MAX_STEPS = 12;

export const BASE = `You are Bino, the assistant in Dovre: the user's own cockpit for their work and their apps. You see what they see in Dovre (below) and you remember a few things about them across conversations.

The user can ask you from a pane on any page in Dovre; then their message starts with [Looking at …], the page they're on. Take "this" and "here" to mean that page. Some pages are only named, never described: don't guess what they show.

You talk with the user to help them think: how to group and break down a piece of work, what to do first, what's really one task and what's three. Be brief and concrete. Ask at most one question at a time, and only when the answer changes your advice. Write in the language the user writes in; Norwegian and English both welcome, developer terms stay English.

You can't act: you have no tools, and you change nothing in GitHub or anywhere else. When a breakdown is ready, propose it for the user's list as ONE fenced block, at the end of your reply, exactly like this:

\`\`\`${PLAN_FENCE}
{"title": "the initiative, short", "notes": "optional, one or two lines", "steps": [{"title": "a step", "state": "next", "due": "2026-10-30"}]}
\`\`\`

Rules for the block: valid JSON; at most ${MAX_STEPS} steps; state is one of ${STATES.filter((s) => s !== "done").join(", ")} (default next); due is YYYY-MM-DD or left out; no other keys. The user sees it as a card and decides whether to add it. Only propose one when the user wants a breakdown; most replies need none.`;

/** What Bino may propose to do: only where Dovre can do it (locally, with GitHub and the packs' acts). */
export const ACTS = `You can also propose something for the user to do, when they ask for it to be done (write, file, create): a dev task (a GitHub issue under another issue). It is a fenced block at the end of your reply, at most ${MAX_ACTS} in one reply:

\`\`\`${ACT_FENCE}
{"kind": "task", "parent": "the issue it belongs under: owner/repo#45", "repo": "owner/repo where the code changes", "title": "one line", "body": "plain text"}
\`\`\`

The user sees each as a filled-in card: they can change it, and nothing happens until they press its button. Fill in everything you can, so one click is enough. Leave out a field you don't know rather than inventing it (an unknown repo or parent: leave it empty, and the form asks).`;

/** Hosted, nothing sends a message or files an issue: Bino says so instead of proposing one. */
const NO_ACTS = "You can't propose sending messages or filing issues here: if the user asks for that, write the text for them to copy.";

const line = (s: string, max = 160) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** My list, as Bino sees it: open items with their steps, and what's done lately, by id so a plan can name one. */
function listPart(todos: Todo[], now: number): string {
  const trees = treeOf(todos);
  const open = trees.filter((t) => t.item.state !== "done");
  const recent = trees.filter((t) => t.item.state === "done" && (t.item.doneAt ?? 0) > now - 7 * 86_400_000);
  const item = (t: Todo) => `#${t.id} [${t.state}] ${line(t.title)}${t.due ? ` (due ${t.due})` : ""}`;
  const lines = open.slice(0, 40).flatMap((t) => [`- ${item(t.item)}`, ...t.children.slice(0, 12).map((c) => `  - ${item(c)}`)]);
  if (recent.length) lines.push(`Done in the last week: ${recent.slice(0, 10).map((t) => line(t.item.title, 80)).join("; ")}`);
  return lines.length ? lines.join("\n") : "(empty)";
}

/** Everything Bino is told about right now, as plain text. */
export function contextOf(o: {
  todos: Todo[];
  s?: Snapshot;
  now?: number;
  /** The org's code repos' owner: where a dev task can go. */
  org?: string;
  /** Who the user is (ABOUT_ME). */
  about?: string;
  /** What each app's pack says Bino may know (packBinoOf, src/packs/registry.ts). */
  apps?: { name: string; text: string; /** Dovre's own pack (topo), not one of my apps. */ own?: boolean }[];
}): string {
  const now = o.now ?? Date.now();
  const s = o.s;
  const parts = [`Today is ${new Date(now).toISOString().slice(0, 10)}.`, ...(o.about?.trim() ? [`## About me\n${line(o.about, 300)}`] : []), `## My list (local, in Dovre)\n${listPart(o.todos, now)}`];
  if (o.org) parts.push(`## Where things can be filed
Dev tasks: a repo in ${o.org}.`);
  if (s?.prs.ok) {
    const pr = (p: (typeof s.prs.value.mine)[number]) => `- ${p.repo}#${p.number} ${line(p.title)}${p.draft ? " (draft)" : ""}${p.review ? ` [${p.review.toLowerCase().replace(/_/g, " ")}]` : ""}`;
    parts.push(`## My open pull requests\n${s.prs.value.mine.slice(0, 30).map(pr).join("\n") || "(none)"}`);
    parts.push(`## Asking for my review\n${s.prs.value.review.slice(0, 20).map((p) => `${pr(p)} by ${p.author}`).join("\n") || "(none)"}`);
  }

  for (const a of o.apps ?? []) parts.push(`## ${line(a.name, 60)}${a.own ? " (part of Dovre)" : " (one of the user's apps)"}\n${a.text}`);

  return parts.join("\n\n");
}

/** Most a pack may tell Bino, and how many packs are heard. */
export const APP_CHARS = 1500;
const MAX_APPS = 12;

/** What packs said Bino may know: plain text, no control characters, capped; a pack with nothing to say is left out. */
export function appsOf(said: { name: string; text: unknown; own?: boolean }[]): { name: string; text: string; own?: boolean }[] {
  return said
    .map(({ name, text, own }) => ({
      ...(own ? { own: true } : {}),
      name: line(String(name ?? ""), 60),
      text: typeof text === "string" ? text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, APP_CHARS) : "",
    }))
    .filter((a) => a.name && a.text)
    .slice(0, MAX_APPS);
}

export type Turn = { role: "user" | "assistant"; text: string };

/** The conversation as one message for a CLI that takes one: earlier turns labelled, the newest last. */
export function transcriptOf(turns: Turn[], maxChars = 24_000): string {
  const all = turns.map((t) => `${t.role === "user" ? "User" : "Bino"}: ${t.text}`);
  let out = all.join("\n\n");
  while (out.length > maxChars && all.length > 1) {
    all.shift();
    out = `(earlier turns left out)\n\n${all.join("\n\n")}`;
  }
  return `${out}\n\nReply as Bino to the user's last message.`;
}

/** What the user's apps let Bino propose besides (the packs' acts), the same way: one block each, the same limit. */
export function packActsPrompt(kinds: ActSpec[]): string {
  if (!kinds.length) return "";
  const each = kinds.map((k) => {
    const example = JSON.stringify({ kind: k.kind, ...Object.fromEntries(k.fields.map((f) => [f.name, f.about])) });
    const needed = k.fields.filter((f) => f.required).map((f) => f.name);
    return `From ${k.app}: ${k.when}${needed.length ? ` (needs ${needed.join(", ")})` : ""}\n\n\`\`\`${ACT_FENCE}\n${example}\n\`\`\``;
  });
  return `The user's apps add these kinds, proposed the same way and counted in the same ${MAX_ACTS}. The app carries one out only when the user presses its card's button:\n\n${each.join("\n\n")}`;
}

/** The whole system prompt: who Bino is, what's on now, what it remembers. `kinds`: the packs' acts (only where Bino may propose). */
export function systemOf(context: string, memories: string, o: { acts?: boolean; kinds?: ActSpec[] } = {}): string {
  const acts = o.acts === false ? NO_ACTS : [ACTS, packActsPrompt(o.kinds ?? [])].filter(Boolean).join("\n\n");
  return [BASE, acts, `# What the user has on right now\n\n${context}`, memories ? `# ${memories}` : ""].filter(Boolean).join("\n\n");
}

// ── A plan Bino proposes ──────────────────────────────────────────────────────

export type PlanStep = { title: string; state: State; due: string | null };
export type Plan = { title: string; notes: string; steps: PlanStep[] };

const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) ? v : null);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

/** A plan from what was sent (Bino's block, or the card's form): checked field by field; null when there's nothing usable. */
export function planOf(raw: unknown): Plan | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const title = text(r.title, 300);
  if (!title || !Array.isArray(r.steps)) return null;
  const steps = r.steps
    .slice(0, MAX_STEPS)
    .map((x): PlanStep | null => {
      if (!x || typeof x !== "object") return null;
      const s = x as Record<string, unknown>;
      const t = text(s.title, 300);
      const state = typeof s.state === "string" && (STATES as readonly string[]).includes(s.state) && s.state !== "done" ? (s.state as State) : "next";
      return t ? { title: t, state, due: date(s.due) } : null;
    })
    .filter((x): x is PlanStep => !!x);
  return { title, notes: typeof r.notes === "string" ? r.notes.replace(/\r\n?/g, "\n").trim().slice(0, 2000) : "", steps };
}

/** Bino's reply split: the text to show, and the plan block it ended with (if a valid one). */
export function splitReply(reply: string): { text: string; plan: Plan | null } {
  const re = new RegExp("```" + PLAN_FENCE + "\\s*\\n([\\s\\S]*?)\\n?```", "g");
  let plan: Plan | null = null;
  for (const m of reply.matchAll(re)) {
    try {
      plan = planOf(JSON.parse(m[1]!)) ?? plan;
    } catch {}
  }
  return { text: reply.replace(re, "").trim(), plan };
}
