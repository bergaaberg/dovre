/**
 * Bino carries on after the climb (#94): what its conversation reads from Dovre, and the one write
 * it adds. The packs as a catalogue (on, switched off here, can't run yet, in dovre-packs to add,
 * being added), the opening line from what the climb asked, and Add, the same as the Packs page's.
 * All of it is read from state when it's drawn, never from what Bino said.
 */
import { proposeAdd } from "../actions/addpack.ts";
import { actionsOf, logAction } from "../actions/deploys.ts";
import { FORGES } from "../onboarding.ts";
import type { ToAdd } from "../packs/copies.ts";
import type { Listed, Runs } from "../packs/releases.ts";
import { ROLES } from "../packs/suggest.ts";
import type { AppScope } from "./scope.ts";

/** One pack as Bino's setup chat sees it. */
export type CarryPack = {
  id: string;
  name: string;
  /** Its one line. */
  what: string;
  /**
   * on: on and shown. hidden: here, switched off on Layout. off: here, but it can't run yet (`why`).
   * add: in dovre-packs, not here. adding: its Add is running, or its PR is open (`href`).
   */
  state: "on" | "hidden" | "off" | "add" | "adding";
  why?: string;
  /** on: the steps of its own setup not done yet; unset when it has none. */
  left?: number;
  href?: string;
  /** add: where it runs, when not everywhere. */
  runs?: Exclude<Runs, "any">;
  /** One of Dovre's own (src/packs/core/). */
  own?: boolean;
};

export type Added = { ok: true; text: string; href: string } | { ok: false; why: string };

export type CarryApi = {
  /** Bino's fixed opening: the role, where code lives and the packs on, from the climb; then the question. */
  opening(): string;
  /** Every pack here and in dovre-packs, as it stands now. */
  packs(): Promise<CarryPack[]>;
  /** Add from dovre-packs (#88): locally a job on the copies, hosted a PR on the instance repo. Logged as `packs.add`. */
  add(id: string, o?: { waitUntil?: (p: Promise<unknown>) => void }): Promise<Added>;
};

type Scope = Pick<AppScope, "env" | "deps" | "hosted" | "packs" | "hidden" | "onboarding" | "setupOf" | "setupLeft" | "packIds" | "instanceRepo" | "opening" | "releases" | "packsGet" | "ghe">;

/** Hosted: each pack to add, with its newest Add from the log (the PR it opened, or why not) or one opening now. */
export async function hostedAdds(s: Pick<Scope, "env" | "opening">, listed: Listed[]): Promise<ToAdd[]> {
  const log = await actionsOf(s.env.DB, "packs.add").catch(() => []);
  return listed.map((l) => {
    if (s.opening.has(l.id)) return { ...l, job: { at: Date.now(), state: "running" as const, step: "opening a PR" } };
    const a = log.find((x) => x.target === l.id);
    if (!a) return l;
    const at = Date.parse(a.at);
    return { ...l, job: a.ok ? { at, state: "done" as const, step: "PR opened; merge it, then deploy", url: a.detail ?? undefined } : { at, state: "failed" as const, step: a.error ?? "failed" } };
  });
}

/** Add (#88): a pack from dovre-packs this instance doesn't list. The Packs page's Add and Bino's card both come here. */
export async function addPack(s: Scope, id: string, o: { waitUntil?: (p: Promise<unknown>) => void; publish?: () => void } = {}): Promise<{ ok: true } | { ok: false; why: string; missing?: boolean }> {
  if (s.packIds().includes(id)) return { ok: false, why: "It's here already." };
  if (s.hosted) {
    const repo = s.instanceRepo();
    const l = s.releases?.get()?.listed.find((x) => x.id === id);
    if (!repo || !l) return { ok: false, why: "dovre-packs has no such pack, or this instance can't add one.", missing: true };
    if (s.opening.has(id)) return { ok: true };
    s.opening.add(id);
    const work = proposeAdd(s.ghe, s.packsGet, { repo, id })
      .then(
        (pr) => logAction(s.env.DB, { kind: "packs.add", target: id, detail: pr.url, ok: true }),
        (e: unknown) => logAction(s.env.DB, { kind: "packs.add", target: id, ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }),
      )
      .catch(() => {})
      .finally(() => {
        s.opening.delete(id);
        o.publish?.();
      });
    o.waitUntil?.(work);
    return { ok: true };
  }
  const copies = s.deps.packs?.copies;
  if (!copies) return { ok: false, why: "Packs can't be added on this machine.", missing: true };
  const r = copies.add(id, (ok, detail) => void logAction(s.env.DB, { kind: "packs.add", target: id, detail, ok }).catch(() => {}));
  if (!r.ok) await logAction(s.env.DB, { kind: "packs.add", target: id, ok: false, error: r.why }).catch(() => {});
  return r;
}

const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

export function carryApi(s: Scope & { publish?: () => void }): CarryApi {
  const own = new Set(s.packs.core ?? []);
  /** What's in dovre-packs and not here, with how its Add went. */
  const toAdd = async (): Promise<ToAdd[]> => {
    const here = new Set(s.packIds());
    if (!s.hosted) return (s.deps.packs?.copies?.listed() ?? []).filter((p) => !here.has(p.id));
    const got = s.releases?.get();
    return got && s.instanceRepo() ? (await hostedAdds(s, got.listed)).filter((p) => !here.has(p.id)) : [];
  };
  const packs = async (): Promise<CarryPack[]> => {
    const here: CarryPack[] = s.packs.on.map((p) => {
      const id = p.manifest.id;
      const base = { id, name: p.manifest.name, what: p.manifest.description ?? "", ...(own.has(id) ? { own: true } : {}) };
      if (s.hidden(id)) return { ...base, state: "hidden" as const };
      return { ...base, state: "on" as const, ...(s.setupOf(p) ? { left: s.setupLeft(p).length } : {}) };
    });
    const off: CarryPack[] = s.packs.off.map((x) => ({ id: x.id, name: x.name, what: x.manifest?.description ?? "", state: "off" as const, why: x.why, ...(own.has(x.id) ? { own: true } : {}) }));
    // One that needs a newer core has no Add (the Packs page says why).
    const adds: CarryPack[] = (await toAdd().catch(() => [])).filter((l) => !l.needsCore).map((l) => {
      const base = { id: l.id, name: l.name, what: l.description, ...(l.execution !== "any" ? { runs: l.execution } : {}) };
      if (l.job && l.job.state !== "failed") return { ...base, state: "adding" as const, why: l.job.step, ...(l.job.url ? { href: l.job.url } : {}) };
      return { ...base, state: "add" as const, ...(l.job?.state === "failed" ? { why: `The last Add failed: ${l.job.step}` } : {}) };
    });
    return [...here, ...off, ...adds];
  };
  return {
    packs,
    opening() {
      const o = s.onboarding.get();
      const forge = o.forge === "none" ? "no code host" : o.forge ? `code on ${FORGES.find(([id]) => id === o.forge)?.[1] ?? o.forge}` : "";
      const who = [o.role ? ROLES[o.role] : "", forge].filter(Boolean).join(", ");
      const on = s.packs.on.filter((p) => !own.has(p.manifest.id) && !s.hidden(p.manifest.id)).map((p) => p.manifest.name);
      return [
        `You're up.${who ? ` ${who}.` : ""}${on.length ? ` On now: ${list(on)}.` : ""}`,
        "What else do you work with? Name the tools (where errors show up, where you deploy, where the team talks), and I'll find their packs. Below is what's set up and what's left.",
      ].join(" ");
    },
    async add(id, o = {}) {
      const p = (await packs()).find((x) => x.id === id);
      if (!p || p.state !== "add") return { ok: false, why: p ? `${p.name} isn't one to add: it's ${p.state === "adding" ? "being added already" : "here already"}.` : "dovre-packs has no such pack." };
      const r = await addPack(s, id, { ...o, publish: s.publish });
      if (!r.ok) return r;
      const href = `/packs#add-${encodeURIComponent(id)}`;
      if (s.hosted) return { ok: true, href, text: `Opening a PR on ${s.instanceRepo()} that adds ${p.name}. Merge it, then deploy.` };
      return { ok: true, href, text: `Adding ${p.name}: Dovre fetches it and checks it. The Packs page shows how it goes.` };
    },
  };
}
