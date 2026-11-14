/** The first run, the climb (src/pages/welcome.ts, #417), and a pack's own setup pages (src/pages/setup.ts, #418): the pack draws each step, core draws the frame. */
import { coreTheme } from "../ui/themes.ts";
import { bugHref, PACK_ROUTE_MS } from "../app.ts";
import { type Config, configFromForm, saveConfig } from "../config.ts";
import { type App, fixedKeys } from "../env.ts";
import { html } from "../html.ts";
import { answersFrom, FORGES } from "../onboarding.ts";
import { guardHtml } from "../packs/guard.ts";
import { scanCheckouts } from "../packs/scan.ts";
import { type Answers, INTERVIEW, markersOf, QUESTIONS, ROLES, suggest } from "../packs/suggest.ts";
import type { Pack, Role } from "../packs/types.ts";
import { manifestSettings } from "../pages/packs.ts";
import { setupGo, setupPage, type SetupView } from "../pages/setup.ts";
import { type ClimbField, climbPage, type ClimbView, type KitTile, startingPage } from "../pages/welcome.ts";
import { strictOrigin } from "../strict.ts";
import { type Step, STEPS } from "../ui/climb.ts";
import type { Html } from "../ui/kit.ts";
import type { AppScope } from "./scope.ts";

export function welcomeRoutes(app: App, s: Pick<AppScope, "env" | "deps" | "hosted" | "packs" | "ctxOf" | "packLog" | "shown" | "layout" | "onboarding" | "page" | "noStore" | "keep" | "restarting" | "setupOf" | "setupLeft">) {
  const { env, deps, hosted, packs, ctxOf, packLog, shown, layout, onboarding, page, noStore, keep, restarting, setupOf, setupLeft } = s;
  // ── The first run, the climb (src/pages/welcome.ts, #417): Today sends here until it's finished or skipped ──
  const setUp = () => !!(env.SETUP_DONE || deps.config?.stored.SETUP_DONE || onboarding.get().done);
  /** Local: the folder and owners asked for on the way up, kept at the summit (they need a restart). */
  let pending: Config = {};
  let climbBad: string[] | undefined;
  const stepsOf = (role: Role | undefined): Step[] => STEPS.filter((s) => s !== "machine" || role !== "po");
  /** Every pack the kit offers: those that run here, and those that can't, with why. */
  const kitPacks = () => [...packs.on.map((p) => ({ m: p.manifest, off: undefined as string | undefined })), ...packs.off.filter((o) => o.manifest).map((o) => ({ m: o.manifest!, off: o.why }))];
  const climbDir = () => {
    return pending.CODE_DIR ?? deps.config?.stored.CODE_DIR ?? env.CODE_DIR;
  };
  /** The scan (local, after the role): which markers the checkouts have. */
  const scanNow = () => {
    const dir = hosted ? undefined : climbDir();
    if (!dir) return { dir, checkouts: 0, found: new Map<string, number>() };
    return { dir, ...scanCheckouts(dir, kitPacks().flatMap((k) => markersOf(k.m))) };
  };
  /** What's suggested at a step: only what was asked before it counts. */
  const suggestedAt = (step: Step, found: Map<string, number>) => {
    const o = onboarding.get();
    const steps = stepsOf(o.role);
    const i = steps.indexOf(step);
    const past = (s: Step) => steps.includes(s) && steps.indexOf(s) < i;
    const answers = { ...(past("q0") ? pick(o.answers, INTERVIEW[o.role!]?.[0]) : {}), ...(past("q1") ? pick(o.answers, INTERVIEW[o.role!]?.[1]) : {}) };
    return suggest(
      kitPacks().filter((k) => !k.off).map((k) => k.m),
      past("role") ? o.role : undefined,
      answers,
      past("machine") ? found.keys() : [],
    );
  };
  const pick = (a: Answers, qid: string | undefined): Answers => (qid && a[qid] !== undefined ? { [qid]: a[qid] } : {});
  /** The packs on at the summit: what was ticked, or else what's suggested. */
  const pickedNow = (found: Map<string, number>) => onboarding.get().picked ?? [...suggestedAt("summit", found).keys()];
  app.get("/welcome", async (c) => {
    if (deps.session) return c.notFound();
    await onboarding.ready;
    const started = c.req.query("started") === "1" ? restarting() : undefined;
    if (started) return c.html(startingPage((await page()).frame, started));
    const o = onboarding.get();
    const steps = stepsOf(o.role);
    const asked = c.req.query("at");
    let step: Step = steps.find((s) => s === asked) ?? "welcome";
    if (!o.role && step !== "welcome" && step !== "role") step = "role";
    const from = steps[steps.indexOf(step) - 1];
    const bad = climbBad;
    climbBad = undefined;
    const scan = step === "welcome" || step === "role" ? undefined : scanNow();
    const found = scan?.found ?? new Map<string, number>();
    const flagsAt = (s: Step | undefined) => (!s ? [] : s === "summit" || s === "packs" ? (s === "summit" ? pickedNow(found) : [...suggestedAt(s, found).keys()]) : [...suggestedAt(s, found).keys()]);
    const now = flagsAt(step);
    const before = new Set(flagsAt(from));
    const names = new Map(kitPacks().map((k) => [k.m.id, k.m.name]));
    const flags = now.filter((id) => names.has(id)).map((id) => ({ name: names.get(id)!, fresh: !before.has(id) }));
    const view: ClimbView = { step, from, flags, role: o.role, forge: o.forge, bad, look: { theme: coreTheme(layout.get().theme), accent: layout.get().accent, font: layout.get().font, motion: layout.get().motion } };
    const fixed = fixedKeys();
    const e = env as unknown as Record<string, string | undefined>;
    const field = (k: string): ClimbField => (fixed.has(k) ? { value: e[k] ?? "", fixed: true } : { value: pending[k] ?? deps.config?.stored[k] ?? e[k] ?? "", fixed: false });
    if (deps.config) {
      view.owners = field("REPO_OWNERS");
      view.codeDir = field("CODE_DIR");
    }
    let refresh: number | undefined;
    if (step === "machine") {
      if (hosted) {
        const online = (await deps.machines?.().catch(() => []))?.find((m) => m.online);
        const handle = /^([a-z0-9-]+)\.dovre\.dev$/i.exec(c.req.header("host")?.split(":")[0] ?? "")?.[1] ?? "<handle>";
        view.machine = { kind: "hosted", handle, online: online ? (online.name ?? "your laptop") : undefined };
        if (!online) refresh = 5;
      } else {
        const byMarker = new Map<string, string[]>();
        for (const k of kitPacks()) for (const mk of markersOf(k.m)) if (found.has(mk)) byMarker.set(mk, [...(byMarker.get(mk) ?? []), k.m.name]);
        view.machine = { kind: "local", dir: scan?.dir, checkouts: scan?.checkouts ?? 0, found: [...found].map(([marker, n]) => ({ marker, n, packs: byMarker.get(marker) ?? [] })) };
      }
    }
    if (step === "q0" || step === "q1") {
      const qid = INTERVIEW[o.role!][step === "q0" ? 0 : 1]!;
      const a = o.answers[qid];
      view.question = { q: QUESTIONS[qid]!, chosen: Array.isArray(a) ? a : a ? [a] : [] };
    }
    if (step === "packs") {
      const sug = suggestedAt("summit", found);
      const picked = o.picked ? new Set(o.picked) : undefined;
      const tiles = kitPacks().map((k): KitTile => ({ id: k.m.id, name: k.m.name, what: k.m.description, why: sug.get(k.m.id) ?? [], on: picked ? picked.has(k.m.id) : sug.has(k.m.id), off: k.off }));
      const on = new Set(tiles.filter((t) => t.on && !t.off).map((t) => t.id));
      const needs = kitPacks()
        .filter((k) => on.has(k.m.id))
        .map((k) => ({ id: k.m.id, name: k.m.name, keys: manifestSettings(k.m).filter((s) => s.required && !packs.env[s.key]?.trim()).map((s) => s.label) }))
        .filter((n) => n.keys.length);
      view.kit = { suggested: tiles.filter((t) => sug.has(t.id)), rest: tiles.filter((t) => !sug.has(t.id)), needs };
    }
    if (step === "summit") {
      const on = new Set(pickedNow(found));
      const k = kitPacks().filter((x) => !x.off && on.has(x.m.id));
      const later = k.flatMap((x) => {
        const p = packs.on.find((c) => c.manifest.id === x.m.id);
        const ob = p && setupOf(p);
        return ob ? [{ id: x.m.id, name: x.m.name, steps: ob.steps.map((s) => s.title) }] : [];
      });
      const online = hosted ? (await deps.machines?.().catch(() => []))?.some((m) => m.online) : true;
      view.summit = { on: k.map((x) => x.m.name), later, waits: hosted && !online, restarts: !!deps.restart && Object.keys(pending).length > 0 };
    }
    return noStore(await c.html(climbPage(view, steps, { refresh })));
  });
  const nextOf = (step: Step) => {
    const steps = stepsOf(onboarding.get().role);
    return `/welcome?at=${steps[Math.min(steps.length - 1, steps.indexOf(step) + 1)]}`;
  };
  /** A local text setting asked on the way: checked as Settings does, kept until the summit. */
  const askGeneral = (form: Record<string, unknown>, key: string) => {
    if (!deps.config || typeof form[key] !== "string") return;
    const { config, bad } = configFromForm({ [key]: form[key] }, { ...deps.config.stored, ...pending }, fixedKeys(), { general: true });
    if (bad.length) climbBad = bad;
    else if (config[key] !== (deps.config.stored[key] ?? undefined)) pending = { ...pending, [key]: config[key] ?? "" };
    else {
      const { [key]: _, ...rest } = pending;
      pending = rest;
    }
    return bad.length === 0;
  };
  app.post("/welcome/role", strictOrigin, async (c) => {
    if (deps.session) return c.notFound();
    await onboarding.ready;
    const f = await c.req.parseBody();
    const role = typeof f.role === "string" && Object.hasOwn(ROLES, f.role) ? (f.role as Role) : undefined;
    if (!role) return c.redirect("/welcome?at=role", 303);
    const forge = FORGES.find(([x]) => x === f.forge)?.[0] ?? "github";
    // A new role asks new questions: the old answers and picks no longer fit.
    await onboarding.update((was) => (was.role === role ? { ...was, forge } : { answers: {}, role, forge, done: was.done }));
    if (askGeneral(f, "REPO_OWNERS") === false) return c.redirect("/welcome?at=role", 303);
    return c.redirect(nextOf("role"), 303);
  });
  app.post("/welcome/machine", strictOrigin, async (c) => {
    if (deps.session || hosted) return c.notFound();
    askGeneral(await c.req.parseBody(), "CODE_DIR");
    return c.redirect("/welcome?at=machine", 303);
  });
  for (const step of ["q0", "q1"] as const)
    app.post(`/welcome/${step}`, strictOrigin, async (c) => {
      if (deps.session) return c.notFound();
      await onboarding.ready;
      const o = onboarding.get();
      if (!o.role) return c.redirect("/welcome?at=role", 303);
      const qid = INTERVIEW[o.role][step === "q0" ? 0 : 1]!;
      const f = await c.req.parseBody({ all: true });
      const a = [f.a ?? []].flat().filter((x): x is string => typeof x === "string");
      const answers = answersFrom({ ...o.answers, [qid]: QUESTIONS[qid]!.multi ? a : a[0] });
      if (!QUESTIONS[qid]!.multi && answers[qid] === undefined) return c.redirect(`/welcome?at=${step}`, 303);
      // New answers suggest anew: what was ticked before is forgotten.
      await onboarding.update((now) => ({ ...now, answers: answersFrom({ ...now.answers, [qid]: answers[qid] }), picked: undefined }));
      return c.redirect(nextOf(step), 303);
    });
  app.post("/welcome/packs", strictOrigin, async (c) => {
    if (deps.session) return c.notFound();
    await onboarding.ready;
    const f = await c.req.parseBody({ all: true });
    const can = new Set(packs.on.map((p) => p.manifest.id));
    const picked = [f.pack ?? []].flat().filter((x): x is string => typeof x === "string" && can.has(x));
    await onboarding.update((o) => ({ ...o, picked }));
    return c.redirect(nextOf("packs"), 303);
  });
  /** The summit's Open Today: the picked packs on and the rest off (Packs page), the folder and owners kept. */
  app.post("/welcome/done", strictOrigin, async (c) => {
    if (deps.session) return c.notFound();
    await onboarding.ready;
    // The summit's "Set up X": straight on to that pack's setup (#445).
    const asked = (await c.req.parseBody())["setup"];
    const then = typeof asked === "string" && setupPack(asked) ? `/setup/${asked}` : "/";
    const on = new Set(pickedNow(scanNow().found));
    const ids = packs.on.map((p) => p.manifest.id);
    await layout.update((l) => ({ ...l, packsOff: [...new Set([...(l.packsOff ?? []).filter((x) => !on.has(x)), ...ids.filter((x) => !on.has(x))])] }));
    await onboarding.update((o) => ({ ...o, picked: [...on], done: true }));
    deps.hub?.publish(["snapshot", "packs"]);
    if (!deps.config) return c.redirect(then, 303);
    const config: Config = { ...deps.config.stored, ...pending, SETUP_DONE: "1" };
    for (const [k, v] of Object.entries(pending)) if (v === "") delete config[k];
    const changed = Object.keys(pending).length > 0;
    pending = {};
    if (changed) return c.redirect((await keep(config)) ? "/welcome?started=1" : then, 303);
    await saveConfig(env.DB, config);
    deps.config.stored = config;
    return c.redirect(then, 303);
  });
  // ── A pack's own setup (src/pages/setup.ts, #418): the pack draws each step, core draws the frame ──
  /** A shown pack with a setup page, by id. */
  const setupPack = (id: string) => shown().find((c) => c.manifest.id === id && !!setupOf(c));
  /** A step as the pack draws it, in the time its pages get. One that throws, is late or breaks the rules is that pack's broken step. */
  const drawStep = async (c: Pack, step: string): Promise<{ body: Html; form: boolean; wait?: string; refresh?: number; go?: SetupView["go"]; carry?: boolean; broke?: string }> => {
    const ms = packs.routeMs ?? PACK_ROUTE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const log = packLog(c.manifest.id);
    try {
      const late = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`didn't answer in ${ms / 1000} s`)), ms)));
      const got = await Promise.race([Promise.resolve().then(() => c.setup!.draw(ctxOf(c), step)), late]);
      const body = await guardHtml(got?.body ?? "", c.manifest.name, `setup ${step}`, log);
      const form = got?.form === true;
      // A form step's inputs go with Next: a form inside it would be a form in a form.
      if (form && /<form[\s>]/i.test(String(body))) throw new Error("a form step's body holds a form of its own");
      const wait = typeof got?.wait === "string" && got.wait.trim() ? got.wait.trim().slice(0, 200) : undefined;
      const refresh = typeof got?.refresh === "number" && Number.isFinite(got.refresh) ? Math.min(60, Math.max(2, Math.round(got.refresh))) : undefined;
      const go = setupGo(c.manifest.id, got?.go);
      // The main button posts a form of its own: a form step's inputs would go nowhere.
      if (go && form) throw new Error("a form step has no main button of its own: Next sends its form");
      return { body: html`<div class="pack-box" data-pack="${c.manifest.id}">${body}</div>`, form, wait, refresh, ...(go ? { go, carry: got?.carry === true } : {}) };
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 300);
      log(`setup ${step}: ${why}`);
      return {
        body: html`<div class="climb-card"><p><b>${c.manifest.name} broke on this step.</b> The rest of Dovre is fine. The pack's log on <a href="/packs">Packs</a> says what happened. <a href="${bugHref(`/setup/${c.manifest.id}`, why, c.manifest.id)}">Report this</a> if it looks like a bug.</p></div>`,
        form: false,
        wait: "Come back once it's fixed.",
        broke: why,
      };
    } finally {
      clearTimeout(timer);
    }
  };
  /** A setup page at step `at` (`steps.length` is done), with what Next was refused for, if it was. */
  const setupView = async (p: Pack, at: number, error?: string, drawn?: Awaited<ReturnType<typeof drawStep>>): Promise<{ view: SetupView; status: 200 | 422 | 500 }> => {
    const { steps } = setupOf(p)!;
    const l = layout.get();
    const view: SetupView = { look: { theme: coreTheme(l.theme), accent: l.accent, font: l.font, motion: l.motion }, flags: shown().map((x) => ({ name: x.manifest.name, focus: x === p })), pack: { id: p.manifest.id, name: p.manifest.name }, steps, at, error };
    if (at >= steps.length) {
      // Done: the next pack whose setup isn't, in Today's order (#445).
      const next = shown().find((x) => x !== p && !!setupOf(x) && setupLeft(x).length > 0);
      return { view: { ...view, ...(next ? { next: { id: next.manifest.id, name: next.manifest.name } } : {}) }, status: 200 };
    }
    const d = drawn ?? (await drawStep(p, steps[at]!.id));
    Object.assign(view, { body: d.body, form: d.form, wait: d.wait, refresh: d.refresh, go: d.go, carry: d.carry });
    return { view, status: d.broke ? 500 : error ? 422 : 200 };
  };
  app.get("/setup/:id", async (c) => {
    if (deps.session) return c.notFound();
    const p = setupPack(c.req.param("id"));
    if (!p) return c.notFound();
    await onboarding.ready;
    const id = p.manifest.id;
    const { steps } = setupOf(p)!;
    const asked = c.req.query("at");
    const left = setupLeft(p);
    let at = asked === "done" ? steps.length : steps.findIndex((s) => s.id === asked);
    if (at < 0) at = left.length ? steps.findIndex((s) => s.id === left[0]!.id) : 0;
    const v = await setupView(p, at);
    return noStore(await c.html(setupPage(v.view), v.status));
  });
  app.post("/setup/:id/next", strictOrigin, async (c) => {
    if (deps.session) return c.notFound();
    const p = setupPack(c.req.param("id"));
    if (!p) return c.notFound();
    await onboarding.ready;
    const id = p.manifest.id;
    const { steps } = setupOf(p)!;
    const form = await c.req.parseBody({ all: true });
    const i = steps.findIndex((s) => s.id === form.step);
    if (i < 0) return c.redirect(`/setup/${id}`, 303);
    const step = steps[i]!;
    // Drawn again: a write it waits on may have finished, or not. Still waiting, the step says so itself.
    const d = await drawStep(p, step.id);
    if (d.wait || d.go) return c.redirect(`/setup/${id}?at=${step.id}`, 303);
    if (d.form && p.setup!.save) {
      const fields: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(form).slice(0, 50)) {
        if (k === "step") continue;
        const vs = ([] as unknown[]).concat(v).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 2000)).slice(0, 200);
        if (vs.length) fields[k] = vs.length === 1 ? vs[0]! : vs;
      }
      const r = await Promise.resolve()
        .then(() => p.setup!.save!(ctxOf(p), step.id, fields))
        .catch((e: unknown): { ok: false; error: string } => {
          packLog(id)(`setup ${step.id} save: ${(e as Error)?.message ?? e}`);
          return { ok: false, error: `${p.manifest.name} couldn't keep that. Its log on Packs says why.` };
        });
      // Refused: the step again, drawn in this answer. Hosted, a redirect's GET can land on another isolate (#446).
      if (!r || r.ok !== true) {
        const v = await setupView(p, i, (typeof r?.error === "string" && r.error ? r.error : "Not kept.").slice(0, 300), d);
        return noStore(await c.html(setupPage(v.view), v.status));
      }
    }
    await onboarding.update((o) => ({ ...o, setup: { ...o.setup, [id]: [...new Set([...(o.setup?.[id] ?? []), step.id])] } }));
    deps.hub?.publish(["snapshot", id]);
    const next = steps[i + 1];
    return c.redirect(`/setup/${id}?at=${next ? next.id : "done"}`, 303);
  });
  app.post("/welcome/skip", strictOrigin, async (c) => {
    if (deps.session) return c.notFound();
    await onboarding.ready;
    await onboarding.update((o) => ({ ...o, done: true }));
    pending = {};
    if (deps.config) {
      await saveConfig(env.DB, { ...deps.config.stored, SETUP_DONE: "1" });
      deps.config.stored = { ...deps.config.stored, SETUP_DONE: "1" };
    }
    return c.redirect("/", 303);
  });
  return { setUp };
}
