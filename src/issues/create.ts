/**
 * Filing the issue: one REST call that sets the type with it (`gh issue create` has no type),
 * then checks what stuck. Without push access GitHub drops the type and labels silently, and
 * intake workflows close an issue without a type on sight, so a dropped type is set again over
 * GraphQL. A template's `projects:` the UI would have added it to are added here the same way.
 * Logged whether it worked or not.
 */
import { logAction } from "../actions/deploys.ts";
import type { D1 } from "../db.ts";
import type { Ghe } from "../sources/ghe.ts";

export type NewIssue = { repo: string; title: string; body: string; type: string; typeNodeId?: string; labels: string[]; projects: string[] };
export type Created = { ok: true; url: string; number: number; repo: string; title: string; warnings: string[] } | { ok: false; message: string };

export type RawIssue = { html_url: string; number: number; id: number; node_id: string; type: { name: string } | null; labels: ({ name: string } | string)[] };

/** The payload the REST create gets: the type by name, in the same call. */
export const createPayload = (i: NewIssue) => ({ title: i.title, body: i.body, type: i.type, labels: i.labels });

/** "ACME/6" → the org's project 6; any other owner is refused like a foreign repo. */
export function projectRef(org: string, ref: string): number | null {
  const m = ref.trim().match(/^([\w.-]+)\/(\d{1,6})$/);
  return m && m[1] === org ? Number(m[2]) : null;
}

export const msg = (e: unknown) => String((e as Error)?.message ?? e);

/** GitHub dropped the type (no push access): set it over GraphQL. A warning when that fails too. */
export async function ensureType(ghe: Ghe, issue: RawIssue, type: string, typeNodeId?: string): Promise<string | undefined> {
  if (issue.type?.name === type) return undefined;
  try {
    if (!typeNodeId) throw new Error("the type's id didn't load");
    await ghe.graphql(`mutation{updateIssue(input:{id:${JSON.stringify(issue.node_id)},issueTypeId:${JSON.stringify(typeNodeId)}}){issue{number}}}`);
    return undefined;
  } catch (e) {
    return `The type «${type}» didn't stick (${msg(e)}). Set it on the issue before an intake workflow closes it.`;
  }
}

export async function createIssue(ghe: Ghe, db: D1, org: string, i: NewIssue): Promise<Created> {
  let issue: RawIssue;
  try {
    issue = await ghe.rest<RawIssue>(`/repos/${i.repo}/issues`, { method: "POST", body: createPayload(i) });
  } catch (e) {
    await logAction(db, { kind: "issue.create", target: i.repo, detail: `${i.type} · ${i.title}`, ok: false, error: msg(e) });
    return { ok: false, message: `Couldn't create the issue in ${i.repo}: ${msg(e)}` };
  }
  const warnings: string[] = [];
  const typeWarning = await ensureType(ghe, issue, i.type, i.typeNodeId);
  if (typeWarning) warnings.push(typeWarning);
  const got = new Set((issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)));
  const dropped = i.labels.filter((l) => !got.has(l));
  if (dropped.length) warnings.push(`GHE dropped the labels ${dropped.join(", ")} (they need push access).`);
  for (const ref of i.projects) {
    const n = projectRef(org, ref);
    if (n === null) {
      warnings.push(`Not added to project ${ref}: it isn't one of ${org}'s.`);
      continue;
    }
    try {
      const d = await ghe.graphql<{ organization: { projectV2: { id: string } | null } | null }>(`{organization(login:${JSON.stringify(org)}){projectV2(number:${n}){id}}}`);
      const id = d?.organization?.projectV2?.id;
      if (!id) throw new Error("project not found");
      await ghe.graphql(`mutation{addProjectV2ItemById(input:{projectId:${JSON.stringify(id)},contentId:${JSON.stringify(issue.node_id)}}){item{id}}}`);
    } catch (e) {
      warnings.push(`Not added to project ${ref}: ${msg(e)}`);
    }
  }
  const target = `${i.repo}#${issue.number}`;
  await logAction(db, { kind: "issue.create", target, detail: `${i.type} · ${i.title}`, ok: true, error: warnings.join(" ") || undefined });
  return { ok: true, url: issue.html_url, number: issue.number, repo: i.repo, title: i.title, warnings };
}
