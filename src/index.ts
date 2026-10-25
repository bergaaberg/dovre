/** Runs Dovre: open the database, find out who I am on GHE, keep the view fresh, bind to localhost. */
import { ownersIn } from "./owners.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { packsOf, createApp } from "./app.ts";
import { loadPacks } from "./packs/load.ts";
import { activePacks, initAll, refresher as packRefresher } from "./packs/registry.ts";
import { launchToken, maskedLogin, serveSetup } from "./boot.ts";
import { findTool, found, harnessesOn, which } from "./tools.ts";
import { startingPage } from "./pwa.ts";
import { openDb } from "./db.ts";
import { loadEnv, onPath, rawVars } from "./env.ts";
import { loadConfig, panesOf, runningOf, saveConfig } from "./config.ts";
import { setWhen } from "./when.ts";
import { createHelper } from "./teams/helper.ts";
import { createTeams } from "./teams/teams.ts";
import { createOutlook } from "./teams/outlook.ts";
import { createChannels } from "./teams/channels.ts";
import { ompCrawler } from "./teams/crawl.ts";
import { runOff } from "./spawn.ts";
import { createData } from "./data/db.ts";
import { createGatherer, SNAPSHOT_SHAPE, type Snapshot, snapshotStore } from "./gather.ts";
import { keptFile } from "./issues/templates.ts";
import { logAction } from "./actions/deploys.ts";
import { askInBar, createAsks } from "./relay/asks.ts";
import { createQueue } from "./agents/queue.ts";
import { createDbMcp } from "./data/mcp.ts";
import { createProd } from "./data/prod.ts";
import { createSpend } from "./stats/spend.ts";
import { createStats } from "./stats/stats.ts";
import { ompAgentDirs } from "./sources/omp.ts";
import { loadMemory } from "./packs/core/assistant/bino/memory.ts";
import { routeOf, viaOf } from "./packs/core/assistant/bino/route.ts";
import { createGhe, missingGhe, viewer } from "./sources/ghe.ts";
import { forgeIdOf, pickForge } from "./forge/pick.ts";
import { githubForge } from "./forge/github.ts";
import { agyCli, claudeCli, codexCli, copilotComplete } from "./ai/llm.ts";
import { copilotCli } from "./ai/copilotcli.ts";
import { createSummaries } from "./ai/summaries.ts";
import { claudeHarness, createRunner, type Run } from "./agents/runner.ts";
import { ompHarness } from "./agents/omp.ts";
import { agyHarness } from "./agents/agy.ts";
import { codexHarness } from "./agents/codex.ts";
import { ompProfileOf } from "./sources/omp.ts";
import { liveAgents } from "./sources/claude.ts";
import { createHub, startRefresher, throttle } from "./live.ts";
import { createDocker, findEngineSocket, readPipe } from "./packs/core/docker/docker.ts";
import { createEngine } from "./packs/core/docker/engine.ts";
import { dockerPack } from "./packs/core/docker/index.ts";
import { agentsPack } from "./packs/core/agents/index.ts";
import { createHere } from "./packs/core/agents/here.ts";
import { localSessions } from "./sources/sessions.ts";
import { loadWorktrees } from "./sources/worktrees.ts";
import { createDismissed } from "./agents/dismissed.ts";
import { localDesk } from "./agents/desk.ts";
import { assistantPack } from "./packs/core/assistant/index.ts";
import { issuesPack } from "./packs/core/issues/index.ts";
import { terminalPack } from "./packs/core/terminal/index.ts";
import { findPrograms } from "./packs/core/terminal/programs.ts";
import { createTerminals } from "./packs/core/terminal/terms.ts";
import { type Need, needsOf } from "./home/needs.ts";
import { avatarPack } from "./packs/core/avatar/index.ts";
import type { AvatarFeeds } from "./packs/registry.ts";
import { listRepos } from "./sources/claude.ts";
import { listTodos } from "./todo/store.ts";
import { type Policy, createNotifier, createRinger, loadPolicy, type Note, savePolicy, windowsToast } from "./notify.ts";

const port = Number(process.env.PORT ?? 4848);
// Where the database is comes from the environment or .dev.vars; everything else may be set on Settings too.
const boot = loadEnv();
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
  writeFileSync(join(dataDir, `starting-${port}.html`), String(startingPage({ file: { base: `http://127.0.0.1:${port}`, up: `up-${port}.js`, icon: new URL("../assets/icon-192.png", import.meta.url).href, font: new URL("../assets/fonts/NordwandMono-Regular.woff2", import.meta.url).href, avatar: existsSync(join(dataDir, "avatar-start.svg")) ? "avatar-start.svg" : undefined } })));
} catch (e) {
  console.error("couldn't write the starting page:", (e as Error).message);
}
const db = openDb({ path: dbPath });
if (db.applied.length) console.log(`migrations applied: ${db.applied.join(", ")}`);
// What Settings keeps (src/config.ts), under the environment and .dev.vars.
let config = await loadConfig(db.DB);
let env = loadEnv(config);
setWhen({ tz: env.TZ_NAME, lang: env.GREETING });
const setup = { token: launch, port, dataDir, version, supervised };
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
const claude = findTool("claude", env.CLAUDE_BIN);
const omp = findTool("omp", env.OMP_BIN);
const agy = findTool("agy", env.AGY_BIN);
const codex = findTool("codex", env.CODEX_BIN);
// The agents pack uses only the CLIs switched on (AGENT_HARNESSES, Settings); Bino and summaries pick their own.
const harnessOn = harnessesOn(env.AGENT_HARNESSES);
found.harnesses = [...(claude && harnessOn("claude") ? (["claude"] as const) : []), ...(omp && harnessOn("omp") ? (["omp"] as const) : []), ...(agy && harnessOn("agy") ? (["agy"] as const) : []), ...(codex && harnessOn("codex") ? (["codex"] as const) : [])];
// Copilot CLI: Bino and summaries can ask through it (src/ai/copilotcli.ts); its sessions are read whether or not.
const copilotTool = findTool("copilot", env.COPILOT_BIN);
found.paths = { claude: claude?.path, omp: omp?.path, copilot: copilotTool?.path, agy: agy?.path, codex: codex?.path };
const pwsh = process.platform === "win32" && onPath("pwsh") ? "pwsh" : undefined;
const dbTool = findTool("db");
found.paths = { ...found.paths, pwsh: pwsh ? findTool("pwsh")?.path : undefined, db: dbTool?.path };
const hostExe = fileURLToPath(new URL(`../bin/dovre${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
// Which panes run (Settings, src/config.ts): one that's off, or can't run here, never starts its work.
// Copilot through omp, for whoever has no Claude Code: Bino and summaries talk through it. The crawler's
// asker (src/teams/crawl.ts): its own profile with no MCP servers, no tools, no session, an empty folder.
const copilotDir = join(dataDir, "copilot");
mkdirSync(copilotDir, { recursive: true });
const copilot = omp ? ompCrawler({ omp: { bin: omp.bin, pre: omp.pre }, profile: env.TEAMS_CRAWL_PROFILE || "dovre-copilot", model: env.TEAMS_CRAWL_MODEL || "github-copilot/gpt-6-luna:medium", cwd: copilotDir, run: runOff, who: { name: "Copilot through omp", profileVar: "TEAMS_CRAWL_PROFILE", modelVar: "TEAMS_CRAWL_MODEL" } }) : undefined;
found.copilot = copilot ? (copilot.why() ?? "ready") : undefined;
const copilotAsk = copilotTool ? copilotCli(copilotTool, { model: env.COPILOT_CLI_MODEL, log: (l) => console.log(l) }) : undefined;
const isWin = process.platform === "win32";
const dockerSocket = isWin ? undefined : findEngineSocket(env, homedir());
const panes = panesOf(env, { claude: !!claude, omp: !!omp, copilot: !!copilot && !copilot.why(), copilotCli: !!copilotTool, agy: !!agy, codex: !!codex, pwsh: !!pwsh, db: !!dbTool, terminals: existsSync(hostExe), windows: isWin, dockerSocket });
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
// A finished summary or a change in an agent run redraws the pages that show it, a few times a second at most.
const summariesChanged = throttle(() => hub.publish(["snapshot"]), 2000);
const summaryModel = !on.summaries ? undefined : panes.summaries.via === "claude" && claude ? claudeCli({ bin: claude.bin, pre: claude.pre }) : panes.summaries.via === "omp" && copilot ? copilotComplete(copilot) : panes.summaries.via === "copilot" ? copilotAsk : panes.summaries.via === "agy" && agy ? agyCli({ bin: agy.bin, pre: agy.pre }) : panes.summaries.via === "codex" && codex ? codexCli({ bin: codex.bin, pre: codex.pre }) : undefined;
const summaries = summaryModel ? createSummaries(db.DB, summaryModel, { onReady: summariesChanged }) : undefined;
await summaries?.load();
// The refresher keeps the snapshot fresh; pages only read it, and never wait for GHE when there's one to show.
let gathered = (_s: Snapshot) => {};
const gatherer = createGatherer({
  env, forge, login, name, summaries, ttlMs: 10 * 60_000,
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
const runner = createRunner({
  host: existsSync(hostExe) ? { exe: hostExe, dir: join(dataDir, "runs") } : undefined,
  // omp turns always say how to ask before acting: the user's own omp config approves everything.
  harnesses: {
    ...(claude && harnessOn("claude") ? { claude: { ...claudeHarness(claude.bin), pre: claude.pre } } : {}),
    ...(omp && harnessOn("omp") ? { omp: { ...ompHarness(omp.bin, { profileOf: (id) => ompProfileOf(id) }), pre: omp.pre } } : {}),
    ...(agy && harnessOn("agy") ? { agy: { ...agyHarness(agy.bin), pre: agy.pre } } : {}),
    ...(codex && harnessOn("codex") ? { codex: { ...codexHarness(codex.bin), pre: codex.pre } } : {}),
  },
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
/** What the packs say needs me (agents waiting…), what works and waits (the avatar's), and the PRs their pages link; set once the app is built. */
let packNeeds: () => Need[] = () => [];
let packFeeds = (): AvatarFeeds & { busy: boolean } => ({ working: 0, asking: 0, trouble: [], busy: false });
let packLinked = (): string[] => [];
const refresher = startRefresher({ gatherer, hub });
// What needs me rings once, checked again whenever pages are told something changed: a gather, or a
// pack's own read (the agents pack's sessions every 15 s).
hub.subscribe((c) => {
  const s = gatherer.peek();
  if (s && c.topics.includes("snapshot")) ring(notifier.observe([...needsOf(s), ...packNeeds()], policy));
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
const terminals = on.terminal ? createTerminals({ hostExe, codeDir: env.CODE_DIR, programs: findPrograms({ copilotBin: env.COPILOT_BIN, agyBin: env.AGY_BIN, codexBin: env.CODEX_BIN, on: harnessOn }), onChange: () => hub.publish(["snapshot"]) }) : undefined;
if (terminals) console.log(`terminals: ${terminals.programs().map((p) => p.id).join(", ")}`);

// Dovre's own packs (PLAN WP-H9), before the instance's. Assistant: Bino and Atlas, the range.yaml manifests under
// CODE_DIR. Terminal: the pty host above. Docker: Engine in its own WSL distro, served by the
// launcher on a pipe (launcher/docker.go).
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
  agentsPack({ desk, dismissed, here, onTurn: (fn) => (turnChanged = fn), longTurnMs: () => policy.longTurnMin * 60_000 }),
  // Bino's switch, and Atlas (the range.yaml manifests under CODE_DIR) unless PACK_ATLAS=off.
  assistantPack({ codeDir: /^(off|false|no|0)$/i.test((rawVars(config).PACK_ATLAS ?? "").trim()) ? undefined : env.CODE_DIR }),
  // My avatar: GHE's numbers shape it, the snapshot, My list and the packs set its scene.
  avatarPack({
    feeds: () => packFeeds(),
    ghe: { ghe, org: ownersIn(env), login: () => gatherer.peek()?.login },
    onStart: (svg) => writeFileSync(join(dataDir, "avatar-start.svg"), svg),
  }),
  // My open issues from the forge (/tracker), where the forge has them.
  issuesPack({ forge, owners: () => ownersIn(env), login: () => gatherer.peek()?.login, newHref: "/issues/new" }),
  ...(terminals ? [terminalPack(terminals)] : []),
  ...(on.docker
    ? [
        dockerPack((ctx) =>
          createDocker({
            engine: createEngine(() => (isWin ? env.DOCKER_PIPE || readPipe(join(dataDir, "docker-pipe")) : findEngineSocket(env, homedir()))),
            pipeFile: join(dataDir, "docker-pipe"),
            offFile: join(dataDir, "docker-off"),
            pipe: isWin ? env.DOCKER_PIPE : () => findEngineSocket(env, homedir()),
            ours: isWin && !env.DOCKER_PIPE,
            onChange: throttle(() => ctx.publish(["docker"]), 500),
            log: (kind, target, ok, error) => logAction(ctx.db, { kind, target, ok, error }),
          }),
        ),
      ]
    : []),
];

// Teams through Graph PowerShell's sign-in (src/teams/): a pwsh helper that only GETs an allow-list.
// What chats say stays in memory; on disk only that I connected (data/teams.json).
// Chats are kept encrypted (data/teams.key, wrapped by DPAPI); the crawler that proposes todos from them
// runs only on a Copilot model through omp, in its own profile with no MCP servers and no tools.
// The Data tab's query agent: a Copilot model through omp, like the crawler (never Claude), in its own empty folder.
const dataAgentDir = join(dataDir, "data-agent");
mkdirSync(dataAgentDir, { recursive: true });
const dataAsker =
  !on.data || env.DATA_AGENT === "off"
    ? undefined
    : ompCrawler({
        omp: omp ? { bin: omp.bin, pre: omp.pre } : undefined,
        profile: env.DATA_AGENT_PROFILE || env.TEAMS_CRAWL_PROFILE || "dovre-copilot",
        model: env.DATA_AGENT_MODEL || env.TEAMS_CRAWL_MODEL || "github-copilot/gpt-6-luna:medium",
        cwd: dataAgentDir,
        run: runOff,
        who: { name: "The query agent", profileVar: "DATA_AGENT_PROFILE", modelVar: "DATA_AGENT_MODEL" },
      });
const teamsCrawlDir = join(dataDir, "teams-crawl");
mkdirSync(teamsCrawlDir, { recursive: true });
const graph = pwsh && on.teams ? createHelper({ pwsh, script: fileURLToPath(new URL("../scripts/teams.ps1", import.meta.url)) }) : undefined;
const teams = !on.teams ? undefined : createTeams({
  helper: graph,
  marker: join(dataDir, "teams.json"),
  onChange: throttle(() => hub.publish(["snapshot"]), 1000),
  db: db.DB,
  keyFile: join(dataDir, "teams.key"),
  sinceDays: Number(env.TEAMS_SINCE_DAYS) > 0 ? Number(env.TEAMS_SINCE_DAYS) : 60,
  log: (a) => logAction(db.DB, a),
  crawler:
    env.TEAMS_CRAWL === "off"
      ? undefined
      : ompCrawler({ omp: omp ? { bin: omp.bin, pre: omp.pre } : undefined, profile: env.TEAMS_CRAWL_PROFILE || "dovre-copilot", model: env.TEAMS_CRAWL_MODEL || "github-copilot/gpt-6-luna:medium", cwd: teamsCrawlDir, run: runOff }),
  crawlEveryMs: env.TEAMS_CRAWL === "ask" ? 0 : undefined,
  me: () => gatherer.peek()?.name ?? "",
});

// Outlook and followed team channels through the same sign-in: read-only, held in memory only.
const microsoft = () => teams?.view().state === "ok";
const outlook = !on.outlook ? undefined : createOutlook({ helper: graph, connected: microsoft, onChange: throttle(() => hub.publish(["snapshot"]), 1000) });
const channels = !teams ? undefined : createChannels({ helper: graph, db: db.DB, connected: microsoft, onChange: throttle(() => hub.publish(["snapshot"]), 1000) });

// The Data tab: test databases through db-cli, which only reads (src/data/db.ts). Off without `db`.
const data = on.data && dbTool ? createData({ bin: dbTool.bin, pre: dbTool.pre, run: runOff }) : undefined;
// Production through `db mcp`: db asks before each database, and the question goes to the bar.
// It waits up to ten minutes for my answer; unanswered is a no.
const askMe = askInBar(asks, "db");
// Stats: GHE history every six hours (kept in data/stats.json), spend from the transcripts here.
const stats = !on.stats ? undefined : createStats({ ghe, org: ownersIn(env), login: () => gatherer.peek()?.login, spend: createSpend({ claudeDir: env.CLAUDE_DIR, ompDirs: ompAgentDirs().map((d) => d.dir) }), file: join(dataDir, "stats.json"), onChange: () => hub.publish(["stats"]) });
if (stats) {
  setInterval(() => stats.refresh(), 3600e3).unref();
  setTimeout(() => stats.refresh(), 90e3).unref();
}

const prod = data && dbTool ? createProd({ mcp: (onClose) => createDbMcp({ bin: dbTool.bin, pre: dbTool.pre, ask: askMe, onClose }), onChange: () => hub.publish(["prod"]) }) : undefined;

// Packs (PLAN D23): those PACKS loaded above that can run here, after the core's.
const packSet = { ...activePacks([...corePacks, ...loaded.packs], { env: packEnv, hosted: false, which: (b) => which(b) }), env: packEnv, core: corePacks.map((c) => c.manifest.id), varsFile: ".dev.vars" };
packSet.off.push(...loaded.failed);
for (const o of packSet.off) console.log(`pack ${o.id}: off, ${o.why}`);

const app = createApp({ ...env, DB: db.DB, LAUNCH_TOKEN: launch }, {
  packs: packSet,
  data,
  prod,
  stats,
  gatherer,
  ghe,
  forge,
  summaries,
  runner,
  hub,
  notify,
  info: { version, startedAt: Date.now() },
  kept: keptAnswers,
  teams,
  outlook,
  channels,
  schemaDir: join(dataDir, "schemas"),
  dataAsker,
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
    // Production closes with the server: db asks again after a restart.
    prod?.close();
    process.exit(75);
  },
});
// Packs start, then refresh on their own schedule (checked every 30 s); pages never wait for either.
const mountedPacks = packsOf(app)!;
packNeeds = mountedPacks.needs;
packFeeds = mountedPacks.feeds;
packLinked = mountedPacks.linked;
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
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  try {
    writeFileSync(upFile, `window.dovreUp = ${Date.now()};
`);
  } catch {}
  console.log(`dovre on http://127.0.0.1:${info.port} as ${login}`);
  console.log(`login:   ${maskedLogin(`http://127.0.0.1:${info.port}`)}`);
});

// Agent runs are this process's children: stop them with it, so nothing keeps editing a repo unseen.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    refresher.stop();
    // Agent turns run apart from the server (the agent host) and carry on; they show again after the restart.
    if (!existsSync(hostExe)) for (const r of runner.list()) if (r.status === "running") runner.stop(r.id);
    // Production closes with the server: db asks again after a restart.
    prod?.close();
    process.exit(0);
  });
