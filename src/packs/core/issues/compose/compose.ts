/**
 * An issue being written: read from the form, checked, and composed into the body GitHub would
 * have made from the same issue form. Pure; the page renders it, create.ts sends it.
 */
import type { Field, IssueType, Template } from "./templates.ts";

/** What one field holds: text (input, textarea), picked option indexes (dropdown), ticks (checkboxes). */
export type Value = { text: string; picked: number[]; ticked: boolean[] };

export type Draft = {
  repo: string;
  /** null: a blank issue, no form. */
  template: Template | null;
  type: string;
  title: string;
  /** A blank issue's body; a form's comes from its fields. */
  body: string;
  values: Value[];
  /** Labels picked on top of the template's (only ones the repo has). */
  extra: string[];
};

export type Errors = { title?: string; type?: string; body?: string; fields: (string | undefined)[] };

/** GitHub's own limits on an issue. */
export const MAX_TITLE = 256;
export const MAX_BODY = 65536;
export const BLANK = "blank";

/** The type is the form's when it names one; a blank issue (or a form without `type:`) picks it. */
export const picksType = (t: Template | null) => !t?.type;

type Form = Record<string, unknown>;
const first = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? (v.find((x) => typeof x === "string") ?? "") : "");
const all = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
const lf = (s: string) => s.replace(/\r\n?/g, "\n");

/** Labels the repo has that are worth offering on top of a template's: one priority, one track. */
export type Offered = { priority: string[]; tracks: string[] };
export const NOTHING_OFFERED: Offered = { priority: [], tracks: [] };

/**
 * Only labels that exist (adding a missing one would create it). `priority:*` where a repo still
 * has them (most moved to the org's Priority field). A track (`team:*` for a team's work,
 * `category:*` for work across teams) is one label at most, as syncs like the sync read it.
 */
export function offeredLabels(repoLabels: string[]): Offered {
  return {
    priority: repoLabels.filter((l) => /^priority:/i.test(l)).sort(),
    tracks: repoLabels.filter((l) => /^(team|category):/i.test(l)).sort(),
  };
}

/** A fresh draft: the template's title prefix, starting values and defaults. */
export function emptyDraft(repo: string, template: Template | null, offered: Offered): Draft {
  return {
    repo,
    template,
    type: template?.type ?? "",
    title: template?.title ?? "",
    body: "",
    values: (template?.fields ?? []).map((f) => ({ text: f.value ?? "", picked: f.default !== undefined ? [f.default] : [], ticked: f.options.map(() => false) })),
    extra: [],
  };
}

/** A draft from a posted form. Anything not offered (an option index, a label) is dropped, not trusted. */
export function readDraft(repo: string, template: Template | null, form: Form, offered: Offered): Draft {
  const values = (template?.fields ?? []).map((f, i): Value => {
    const name = `f${i}`;
    if (f.kind === "dropdown") {
      const picked = [...new Set(all(form[name]).filter((s) => /^\d{1,4}$/.test(s)).map(Number))].filter((n) => n < f.options.length);
      return { text: "", picked: f.multiple ? picked.sort((a, b) => a - b) : picked.slice(0, 1), ticked: [] };
    }
    if (f.kind === "checkboxes") return { text: "", picked: [], ticked: f.options.map((_, j) => first(form[`${name}.${j}`]) === "on") };
    if (f.kind === "markdown") return { text: "", picked: [], ticked: [] };
    // An input is one line, as GitHub's is.
    return { text: f.kind === "input" ? first(form[name]).replace(/[\r\n]+/g, " ") : lf(first(form[name])), picked: [], ticked: [] };
  });
  const priority = first(form.priority);
  const track = first(form.track);
  return {
    repo,
    template,
    type: picksType(template) ? first(form.type).trim() : template!.type!,
    title: first(form.title).replace(/[\r\n]+/g, " "),
    body: template ? "" : lf(first(form.body)),
    values,
    extra: [...(offered.priority.includes(priority) ? [priority] : []), ...(offered.tracks.includes(track) ? [track] : [])],
  };
}

/** The draft as form fields again: what the preview carries to create, and what readDraft reads back. */
export function formPairs(d: Draft): [string, string][] {
  const out: [string, string][] = [["repo", d.repo], ["template", d.template?.file ?? BLANK], ["title", d.title]];
  if (picksType(d.template)) out.push(["type", d.type]);
  if (!d.template) out.push(["body", d.body]);
  (d.template?.fields ?? []).forEach((f, i) => {
    const v = d.values[i]!;
    if (f.kind === "input" || f.kind === "textarea") out.push([`f${i}`, v.text]);
    if (f.kind === "dropdown") for (const p of v.picked) out.push([`f${i}`, String(p)]);
    if (f.kind === "checkboxes") v.ticked.forEach((t, j) => t && out.push([`f${i}.${j}`, "on"]));
  });
  for (const l of d.extra) out.push(/^priority:/i.test(l) ? ["priority", l] : ["track", l]);
  return out;
}

const NO_RESPONSE = "_No response_";

function answer(f: Field, v: Value): string {
  if (f.kind === "checkboxes") return f.options.map((o, j) => `- [${v.ticked[j] ? "X" : " "}] ${o}`).join("\n");
  if (f.kind === "dropdown") return v.picked.length ? v.picked.map((p) => f.options[p]).join(", ") : NO_RESPONSE;
  const text = v.text.trim();
  if (!text) return NO_RESPONSE;
  return f.render ? `\`\`\`${f.render}\n${text}\n\`\`\`` : text;
}

/**
 * The body as GitHub writes it from an issue form: `### <label>`, a blank line, the answer;
 * `_No response_` for what was left empty; markdown blocks left out; ticked boxes as `- [X]`
 * (GitHub's capital X); a `render:` textarea fenced. Triage tooling reads these headings.
 */
export function composeBody(d: Draft): string {
  if (!d.template) return d.body.trim();
  return d.template.fields
    .map((f, i) => (f.kind === "markdown" ? null : `### ${f.label}\n\n${answer(f, d.values[i]!)}`))
    .filter((s): s is string => s !== null)
    .join("\n\n");
}

/** The template's labels, then the extras, once each. */
export const labelsOf = (d: Draft) => [...new Set([...(d.template?.labels ?? []), ...d.extra])];

/**
 * What stops the draft from being filed. `types`: the org's enabled Issue Types, when they
 * loaded: intake workflows close an issue without a type on sight, so a type that isn't one is an error too.
 */
export function validate(d: Draft, types: IssueType[] | null): Errors {
  const e: Errors = { fields: [] };
  const title = d.title.trim();
  const prefix = d.template?.title.trim() ?? "";
  if (!title) e.title = "Write a title.";
  else if (prefix && title === prefix) e.title = "The title is still the template's: add the summary.";
  else if (title.length > MAX_TITLE) e.title = `At most ${MAX_TITLE} characters (${title.length} now).`;
  if (!d.type) e.type = "Pick a type.";
  else if (types && !types.some((t) => t.name === d.type)) e.type = `«${d.type}» isn't an enabled Issue Type in the org.`;
  (d.template?.fields ?? []).forEach((f, i) => {
    const v = d.values[i]!;
    if (f.kind === "checkboxes") e.fields[i] = f.mustTick.some((must, j) => must && !v.ticked[j]) ? "Tick the required boxes." : undefined;
    else if (!f.required) e.fields[i] = undefined;
    else if (f.kind === "dropdown") e.fields[i] = v.picked.length ? undefined : "Pick one.";
    else if (f.kind !== "markdown") e.fields[i] = v.text.trim() ? undefined : "Required.";
  });
  if (composeBody(d).length > MAX_BODY) e.body = `The body is over GitHub's ${MAX_BODY} characters.`;
  return e;
}

export const isValid = (e: Errors) => !e.title && !e.type && !e.body && e.fields.every((f) => !f);

/** Fields still holding the template's starting text (a scaffold like «Som <rolle> …»): worth a second look, not an error. */
export const untouched = (d: Draft): string[] =>
  (d.template?.fields ?? []).filter((f, i) => f.value?.trim() && d.values[i]!.text.trim() === f.value.trim()).map((f) => f.label);

/** Where the work goes, for the agent's prompt: the org's setup, from config. */
export type Setup = { /** Repos whose issues the work is planned in (SORTING_REPOS): dev tasks hang under them. */ sortingRepos: string[]; formRepos: string[]; /** The skill that drafts an issue through a repo's forms (FORM_SKILL). */ formSkill?: string };

const DRAFT_FIRST = "Ask me what's missing, show me the draft, and wait for my go before you create anything.";

/** The kinds of work, in a few lines, so an agent files the note as the right one. */
export function kindsOf(s: Setup): string {
  const sorting = s.sortingRepos.join(", ");
  return [
    `- Dev task: a piece of a planned issue${sorting ? ` (in ${sorting})` : ""}. An issue in the code repo where the work happens, added as a sub-issue of the planned one, and closed from the PR with "Closes <org>/<repo>#<n>".${sorting ? ` Never create issues in ${sorting} itself: they're planned there.` : ""}`,
    s.formRepos.length ? `- Issue through a repo's own forms (${s.formRepos.join(", ")}): ${s.formSkill ? `use the /${s.formSkill} skill, which follows the repo's issue forms` : "follow the repo's issue forms (.github/ISSUE_TEMPLATE)"}.` : "",
  ].filter(Boolean).join("\n");
}

export type AgentAsk =
  | { kind: "forms"; repo: string; template?: string }
  | { kind: "task"; parent?: string; repo?: string }
  | { kind: "any" };

/** What an agent gets to draft the work with: the FORM_SKILL skill for a repo's forms, plain instructions for the rest. */
export function agentPrompt(note: string, ask: AgentAsk, setup: Setup): string {
  const n = note.trim();
  if (ask.kind === "forms")
    return setup.formSkill
      ? `/${setup.formSkill} ${n} (target repo: ${ask.repo}${ask.template ? `, template: ${ask.template}` : ""})`
      : `Create an issue in ${ask.repo} from my note below, following the repo's issue forms (.github/ISSUE_TEMPLATE)${ask.template ? `, template ${ask.template}` : ""}. ${DRAFT_FIRST}

Note: ${n}`;
  if (ask.kind === "task")
    return `Create a dev task from my note below: an issue in ${ask.repo ?? "the code repo where the work happens (ask me if it isn't clear)"}, with the org Issue Type Task, then add it as a sub-issue of ${ask.parent ?? "the issue it belongs under" + (setup.sortingRepos.length ? ` in ${setup.sortingRepos.join(" or ")}` : "") + " (ask me if it isn't clear)"} (REST: POST /repos/<parent repo>/issues/<n>/sub_issues with the new issue's id). ${DRAFT_FIRST}

Note: ${n}`;
  return `Help me file the note below as the right kind of work. The kinds:
${kindsOf(setup)}

Pick the kind and say why. ${DRAFT_FIRST}

Note: ${n}`;
}

/** Rules for Norwegian issue prose, condensed: checked by eye, never rewritten. */
export const PROSE_RULES: string[] = [
  "Sammensatte ord i ett: «kjøpstidspunkt», ikke «kjøp-tidspunkt» (akronym + ord kan ha bindestrek: «FREG-oppslag»).",
  "Negasjon etter ennå/alltid/nettopp: «ennå ikke kalt».",
  "Ikke dropp «at»: «Vi antar at de ikke forekommer».",
  "Lister med «eller», ikke skråstrek mellom norske ord (greit for tekniske feltnavn).",
  "Ingen engelske calques: «parter», «kanttilfeller», ikke «parties», «edge cases».",
  "Tankestrek sparsomt. Ingen emoji. Ikke fet skrift på punktstarter.",
  "Engelske utviklerord som «deploy», «feature flag» og «PR» står som de er.",
];
