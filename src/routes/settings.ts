/** Settings (what's here, the panes, notifications, keys, writes, ingest tokens) and the Packs page (switch, update, add, a pack's settings and keys). */
import { proposeAdd } from "../actions/addpack.ts";
import { actionsOf, logAction } from "../actions/deploys.ts";
import { TOOLS_HARNESSES, type ToolsHarness } from "../agents/mcpsetup.ts";
import { type Config, configFromForm, saveConfig } from "../config.ts";
import { type App, type AppEnv, fixedKeys } from "../env.ts";
import { type Frame, html, tabsOf } from "../html.ts";
import { DEFAULT_KEYS, KEY_GROUPS } from "../keys.ts";
import { type Layout, layoutFromForm } from "../layout.ts";
import { policyOf, RING_KINDS } from "../notify.ts";
import type { ToAdd } from "../packs/copies.ts";
import { createToken, listTokens, revokeToken, sourceOk, tokensPanel } from "../packs/ingest.ts";
import { fillsOf, missingWhy, settingsFrom, settleRequires, startPack } from "../packs/registry.ts";
import type { Listed } from "../packs/releases.ts";
import type { Pack, PackManifest } from "../packs/types.ts";
import { callsPanels } from "../pages/calls.ts";
import { CORE_CARDS, packOrder } from "../pages/home.ts";
import { keysPanel } from "../pages/keys.ts";
import { layoutPanel, type LayoutView, LOOK_KEYS, lookPanel } from "../pages/layout.ts";
import { aiAskOf, grantOf } from "../packs/ai.ts";
import { aiPanel, manifestPanel, manifestSettings, packsPage } from "../pages/packs.ts";
import { sentPanels, type SentView } from "../pages/sent.ts";
import { agentToolsPanel, type AgentToolsView, appPanel, type AreaId, AREAS, edgePath, isArea, longTurnPanel, notifyPanels, type PackSettings, packsList, sessionSettings, settingRows, settingsArea, settingsHome, type SettingsNotes, setupLines, setupPanel, workPanel } from "../pages/settings.ts";
import { speedPanels } from "../pages/speed.ts";
import { statOffers } from "../pages/stats.ts";
import { writesPanel } from "../pages/writes.ts";
import { quietOf } from "../quiet.ts";
import { CATALOG } from "../sent.ts";
import { removeDevVar, upsertDevVar } from "../setup.ts";
import { listRepos } from "../sources/claude.ts";
import { strictOrigin } from "../strict.ts";
import { found } from "../tools.ts";
import { type Html, Notice, Panel } from "../ui/kit.ts";
import { currentViewer } from "../viewer.ts";
import { writeKinds } from "../writes.ts";
import type { Context } from "hono";
import type { AppScope } from "./scope.ts";

export function settingsRoutes(app: App, s: Pick<AppScope, "publicOrigin" | "refreshes" | "env" | "deps" | "hosted" | "packs" | "ctxOf" | "packLog" | "shown" | "layout" | "onboarding" | "page" | "noStore" | "setupOf" | "setupLeft" | "speed" | "ghe" | "forge" | "clicks" | "aiStore" | "aiAsk" | "keyPrefs" | "openUrl" | "held" | "hidden" | "packIds" | "envSeen" | "bindingsSeen" | "packCards" | "packRings" | "packStats" | "runPackRefresh" | "instanceRepo" | "opening" | "releases" | "packsGet">) {
  const { publicOrigin, refreshes, env, deps, hosted, packs, ctxOf, packLog, shown, layout, onboarding, page, noStore, setupOf, setupLeft, speed, ghe, forge, clicks, aiStore, aiAsk, keyPrefs, openUrl, held, hidden, packIds, envSeen, bindingsSeen, packCards, packRings, packStats, runPackRefresh, instanceRepo, opening, releases, packsGet } = s;
  // ── Settings: what's here, the panes (src/config.ts), notifications ──
  let saved = false;
  /** Set when a save restarts Dovre: when this server started, so the page knows when the next one is up. */
  let restarting: number | undefined;
  let settingsBad: string[] | undefined;
  const startedAt = deps.info?.startedAt ?? Date.now();
  const setupNow = (login: string) =>
    setupLines({
      ghe: { host: env.GHE_HOST, org: env.GHE_ORG, login },
      claude: found.paths?.claude,
      omp: found.paths?.omp,
      copilot: found.copilot,
      copilotCli: found.paths?.copilot,
      edge: edgePath(),
      codeDir: env.CODE_DIR,
      repos: listRepos(env.CODE_DIR).length,
      publicOrigin,
    });
  /** Kept, then (under the supervisor) Dovre starts again with it. */
  const keep = async (config: Config) => {
    await saveConfig(env.DB, config);
    deps.config!.stored = config;
    if (!deps.restart) return false;
    restarting = startedAt;
    setTimeout(() => deps.restart?.(), 300);
    return true;
  };
  /** What the Work form shows: what Settings keeps, and what .dev.vars or the environment fixes. */
  const panesView = () => {
    if (!deps.config) return undefined;
    const fixed = fixedKeys();
    const e = env as unknown as Record<string, string | undefined>;
    const values: Record<string, string | undefined> = { ...deps.config.stored, CODE_DIR: deps.config.stored.CODE_DIR ?? env.CODE_DIR };
    for (const k of fixed) values[k] = e[k];
    return { values, fixed };
  };
  /** Settings → Layout: what can be arranged here, and where it is now. */
  const layoutView = async (frame: Frame): Promise<LayoutView> => {
    const l = layout.get();
    const packNow = shown().length ? (await packCards()).cards : [];
    const packLabel = (id: string) => {
      const pack = packs.on.find((c) => id.startsWith(`${c.manifest.id}-`));
      if (!pack) return id;
      const n = packNow.filter((x) => x.id.startsWith(`${pack.manifest.id}-`)).length;
      return n > 1 ? `${pack.manifest.name} · ${id.slice(pack.manifest.id.length + 1)}` : pack.manifest.name;
    };
    const placed = (id: string, col: "left" | "right", order: number) => ({ col: l.cards?.[id]?.col ?? col, order: l.cards?.[id]?.order ?? order });
    return {
      layout: l,
      pages: frame.nav.filter((p) => p.href !== "/" && p.place !== "action").map((p) => ({ href: p.href, title: p.title })),
      tabs: tabsOf(frame.nav).map((p) => p.href).filter((h) => h !== "/"),
      cards: [
        ...CORE_CARDS.map((c) => ({ id: c.id, label: c.label, ...placed(c.id, c.col, c.order) })),
        ...packNow.map((c) => ({ id: c.id, label: packLabel(c.id), ...placed(c.id, c.column === "left" ? "left" : "right", packOrder(c.order)) })),
      ],
      feeds: packs.on.filter((c) => c.feed).map((c) => ({ id: c.manifest.id, name: c.manifest.name })),
      packs: packs.on.map((c) => ({ id: c.manifest.id, name: c.manifest.name })),
      opener: !!openUrl,
      stats: statOffers(packStats()).map((o, i) => ({ id: o.id, label: o.label, from: o.from, show: l.stats?.[o.id]?.show ?? true, order: l.stats?.[o.id]?.order ?? (i + 1) * 10 })),
    };
  };
  /** Look's keys of a Layout (`look`), or the rest. */
  const partOf = (l: Layout, look: boolean) => Object.fromEntries(Object.entries(l).filter(([k]) => (LOOK_KEYS as string[]).includes(k) === look)) as Layout;
  // Look and Layout each post their `part`; the other part stays as it was. No part: the whole of it.
  app.post("/settings/layout", async (c) => {
    const { frame } = await page();
    const v = await layoutView(frame);
    const form = await c.req.parseBody({ all: true });
    const next = layoutFromForm(form, { hrefs: v.pages.map((p) => p.href), cards: v.cards.map((x) => x.id), feeds: v.feeds.map((f) => f.id), packs: v.packs.map((x) => x.id), stats: v.stats.map((x) => x.id) });
    // Cards not drawn and stats not offered just now (a pack hidden or slow) keep where I put them.
    const part = form.part;
    await layout.update((l) => {
      const whole = { ...next, cards: { ...l.cards, ...next.cards }, stats: { ...l.stats, ...next.stats } };
      return part === "look" ? { ...partOf(l, false), ...partOf(next, true) } : part === "layout" ? { ...partOf(l, true), ...partOf(whole, false) } : whole;
    });
    saved = true;
    deps.hub?.publish(["snapshot", "packs"]);
    return c.redirect(part === "look" ? "/settings/look" : "/settings/layout", 303);
  });
  app.post("/settings/layout/reset", async (c) => {
    const part = (await c.req.parseBody()).part;
    if (part === "look" || part === "layout") await layout.update((l) => partOf(l, part === "layout"));
    else await layout.reset();
    saved = true;
    deps.hub?.publish(["snapshot", "packs"]);
    return c.redirect(part === "look" ? "/settings/look" : "/settings/layout", 303);
  });
  app.get("/packs", async (c) => {
    const { frame } = await page();
    const local = hosted ? undefined : deps.packs?.copies;
    const copies = local?.get();
    const reading = releases?.refresh();
    if (reading)
      try {
        c.executionCtx.waitUntil(reading);
      } catch {}
    const here = packIds();
    const toAdd = local ? { packs: local.listed().filter((p) => !here.includes(p.id)), into: local.target() } : releases?.get() ? { packs: await hostedAdds(releases.get()!.listed), into: instanceRepo() ?? undefined } : undefined;
    const setups = new Map(packs.on.flatMap((x) => (setupOf(x) ? [[x.manifest.id, setupLeft(x).length > 0] as const] : [])));
    return c.html(packsPage(frame, { forge: forge.name, setups, on: packs.on, off: packs.off, env: packs.env, alsoReads: envSeen.of, bindingsAsked: bindingsSeen.of, fills: (p) => fillsOf(p, ctxOf, (id, line) => packLog(id)(line)), keys: packs.keys?.state, hosted, refreshes, core: packs.core, copies, releases: releases?.get(), canRestart: !!deps.restart, hidden: layout.get().packsOff ?? [], held: held(), toAdd }));
  });
  /** A pack's one switch (#271): on or off here, the same as Settings → Layout's list. No restart. */
  app.post("/packs/:id/switch", strictOrigin, async (c) => {
    const id = c.req.param("id");
    if (!packs.on.some((p) => p.manifest.id === id)) return c.notFound();
    const on = (await c.req.parseBody()).on === "1";
    await layout.update((l) => {
      const was = l.packsOff ?? [];
      return { ...l, packsOff: on ? was.filter((x) => x !== id) : [...new Set([...was, id])] };
    });
    deps.hub?.publish(["snapshot", "packs"]);
    return c.redirect(`/packs#pack-${encodeURIComponent(id)}`, 303);
  });
  app.post("/packs/:id/update", strictOrigin, async (c) => {
    const copies = deps.packs?.copies;
    if (hosted || !copies) return c.notFound();
    const id = c.req.param("id");
    const r = copies.update(id, (ok, detail) => void logAction(env.DB, { kind: "packs.update", target: id, detail, ok }).catch(() => {}));
    if (!r.ok) await logAction(env.DB, { kind: "packs.update", target: id, ok: false, error: r.why }).catch(() => {});
    deps.hub?.publish(["packs"]);
    return c.redirect(`/packs#pack-${encodeURIComponent(id)}`, 303);
  });
  /** Hosted: each pack to add, with its newest Add from the log (the PR it opened, or why not) or one opening now. */
  async function hostedAdds(listed: Listed[]): Promise<ToAdd[]> {
    const log = await actionsOf(env.DB, "packs.add").catch(() => []);
    return listed.map((l) => {
      if (opening.has(l.id)) return { ...l, job: { at: Date.now(), state: "running" as const, step: "opening a PR" } };
      const a = log.find((x) => x.target === l.id);
      if (!a) return l;
      const at = Date.parse(a.at);
      return { ...l, job: a.ok ? { at, state: "done" as const, step: "PR opened; merge it, then deploy", url: a.detail ?? undefined } : { at, state: "failed" as const, step: a.error ?? "failed" } };
    });
  }
  /** Add (#88): a pack from dovre-packs this instance doesn't list; locally a job on the copies, hosted a PR on the instance repo. */
  app.post("/packs/:id/add", strictOrigin, async (c) => {
    const id = c.req.param("id");
    if (packIds().includes(id)) return c.redirect(`/packs#pack-${encodeURIComponent(id)}`, 303);
    if (hosted) {
      const repo = instanceRepo();
      const l = releases?.get()?.listed.find((x) => x.id === id);
      if (!repo || !l) return c.notFound();
      if (opening.has(id)) return c.redirect(`/packs#add-${encodeURIComponent(id)}`, 303);
      opening.add(id);
      const work = proposeAdd(ghe, packsGet, { repo, id })
        .then(
          (pr) => logAction(env.DB, { kind: "packs.add", target: id, detail: pr.url, ok: true }),
          (e: unknown) => logAction(env.DB, { kind: "packs.add", target: id, ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }),
        )
        .catch(() => {})
        .finally(() => {
          opening.delete(id);
          deps.hub?.publish(["packs"]);
        });
      try {
        c.executionCtx.waitUntil(work);
      } catch {}
      deps.hub?.publish(["packs"]);
      return c.redirect(`/packs#add-${encodeURIComponent(id)}`, 303);
    }
    const copies = deps.packs?.copies;
    if (!copies) return c.notFound();
    const r = copies.add(id, (ok, detail) => void logAction(env.DB, { kind: "packs.add", target: id, detail, ok }).catch(() => {}));
    if (!r.ok) await logAction(env.DB, { kind: "packs.add", target: id, ok: false, error: r.why }).catch(() => {});
    deps.hub?.publish(["packs"]);
    return c.redirect(`/packs#add-${encodeURIComponent(id)}`, 303);
  });
  /** After its settings changed: off for a required one missing (or unread), on (and started) once they're all there. */
  const settleSettings = async (id: string) => {
    const onPack = packs.on.find((x) => x.manifest.id === id);
    const offEntry = packs.off.find((x) => x.id === id);
    const manifest = onPack?.manifest ?? offEntry?.manifest;
    if (!manifest) return;
    const missing = manifestSettings(manifest).find((s) => s.required && !packs.env[s.key]?.trim());
    const why = missing && missingWhy(missing.key, packs.keys?.unread());
    if (onPack && why) {
      packs.on.splice(packs.on.indexOf(onPack), 1);
      packs.off.push({ id, name: manifest.name, why, manifest, pack: onPack });
      settleRequires(packs);
    } else if (offEntry?.pack && !offEntry.needs && !why) {
      const p = offEntry.pack;
      packs.off.splice(packs.off.indexOf(offEntry), 1);
      packs.on.push(p);
      // It, and what was off only for want of it (#326), start in order: each after what it requires.
      const starting = [p, ...settleRequires(packs)];
      for (const q of [...packs.on]) {
        if (!starting.includes(q) || !packs.on.includes(q)) continue;
        const failed = await startPack(q, ctxOf, (l) => console.log(l));
        if (failed) {
          packs.on.splice(packs.on.indexOf(q), 1);
          packs.off.push({ id: q.manifest.id, name: q.manifest.name, why: failed, manifest: q.manifest });
          settleRequires(packs);
        }
      }
      for (const q of starting) if (packs.on.includes(q)) void runPackRefresh.one(q);
    } else if (offEntry && why) {
      offEntry.why = why;
      // Off for its settings now, not only for a pack it requires: it waits for them first.
      delete offEntry.needs;
    } else if (onPack) {
      void runPackRefresh.one(onPack);
    }
  };
  app.post("/packs/:id/settings", strictOrigin, async (c) => {
    if (hosted) return c.notFound();
    const id = c.req.param("id");
    const manifest = packs.on.find((x) => x.manifest.id === id)?.manifest ?? packs.off.find((x) => x.id === id)?.manifest;
    const settings = manifestSettings(manifest);
    if (!manifest || !settings.length) return c.notFound();
    const body = await c.req.parseBody();
    const keys = packs.keys;
    for (const s of settings) {
      const val = body[s.key];
      const raw = typeof val === "string" ? val.replace(/[\r\n]+/g, " ").trim().slice(0, 2000) : "";
      // A setting with choices keeps only one of them (API 1.15); anything else leaves it as it was.
      if (s.choices && raw && !s.choices.some((x) => x.value === raw)) continue;
      if (s.secret) {
        // A reference is kept and read; a pasted key goes to the Keychain on a Mac (#416).
        if (body[`clear.${s.key}`] === "1") {
          if (keys) await keys.clear(s.key);
          else {
            delete packs.env[s.key];
            if (packs.varsFile) removeDevVar(packs.varsFile, s.key);
          }
        } else if (raw) {
          if (keys) await keys.save(s.key, raw);
          else {
            packs.env[s.key] = raw;
            if (packs.varsFile) upsertDevVar(packs.varsFile, s.key, raw);
          }
        }
      } else if (raw) {
        packs.env[s.key] = raw;
        if (packs.varsFile) upsertDevVar(packs.varsFile, s.key, raw);
      } else {
        delete packs.env[s.key];
        if (packs.varsFile) removeDevVar(packs.varsFile, s.key);
      }
    }
    await settleSettings(id);
    saved = true;
    deps.hub?.publish([id, "packs", "snapshot"]);
    return c.redirect(`/settings/packs/${encodeURIComponent(id)}`, 303);
  });
  // Read again (#416): its keys from their stores, then on or off as they came back.
  app.post("/packs/:id/keys", strictOrigin, async (c) => {
    const id = c.req.param("id");
    const manifest = packs.on.find((x) => x.manifest.id === id)?.manifest ?? packs.off.find((x) => x.id === id)?.manifest;
    const secret = manifestSettings(manifest).filter((s) => s.secret && packs.keys?.state(s.key));
    if (!packs.keys || !secret.length) return c.notFound();
    await packs.keys.read(secret.map((s) => s.key));
    await settleSettings(id);
    deps.hub?.publish([id, "packs", "snapshot"]);
    return c.redirect(`/settings/packs/${encodeURIComponent(id)}`, 303);
  });

  /** A pack's own Settings panel, with core's ingest tokens when it takes ingest (dovre#109). */
  const ownPanel = async (p: Pack, made?: { pack: string; source: string; token: string }): Promise<Html | undefined> => {
    const id = p.manifest.id;
    const mine = settingsFrom([p], ctxOf, (pid, line) => packLog(pid)(line))[0]?.body;
    if (!p.ingest) return mine;
    const tokens = tokensPanel(p, await listTokens(env.DB, id).catch(() => []), { hosted, made: made?.pack === id ? made : undefined });
    return html`${mine ?? ""}${tokens}`;
  };
  /** The packs with settings: their manifest's, their own panel, or ingest tokens. Off ones too: one may be off for want of a setting. */
  const packSettings = (): PackSettings[] => {
    const set = (m: PackManifest | undefined) => manifestSettings(m).map((x) => ({ key: x.key, label: x.label, set: !!packs.env[x.key]?.trim() }));
    // A pack's own panel counts when it draws something (an empty answer or a throw: none).
    const own = new Set(settingsFrom(shown(), ctxOf, (id, line) => packLog(id)(line)).map((x) => x.id));
    return [
      ...shown().map((p) => ({ id: p.manifest.id, name: p.manifest.name, on: true, settings: set(p.manifest), panel: own.has(p.manifest.id) || !!p.ingest || !!aiAskOf(p.manifest) })),
      ...packs.on.filter((p) => hidden(p.manifest.id)).map((p) => ({ id: p.manifest.id, name: p.manifest.name, on: false, settings: set(p.manifest), panel: false })),
      ...packs.off.map((o) => ({ id: o.id, name: o.name, on: false, settings: set(o.manifest), panel: false })),
    ].filter((k) => k.settings.length || k.panel);
  };
  /** The areas this instance has: Work only where Settings keeps config, Agents only on a machine. */
  const settingsAreas = (): AreaId[] =>
    AREAS.map((a) => a.id).filter((id) => (id === "work" ? !!deps.config : id === "agents" ? (!hosted && !!deps.agentTools) || !!deps.notify || settingsFrom(shown().filter((p) => p.manifest.id === "agents"), ctxOf, () => {}).length > 0 : id === "packs" ? packSettings().length > 0 : true));
  /** Every setting as it is now, to find and to mark what was changed. */
  const rowsNow = async (frame: Frame) => {
    const v = panesView();
    return settingRows({
      layout: layout.get(),
      policy: deps.notify?.policy() ?? policyOf(undefined),
      rings: packRings,
      writes: { chosen: await clicks.get().catch(() => new Map()), kinds: writeKinds(packs.on) },
      keys: frame.keys ?? DEFAULT_KEYS,
      panes: v && deps.config ? { ...v, stored: deps.config.stored as Record<string, string | undefined> } : undefined,
      packs: packSettings(),
      agents: !hosted && deps.agentTools ? deps.agentTools.view().rows : undefined,
      setup: deps.setup?.() ?? setupNow(frame.operator),
      canRestart: !!deps.restart,
    });
  };
  /** Saved, starting again, or refused: shown once, on the next Settings page. */
  const takeNotes = (then: string): SettingsNotes => {
    const n = { saved, restarting, bad: settingsBad, then };
    saved = false;
    settingsBad = undefined;
    return n;
  };
  const sentNow = async (): Promise<SentView> => (await deps.sent?.().catch(() => undefined)) ?? { hosted };
  const areaBody = async (area: AreaId, frame: Frame): Promise<Html> => {
    switch (area) {
      case "look":
        return lookPanel(layout.get());
      case "layout":
        return layoutPanel(await layoutView(frame));
      case "notifications":
        return notifyPanels(deps.notify?.policy() ?? policyOf(undefined), deps.notify?.log() ?? [], packRings);
      case "writes":
        return writesPanel(await clicks.get().catch(() => new Map()), writeKinds(packs.on));
      case "keys":
        return keysPanel(frame.keys ?? DEFAULT_KEYS, !!currentViewer());
      case "work":
        return workPanel(panesView()!, !!deps.restart);
      case "agents": {
        // One area for agents (#272): their tools here, the long-turn ring, and the auto runs' limits.
        const agents = shown().find((p) => p.manifest.id === "agents");
        const auto = agents ? await ownPanel(agents) : undefined;
        return html`${!hosted && deps.agentTools ? agentToolsPanel({ ...deps.agentTools.view(), said: takeToolsSaid() }) : ""}${deps.notify ? longTurnPanel(deps.notify.policy()) : ""}${auto ? Panel({ title: "Auto runs", id: "auto", children: auto }) : ""}`;
      }
      case "packs":
        return packsList(packSettings());
      case "calls":
        return callsPanels((await ghe.calls?.view(env.DB)) ?? { quota: [], counts: [], now: Date.now() }, forge.name);
      case "speed":
        return speedPanels(await speed.view(env.DB));
      case "sent":
        return sentPanels(await sentNow());
      case "about":
        return html`${appPanel(deps.info, !!deps.restart, frame.tz)}${setupPanel(deps.setup?.() ?? setupNow(frame.operator))}`;
    }
  };
  /** Settings → Packs → one pack: its own panel (and ingest tokens), its manifest's settings, and where else it has some. */
  const showPack = async (c: Context<AppEnv>, id: string, made?: { pack: string; source: string; token: string }) => {
    // The agents pack's settings (auto runs) live in Settings → Agents (#272).
    if (id === "agents" && settingsAreas().includes("agents")) return c.redirect("/settings/agents#auto", 303);
    const k = packSettings().find((x) => x.id === id);
    if (!k) return c.notFound();
    const { frame } = await page();
    const on = shown().find((p) => p.manifest.id === id);
    const offEntry = packs.off.find((o) => o.id === id);
    const settings = manifestSettings(on?.manifest ?? offEntry?.manifest);
    const own = on ? await ownPanel(on, made) : undefined;
    const writes = on ? writeKinds([on]).filter((w) => w.kind.startsWith(`${id}.`)).length : 0;
    const where = html`<p class="t2">${writes ? html`Its writes: <a href="/settings/writes">Settings → Writes</a>. ` : ""}On or off, its refreshes and why: <a href="/packs#pack-${encodeURIComponent(id)}">Packs</a>.</p>`;
    if (made) c.header("Cache-Control", "no-store");
    if (deps.session) {
      const body = html`${offEntry ? Notice({ tone: "warn", children: html`Off: ${offEntry.why}` }) : ""}${own ? Panel({ title: "Its own settings", id: `pack-${id}`, children: own }) : ""}${settings.length ? manifestPanel(id, settings, packs.env, hosted, true, packs.keys?.state) : ""}`;
      return c.html(sessionSettings(frame, { name: k.name, notes: takeNotes(`/settings/packs/${encodeURIComponent(id)}`), body }));
    }
    // What it may ask the model (#466), when it asked for any.
    const asks = on ? aiAsk(on) : undefined;
    if (asks) await aiStore?.load().catch(() => {});
    const ai = asks && aiStore ? aiPanel(id, { ask: asks, grant: aiStore.grant(id), spent: await aiStore.spent(id).catch(() => 0), route: deps.ai?.via, hosted, agents: !!deps.runner || !!deps.agents, mcp: !!deps.mcp }) : "";
    const body = html`${offEntry ? Notice({ tone: "warn", children: html`Off: ${offEntry.why}` }) : ""}${own ? Panel({ title: "Its own settings", id: `pack-${id}`, children: own }) : ""}${ai}${settings.length ? manifestPanel(id, settings, packs.env, hosted, false, packs.keys?.state) : ""}${where}`;
    return c.html(settingsArea(frame, "packs", { areas: settingsAreas(), rows: await rowsNow(frame), notes: takeNotes(`/settings/packs/${encodeURIComponent(id)}`), body, title: k.name, crumbs: [{ href: "/settings/packs", label: "Packs" }] }));
  };
  // What the last "Set up omp/agy" said, shown once on the next Settings.
  let toolsSaid: AgentToolsView["said"];
  const takeToolsSaid = () => {
    const s = toolsSaid;
    toolsSaid = undefined;
    return s;
  };
  app.post("/settings/agent-tools/:h", strictOrigin, async (c) => {
    const h = c.req.param("h");
    if (hosted || !deps.agentTools || !TOOLS_HARNESSES.includes(h as ToolsHarness)) return c.notFound();
    const r = deps.agentTools.register(h as ToolsHarness);
    await logAction(env.DB, { kind: "agents.tools", target: h, detail: "added the dovre MCP server", ok: r.ok, ...(r.ok ? {} : { error: r.why }) }).catch(() => {});
    toolsSaid = r.ok ? { ok: true, text: `${h} gets the packs' tools from its next turn or terminal.` } : { ok: false, text: r.why };
    return c.redirect("/settings/agents", 303);
  });
  app.get("/settings", async (c) => {
    const { frame } = await page();
    return c.html(settingsHome(frame, { areas: settingsAreas(), rows: await rowsNow(frame), q: (c.req.query("q") ?? "").slice(0, 100), notes: takeNotes("/settings") }));
  });
  app.post("/settings/keys", async (c) => {
    const f = await c.req.parseBody({ all: true });
    const on = ([] as unknown[]).concat(f.on ?? []);
    await keyPrefs.set(currentViewer(), { scroll: f.scroll, off: KEY_GROUPS.map((g) => g.id).filter((id) => !on.includes(id)) });
    saved = true;
    return c.redirect("/settings/keys", 303);
  });
  app.post("/settings/writes", async (c) => {
    const f = await c.req.parseBody({ all: true });
    const twice = ([] as unknown[]).concat(f.twice ?? []).filter((v): v is string => typeof v === "string");
    await clicks.set(twice);
    saved = true;
    return c.redirect("/settings/writes", 303);
  });
  const ingestPack = (id: unknown) => shown().find((p) => p.ingest && p.manifest.id === id);
  // A new token is shown on the page this answers, once; only its hash is kept.
  app.post("/settings/ingest/new", async (c) => {
    const f = await c.req.parseBody();
    const p = ingestPack(f.pack);
    if (!p) return c.notFound();
    if (!sourceOk(f.source)) {
      settingsBad = ["the source's name"];
      return c.redirect(`/settings/packs/${p.manifest.id}`, 303);
    }
    const token = await createToken(env.DB, p.manifest.id, f.source);
    await logAction(env.DB, { kind: "ingest-token", target: `${p.manifest.id}:${f.source}`, ok: true, detail: "made" }).catch(() => {});
    return showPack(c, p.manifest.id, { pack: p.manifest.id, source: f.source, token });
  });
  app.post("/settings/ingest/revoke", async (c) => {
    const f = await c.req.parseBody();
    const p = ingestPack(f.pack);
    const id = Number(f.id);
    if (!p || !Number.isInteger(id)) return c.notFound();
    const done = await revokeToken(env.DB, p.manifest.id, id);
    await logAction(env.DB, { kind: "ingest-token", target: `${p.manifest.id}:${id}`, ok: done, detail: "revoked" }).catch(() => {});
    return c.redirect(`/settings/packs/${p.manifest.id}`, 303);
  });
  /** When this server started: a page waiting out a restart asks until it changes. */
  app.get("/settings/started", (c) => noStore(c.text(String(startedAt))));
  // The record of calls home, for a security review (#145): the list of kinds, and what was sent.
  app.get("/settings/sent.json", async (c) => {
    c.header("Content-Disposition", 'attachment; filename="dovre-sent.json"');
    return noStore(c.json({ at: Date.now(), catalog: CATALOG, ...(await sentNow()) }));
  });
  app.get("/settings/packs/:id", (c) => showPack(c, c.req.param("id")));
  /** A pack's AI grant (#466): only for a shown pack that asked, only on a machine; logged. */
  app.post("/settings/packs/:id/ai", strictOrigin, async (c) => {
    const id = c.req.param("id");
    const on = shown().find((p) => p.manifest.id === id);
    const asks = on ? aiAsk(on) : undefined;
    if (hosted || deps.session || !aiStore || !on || !asks) return c.notFound();
    await aiStore.load();
    const g = grantOf(await c.req.parseBody(), asks);
    await aiStore.set(id, g);
    const agent = g.level === "agent" ? `; agent: ${g.where.join(" and ") || "nowhere"}, in ${g.repos === "mine" ? "all my repos" : g.repos.join(" ") || "no repos"}, $${g.runUsd} a run, ${g.turns} turns${g.tools.length ? `, tools ${g.tools.join(" ")}` : ""}` : "";
    await logAction(env.DB, { kind: "packs.ai", target: id, detail: `${g.level === "off" ? (g.mcp ? `AI: $${g.dayUsd} a day` : "AI: nothing") : `AI: text, ${g.size}, $${g.dayUsd} a day${agent}`}${g.mcp ? "; MCP calls" : ""}`.slice(0, 300), ok: true }).catch(() => {});
    return c.redirect(`/settings/packs/${encodeURIComponent(id)}#ai`, 303);
  });
  app.get("/settings/:area", async (c) => {
    const area = c.req.param("area");
    if (!isArea(area) || !settingsAreas().includes(area)) return c.notFound();
    const { frame } = await page();
    const notes = takeNotes(`/settings/${area}`);
    const body = await areaBody(area, frame);
    return c.html(settingsArea(frame, area, { areas: settingsAreas(), rows: await rowsNow(frame), notes, body }));
  });
  /** The Work form: kept, then Dovre starts again with it (under the supervisor). */
  for (const path of ["/settings/work"])
    app.post(path, async (c) => {
      if (!deps.config) return c.notFound();
      const { config, bad } = configFromForm(await c.req.parseBody(), deps.config.stored, fixedKeys(), { general: true });
      const back = path;
      if (bad.length) {
        settingsBad = bad;
        return c.redirect(back, 303);
      }
      saved = true;
      await keep(config);
      return c.redirect(back, 303);
    });
  app.post("/settings/notify", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const kinds = new Set([form.kind ?? []].flat().map(String));
    const num = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? Number(v) : undefined);
    const was = deps.notify?.policy() ?? policyOf(undefined);
    const next = policyOf({
      // The kinds on the form: the core's and the shown packs'; any other keeps what it was.
      kinds: { ...was.kinds, ...Object.fromEntries([...RING_KINDS, ...packRings].map((k) => [k.kind, kinds.has(k.kind)])) },
      // A long turn is set on Settings → Agents (#272).
      longTurnMin: was.longTurnMin,
      bundleSec: num(form.bundleSec),
      quiet: quietOf(form.quietFrom, form.quietTo, form.quietWeekends),
    });
    await deps.notify?.setPolicy(next);
    saved = true;
    return c.redirect("/settings/notifications", 303);
  });
  /** Settings → Agents: how long a turn runs before its end rings (the rest of the policy as it was). */
  app.post("/settings/agents/long-turn", async (c) => {
    if (!deps.notify) return c.notFound();
    const v = (await c.req.parseBody()).longTurnMin;
    await deps.notify.setPolicy(policyOf({ ...deps.notify.policy(), longTurnMin: typeof v === "string" && v.trim() !== "" ? Number(v) : undefined }));
    saved = true;
    return c.redirect("/settings/agents#long-turn", 303);
  });
  app.post("/settings/restart", (c) => {
    // The supervisor (`dovre supervise`, launcher/) starts it again; the page waits on the starting page.
    setTimeout(() => deps.restart?.(), 300);
    return c.redirect("/settings/about", 303);
  });
  app.post("/settings/notify/test", (c) => {
    deps.notify?.test();
    return c.redirect("/settings/notifications#rang-lately", 303);
  });
  return { keep, settleSettings, settingsAreas, restarting: () => restarting };
}
