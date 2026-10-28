/**
 * A pack proposes a change to one file in the owners' repos (PackForge.propose, for Topo's
 * peak.yaml fixes): a branch off the default branch, one commit with the file's new text, and a
 * PR. Before writing it reads the file again: it must still be what the pack saw (`expect`; null:
 * there is none), or nothing is written. Every try is logged under the pack's write kind.
 */
import type { D1 } from "../db.ts";
import type { Ghe } from "../sources/ghe.ts";
import { MAX_FILE, ownedRepo, repoPath } from "../sources/files.ts";
import { logAction } from "./deploys.ts";

/** What the forge is asked to do, checked already (the owners, the path, the sizes). */
export type Proposal = { repo: string; path: string; text: string; expect: string | null; title: string; body: string; branch: string };
/** What a pack asks for (PackForge.propose): `kind` is one of its manifest's `writes`. */
export type PackProposal = { kind: string; repo: string; path: string; text: string; expect: string | null; title: string; body?: string };
export type Proposed = { ok: true; number: number; url: string } | { ok: false; error: string };

const fromB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
const toB64 = (s: string) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));
const is404 = (e: unknown) => /: 404\b/.test(String((e as Error)?.message ?? e));

/** On GitHub: the branch, the commit and the PR. Throws why it didn't; a branch it made is deleted again. */
export async function proposeFile(ghe: Ghe, p: Proposal): Promise<{ number: number; url: string }> {
  const info = await ghe.rest<{ default_branch: string }>(`/repos/${p.repo}`);
  const base = info.default_branch;
  const at = p.path.split("/").map(encodeURIComponent).join("/");
  const now = await ghe.rest<{ type?: string; sha: string; content?: string }>(`/repos/${p.repo}/contents/${at}?ref=${encodeURIComponent(base)}`).catch((e) => (is404(e) ? undefined : Promise.reject(e)));
  if (now && (now.type !== "file" || typeof now.content !== "string")) throw new Error(`${p.path} isn't a file there.`);
  const text = now ? fromB64(now.content!) : null;
  if (text !== p.expect) throw new Error(p.expect === null ? `${p.path} exists now.` : text === null ? `${p.path} is gone.` : `${p.path} changed since it was read.`);
  if (text === p.text) throw new Error(`${p.path} already says that.`);
  const ref = await ghe.rest<{ object: { sha: string } }>(`/repos/${p.repo}/git/ref/heads/${encodeURIComponent(base)}`);
  await ghe.rest(`/repos/${p.repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${p.branch}`, sha: ref.object.sha } });
  try {
    await ghe.rest(`/repos/${p.repo}/contents/${at}`, { method: "PUT", body: { message: p.title, content: toB64(p.text), branch: p.branch, ...(now ? { sha: now.sha } : {}) } });
    const pr = await ghe.rest<{ number: number; html_url: string }>(`/repos/${p.repo}/pulls`, { method: "POST", body: { title: p.title, head: p.branch, base, body: p.body } });
    return { number: pr.number, url: pr.html_url };
  } catch (e) {
    await ghe.rest(`/repos/${p.repo}/git/refs/heads/${encodeURIComponent(p.branch)}`, { method: "DELETE" }).catch(() => {});
    throw e;
  }
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const line = (s: unknown, max: number) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

/**
 * A pack's proposals: refused before anything is asked when the kind isn't one it declared, the
 * repo isn't the owners', the path isn't plain, or the text is too big. Logged either way.
 */
export function packProposals(o: { pack: { id: string; name: string }; kinds: string[]; owners: () => string; db: D1; propose: (p: Proposal) => Promise<{ number: number; url: string }>; now?: () => Date }) {
  return async (p: PackProposal): Promise<Proposed> => {
    const kind = `${o.pack.id}.${String(p?.kind ?? "")}`;
    const repo = ownedRepo(o.owners(), p?.repo);
    const path = repoPath(p?.path);
    const target = `${line(p?.repo, 100)}:${line(p?.path, 300)}`;
    const refuse = async (error: string): Promise<Proposed> => {
      await logAction(o.db, { kind, target, ok: false, error }).catch(() => {});
      return { ok: false, error };
    };
    if (!o.kinds.includes(String(p?.kind))) return { ok: false, error: `${o.pack.name} didn't declare the write kind "${line(p?.kind, 40)}".` };
    if (!repo || !path) return refuse("Not a file in your repos.");
    if (typeof p.text !== "string" || new TextEncoder().encode(p.text).length > MAX_FILE) return refuse("The text is missing or too big.");
    if (p.expect !== null && typeof p.expect !== "string") return refuse("What the file said before is missing.");
    const title = line(p.title, 120);
    if (!title) return refuse("A PR needs a title.");
    const body = `${String(p.body ?? "").slice(0, 4000)}\n\nOpened by Dovre (${o.pack.name}).`.trim();
    try {
      const pr = await o.propose({ repo, path, text: p.text, expect: p.expect, title, body, branch: `dovre/${o.pack.id}-${p.kind}-${stamp(o.now?.() ?? new Date())}` });
      await logAction(o.db, { kind, target: `${repo}:${path}`, detail: `#${pr.number}`, ok: true }).catch(() => {});
      return { ok: true, ...pr };
    } catch (e) {
      return refuse(line((e as Error)?.message ?? e, 300));
    }
  };
}
