/**
 * An agent's plan as it works (#240): Claude Code's to-do list (TodoWrite) and Codex's plan steps
 * (a `todo_list` item), read narrowly into one shape. These are the agent's own words, cut short as
 * launcher/keep_claude.go and keep_codex.go keep them; anything else in an item is dropped.
 */

export type TodoStatus = "pending" | "active" | "done";
export type Todo = { text: string; status: TodoStatus };

const MAX = 30;

/** Claude Code's TodoWrite input: `todos` of `{ content, status }`. Null when it isn't one. */
export function todosOf(input: unknown): Todo[] | null {
  const list = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(list)) return null;
  const out: Todo[] = [];
  for (const t of list.slice(0, MAX)) {
    const text = typeof t?.content === "string" ? t.content.trim().slice(0, 300) : "";
    if (!text) continue;
    out.push({ text, status: t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "pending" });
  }
  return out;
}

/** Codex's `todo_list` items: `{ text, completed }`. The first step not done is the one under way. */
export function stepsOf(items: unknown): Todo[] | null {
  if (!Array.isArray(items)) return null;
  const out: Todo[] = [];
  for (const t of items.slice(0, MAX)) {
    const text = typeof t?.text === "string" ? t.text.trim().slice(0, 300) : "";
    if (text) out.push({ text, status: t.completed === true ? "done" : "pending" });
  }
  const next = out.find((t) => t.status === "pending");
  if (next) next.status = "active";
  return out;
}

/** A subagent call's kind (Claude Code's Task, or Agent in newer versions), or undefined when it isn't one. */
export function subagentOf(name: unknown, input: unknown): string | undefined {
  if (name !== "Task" && name !== "Agent") return undefined;
  const t = (input as { subagent_type?: unknown } | null)?.subagent_type;
  return typeof t === "string" && t.trim() ? t.trim().slice(0, 60) : "agent";
}
