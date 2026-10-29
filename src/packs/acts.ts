/**
 * Act shapes (dovre#262 idea 3): a pack's acts (ActKind) built from a helper that already does
 * what every write must. It checks the pack is set up, reads the card's form, re-checks the app's
 * current state, logs to the actions table on every path (never the text written), and turns a
 * throw into "not done". Every card asks twice unless the pack says `oneClick`.
 *
 * `writeAct` is the general one. `commentAct`, `createAct`, `assignAct` and `statusAct` are the
 * common writes of a tracker (Jira, GitLab, Linear): a pack gives only how to find a thing and
 * how to write to it. A pack imports them as `dovre/packs/acts.ts`.
 */
import { html } from "hono/html";
import { logAction } from "../actions/deploys.ts";
import type { ActDone, ActField, ActKind, PackContext } from "./types.ts";
import type { Html } from "../ui/kit.ts";

/** The app said no, or the thing isn't as it was: the card shows `refuse`, the log keeps `log` (default `refuse`). */
export type Refusal = { refuse: string; log?: string };
export const refused = (r: unknown): r is Refusal => typeof (r as Refusal | undefined)?.refuse === "string";

/** What a write did: the card's line after, a link to the thing, and a short detail for the log (a title, never a body). */
export type Wrote = { done: string; href?: string; detail?: string };

/** What the card's form asked for, checked: who it's about in the log (`target`), and the values the write needs. */
export type Read<T> = { target: string; value: T };

export type WriteSpec<T, C> = {
  /** The pack's id: the write is logged as `<pack>.<kind>`. */
  pack: string;
  kind: string;
  title: string;
  when: string;
  fields: ActField[];
  button: string;
  hint?: string;
  question?: string;
  oneClick?: boolean;
  /** The card's inputs; by default a labelled box for each field (`fieldInputs`). */
  inputs?: ActKind["inputs"];
  /** Why it can't run at all (a key not set), or undefined. Not logged: nothing was tried. */
  ready?(ctx: PackContext): string | undefined;
  /** The form checked: what's missing or malformed is a string for the card, not logged. */
  read(form: Record<string, string>, ctx: PackContext): Read<T> | string;
  /** The app's current state, read again just before writing; a Refusal stops it, and is logged. */
  check?(value: T, ctx: PackContext): Promise<C | Refusal>;
  write(value: T, checked: C, ctx: PackContext): Promise<Wrote | Refusal>;
};

/** A labelled box per field, filled from what I typed when it was refused (`kept`), else from Bino (`act`). */
export function fieldInputs(fields: ActField[], act: Record<string, string>, kept?: Record<string, string>): Html {
  return html`${fields.map((f) => {
    const v = kept?.[f.name] ?? act[f.name] ?? "";
    const label = f.name.charAt(0).toUpperCase() + f.name.slice(1).replace(/_/g, " ");
    const max = Math.max(1, Math.min(4000, f.max ?? 200));
    return f.text
      ? html`<label class="field"><span class="label">${label}</span><textarea name="${f.name}" rows="5" maxlength="${max}" placeholder="${f.about}"${f.required ? html` required` : ""}>\n${v}</textarea></label>`
      : html`<label class="field"><span class="label">${label}</span><input type="text" name="${f.name}" value="${v}" maxlength="${max}" placeholder="${f.about}"${f.required ? html` required` : ""}></label>`;
  })}`;
}

const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/** A pack's act from a WriteSpec: ready, read, re-check, write, each step's outcome logged. */
export function writeAct<T, C = undefined>(s: WriteSpec<T, C>): ActKind {
  const kind = `${s.pack}.${s.kind}`;
  return {
    kind: s.kind,
    title: s.title,
    when: s.when,
    fields: s.fields,
    button: s.button,
    ...(s.hint ? { hint: s.hint } : {}),
    ...(s.question ? { question: s.question } : {}),
    ...(s.oneClick ? { oneClick: true } : {}),
    inputs: s.inputs ?? ((act, kept) => fieldInputs(s.fields, act, kept)),
    async run(form, _act, ctx): Promise<ActDone> {
      const notReady = s.ready?.(ctx);
      if (notReady) return { ok: false, error: notReady };
      let r: Read<T> | string;
      try {
        r = s.read(form, ctx);
      } catch (e) {
        return { ok: false, error: message(e) };
      }
      if (typeof r === "string") return { ok: false, error: r };
      const target = r.target.slice(0, 200);
      const fail = async (error: string, log = error): Promise<ActDone> => {
        await logAction(ctx.db, { kind, target, ok: false, error: log.slice(0, 300) }).catch(() => {});
        return { ok: false, error };
      };
      try {
        const checked = s.check ? await s.check(r.value, ctx) : (undefined as C);
        if (refused(checked)) return await fail(checked.refuse, checked.log);
        const w = await s.write(r.value, checked, ctx);
        if (refused(w)) return await fail(w.refuse, w.log);
        await logAction(ctx.db, { kind, target, ...(w.detail ? { detail: w.detail.slice(0, 200) } : {}), ok: true });
        return { ok: true, done: w.done, ...(w.href ? { href: w.href } : {}) };
      } catch (e) {
        return await fail(message(e));
      }
    },
  };
}

// ── Tracker shapes ──

/** How a pack names one of its things in a field: "issue", "ENG-123". `pattern` must match the whole (normalized) value. */
export type Ref = { name: string; about: string; pattern: RegExp; max?: number; /** Default: trimmed. */ normalize?(s: string): string };

/** A thing as the app says it is now: `label` names it on the card and in the log ("ENG-123"). */
export type Found = { label: string; href?: string; /** False when it's closed, done or archived: no writes to it. */ open?: boolean; state?: string };

/** What every tracker shape takes. `app` is the app's name ("Linear"), `thing` what it holds ("issue"). */
type Base = { pack: string; app: string; thing: string; ready?(ctx: PackContext): string | undefined; oneClick?: boolean; when?: string };
type OnThing<F extends Found> = Base & { ref: Ref; /** The thing now; null when the app has none by that name. */ find(ref: string, ctx: PackContext): Promise<F | null> };

function refOf(ref: Ref, raw: string | undefined): string | undefined {
  const v = (ref.normalize ?? ((s: string) => s.trim()))(raw ?? "");
  ref.pattern.lastIndex = 0;
  const m = ref.pattern.exec(v);
  return m && m.index === 0 && m[0] === v && v.length <= (ref.max ?? 60) ? v : undefined;
}

const refField = (ref: Ref): ActField => ({ name: ref.name, about: ref.about, required: true, max: ref.max ?? 60 });

/** Finds the thing again and refuses one that's gone or closed. */
async function findOpen<F extends Found>(s: OnThing<F>, ref: string, ctx: PackContext): Promise<F | Refusal> {
  const f = await s.find(ref, ctx);
  if (!f) return { refuse: `${s.app} has no ${s.thing} ${ref}.`, log: `no such ${s.thing}` };
  if (f.open === false) return { refuse: `${f.label} is ${f.state ?? "closed"}; let it be.`, log: f.state ?? "closed" };
  return f;
}

/** A comment on one of the app's things. */
export function commentAct<F extends Found>(s: OnThing<F> & { comment(found: F, text: string, ctx: PackContext): Promise<true | Refusal> }): ActKind {
  return writeAct<{ ref: string; text: string }, F>({
    pack: s.pack,
    kind: "comment",
    title: `A comment on a ${s.app} ${s.thing}`,
    when: s.when ?? `I want to add a comment to a ${s.app} ${s.thing} I can name (${s.ref.about}).`,
    fields: [refField(s.ref), { name: "text", about: "the comment", required: true, max: 4000, text: true }],
    button: "Comment",
    hint: "Adds the comment from you.",
    question: `Post this comment on ${s.app}?`,
    oneClick: s.oneClick,
    ready: s.ready,
    read(form) {
      const ref = refOf(s.ref, form[s.ref.name]);
      const text = (form.text ?? "").trim().slice(0, 4000);
      if (!ref || !text) return `Give the ${s.thing} (${s.ref.about}) and a comment.`;
      return { target: `${ref} comment`, value: { ref, text } };
    },
    check: ({ ref }, ctx) => findOpen(s, ref, ctx),
    async write({ text }, found, ctx) {
      const r = await s.comment(found, text, ctx);
      return refused(r) ? r : { done: `Commented on ${found.label}`, href: found.href };
    },
  });
}

/** A new thing in one of the app's places (a team, a project). */
export function createAct(
  s: Base & {
    /** Where it goes: "team", "the team key, e.g. ENG". */
    where: Ref;
    /** Checks the place exists, then creates it; null when the app has no such place. */
    create(where: string, title: string, description: string, ctx: PackContext): Promise<Found | Refusal | null>;
  },
): ActKind {
  return writeAct<{ where: string; title: string; description: string }>({
    pack: s.pack,
    kind: "create",
    title: `A ${s.app} ${s.thing}`,
    when: s.when ?? `I want a new ${s.thing} in ${s.app}, with a title and optional description.`,
    fields: [refField(s.where), { name: "title", about: `the ${s.thing}'s title`, required: true, max: 200 }, { name: "description", about: "what it's about, in a few lines", max: 4000, text: true }],
    button: "Create",
    hint: "Creates it and links it here.",
    question: `Create this ${s.app} ${s.thing}?`,
    oneClick: s.oneClick,
    ready: s.ready,
    read(form) {
      const where = refOf(s.where, form[s.where.name]);
      const title = (form.title ?? "").trim().slice(0, 200);
      if (!where || !title) return `Give the ${s.where.name} (${s.where.about}) and a title.`;
      return { target: `${where} ${s.thing}`, value: { where, title, description: (form.description ?? "").trim().slice(0, 4000) } };
    },
    async write({ where, title, description }, _c, ctx) {
      const r = await s.create(where, title, description, ctx);
      if (r === null) return { refuse: `${s.app} has no ${s.where.name} "${where}".`, log: `no such ${s.where.name}` };
      if (refused(r)) return r;
      return { done: `Created ${r.label}`, href: r.href, detail: title };
    },
  });
}

/** One of the app's things given to someone ("me" by default). */
export function assignAct<F extends Found & { assignee?: string }>(
  s: OnThing<F> & {
    /** Who may be named: "a username, or me". */
    who?: string;
    assign(found: F, who: string, ctx: PackContext): Promise<true | Refusal>;
  },
): ActKind {
  return writeAct<{ ref: string; who: string }, F>({
    pack: s.pack,
    kind: "assign",
    title: `Assign a ${s.app} ${s.thing}`,
    when: s.when ?? `I want a ${s.app} ${s.thing} I can name (${s.ref.about}) assigned to me or someone else.`,
    fields: [refField(s.ref), { name: "to", about: s.who ?? "who gets it: a username, or me", max: 80 }],
    button: "Assign",
    question: `Assign this ${s.app} ${s.thing}?`,
    oneClick: s.oneClick,
    ready: s.ready,
    read(form) {
      const ref = refOf(s.ref, form[s.ref.name]);
      const typed = (form.to ?? "").trim().slice(0, 80);
      const who = !typed || typed.toLowerCase() === "me" ? "me" : typed;
      if (!ref) return `Give the ${s.thing} (${s.ref.about}).`;
      return { target: `${ref} to ${who}`, value: { ref, who } };
    },
    async check({ ref, who }, ctx) {
      const f = await findOpen(s, ref, ctx);
      if (refused(f)) return f;
      if (f.assignee && f.assignee.toLowerCase() === who.toLowerCase()) return { refuse: `${f.label} is already ${who === "me" ? "yours" : `${who}'s`}.`, log: "already assigned" };
      return f;
    },
    async write({ who }, found, ctx) {
      const r = await s.assign(found, who, ctx);
      return refused(r) ? r : { done: `Assigned ${found.label} to ${who}`, href: found.href };
    },
  });
}

/** One of the app's things moved to another status. `find` should say its `state` and, when it can, the ones it may move to. */
export function statusAct<F extends Found & { states?: string[] }>(
  s: OnThing<F> & { setStatus(found: F, status: string, ctx: PackContext): Promise<true | Refusal> },
): ActKind {
  return writeAct<{ ref: string; status: string }, { found: F; status: string }>({
    pack: s.pack,
    kind: "status",
    title: `A ${s.app} ${s.thing}'s status`,
    when: s.when ?? `I want a ${s.app} ${s.thing} I can name (${s.ref.about}) moved to another status, such as In progress or Done.`,
    fields: [refField(s.ref), { name: "status", about: "the status to move it to, as the app names it", required: true, max: 60 }],
    button: "Move",
    question: `Change this ${s.app} ${s.thing}'s status?`,
    oneClick: s.oneClick,
    ready: s.ready,
    read(form) {
      const ref = refOf(s.ref, form[s.ref.name]);
      const status = (form.status ?? "").trim().slice(0, 60);
      if (!ref || !status) return `Give the ${s.thing} (${s.ref.about}) and a status.`;
      return { target: `${ref} to ${status}`, value: { ref, status } };
    },
    async check({ ref, status }, ctx) {
      // A done thing may still move (reopened), so not findOpen: only that it exists.
      const f = await s.find(ref, ctx);
      if (!f) return { refuse: `${s.app} has no ${s.thing} ${ref}.`, log: `no such ${s.thing}` };
      const same = (a: string) => a.toLowerCase() === status.toLowerCase();
      if (f.state && same(f.state)) return { refuse: `${f.label} is already ${f.state}.`, log: "already there" };
      const to = f.states?.find(same);
      if (f.states && !to) return { refuse: `${f.label} can't move to "${status}". It can move to: ${f.states.slice(0, 12).join(", ")}.`, log: "no such status" };
      return { found: f, status: to ?? status };
    },
    async write(_v, { found, status }, ctx) {
      const r = await s.setStatus(found, status, ctx);
      return refused(r) ? r : { done: `Moved ${found.label} to ${status}`, href: found.href };
    },
  });
}
