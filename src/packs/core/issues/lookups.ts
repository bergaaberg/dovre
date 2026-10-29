/**
 * What Bino may look up on the forge (#262), through the tracker pack: one issue or PR in full, and
 * a search over the owners' accounts. A repo outside REPO_OWNERS is refused before it reaches the
 * forge; descriptions, comments and reviews are cut to size.
 */
import { repoIn } from "../../../actions/deploys.ts";
import type { Forge } from "../../../forge/types.ts";
import type { LookupKind } from "../../types.ts";

const REF = /^\s*([\w.-]+\/[\w.-]+)\s*#\s*(\d{1,7})\s*$/;
const one = (t: string, max: number) => t.replace(/\s+/g, " ").trim().slice(0, max);
const para = (t: string, max: number) => {
  const c = t.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return c.length > max ? `${c.slice(0, max)}…` : c;
};

export function forgeLookups(forge: Pick<Forge, "name" | "thread" | "searchThreads">, owners: () => string): LookupKind[] {
  const out: LookupKind[] = [];
  const name = forge.name;
  if (forge.thread) {
    const thread = forge.thread;
    out.push({
      kind: "thread",
      when: `One ${name} issue or pull request by its reference (owner/repo#123): state, labels, assignees, its description, the latest comments, and a PR's size and reviews.`,
      fields: [{ name: "ref", about: "owner/repo#123", required: true, max: 120 }],
      async run(a) {
        const m = REF.exec(a.ref ?? "");
        if (!m) return `${one(a.ref ?? "", 80)} isn't a reference like owner/repo#123.`;
        const repo = repoIn(owners(), m[1]);
        if (!repo) return `${m[1]} isn't one of the owners' repos here, so it isn't looked up.`;
        const t = await thread(repo, Number(m[2]));
        if (!t) return `There's no issue or PR ${repo}#${m[2]}.`;
        const facts = [
          `${t.kind === "pr" ? "PR" : "Issue"} ${t.repo}#${t.number}: ${one(t.title, 200)}`,
          `State: ${t.state.toLowerCase()}${t.pr?.draft ? " (draft)" : ""}, by ${t.author || "?"}${t.assignees.length ? `, assigned to ${t.assignees.join(", ")}` : ""}${t.labels.length ? `, labels: ${t.labels.join(", ")}` : ""}.`,
          t.pr ? `Branch ${t.pr.branch}, ${t.pr.files} files, +${t.pr.additions} −${t.pr.deletions}${t.pr.review ? `, review: ${t.pr.review.toLowerCase().replace(/_/g, " ")}` : ""}.` : "",
          t.body.trim() ? `Description:\n${para(t.body, 2500)}` : "No description.",
          t.comments.length ? `Latest comments:\n${t.comments.map((c) => `- ${c.author || "someone"} (${c.at.slice(0, 10)}): ${para(c.body, 400)}`).join("\n")}` : "",
          t.pr?.reviews.length ? `Latest reviews:\n${t.pr.reviews.map((r) => `- ${r.author || "someone"}: ${r.state.toLowerCase().replace(/_/g, " ")}${r.body.trim() ? `: ${para(r.body, 300)}` : ""}`).join("\n")}` : "",
        ];
        return facts.filter(Boolean).join("\n\n");
      },
    });
  }
  if (forge.searchThreads) {
    const search = forge.searchThreads;
    out.push({
      kind: "search",
      when: `${name} issues and pull requests in the user's repos matching some words, newest first (15 at most): reference, state, title, author.`,
      fields: [{ name: "q", about: "the words to search for", required: true, max: 100 }],
      async run(a) {
        const words = one(a.q ?? "", 100);
        if (words.length < 2) return "Say at least two characters to search for.";
        const list = owners().split(",").map((o) => o.trim()).filter(Boolean);
        const hits = (await search(list, words)).filter((h) => repoIn(owners(), h.repo));
        if (!hits.length) return `Nothing matches "${words}".`;
        return `Matching "${words}":\n${hits.map((h) => `- ${h.repo}#${h.number} ${h.kind === "pr" ? "PR" : "issue"} [${h.state.toLowerCase()}] ${one(h.title, 160)} (${h.author || "?"})`).join("\n")}`;
      },
    });
  }
  return out;
}
