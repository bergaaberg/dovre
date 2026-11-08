/**
 * The first run (#417, epic #386): the climb. One thing at a time over the night ridge: what Dovre
 * is, your role and where code lives, your machine, two questions, your kit, the summit. Each step
 * is a form of its own that saves and moves on, so it works without script, and Skip is always
 * there. Today sends here until it's finished or skipped; Settings and Packs change any of it later.
 */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import { PageHeader } from "../ui/kit.ts";
import { restartingNote } from "./settings.ts";
import type { ForgeChoice } from "../onboarding.ts";
import { FORGES } from "../onboarding.ts";
import type { Question } from "../packs/suggest.ts";
import { ROLES } from "../packs/suggest.ts";
import type { Role } from "../packs/types.ts";
import { climbArt, type Flag, type Step } from "../ui/climb.ts";
import { MARK } from "../ui/splash.ts";
import { STYLE_PATH } from "../ui/style.ts";

/** What each role's day is like, under its name. */
const DAYS: Record<Role, string> = { dev: "PRs, reviews, agents", lead: "What moved, what's stuck", po: "Roadmap, releases, feedback", op: "Deploys, health, on-call", an: "Data, queries, boards" };
/** How high each step is, in metres, on the way up Snøhetta. */
const ALT: Record<Step, number> = { welcome: 1020, role: 1240, machine: 1510, q0: 1760, q1: 1980, packs: 2160, summit: 2286 };
const EYEBROW: Partial<Record<Step, string>> = { role: "Trailhead", machine: "Treeline", q0: "One of two", q1: "Two of two", packs: "The ridge", summit: "Snøhetta · 2 286 m" };
const metres = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} m`;

/** A text setting the climb asks for (local): its value, and whether .dev.vars fixes it. */
export type ClimbField = { value: string; fixed: boolean };
export type KitTile = { id: string; name: string; what: string; why: string[]; on: boolean; /** Why it can't run here: not offered. */ off?: string };

export type ClimbView = {
  step: Step;
  /** The step before this one, where the scene starts from. */
  from?: Step;
  look?: Frame["look"];
  flags: Flag[];
  role?: Role;
  forge?: ForgeChoice;
  /** Local only: the owners to track, and the code folder. */
  owners?: ClimbField;
  codeDir?: ClimbField;
  /** What a refused field was. */
  bad?: string[];
  machine?: { kind: "local"; dir?: string; checkouts: number; found: { marker: string; n: number; packs: string[] }[] } | { kind: "hosted"; handle: string; online?: string };
  question?: { q: Question; chosen: string[] };
  kit?: { suggested: KitTile[]; rest: KitTile[]; needs: { id: string; name: string; keys: string[] }[] };
  summit?: { on: string[]; later: { id: string; name: string; steps: string[] }[]; waits: boolean; restarts: boolean };
};

const arrow = html`<span aria-hidden="true">→</span>`;
const top = (step: Step) => html`<div class="climb-top"><span class="climb-mark">${MARK}Dovre</span><span class="climb-alt">${metres(ALT[step])}</span></div>`;
const eyebrow = (step: Step) => (EYEBROW[step] ? html`<div class="climb-eyebrow">${EYEBROW[step]}</div>` : "");
const skip = html`<form method="post" action="/welcome/skip"><button type="submit" class="climb-link">Skip setup</button></form>`;
const back = (to: Step) => html`<a class="climb-link" href="/welcome?at=${to}">Back</a>`;

function welcome(v: ClimbView) {
  return html`${top(v.step)}
<h1>Dovre</h1>
<p class="climb-lede">Your work on one page. What needs you, what moved, what's on fire.</p>
<p class="climb-small">Packs bring in each part. Bino, the assistant, knows what they know. A minute to set up; Settings changes any of it later.</p>
<div class="climb-row"><a class="climb-go" href="/welcome?at=role">Let's climb ${arrow}</a>${skip}</div>`;
}

function role(v: ClimbView) {
  const forge = v.forge ?? "github";
  const owners = v.owners;
  return html`${top(v.step)}${eyebrow(v.step)}
<h2>What's your day like?</h2>
<p class="climb-small">Pick the closest. It only chooses your starting packs.</p>
<form method="post" action="/welcome/role">
<div class="climb-opts" role="radiogroup" aria-label="Your role">${(Object.keys(ROLES) as Role[]).map(
    (k, i) => html`<label class="climb-opt"><input type="radio" name="role" value="${k}"${v.role === k ? " checked" : ""} required><span class="climb-k">${i + 1}</span><span class="climb-l">${ROLES[k]}</span><span class="climb-s">${DAYS[k]}</span></label>`,
  )}</div>
<div class="climb-inline" role="radiogroup" aria-label="Where code lives"><span>Code lives on</span><span class="climb-chips">${FORGES.map(([f, l]) => html`<label class="climb-chip"><input type="radio" name="forge" value="${f}"${forge === f ? " checked" : ""}>${l}</label>`)}</span></div>
${owners ? html`<div class="climb-inline"><label for="climb-owners">Orgs or groups</label><input class="climb-in" id="climb-owners" name="REPO_OWNERS" value="${owners.value}" placeholder="my-org, my-user" autocomplete="off"${owners.fixed ? " disabled" : ""}>${owners.fixed ? html`<span class="climb-small">set in .dev.vars</span>` : ""}</div>` : ""}
${v.bad?.length ? html`<p class="climb-small">Not kept: ${v.bad.join(", ")}.</p>` : ""}
<div class="climb-row"><button type="submit" class="climb-go">Next ${arrow}</button>${back("welcome")}</div>
</form>`;
}

function machine(v: ClimbView, next: Step) {
  const m = v.machine;
  if (m?.kind === "hosted") {
    const cmd = (c: string) => html`<div class="climb-cmd"><code>${c}</code></div>`;
    return html`${top(v.step)}${eyebrow(v.step)}
<h2>${m.online ? html`Hi, ${m.online}.` : "Bring your laptop?"}</h2>
<p class="climb-small">Agents and terminals run there. It dials out, so nothing opens up. Skip it and those wait.</p>
${m.online ? "" : html`${cmd(`dovre bridge login ${m.handle}`)}${cmd("dovre bridge install")}`}
<div class="climb-listen"><i class="climb-beacon${m.online ? " on" : ""}"></i>${m.online ? "Connected." : "Listening for it…"}</div>
<div class="climb-row"><a class="climb-go" href="/welcome?at=${next}">${m.online ? "Nice" : "Later"} ${arrow}</a>${back("role")}</div>`;
  }
  const dir = v.codeDir;
  const found = m?.kind === "local" ? m : undefined;
  return html`${top(v.step)}${eyebrow(v.step)}
<h2>Peeking at your repos.</h2>
<p class="climb-small">${found?.dir ? html`${found.checkouts} checkout${found.checkouts === 1 ? "" : "s"} in ${found.dir}.` : "No code folder yet."} File names only, never what's in them.</p>
${found?.found.length ? html`<ul class="climb-scan">${found.found.map((x) => html`<li><span><code>${x.marker}</code> <span class="climb-small">× ${x.n}</span></span><span>${x.packs.join(", ")}</span></li>`)}</ul>` : found?.dir ? html`<p class="climb-small">Nothing a pack looks for. Fine too.</p>` : ""}
${dir ? html`<form method="post" action="/welcome/machine"><div class="climb-inline"><label for="climb-dir">Code folder</label><input class="climb-in" id="climb-dir" name="CODE_DIR" value="${dir.value}" placeholder="~/src" autocomplete="off"${dir.fixed ? " disabled" : ""}>${dir.fixed ? html`<span class="climb-small">set in .dev.vars</span>` : html`<button type="submit" class="climb-link">Look there</button>`}</div></form>` : ""}
${v.bad?.length ? html`<p class="climb-small">Not kept: ${v.bad.join(", ")}.</p>` : ""}
<div class="climb-row"><a class="climb-go" href="/welcome?at=${next}">Nice ${arrow}</a>${back("role")}</div>`;
}

function question(v: ClimbView, prev: Step) {
  const { q, chosen } = v.question!;
  const at = v.step;
  if (!q.multi)
    return html`${top(at)}${eyebrow(at)}
<h2>${q.q}</h2>
<p class="climb-small">Pick one.</p>
<form method="post" action="/welcome/${at}">
<div class="climb-opts" role="group" aria-label="${q.q}">${q.opts.map((o, i) => html`<button type="submit" name="a" value="${o.v}" class="climb-opt${chosen.includes(o.v) ? " on" : ""}"><span class="climb-k">${i + 1}</span><span class="climb-l">${o.l}</span></button>`)}</div>
<div class="climb-row">${back(prev)}</div>
</form>`;
  return html`${top(at)}${eyebrow(at)}
<h2>${q.q}</h2>
<p class="climb-small">Any that fit, or none.</p>
<form method="post" action="/welcome/${at}">
<div class="climb-opts" role="group" aria-label="${q.q}">${q.opts.map((o, i) => html`<label class="climb-opt"><input type="checkbox" name="a" value="${o.v}"${chosen.includes(o.v) ? " checked" : ""}><span class="climb-k">${i + 1}</span><span class="climb-l">${o.l}</span></label>`)}</div>
<input type="hidden" name="multi" value="1">
<div class="climb-row"><button type="submit" class="climb-go">Next ${arrow}</button>${back(prev)}</div>
</form>`;
}

const tile = (t: KitTile) =>
  html`<label class="climb-tile"><input type="checkbox" name="pack" value="${t.id}"${t.on && !t.off ? " checked" : ""}${t.off ? " disabled" : ""}><b>${t.name}</b><small>${t.what}</small>${t.off ? html`<span class="climb-no">${t.off}</span>` : t.why.length ? html`<span class="climb-why">${t.why.join(" · ")}</span>` : ""}</label>`;

function packs(v: ClimbView, prev: Step) {
  const k = v.kit!;
  const on = [...k.suggested, ...k.rest].filter((t) => t.on && !t.off).length;
  return html`${top(v.step)}${eyebrow(v.step)}
<h2>Your kit.</h2>
<p class="climb-small">${on} pack${on === 1 ? "" : "s"}, one flag each. Tick to swap.</p>
<form method="post" action="/welcome/packs">
<input type="hidden" name="kit" value="1">
${k.suggested.length ? html`<fieldset class="climb-kit"><legend class="climb-small">Picked for you</legend>${k.suggested.map(tile)}</fieldset>` : html`<p class="climb-small">Nothing stood out. Pick what you like.</p>`}
${k.rest.length ? html`<details class="climb-more"${k.suggested.length ? "" : " open"}><summary>${k.rest.length} more pack${k.rest.length === 1 ? "" : "s"}</summary><div class="climb-kit">${k.rest.map(tile)}</div></details>` : ""}
${k.needs.length ? html`<div class="climb-card"><h3>What they need</h3><ul class="climb-later">${k.needs.map((n) => html`<li><b>${n.name}</b> · ${n.keys.join(", ")} · <a href="/settings/packs/${n.id}">set it</a></li>`)}</ul><p class="climb-small">Skip any. That pack says so on Packs until it's set.</p></div>` : ""}
<div class="climb-row"><button type="submit" class="climb-go">To the top ${arrow}</button>${back(prev)}</div>
</form>`;
}

function summit(v: ClimbView) {
  const s = v.summit!;
  const n = s.on.length;
  return html`${top(v.step)}${eyebrow(v.step)}
<h2>You made it.</h2>
<p class="climb-lede">${n} flag${n === 1 ? "" : "s"} on the ridge. Today's ready${s.restarts ? " once Dovre restarts, in a few seconds" : ""}.</p>
${s.waits ? html`<p class="climb-small">What runs on your laptop waits for it.</p>` : ""}
${s.later.length ? html`<div class="climb-card"><h3>A little more, when you get there</h3><p class="climb-small">These packs have a short setup of their own. Today lists them until they're done.</p><ul class="climb-later">${s.later.map((l) => html`<li><a href="/setup/${l.id}"><b>${l.name}</b></a> · ${l.steps.join(", ").toLowerCase()}</li>`)}</ul></div>` : ""}
<div class="climb-row"><form method="post" action="/welcome/done"><button type="submit" class="climb-go">Open Today ${arrow}</button></form><a class="climb-link" href="/welcome?at=role">Climb again</a></div>
<p class="climb-small">Fonts, colours and the rest are under Settings → Look.</p>`;
}

/** The climb at `v.step`, in a page of its own (no menu). `steps` is this role's way up. */
export function climbPage(v: ClimbView, steps: Step[], o: { refresh?: number } = {}) {
  const i = steps.indexOf(v.step);
  const prev = steps[Math.max(0, i - 1)]!;
  const next = steps[Math.min(steps.length - 1, i + 1)]!;
  const body =
    v.step === "welcome" ? welcome(v) : v.step === "role" ? role(v) : v.step === "machine" ? machine(v, next) : v.step === "q0" || v.step === "q1" ? question(v, prev) : v.step === "packs" ? packs(v, prev) : summit(v);
  return climbDoc({ title: "Set up · Dovre", look: v.look, scene: climbArt(v.step, v.flags, v.from), body, refresh: o.refresh });
}

/** A page of the climb's kind (no menu): the scene behind, one column over it. The setup pages (#418) are one too. */
export function climbDoc(o: { title: string; look?: Frame["look"]; scene: unknown; body: unknown; refresh?: number }) {
  const l = o.look ?? {};
  return html`<!doctype html>
<html lang="en"${l.theme ? html` data-theme="${l.theme}"` : ""}${l.accent ? html` data-accent="${l.accent}"` : ""}${l.motion ? html` data-motion="${l.motion}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${o.title}</title>
<link rel="stylesheet" href="${STYLE_PATH}">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<meta name="theme-color" content="#0e1922">${o.refresh ? html`
<meta http-equiv="refresh" content="${o.refresh}">` : ""}
</head>
<body class="climb-page">
<div class="climb-scene">${o.scene}</div>
<main class="climb"><div class="climb-col">${o.body}</div></main>
</body>
</html>`;
}

/** After the summit, locally: Dovre starts again with the new folder or owners, and Today opens when it's up. */
export function startingPage(frame: Frame, started: number) {
  return shell({ title: "Starting · Dovre", frame, current: "/welcome", body: html`${PageHeader({ title: "Starting Dovre" })}${restartingNote(started, "/", "Saved. Dovre is starting again with your choices; Today opens when it's up.")}` });
}
