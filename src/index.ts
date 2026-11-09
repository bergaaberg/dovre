/** Runs Dovre: open the database, find out who I am on GHE, keep the view fresh, bind to localhost. */
import { ownersIn } from "./owners.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSent, sentFiles } from "./bridge/sentfile.ts";
import { recordOf } from "./sent.ts";
import { serve } from "@hono/node-server";
import { packsOf, createApp } from "./app.ts";
import { createCopies } from "./packs/copies.ts";
import { loadPacks } from "./packs/load.ts";
import { activePacks, initAll, refresher as packRefresher } from "./packs/registry.ts";
import { launchToken, maskedLogin, serveSetup } from "./boot.ts";
import { publicOriginOf } from "./access.ts";
import { findTool, found, harnessesOn, summariesVia, which } from "./tools.ts";
import { startingPage } from "./pwa.ts";
import { openDb } from "./db.ts";
import { loadEnv, rawVars } from "./env.ts";
import { createKeys } from "./secrets.ts";
import { LEGACY_SWITCHES, legacyOff, loadConfig, panesOf, runningOf, saveConfig } from "./config.ts";
import { layoutStore } from "./layout.ts";
import { setWhen } from "./when.ts";
import { ompAsker } from "./ai/omp.ts";
import { runOff } from "./spawn.ts";
import { createGatherer, SNAPSHOT_SHAPE, type Snapshot, snapshotStore } from "./gather.ts";
import { keptFile } from "./kept.ts";
import { logAction } from "./actions/deploys.ts";
import { createAsks } from "./relay/asks.ts";
import { createQueue } from "./agents/queue.ts";
import { createSpend } from "./packs/core/agents/spend.ts";
import { historyPack } from "./packs/core/history/index.ts";
import { createHistory } from "./packs/core/history/store.ts";
import { ompAgentDirs } from "./sources/omp.ts";
import { loadMemory } from "./packs/core/assistant/bino/memory.ts";
import { routeOf, viaOf } from "./packs/core/assistant/bino/route.ts";
import { createGhe, missingGhe, viewer } from "./sources/ghe.ts";
import { forgeIdOf, pickForge } from "./forge/pick.ts";
import { githubForge } from "./forge/github.ts";
import { forgeCan } from "./forge/types.ts";
import { checkoutOf, checkouts } from "./checkouts.ts";
import { agyCli, claudeCli, codexCli, copilotComplete } from "./ai/llm.ts";
import { copilotCli } from "./ai/copilotcli.ts";
import { createRunner, HARNESSES, repoDir, type Run } from "./agents/runner.ts";
import { gitTurnDiff } from "./agents/turndiff.ts";
import { appleContainer } from "./agents/sandbox.ts";
import { findHarnessTools, harnessesFor, useFoundModels } from "./agents/harnesses/index.ts";
import { foundModels } from "./agents/harnesses/found.ts";
import { addLeftOut } from "./packs/core/dependabot/relock.ts";
import { dependabotPack } from "./packs/core/dependabot/index.ts";
import { stacksPack } from "./packs/core/stacks/index.ts";
import { prsPack } from "./packs/core/prs/index.ts";
import { runCheck } from "./reviews/check.ts";
import { ompProfileOf } from "./sources/omp.ts";
import { liveAgents } from "./sources/claude.ts";
import { createHub, startRefresher, throttle } from "./live.ts";
import { agentsPack } from "./packs/core/agents/index.ts";
import { autoreviewPack } from "./packs/core/autoreview/index.ts";
import { reviewsPack } from "./packs/core/reviews/index.ts";
import { summariesPack } from "./packs/core/summaries/index.ts";
import { createHere } from "./packs/core/agents/here.ts";
import { localSessions } from "./sources/sessions.ts";
import { loadWorktrees } from "./sources/worktrees.ts";
import { createDismissed } from "./agents/dismissed.ts";
import { localDesk, modelOf } from "./agents/desk.ts";
import { assistantPack } from "./packs/core/assistant/index.ts";
import { issuesPack } from "./packs/core/issues/index.ts";
import { terminalPack } from "./packs/core/terminal/index.ts";
import { findPrograms } from "./packs/core/terminal/programs.ts";
import { createTerminals } from "./packs/core/terminal/terms.ts";
import { bridgeEntry, registerTools, toolsState } from "./agents/mcpsetup.ts";
import { type Need, needsOf } from "./home/needs.ts";
import { listRepos } from "./sources/claude.ts";
import { todoPack } from "./packs/core/todo/index.ts";
import { movementPack } from "./packs/core/movement/index.ts";
import { deploysPack } from "./packs/core/deploys/index.ts";
import { systemOpener } from "./open-link.ts";
import { type Policy, createNotifier, createRinger, loadPolicy, type Note, savePolicy, windowsToast } from "./notify.ts";

const port = Number(process.env.PORT ?? 4848);
// Where the database is comes from the environment or .dev.vars; everything else may be set on Settings too.
const boot = loadEnv();
// Self-hosting on a server (docs/REMOTE.md): the public address a sign-in proxy serves Dovre at (#74),
// and what to listen on. A bad PUBLIC_ORIGIN stops the start here. LISTEN_HOST is only for a
// container, whose port is published to the host's loopback: the Host and cookie checks still apply.
const publicOrigin = publicOriginOf(boot.PUBLIC_ORIGIN);
const listenHost = process.env.LISTEN_HOST || "127.0.0.1";
const dbPath = boot.U_DB ?? "data/dovre.sqlite";
// Dovre was Utsikten until 2026-10-23: its database moves to the new name once (with SQLite's side files).
if (!boot.U_DB && !existsSync(dbPath) && existsSync("data/utsikten.sqlite"))
  for (const ext of ["", "-wal", "-shm"]) if (existsSync(`data/utsikten.sqlite${ext}`)) renameSync(`data/utsikten.sqlite${ext}`, `${dbPath}${ext}`);
// Absolute: the agent host runs in the repo it works on, so a relative path would point there.
const dataDir = resolve(dirname(dbPath));
mkdirSync(dataDir, { recursive: true });
// Made once and kept (data/launch-token) unless pinned in .dev.vars; the launcher reads the same.
const launch = launchToken(dataDir, boot.LAUNCH_TOKEN);
const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
// Under the launcher's supervisor (launcher/supervise.go): exit 75 starts the server again at once.
const supervised = process.env.DOVRE_SUPERVISED === "1";
// The launcher's starting page (launcher/ opens it before there's a server to ask).
try {
  writeFileSync(join(dataDir, `starting-${port}.html`), String(startingPage({ file: { base: `http://127.0.0.1:${port}`, up: `up-${port}.js`, icon: new URL("../assets/icon-192.png", import.meta.url).href, font: new URL("../assets/fonts/NordwandMono-Regular.woff2", import.meta.url).href, picture: existsSync(join(dataDir, "start-picture.svg")) ? "start-picture.svg" : undefined } })));
} catch (e) {
  console.error("couldn't write the starting page:", (e as Error).message);
}
const db = openDb({ path: dbPath });
if (db.applied.length) console.log(`migrations applied: ${db.applied.join(", ")}`);
// What Settings keeps (src/config.ts), under the environment and .dev.vars.
let config = await loadConfig(db.DB);
// Terminal, Docker and Bino were switched off on Settings → Panes; now their packs are (#271). Moved once:
// an "off" goes to the pack's switch, and the old key goes (BINO_VIA stays when it names a route).
const oldSwitches = Object.keys(config).filter((k) => k === "TERMINAL" || k === "DOCKER" || (k in LEGACY_SWITCHES && legacyOff({ [k]: config[k] }).length));
if (oldSwitches.length) {
  const layout = layoutStore(db.DB);
  await layout.ready;
  const movedOff = legacyOff(config);
  if (movedOff.length) await layout.save({ ...layout.get(), packsOff: [...new Set([...(layout.get().packsOff ?? []), ...movedOff])] });
  config = Object.fromEntries(Object.entries(config).filter(([k]) => !oldSwitches.includes(k)));
  await saveConfig(db.DB, config);
}
let env = loadEnv(config);
setWhen({ tz: env.TZ_NAME, lang: env.GREETING });
const setup = { token: launch, port, dataDir, version, supervised, publicOrigin, listenHost };
// Which forge the code lives on (FORGE): GitHub unless a pack brings another (src/forge/pick.ts).
const forgeId = forgeIdOf(env.FORGE);
const onGithub = forgeId === "github";
// If no org is set yet, but a GitHub token is already available (e.g. `gh auth status`), discover the user's login and orgs.
if (onGithub && !env.GHE_ORG && env.GHE_TOKEN) {
  try {
    const g = createGhe({ host: env.GHE_HOST, token: env.GHE_TOKEN });
    const v = await viewer(g);
    const orgs = await g.rest<{ login?: string }[]>("/user/orgs?per_page=100").catch(() => []);
    const discovered = [v.login, ...orgs.map((o) => o.login).filter((x): x is string => typeof x === "string" && !!x)];
    if (env.GHE_HOST === "github.com" && discovered.length) {
      config = { ...config, REPO_OWNERS: discovered.join(", ") };
      await saveConfig(db.DB, config);
      env = loadEnv(config);
      console.log(`auto-discovered GitHub owners from gh login: ${env.OWNERS}`);
    }
  } catch {}
}
// No org set: the setup page says to set one. No GHE login: the setup page says how, until there is one.
if (!env.GHE_ORG)
  await serveSetup({
    ...setup,
    problem: { kind: "org", host: env.GHE_HOST },
    onSaveOwners: async (owners) => {
      const cur = await loadConfig(db.DB);
      await saveConfig(db.DB, { ...cur, REPO_OWNERS: owners });
    },
    check: async () => !!loadEnv(await loadConfig(db.DB)).GHE_ORG,
  });
// Packs (PLAN D23): the folders this machine's PACKS lists. Loaded this early because one may bring the forge.
const packEnv = rawVars(config);
// Secret settings given as a store's reference (#416): read now, before the packs built from them load.
const keys = createKeys(packEnv, { varsFile: ".dev.vars", log: (l) => console.log(`secrets: ${l}`) });
await keys.read();
// An old switch set off in .dev.vars or the environment can't be moved: it switches its pack off there.
for (const id of legacyOff(packEnv)) packEnv[`PACK_${id.toUpperCase()}`] ??= "off";
const loaded = await loadPacks(env.PACKS, packEnv);
// GitHub as the forge needs a login: the setup page says how, until there is one. Another forge's pack asks for its own.
const gheToken = !onGithub ? undefined : (env.GHE_TOKEN ?? (await serveSetup({ ...setup, problem: { kind: "login", host: env.GHE_HOST }, check: async () => !!loadEnv().GHE_TOKEN })));
const ghe = gheToken ? createGhe({ host: env.GHE_HOST, token: gheToken }) : missingGhe(env.GHE_HOST, `GitHub isn't this instance's forge (FORGE=${forgeId}).`);
const forge = pickForge(env.FORGE, loaded.packs, () => githubForge(ghe), packEnv);
// Who I am on GHE, kept from last time so starting doesn't wait on GHE; asked again meanwhile.
const viewerFile = join(dataDir, "viewer.json");
const kept = ((): { login: string; name?: string | null } | undefined => {
  try {
    const v = JSON.parse(readFileSync(viewerFile, "utf8"));
    return typeof v?.login === "string" && v.login ? v : undefined;
  } catch {
    return undefined;
  }
})();
const asked = forge.viewer().then((v) => {
  writeFileSync(viewerFile, JSON.stringify({ login: v.login, name: v.name ?? null }));
  return v;
});
// Never seen who I am and GHE doesn't answer (VPN, an expired login): the setup page, until it does.
const me =
  kept ??
  (await asked.catch((e) =>
    serveSetup({
      ...setup,
      problem: { kind: "unreachable", host: forge.host || env.GHE_HOST, error: String((e as Error)?.message ?? e) },
      check: async () => {
        if (!onGithub) return !!(await forge.viewer()).login;
        const token = loadEnv().GHE_TOKEN;
        return !!token && !!(await viewer(createGhe({ host: env.GHE_HOST, token }))).login;
      },
    }),
  ));
if (kept)
  asked.then(
    (v) => {
      // Signed in as someone else now: start again as them.
      if (!env.GHE_LOGIN && v.login !== kept.login) process.exit(75);
    },
    (e) => console.error(`${forge.name} didn't say who I am:`, (e as Error).message),
  );
const login = env.GHE_LOGIN ?? me.login;
const name = me.name?.split(/\s+/)[0] || login;

// The agent CLIs this machine has: only those are offered, polled and used (src/tools.ts).
useFoundModels(foundModels());
const tools = findHarnessTools(env);
const { claude, omp, agy, codex } = tools;
// The agents pack uses only the CLIs switched on (AGENT_HARNESSES, Settings); Bino and summaries pick their own.
const harnessOn = harnessesOn(env.AGENT_HARNESSES);
found.harnesses = HARNESSES.filter((h) => tools[h] && harnessOn(h));
// Copilot CLI: Bino and summaries can ask through it (src/ai/copilotcli.ts); its sessions are read whether or not.
const copilotTool = findTool("copilot", env.COPILOT_BIN);
found.paths = { claude: claude?.path, omp: omp?.path, copilot: copilotTool?.path, agy: agy?.path, codex: codex?.path };
const hostExe = fileURLToPath(new URL(`../bin/dovre${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
// Which panes run (Settings, src/config.ts): one that's off, or can't run here, never starts its work.
// Copilot through omp, for whoever has no Claude Code: Bino and summaries talk through it
// (src/ai/omp.ts): its own profile with no MCP servers, no tools, no session, an empty folder.
const copilotDir = join(dataDir, "copilot");
mkdirSync(copilotDir, { recursive: true });
const copilot = omp ? ompAsker({ omp: { bin: omp.bin, pre: omp.pre }, profile: env.COPILOT_PROFILE || "dovre-copilot", model: env.COPILOT_MODEL || "github-copilot/gpt-6-luna:medium", cwd: copilotDir, run: runOff, who: { name: "Copilot through omp", profileVar: "COPILOT_PROFILE", modelVar: "COPILOT_MODEL" } }) : undefined;
found.copilot = copilot ? (copilot.why() ?? "ready") : undefined;
const copilotAsk = copilotTool ? copilotCli(copilotTool, { model: env.COPILOT_CLI_MODEL, log: (l) => console.log(l) }) : undefined;
const isWin = process.platform === "win32";
const panes = panesOf(env, { claude: !!claude, omp: !!omp, copilot: !!copilot && !copilot.why(), copilotCli: !!copilotTool, agy: !!agy, codex: !!codex, terminals: existsSync(hostExe), windows: isWin });
const on = runningOf(panes);
console.log(`agents: ${found.harnesses.join(", ") || "none found"}; panes off: ${Object.entries(on).filter(([, v]) => !v).map(([k]) => k).join(", ") || "none"}`);
// Bino, the assistant: talks through BINO_VIA / ASSISTANT_VIA (Claude Code's CLI by default), remembers with memlet when it's installed.
const directKey = env.ASSISTANT_API_KEY || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GEMINI_API_KEY;
const binoRoute = routeOf({
  via: panes.bino.wanted ? viaOf(env.BINO_VIA, !!claude, !!omp, !!copilotTool, !!agy) : "off",
  claude,
  copilot,
  copilotCli: copilotAsk,
  copilotCliModel: env.COPILOT_CLI_MODEL,
  agy,
  codex,
  apiKey: { apiKey: directKey },
  cfGateway: { accountId: env.CF_ACCOUNT_ID, gateway: env.CF_GATEWAY_NAME, apiToken: env.CF_AIG_TOKEN },
  openRouter: { apiKey: env.OPENROUTER_API_KEY || env.ASSISTANT_API_KEY },
  model: env.BINO_MODEL,
  reflectModel: env.BINO_REFLECT_MODEL,
  log: (l) => console.log(l),
});
const binoMemory = await loadMemory(db.DB);
console.log(`bino: ${binoRoute.ready ? `${binoRoute.via}, ${binoRoute.model}` : "off"}; memory ${binoMemory.available ? "on" : "off"}`);

const hub = createHub();
// What I write to an agent while it works waits here for the turn to end (src/agents/queue.ts).
const queue = createQueue({ file: join(dataDir, "queue.json"), onChange: (sid) => hub.publish([`run:${sid}`]) });
// The model the summaries pack writes with (SUMMARIES, #390): none here, and the pack doesn't run.
const sumVia = summariesVia(env.SUMMARIES, !!claude, !!omp, !!copilotTool, !!agy);
const summaryModel = sumVia === "claude" && claude ? claudeCli({ bin: claude.bin, pre: claude.pre }) : sumVia === "omp" && copilot && !copilot.why() ? copilotComplete(copilot) : sumVia === "copilot" ? copilotAsk : sumVia === "agy" && agy ? agyCli({ bin: agy.bin, pre: agy.pre }) : sumVia === "codex" && codex ? codexCli({ bin: codex.bin, pre: codex.pre }) : undefined;
// The refresher keeps the snapshot fresh; pages only read it, and never wait for GHE when there's one to show.
let gathered = (_s: Snapshot) => {};
const gatherer = createGatherer({
  env, forge, login, name, ttlMs: 10 * 60_000,
  // The PRs the agents' sessions link: their state and title come with the gather.
  linked: () => packLinked(),
  store: snapshotStore(join(dataDir, "snapshot.json"), SNAPSHOT_SHAPE),
  onGathered: (s) => gathered(s),
});

const base = `http://127.0.0.1:${port}`;
const notifier = createNotifier();
let policy: Policy = await loadPolicy(db.DB);
/** Notes reach open pages over the event stream; when no open page may show them, a Windows toast. */
const ringer = createRinger({
  policy: () => policy,
  deliver: (notes: Note[]) => {
    hub.publish([], notes);
    if (!hub.notifiers()) windowsToast(notes, base);
  },
});
const ring = (notes: Note[]) => ringer.ring(notes);

const runChanged = new Map<string, (r: Run) => void>();
const runStatus = new Map<string, Run["status"]>();
/** The agents pack hears each turn change (one that ends may ring); set once it's made. */
let turnChanged = (_r: Run) => {};
// Agent turns run through the launcher's agent host when it's built: they go on when the server
// restarts, and are picked up again from data/runs (launcher/agenthost.go keeps tool results out).
/** Whether any pack offers agent turns tools (src/mcp.ts); set once the packs are loaded. */
let mcpOn = () => false;
/** How omp and agy start Dovre's stdio MCP bridge (src/mcp-stdio.ts). */
const toolsEntry = bridgeEntry();
const runner = createRunner({
  // What each turn changes in its checkout (#241).
  diff: gitTurnDiff(),
  // Each turn gets Dovre's MCP server, with its own token, when packs offer tools (omp and agy once Settings sets them up).
  mcp: { url: `http://127.0.0.1:${port}/mcp`, on: () => mcpOn() },
  host: existsSync(hostExe) ? { exe: hostExe, dir: join(dataDir, "runs") } : undefined,
  // Sandbox runs (#205): Apple container, so macOS only for now.
  sandbox: process.platform === "darwin" ? appleContainer({
          root: join(dataDir, "sandboxes"),
          // A repo's siblings (#208) come from your checkouts under CODE_DIR, of your owners only.
          checkout: (repo) => {
            const c = checkoutOf(checkouts(env.CODE_DIR, forge.host, ownersIn(env)), repo);
            return c ? join(env.CODE_DIR, c.dir) : undefined;
          },
        }) : undefined,
  harnesses: harnessesFor(tools, harnessOn, { ompProfileOf }),
  onChange: (r) => {
    // A turn that ends lets the messages written meanwhile go; whether it rings is the agents pack's call.
    const was = runStatus.get(r.id);
    runStatus.set(r.id, r.status);
    if (was === "running" && r.status !== "running") queue.ended(r);
    turnChanged(r);
    let fn = runChanged.get(r.id);
    if (!fn) {
      fn = throttle((run: Run) => {
        const topics = [`run:${run.id}`];
        if (run.sessionId) topics.push(`run:${run.sessionId}`);
        if (run.resumed) topics.push(`run:${run.resumed}`);
        // Starting and ending change the Today page too.
        if (run.status !== "running" || run.events.length <= 1) topics.push("snapshot");
        hub.publish(topics);
      }, 250);
      runChanged.set(r.id, fn);
    }
    fn(r);
  },
});
/** What the packs say needs me (agents waiting…) and the PRs their pages link; set once the app is built. */
let packNeeds: () => Need[] = () => [];
let startsOff: ReadonlySet<string> = new Set();
let packLinked = (): string[] => [];
let pageOn = (_href: string) => true;
const refresher = startRefresher({ gatherer, hub });
// What needs me rings once, checked again whenever pages are told something changed: a gather, or a
// pack's own read (the agents pack's sessions every 15 s).
hub.subscribe((c) => {
  const s = gatherer.peek();
  if (s && c.topics.includes("snapshot")) ring(notifier.observe([...needsOf(s, { deploys: pageOn("/deploys") }), ...packNeeds()], policy, startsOff));
});
// A gather a page or an action started is published like the refresher's own.
gathered = refresher.seen;
// Questions MCP servers put to me through the relay: on every page at once, and a notification.
const asks = createAsks({
  onChange: (q) => {
    hub.publish(["snapshot"]);
    if (q) ring([{ title: `${q.server} asks for your OK`, body: q.message.slice(0, 200), url: "/", tag: `ask:${q.id}`, kind: "ask" }]);
  },
});
const notify = {
  policy: () => policy,
  async setPolicy(p: Policy) {
    policy = p;
    await savePolicy(db.DB, p);
  },
  log: () => ringer.log(),
  test: () => ringer.ring([{ title: "Dovre notifications work", body: "This is how something that needs you will look.", url: "/settings", tag: "test", kind: "test" }]),
  ring,
};

// GHE's answers, kept between runs so pages answer at once after a restart.
const keptAnswers = keptFile(join(dataDir, "catalog.json"));
// Terminals in Dovre run in the launcher's pty host (launcher/pty.go): a shell or agent CLI from the
// fixed list, in a checkout under CODE_DIR. They need the launcher built (`bin/dovre` / `bin/dovre.exe`).
// Each terminal gets Dovre's MCP server too, with its own token, while packs offer tools (#172).
const terminals = on.terminal ? createTerminals({ hostExe, codeDir: env.CODE_DIR, programs: findPrograms({ copilotBin: env.COPILOT_BIN, agyBin: env.AGY_BIN, codexBin: env.CODEX_BIN, on: harnessOn }), onChange: () => hub.publish(["snapshot"]), mcp: { url: `http://127.0.0.1:${port}/mcp`, on: () => mcpOn() } }) : undefined;
if (terminals) console.log(`terminals: ${terminals.programs().map((p) => p.id).join(", ")}`);

// Dovre's own packs (PLAN WP-H9), before the instance's. Assistant: Bino's switch. Terminal: the pty host above.
// Agents: this machine's sessions and worktrees (read by the pack, every 15 s and when Claude Code's
// session files change), the desk over the runner and them, and the sessions cleared away. Without
// claude nothing asks it (the registry files in ~/.claude still count); without omp, no process scan.
const listAgents = claude ? () => liveAgents(claude.bin, 20_000, claude.pre) : () => Promise.reject(new Error("claude isn't installed"));
const here = createHere({
  sessions: async () => localSessions(env.CLAUDE_DIR, await listAgents().catch(() => undefined), { omp: !!omp, on: harnessOn }),
  worktrees: () => loadWorktrees(env.CODE_DIR),
  watch: join(env.CLAUDE_DIR, "sessions"),
  log: (l) => console.log(l),
});
const dismissed = createDismissed(db.DB);
const desk = localDesk({ env, runner, queue, sessions: () => here.ready(), onStarted: (sid) => dismissed.remove(sid) });
const corePacks = [
  agentsPack({ desk, dismissed, here, onTurn: (fn) => (turnChanged = fn), longTurnMs: () => policy.longTurnMin * 60_000, repoOf: (dir) => checkouts(env.CODE_DIR, forge.host, ownersIn(env)).find((c) => c.dir === dir)?.repo, ...(gheToken ? { github: { ghe, owners: () => ownersIn(env) } } : {}), spend: createSpend({ claudeDir: env.CLAUDE_DIR, ompDirs: ompAgentDirs().map((d) => d.dir) }) }),
  // The forge's weeks on /stats (#387), where it gathers them: kept in data/stats.json.
  ...(gheToken && forgeCan(forge, "stats") ? [historyPack({ forge: forge.name, history: (changed) => createHistory({ ghe, org: () => ownersIn(env), login: () => gatherer.peek()?.login, file: join(dataDir, "stats.json"), onChange: changed }) })] : []),
  // Review rounds on auto runs' PRs (#326): off while agents is.
  autoreviewPack({ ...(gheToken ? { github: { ghe, owners: () => ownersIn(env) } } : {}), reviewer: () => (binoRoute.ready && binoRoute.ask ? { ask: binoRoute.ask, model: binoRoute.model } : undefined) }),
  // Agent reviews of PRs (#389), where the forge has PR reviews: on while an agent CLI is here.
  ...(gheToken && forgeCan(forge, "reviews")
    ? [
        reviewsPack({
          runner,
          ghe,
          owners: () => ownersIn(env),
          dirOf: (repo) => {
            const c = checkoutOf(checkouts(env.CODE_DIR, forge.host, ownersIn(env)), repo);
            return c ? (repoDir(env.CODE_DIR, c.dir) ?? undefined) : undefined;
          },
          codeDir: env.CODE_DIR,
          claudeDir: env.CLAUDE_DIR,
          modelOf,
          stale: () => gatherer.stale(),
        }),
      ]
    : []),
  // AI summaries on PRs and deploys (#390): on while a model can write them here.
  summariesPack({ complete: summaryModel }),
  // Bino's switch (PACK_ASSISTANT=off).
  assistantPack(),
  // Moved (/movement): what people did in the org lately, from the gather.
  movementPack(),
  // Pull requests (/prs), and where the forge has it the PR viewer with my own review; Bino's model checks it.
  prsPack({ ghe, owners: () => ownersIn(env), forge, kept: keptAnswers, stale: () => gatherer.stale(), checker: () => { const ask = binoRoute.ask; return binoRoute.ready && ask ? { model: binoRoute.model, start: async (job, topic, publish) => void runCheck(db.DB, ask, job, () => publish([topic])) } : undefined; } }),
  // Stacked PRs (/stacks), where the forge has them; the viewer's "2 of 3 in a stack".
  ...(forgeCan(forge, "stacks") ? [stacksPack({ ghe, owners: () => ownersIn(env), kept: keptAnswers })] : []),
  // Dependabot's bumps across the repos (/dependabot), where the forge has them; left-out bumps added in a checkout.
  ...(forgeCan(forge, "dependabot") ? [dependabotPack({ ghe, owners: () => ownersIn(env), relock: (repo, n) => addLeftOut(ghe, db.DB, env.CODE_DIR, repo, n), stale: () => gatherer.stale() })] : []),
  // Deploys waiting for my approval (/deploys), decided from here where the forge lets me.
  deploysPack({ ghe, owners: () => ownersIn(env), approve: forgeCan(forge, "deployApproval"), stale: () => gatherer.stale() }),
  // My list (/todo), shared with Bino, search and New work.
  todoPack({ links: () => ({ ghe: env.GHE_HOST, org: env.GHE_ORG }), bino: () => binoRoute.ready }),
  // My open issues from the forge (/tracker), where the forge has them.
  // Each row can start a new agent session on its issue, in the repo's checkout, when an agent can run here.
  issuesPack({
    forge,
    owners: () => ownersIn(env),
    login: () => gatherer.peek()?.login,
    // New work (/issues/new), where the forge takes GitHub's issue forms.
    ...(forgeCan(forge, "issues") ? { newHref: "/issues/new", tasks: true, compose: { ghe, org: env.GHE_ORG, kept: keptAnswers, prewarm: true } } : {}),
    ...(found.harnesses.length
      ? {
          agents: () => {
            const list = checkouts(env.CODE_DIR, forge.host, ownersIn(env));
            return (repo: string) => checkoutOf(list, repo)?.dir;
          },
        }
      : {}),
  }),
  ...(terminals ? [terminalPack(terminals)] : []),
];

// GitHub's call counts (#253) into the database, when a minute has had any.
if (ghe.calls) setInterval(() => void ghe.calls!.flush(db.DB), 60_000).unref();



// Packs (PLAN D23): those PACKS loaded above that can run here, after the core's.
const copies = createCopies({ packs: env.PACKS, env: packEnv, onChange: () => hub.publish(["packs"]) });
const packSet = { ...activePacks([...corePacks, ...loaded.packs], { env: packEnv, unread: keys.unread(), hosted: false, which: (b) => which(b) }), env: packEnv, keys, core: corePacks.map((c) => c.manifest.id), varsFile: ".dev.vars", copies };
// Terminal isn't added where it can't run: Packs says why.
if (!on.terminal) packSet.off.push({ id: "terminal", name: "Terminal", why: panes.terminal.why ?? "can't run here" });
packSet.off.push(...loaded.failed);
mcpOn = () => packSet.on.some((p) => p.tools || p.lookups);
for (const o of packSet.off) console.log(`pack ${o.id}: off, ${o.why}`);

/** data/perf.log: slow requests and page loads, timings only, 200 kB at most. */
const perfFile = resolve(dirname(dbPath), "perf.log");
const perfLog = (line: string) => {
  try {
    if (!existsSync(perfFile) || statSync(perfFile).size < 200_000) appendFileSync(perfFile, `${line}\n`);
  } catch {}
};
const app = createApp({ ...env, DB: db.DB, LAUNCH_TOKEN: launch }, {
  perfLog,
  packs: packSet,
  gatherer,
  ghe,
  forge,
  // A pack's picture for the starting page (written next to it, read at the next start).
  startPicture: (svg) => writeFileSync(join(dataDir, "start-picture.svg"), svg),
  runner,
  mcpTurns: (t) => terminals?.byMcpToken(t),
  // Settings → Pack tools for agents: omp and agy read MCP servers only from their own config (#172).
  agentTools: {
    view: () => ({
      offered: mcpOn(),
      rows: [
        ...(claude && harnessOn("claude") ? [{ id: "claude" as const }] : []),
        ...(codex && harnessOn("codex") ? [{ id: "codex" as const }] : []),
        ...(omp && harnessOn("omp") ? [{ id: "omp" as const, state: toolsState("omp", homedir(), toolsEntry) }] : []),
        ...(agy && harnessOn("agy") ? [{ id: "agy" as const, state: toolsState("agy", homedir(), toolsEntry) }] : []),
      ],
    }),
    register: (h) => registerTools(h, { home: homedir(), want: toolsEntry, agy: agy ? [agy.bin, ...agy.pre] : undefined }),
  },
  openUrl: systemOpener(),
  hub,
  notify,
  info: { version, startedAt: Date.now() },
  // Settings → What Dovre sends: a bridge's record on this machine, when there is one (#145).
  sent: async () => {
    const file = sentFiles({ env: process.env, home: homedir(), platform: process.platform, checkout: fileURLToPath(new URL("..", import.meta.url)) }).find((f) => existsSync(f));
    return { hosted: false, machine: file ? { ...recordOf(readSent(file)), file } : undefined };
  },
  kept: keptAnswers,
  bino: { route: binoRoute, memory: binoMemory, file: join(dataDir, "bino.json"), log: (l) => console.log(l) },
  asks,
  prewarm: true,
  panes: on,
  config: { panes, stored: config },
  // Exit code 75 tells the supervisor (`dovre supervise`, launcher/) to start it again straight away.
  restart: () => {
    refresher.stop();
    // Agent turns run apart from the server (the agent host) and carry on; they show again after the restart.
    if (!existsSync(hostExe)) for (const r of runner.list()) if (r.status === "running") runner.stop(r.id);
    process.exit(75);
  },
});
// Packs start, then refresh on their own schedule (checked every 30 s); pages never wait for either.
const mountedPacks = packsOf(app)!;
packNeeds = mountedPacks.needs;
startsOff = mountedPacks.startsOff;
packLinked = mountedPacks.linked;
pageOn = mountedPacks.pageOn;
await initAll(mountedPacks, mountedPacks.ctxOf, (l) => console.log(l));
if (mountedPacks.on.length) {
  console.log(`packs: ${mountedPacks.on.map((c) => c.manifest.id).join(", ")}`);
  const packRefresh = packRefresher(mountedPacks.on, mountedPacks.ctxOf, (l) => console.log(l), { record: mountedPacks.refreshes, skip: mountedPacks.hidden });
  void packRefresh.due(true);
  setInterval(() => void packRefresh.due(), 30_000).unref();
}

// Says "listening" to the launcher's starting page (src/pwa.ts); gone again when this process is.
const upFile = join(dataDir, `up-${port}.js`);
process.on("exit", () => {
  try {
    unlinkSync(upFile);
  } catch {}
});
serve({ fetch: app.fetch, port, hostname: listenHost }, (info) => {
  try {
    writeFileSync(upFile, `window.dovreUp = ${Date.now()};
`);
  } catch {}
  console.log(`dovre on http://127.0.0.1:${info.port} as ${login}`);
  console.log(`login:   ${maskedLogin(`http://127.0.0.1:${info.port}`)}`);
  if (publicOrigin) console.log(`public:  ${publicOrigin} (PUBLIC_ORIGIN): keep a sign-in in front of it`);
  if (listenHost !== "127.0.0.1") console.log(`listening on ${listenHost}:${info.port} (LISTEN_HOST): publish this port to loopback only`);
});

// Agent runs are this process's children: stop them with it, so nothing keeps editing a repo unseen.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    refresher.stop();
    // Agent turns run apart from the server (the agent host) and carry on; they show again after the restart.
    if (!existsSync(hostExe)) for (const r of runner.list()) if (r.status === "running") runner.stop(r.id);
    process.exit(0);
  });
