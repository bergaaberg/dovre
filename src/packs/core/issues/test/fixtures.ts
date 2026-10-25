/** An issue for the Issues pack's tests. */
import type { Issue } from "../../../../forge/types.ts";

export const NOW = Date.parse("2026-10-25T12:00:00Z");
export const issue = (o: Partial<Issue> = {}): Issue => ({
  repo: "bergaaberg/dovre",
  number: 33,
  title: "Today header on a wide screen",
  url: "https://github.com/bergaaberg/dovre/issues/33",
  state: "OPEN",
  labels: ["layout", "ui"],
  author: "kari",
  assignees: ["kari"],
  comments: 3,
  createdAt: "2026-10-20T10:00:00Z",
  updatedAt: "2026-10-25T10:00:00Z",
  prs: [{ key: "bergaaberg/dovre#36", state: "OPEN" }],
  subIssues: { done: 2, total: 3 },
  ...o,
});
