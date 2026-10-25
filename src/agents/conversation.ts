/**
 * A session's conversation from its transcript: what the user asked, what the agent said, and
 * a one-line note per tool call. Tool results are never read out (they can hold prod data and
 * secrets), nor are the system's own injected messages.
 */
import { toolDetail } from "./runner.ts";

/** One question an agent puts with AskUserQuestion: what it asks, and the choices it offers. */
export type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };

export type Turn =
  | { role: "user"; text: string; at?: string }
  | { role: "assistant"; text: string; at?: string }
  | { role: "tools"; calls: { name: string; detail: string }[]; at?: string }
  | { role: "ask"; questions: Question[]; at?: string };

const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** AskUserQuestion's input, read narrowly: up to 4 questions of up to 6 choices; anything else is no question. */
export function askOf(input: unknown): Question[] | null {
  const qs = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(qs) || !qs.length) return null;
  const out: Question[] = [];
  for (const q of qs.slice(0, 4)) {
    const question = s(q?.question, 600).trim();
    const options = (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map((o: unknown) => ({ label: s((o as { label?: unknown })?.label, 120).trim(), description: s((o as { description?: unknown })?.description, 400).trim() })).filter((o: { label: string }) => o.label);
    if (!question) continue;
    out.push({ question, header: s(q?.header, 40).trim(), multiSelect: q?.multiSelect === true, options });
  }
  return out.length ? out : null;
}

/**
 * What Dovre puts ahead of the first message in a copy of a session (a fork, made because a
 * terminal still has the session open): the copy carries the whole conversation, unfinished work
 * included, and would otherwise carry that work on beside the terminal, in the same folder.
 */
export const COPY_NOTE =
  "(Dovre) This is a copy of a session that's still open in a terminal, and that session may still be working in this folder. Anything left unfinished above belongs to the terminal: don't carry it on or redo it. Do only what's asked below.";

/** The message that goes with an allow: the exact calls allowed, and to run them as written (another form is refused again). */
export const allowedPrompt = (specs: string[]) =>
  `I've allowed ${specs.map((s) => `\`${s}\``).join(", ")} for this turn, each exactly as written. Run them as written: any other form of a command is refused again. Then go on with what you were doing.`;

const ALLOWED = /^I've allowed (.+?) for this turn[,.]/s;

/**
 * A message of mine as Dovre wrote it, taken apart for the page: started a copy, allowed these
 * calls, and what I wrote besides (queued messages go along with an allow).
 */
export function dovreParts(text: string): { copy: boolean; allowed?: string[]; rest: string } {
  let rest = text;
  const copy = rest.startsWith(COPY_NOTE);
  if (copy) rest = rest.slice(COPY_NOTE.length).trim();
  const cut = rest.indexOf("\n\n");
  const first = cut < 0 ? rest : rest.slice(0, cut);
  const m = first.match(ALLOWED);
  if (!m) return { copy, rest };
  const allowed = [...m[1]!.matchAll(/`([^`\n]+)`/g)].map((x) => x[1]!);
  return { copy, allowed: allowed.length ? allowed : [m[1]!], rest: cut < 0 ? "" : rest.slice(cut + 2).trim() };
}

/** Text the harness adds to a user message, not something the user typed. */
const INJECTED = /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification)[\s\S]*?<\/\1>/g;

export function cleanUserText(text: string): string {
  return text.replace(INJECTED, "").trim();
}

export function turnsOf(text: string, limit = 60): Turn[] {
  const turns: Turn[] = [];
  for (const line of text.split("\n")) {
    // "type" can sit after a long message object, so look along the whole line.
    if (!line.startsWith('{"') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.isSidechain || j.isMeta || j.isCompactSummary) continue;
    const content = j.message?.content;
    if (j.type === "user") {
      const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((b: any) => b.type === "text").map((b: any) => b.text) : [];
      const t = cleanUserText(parts.join("\n"));
      if (t) turns.push({ role: "user", text: t, at: j.timestamp });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "text" && b.text?.trim()) {
        const last = turns[turns.length - 1];
        // Streamed assistant messages arrive as several lines with the same text; keep one.
        if (last?.role === "assistant" && last.text === b.text) continue;
        turns.push({ role: "assistant", text: b.text, at: j.timestamp });
      }
      if (b.type === "tool_use" && b.name === "AskUserQuestion") {
        const questions = askOf(b.input);
        if (questions) {
          turns.push({ role: "ask", questions, at: j.timestamp });
          continue;
        }
      }
      if (b.type === "tool_use") {
        const last = turns[turns.length - 1];
        const call = { name: String(b.name), detail: toolDetail(b.name, b.input) };
        if (last?.role === "tools") last.calls.push(call);
        else turns.push({ role: "tools", calls: [call], at: j.timestamp });
      }
    }
  }
  return turns.slice(-limit);
}

/**
 * The answers to an agent's questions as its next message, from the posted form: `a<i>` the
 * picked choices (by index), `o<i>` an answer of one's own. Only offered choices count; one pick
 * unless the question takes several. Undefined when nothing was answered.
 */
export function answersPrompt(questions: Question[], form: Record<string, unknown>): string | undefined {
  const picks = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string" && /^[0-9]$/.test(x)).map(Number);
  let any = false;
  const lines = questions.map((q, i) => {
    const labels = [...new Set(picks(form[`a${i}`]))].filter((n) => n < q.options.length).map((n) => q.options[n]!.label);
    const own = typeof form[`o${i}`] === "string" ? String(form[`o${i}`]).replace(/\s+/g, " ").trim().slice(0, 500) : "";
    const answer = [...(q.multiSelect ? labels : labels.slice(0, 1)), ...(own ? [own] : [])].join("; ");
    if (answer) any = true;
    return `- ${q.question}: ${answer || "(no answer)"}`;
  });
  return any ? ["My answers to your questions:", ...lines].join(String.fromCharCode(10)) : undefined;
}

/** What "No" tells the agent (the bar's No, and the session page's). */
export const NO = "No, don't run that. Find another way, or stop and say what you need.";
