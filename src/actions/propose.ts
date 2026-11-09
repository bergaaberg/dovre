/**
 * A pack proposes a change to a few files in one of the owners' repos (PackForge.propose: Topo's
 * peak.yaml fixes, the Agents setup's sandbox files): a branch off the default branch, a commit per
 * file, and a PR. Before writing it reads each file again: it must still be what the pack saw
 * (`expect`; null: there is none), or nothing is written. Every try is logged under the pack's write kind.
 */
import type { D1 } from "../db.ts";
import type { Ghe } from "../sources/ghe.ts";
import { MAX_FILE, ownedRepo, repoPath } from "../sources/files.ts";
import { logAction } from "./deploys.ts";

/** A file a PR writes: its new text, and what the pack saw there (null: no file). */
type ProposedFile = { path: string; text: string; expect: string | null };
/** What the forge is asked to do, checked already (the owners, the paths, the sizes). */
export type Proposal = { repo: string; files: ProposedFile[]; title: string; body: string; branch: string };
/**
 * What a pack asks for (PackForge.propose): `kind` is one of its manifest's `writes`. One file
 * (`path`, `text`, `expect`), or up to MAX_FILES in `files` (API 1.17), all in the one PR.
 */
export type PackProposal = { kind: string; repo: string; title: string; body?: string } & ({ path: string; text: string; expect: string | null; files?: undefined } | { files: ProposedFile[]; path?: undefined; text?: undefined; expect?: undefined });
/** Files one PR writes, at most. */
export const MAX_FILES = 5;
export type Proposed = { ok: true; number: number; url: string } | { ok: false; error: string };

const fromB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
const toB64 = (s: string) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));
const is404 = (e: unknown) => /: 404\b/.test(String((e as Error)?.message ?? e));

/** On GitHub: the branch, a commit per file and the PR. Throws why it didn't; a branch it made is deleted again. */
export async function proposeFiles(ghe: Ghe, p: Proposal): Promise<{ number: number; url: string }> {
  const info = await ghe.rest<{ default_branch: string }>(`/repos/${p.repo}`);
  const base = info.default_branch;
  // Every file checked before anything is written.
  const seen: { at: string; sha?: string; f: ProposedFile }[] = [];
  for (const f of p.files) {
    const at = f.path.split("/").map(encodeURIComponent).join("/");
    const now = await ghe.rest<{ type?: string; sha: string; content?: string }>(`/repos/${p.repo}/contents/${at}?ref=${encodeURIComponent(base)}`).catch((e) => (is404(e) ? undefined : Promise.reject(e)));
    if (now && (now.type !== "file" || typeof now.content !== "string")) throw new Error(`${f.path} isn't a file there.`);
    const text = now ? fromB64(now.content!) : null;
    if (text !== f.expect) throw new Error(f.expect === null ? `${f.path} exists now.` : text === null ? `${f.path} is gone.` : `${f.path} changed since it was read.`);
    if (text === f.text) throw new Error(`${f.path} already says that.`);
    seen.push({ at, ...(now ? { sha: now.sha } : {}), f });
  }
  const ref = await ghe.rest<{ object: { sha: string } }>(`/repos/${p.repo}/git/ref/heads/${encodeURIComponent(base)}`);
  await ghe.rest(`/repos/${p.repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${p.branch}`, sha: ref.object.sha } });
  try {
    for (const s of seen) await ghe.rest(`/repos/${p.repo}/contents/${s.at}`, { method: "PUT", body: { message: p.files.length > 1 ? `${p.title} (${s.f.path})` : p.title, content: toB64(s.f.text), branch: p.branch, ...(s.sha ? { sha: s.sha } : {}) } });
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
    const asked: unknown[] = Array.isArray(p?.files) ? p.files : [{ path: p?.path, text: p?.text, expect: p?.expect }];
    const paths = asked.map((f) => repoPath((f as ProposedFile)?.path));
    const target = `${line(p?.repo, 100)}:${line(asked.map((f) => (f as ProposedFile)?.path).join(","), 300)}`;
    const refuse = async (error: string): Promise<Proposed> => {
      await logAction(o.db, { kind, target, ok: false, error }).catch(() => {});
      return { ok: false, error };
    };
    if (!o.kinds.includes(String(p?.kind))) return { ok: false, error: `${o.pack.name} didn't declare the write kind "${line(p?.kind, 40)}".` };
    if (!asked.length || asked.length > MAX_FILES) return refuse(`A PR writes 1 to ${MAX_FILES} files.`);
    if (!repo || paths.some((x) => !x)) return refuse("Not a file in your repos.");
    if (new Set(paths).size !== paths.length) return refuse("The same file twice.");
    const files: ProposedFile[] = [];
    for (const [i, f] of (asked as ProposedFile[]).entries()) {
      if (typeof f?.text !== "string" || new TextEncoder().encode(f.text).length > MAX_FILE) return refuse("The text is missing or too big.");
      if (f.expect !== null && typeof f.expect !== "string") return refuse("What the file said before is missing.");
      files.push({ path: paths[i]!, text: f.text, expect: f.expect });
    }
    const title = line(p.title, 120);
    if (!title) return refuse("A PR needs a title.");
    const body = `${String(p.body ?? "").slice(0, 4000)}\n\nOpened by Dovre (${o.pack.name}).`.trim();
    try {
      const pr = await o.propose({ repo, files, title, body, branch: `dovre/${o.pack.id}-${p.kind}-${stamp(o.now?.() ?? new Date())}` });
      await logAction(o.db, { kind, target: `${repo}:${paths.join(",")}`, detail: `#${pr.number}`, ok: true }).catch(() => {});
      return { ok: true, ...pr };
    } catch (e) {
      return refuse(line((e as Error)?.message ?? e, 300));
    }
  };
}
