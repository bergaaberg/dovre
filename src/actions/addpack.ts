/**
 * Hosted Add (#88): the Worker can't change its own code, so Add opens a PR on the instance repo
 * (INSTANCE_REPO) with what `pnpm packs add` would write. That is the pack's files at its newest
 * release tag in dovre-packs, its `.pack.json`, and the line in `packs.ts`. It all goes in one
 * commit on a branch `dovre/add-<id>`. Before writing, it reads the instance again: the pack must
 * not be there yet. Merging and deploying stay with me. Worker-safe.
 */
import type { Ghe } from "../sources/ghe.ts";
import { HOME_SOURCE, type GetJson, literalApi, literalVersion, newestIn, notesOf } from "../packs/releases.ts";
import { apiCompare } from "../packs/api.ts";
import { PACK_API } from "../packs/types.ts";
import { detectExportName, wirePackIntoFile } from "../packs/wire.ts";

const ID = /^[a-z][a-z0-9-]{0,31}$/;
/** More files than any pack has; a bigger one is refused rather than half-copied. */
const MAX_FILES = 200;
const MAX_BYTES = 40 << 20;

const bytesOf = (b64: string) => Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
const textOf = (b: Uint8Array) => new TextDecoder().decode(b);
const is404 = (e: unknown) => /: 404\b/.test(String((e as Error)?.message ?? e));
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
/** UTF-8 text with no NUL: it can go in the tree as `content`; anything else is uploaded as a blob. */
function asText(b: Uint8Array): string | undefined {
  if (b.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return undefined;
  }
}

type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };

/** The commit a tag points at, through an annotated tag object when there is one. */
async function commitOf(get: GetJson, source: string, tag: string): Promise<string> {
  const ref = (await get(`/repos/${source}/git/ref/tags/${encodeURIComponent(tag)}`)) as { object?: { type?: string; sha?: string } };
  let o = ref?.object;
  for (let i = 0; o?.type === "tag" && i < 3; i++) o = ((await get(`/repos/${source}/git/tags/${o.sha}`)) as { object?: { type?: string; sha?: string } })?.object;
  if (o?.type !== "commit" || typeof o.sha !== "string") throw new Error(`${tag} doesn't point at a commit.`);
  return o.sha;
}

/** A file's text on a branch of the instance; undefined when it isn't there. */
async function textAt(ghe: Ghe, repo: string, path: string, ref: string): Promise<{ text: string } | undefined> {
  const r = await ghe.rest<{ type?: string; content?: string }>(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`).catch((e) => (is404(e) ? undefined : Promise.reject(e)));
  if (!r) return undefined;
  if (r.type !== "file" || typeof r.content !== "string") throw new Error(`${path} isn't a file there.`);
  return { text: textOf(bytesOf(r.content)) };
}

export type AddProposal = { repo: string; id: string; source?: string };

/** On GitHub: reads the release, checks the instance, then the commit, the branch and the PR. Throws why it didn't; a branch it made is deleted again. */
export async function proposeAdd(ghe: Ghe, get: GetJson, p: AddProposal): Promise<{ number: number; url: string; version: string }> {
  const source = p.source ?? HOME_SOURCE;
  if (!ID.test(p.id)) throw new Error(`"${p.id}" isn't a pack id.`);
  const release = (await newestIn(get, source)).get(p.id);
  if (!release) throw new Error(`${p.id} has no release in ${source}.`);
  const commit = await commitOf(get, source, release.tag);
  const top = (await get(`/repos/${source}/git/commits/${commit}`)) as { tree?: { sha?: string } };
  const tree = (await get(`/repos/${source}/git/trees/${top?.tree?.sha}?recursive=1`)) as { tree?: TreeEntry[]; truncated?: boolean };
  if (tree?.truncated) throw new Error(`${source}'s tree is too big to read in one go.`);
  const at = `packs/${p.id}/`;
  const entries = (tree?.tree ?? []).filter((e) => e.type === "blob" && e.path.startsWith(at) && e.path !== `${at}.pack.json` && !e.path.slice(at.length).split("/").includes("node_modules"));
  if (!entries.some((e) => e.path === `${at}index.ts`)) throw new Error(`${p.id} has no index.ts at ${release.tag}.`);
  if (entries.length > MAX_FILES) throw new Error(`${p.id} has ${entries.length} files, more than Add copies (${MAX_FILES}).`);
  if (entries.reduce((n, e) => n + (e.size ?? 0), 0) > MAX_BYTES) throw new Error(`${p.id} is bigger than Add copies (${MAX_BYTES >> 20} MB).`);

  // The instance, read again now: where it lists packs, and that this one isn't there yet.
  const info = await ghe.rest<{ default_branch: string }>(`/repos/${p.repo}`);
  const base = info.default_branch;
  const packsTs = await textAt(ghe, p.repo, "packs.ts", base);
  const listing = packsTs ? { path: "packs.ts", sub: "packs", ...packsTs } : undefined;
  if (!listing) throw new Error(`${p.repo} has no packs.ts.`);
  const dest = `${listing.sub}/${p.id}`;
  const there = await ghe.rest(`/repos/${p.repo}/contents/${dest}?ref=${encodeURIComponent(base)}`).then(() => true, (e) => (is404(e) ? false : Promise.reject(e)));
  if (there) throw new Error(`${dest} is in ${p.repo} already.`);

  // The files, as the release has them; text inline, anything else as a blob of the instance's.
  const files = await Promise.all(
    entries.map(async (e) => {
      const blob = (await get(`/repos/${source}/git/blobs/${e.sha}`)) as { content?: string; encoding?: string };
      if (typeof blob?.content !== "string" || blob.encoding !== "base64") throw new Error(`couldn't read ${e.path}.`);
      const bytes = bytesOf(blob.content);
      return { rel: e.path.slice(at.length), mode: e.mode === "100755" ? "100755" : "100644", b64: blob.content.replace(/\s+/g, ""), bytes, text: asText(bytes), sha256: hex(await crypto.subtle.digest("SHA-256", bytes)) };
    }),
  );
  const index = files.find((f) => f.rel === "index.ts")!.text ?? "";
  const api = literalApi(index) ?? PACK_API;
  if (apiCompare(api, PACK_API) > 0) throw new Error(`${p.id} ${release.version} needs core API ${api}: update Dovre first.`);
  const version = literalVersion(index) ?? release.version;
  const meta = { source, commit, tag: release.tag, version, api, files: Object.fromEntries(files.map((f) => [f.rel, f.sha256] as const).sort(([a], [b]) => (a < b ? -1 : 1))) };
  const wired = wirePackIntoFile(listing.text, `./${dest}/index.ts`, detectExportName(index, p.id));
  if (wired === listing.text) throw new Error(`${listing.path} names ${p.id} already.`);

  const items: { path: string; mode: string; type: "blob"; content?: string; sha?: string }[] = [];
  for (const f of files) {
    if (f.text !== undefined) items.push({ path: `${dest}/${f.rel}`, mode: f.mode, type: "blob", content: f.text });
    else {
      const b = await ghe.rest<{ sha: string }>(`/repos/${p.repo}/git/blobs`, { method: "POST", body: { content: f.b64, encoding: "base64" } });
      items.push({ path: `${dest}/${f.rel}`, mode: f.mode, type: "blob", sha: b.sha });
    }
  }
  items.push({ path: `${dest}/.pack.json`, mode: "100644", type: "blob", content: JSON.stringify(meta, null, 2) + "\n" });
  items.push({ path: listing.path, mode: "100644", type: "blob", content: wired });

  const head = await ghe.rest<{ object: { sha: string } }>(`/repos/${p.repo}/git/ref/heads/${encodeURIComponent(base)}`);
  const parent = await ghe.rest<{ tree: { sha: string } }>(`/repos/${p.repo}/git/commits/${head.object.sha}`);
  const made = await ghe.rest<{ sha: string }>(`/repos/${p.repo}/git/trees`, { method: "POST", body: { base_tree: parent.tree.sha, tree: items } });
  const title = `Add the ${p.id} pack ${version} from dovre-packs`;
  const c = await ghe.rest<{ sha: string }>(`/repos/${p.repo}/git/commits`, { method: "POST", body: { message: title, tree: made.sha, parents: [head.object.sha] } });
  const branch = `dovre/add-${p.id}`;
  await ghe.rest(`/repos/${p.repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: c.sha } });
  try {
    const changelog = files.find((f) => f.rel === "CHANGELOG.md")?.text;
    const lines = changelog ? notesOf(changelog, null)[0]?.lines ?? [] : [];
    const body = [
      `Adds the **${p.id}** pack, release \`${release.tag}\` from ${source}, as \`pnpm packs add ${p.id}\` would: its ${files.length} files in \`${dest}/\`, its \`.pack.json\`, and the line in \`${listing.path}\`.`,
      ...(lines.length ? ["", `What ${version} says:`, ...lines.map((l) => `- ${l}`)] : []),
      "",
      "Opened from Dovre's Packs page. Check out the branch, run the instance's typecheck and tests, merge, then deploy: it loads on the next deploy.",
    ].join("\n");
    const pr = await ghe.rest<{ number: number; html_url: string }>(`/repos/${p.repo}/pulls`, { method: "POST", body: { title, head: branch, base, body } });
    return { number: pr.number, url: pr.html_url, version };
  } catch (e) {
    await ghe.rest(`/repos/${p.repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "DELETE" }).catch(() => {});
    throw e;
  }
}
