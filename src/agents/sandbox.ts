/**
 * Sandbox runs (#201, #205): an agent turn in yolo mode (`--dangerously-skip-permissions`) inside
 * a container, so it needs no approvals and still reaches nothing of this machine.
 *
 * - Code in: a fresh clone of the checkout at a base commit, origin removed. Never a worktree:
 *   that shares `.git` with the real checkout, and the agent could plant hooks there that run on
 *   the host.
 * - The stream still goes through the agent host on the host, so `Keep` filters outside the box.
 * - Nothing of the host inside: no home folder, no `gh` token, no SSH agent, and not the
 *   subscription token either (#208). The token (`claude setup-token`, read from a 0600 file so a
 *   run never waits on a prompt) stays in the proxy on the host (src/agents/egress.ts), which
 *   adds it to the run's model calls; the box holds a placeholder and its run's key.
 * - The box's network is host-only (`dovre-sandbox`, made `--internal`): its one way out is that
 *   proxy, which tunnels only to the hosts the repo allows in `.dovre/sandbox.json` and reports
 *   the rest on the run.
 * - Yolo is only ever turned on by the runner for a sandbox run (`HarnessOpts.yolo`).
 * - A repo's toolchain (#208): an optional `.dovre/sandbox.Containerfile` at the base commit, built
 *   `FROM dovre-sandbox` with an empty context (nothing of the host goes in) and cached per base
 *   image and file. A run waits (refused with why) until its image is built.
 *
 * The engine here is Apple's `container` (a light VM per container, macOS 26). Docker/berth can
 * sit behind the same `SandboxEngine` later.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { allowOf, type Egress, openEgress, PLACEHOLDER_TOKEN } from "./egress.ts";

export const SANDBOX_IMAGE = "dovre-sandbox";
/** The host-only network every box is on. */
export const SANDBOX_NET = "dovre-sandbox";
/** A repo's sandbox settings, read from its checkout at the run's base commit. */
export const SANDBOX_CONFIG = ".dovre/sandbox.json";
/** A repo's toolchain on top of the base image, read from its checkout at the run's base commit. */
export const TOOLCHAIN_FILE = ".dovre/sandbox.Containerfile";

/** Where the subscription token is read from: SANDBOX_TOKEN_FILE, else ~/.dovre/sandbox-token. */
export const sandboxTokenFile = (v: string | undefined = process.env.SANDBOX_TOKEN_FILE, home = homedir()) => v?.trim() || join(home, ".dovre", "sandbox-token");

/** A sandbox run as the runner keeps it: its folder (the clone is `work/` in it), its container, the commit it started from, and the hosts it may reach. */
export type SandboxBox = { dir: string; name: string; base: string; allow?: string[]; image?: string; siblings?: string[] };

/** What a sandbox run needs from where it runs. */
export type SandboxEngine = {
  /** Whether a run can start now, and why not when it can't. Cheap: the last known answer. */
  state(): SandboxState;
  /** Makes the run's clone, env file and way out. `onDeny`: a host it tried and wasn't let reach. Throws with a reason a page can show. */
  prepare(o: { id: string; repo: string; base?: string; onDeny?: (host: string) => void }): SandboxBox;
  /** The program and arguments that run `inner` (the harness's command) inside the box. */
  command(box: SandboxBox, inner: string[]): { bin: string; args: string[] };
  /** Ends the container (Stop, the wall-clock cap). Killing the client alone may leave the VM running. */
  kill(box: SandboxBox): void;
  /** The run ended: its proxy closes and its env file goes. */
  ended(box: SandboxBox): void;
  /** The run is discarded, or its commits are home: its whole folder goes. */
  remove(box: SandboxBox): void;
  /** Removes run folders no run is kept for any more (`keep`: the boxes' dirs still wanted). Toolchain images' folders stay. */
  prune?(keep: string[]): void;
  /**
   * The run ended: a second container bundles its commits, and the bundle is fetched into `cwd`
   * (the checkout it was cloned from) as `branch`. Never throws: a failure is the answer's `why`.
   */
  collect(box: SandboxBox, o: { cwd: string; branch: string }): Promise<SandboxOut>;
  /**
   * Pushes `branch` from `cwd` to origin with the user's own git credentials, once it's checked:
   * still at `head`, and origin still `repo`. Hooks don't run. Throws why not. `to`: onto another
   * sandbox branch on origin instead (a fix session's commits onto its auto PR's branch, #326),
   * never forced, so it lands only on top of what's there.
   */
  push(o: { cwd: string; branch: string; head: string; repo: string; to?: string }): Promise<void>;
  /** Deletes the local branch a run came home as (discarded). Quietly does nothing when it can't. */
  dropBranch(o: { cwd: string; branch: string }): Promise<void>;
  /** How long a run may take before it's stopped. */
  maxMs: number;
};

export type SandboxState = { ok: true } | { ok: false; why: string };

/**
 * What a sandbox run made, once it ended (#206): its commits, fetched into the checkout it was
 * cloned from as branch `sandbox/<id>`, not pushed. `repo` is origin's `owner/name`, when origin
 * is on a forge; `ci`: the diff touches CI config, which runs with the repo's secrets on a push.
 */
export type SandboxOut =
  | { state: "collecting" }
  | { state: "none" }
  | { state: "failed"; why: string }
  | { state: "ready"; branch: string; base: string; head: string; repo?: string; commits: { sha: string; subject: string }[]; files: { path: string; add: number; del: number }[]; ci: boolean; pr?: { number: number; url: string } };

export type SandboxReady = Extract<SandboxOut, { state: "ready" }>;

/** CI config: what a push may run with the repo's secrets. */
export const CI_PATH = /^(?:\.github\/|\.gitlab-ci\.ya?ml$|\.circleci\/|\.buildkite\/|azure-pipelines\.ya?ml$|Jenkinsfile$|\.drone\.ya?ml$|bitbucket-pipelines\.yml$)/;

/** The branch a run's commits come home as. */
export const sandboxBranch = (id: string) => `sandbox/${id.slice(0, 8)}`;

/** `owner/name` from origin's URL (https, ssh or scp-like), else undefined. */
export function originRepo(url: string): string | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?[^/]+\/|ssh:\/\/(?:[^@/]+@)?[^/]+\/|[\w.-]+@[^:/]+:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m && m[1] !== "." && m[1] !== ".." && m[2] !== "." && m[2] !== ".." ? `${m[1]}/${m[2]}` : undefined;
}

/** `git diff --numstat -z --no-renames` into files, at most `max`. Binary files count 0/0. */
export function numstat(out: string, max = 300): { path: string; add: number; del: number }[] {
  const files: { path: string; add: number; del: number }[] = [];
  for (const rec of out.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec.replace(/^\n/, ""));
    if (!m) continue;
    files.push({ path: m[3]!, add: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]) });
    if (files.length >= max) break;
  }
  return files;
}

/**
 * The script the second container runs on the clone: what was left uncommitted is committed (no
 * hooks: the agent could have planted some), and the commits since the base go in a bundle. It
 * runs in the box, so no git on the host ever reads the clone's `.git`.
 */
export const BUNDLE_SCRIPT = [
  "set -e",
  "git -c core.hooksPath=/dev/null add -A",
  'git diff --cached --quiet || git -c core.hooksPath=/dev/null commit -q --no-verify -m "Uncommitted work from the sandbox run"',
  "git update-ref refs/heads/dovre-out HEAD",
  'n=$(git rev-list --count "$DOVRE_BASE"..HEAD)',
  'echo "$n" > /out/count',
  '[ "$n" = 0 ] || git bundle create -q /out/work.bundle refs/heads/dovre-out "^$DOVRE_BASE"',
].join("\n");

/** A bundle bigger than this isn't fetched. */
const MAX_BUNDLE = 200 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
/** A sandbox run's branch (`sandboxBranch`): the only kind a run's commits are pushed to. */
export const SANDBOX_BRANCH = /^sandbox\/[\w-]{1,64}$/;

type Exec = (bin: string, args: string[], ms?: number) => Promise<{ ok: boolean; out: string; err?: string }>;
const exec: Exec = (bin, args, ms = 15_000) => new Promise((res) => execFile(bin, args, { timeout: ms, maxBuffer: 8 * 1024 * 1024 }, (e, out, err) => res({ ok: !e, out: String(out ?? ""), err: String(err ?? "") })));
/** Git on the host, in the real checkout only (never in the agent-written clone): no prompts, no pager. */
type HostGit = (args: string[], cwd: string, ms?: number) => Promise<string>;
const hostGit: HostGit = (args, cwd, ms = 60_000) =>
  new Promise((res, rej) =>
    execFile("git", args, { cwd, timeout: ms, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" } }, (e, out, err) =>
      e ? rej(new Error(String(err || e.message).trim().split("\n").slice(-1)[0] || "git failed")) : res(String(out)),
    ),
  );

/** The `container run` arguments for one run. `-i` so the prompt reaches the agent on stdin. Each sibling's clone goes in read-only at `/siblings/<name>`. */
export function containerArgs(o: { name: string; work: string; envFile: string; image: string; memory: string; cpus: number; network: string; siblings?: { name: string; dir: string }[] }, inner: string[]): string[] {
  const sibs = (o.siblings ?? []).flatMap((s) => ["-v", `${s.dir}:/siblings/${s.name}:ro`]);
  return ["run", "--progress", "none", "--rm", "-i", "--name", o.name, "--network", o.network, "-m", o.memory, "-c", String(o.cpus), "--env-file", o.envFile, "-v", `${o.work}:/work`, ...sibs, "-w", "/work", o.image, ...inner];
}

const SIBLING = /^([\w.-]{1,100})\/([\w.-]{1,100})$/;

/**
 * The sibling repos `.dovre/sandbox.json` lists (`"siblings": ["owner/name", …]`): at most five,
 * each name once (it's the folder under `/siblings`). Anything that isn't a plain `owner/name` is dropped.
 */
export function siblingsOf(text: string | undefined): string[] {
  if (!text) return [];
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return [];
  }
  const list = v && typeof v === "object" && Array.isArray((v as { siblings?: unknown }).siblings) ? ((v as { siblings: unknown[] }).siblings as unknown[]) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const m = typeof raw === "string" ? SIBLING.exec(raw.trim()) : null;
    if (!m || [m[1], m[2]].some((p) => p === "." || p === "..") || seen.has(m[2]!.toLowerCase())) continue;
    seen.add(m[2]!.toLowerCase());
    out.push(`${m[1]}/${m[2]}`);
  }
  return out.slice(0, 5);
}

/** The box's environment: the model API and every other host through the proxy under its run's key, and a placeholder for the token. */
export function boxEnv(gateway: string, port: number, key: string): string {
  const proxy = `http://${key}:x@${gateway}:${port}`;
  return [
    `ANTHROPIC_BASE_URL=http://${gateway}:${port}/r/${key}`,
    `CLAUDE_CODE_OAUTH_TOKEN=${PLACEHOLDER_TOKEN}`,
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    ...["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].map((k) => `${k}=${proxy}`),
    `NO_PROXY=${gateway}`,
    `no_proxy=${gateway}`,
    "",
  ].join("\n");
}

/** The sandbox network's gateway and subnet, from `container network inspect`. */
export function netOf(json: string): { gateway: string; subnet: string } | undefined {
  try {
    const v = JSON.parse(json) as { configuration?: { mode?: string }; status?: { ipv4Gateway?: string; ipv4Subnet?: string } }[];
    const n = v[0];
    if (n?.configuration?.mode !== "hostOnly") return undefined;
    const gateway = n.status?.ipv4Gateway ?? "";
    const subnet = n.status?.ipv4Subnet ?? "";
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway) && /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(subnet) ? { gateway, subnet } : undefined;
  } catch {
    return undefined;
  }
}

/** The image's id from `container image inspect`, else undefined. */
export function imageIdOf(json: string): string | undefined {
  try {
    const id = (JSON.parse(json) as { id?: unknown }[])[0]?.id;
    return typeof id === "string" && /^[0-9a-f]{64}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Why a repo's toolchain file can't be built on the base image, else undefined: its last stage must be `FROM dovre-sandbox`. */
export function toolchainWhy(file: string, base = SANDBOX_IMAGE): string | undefined {
  const froms = file
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(l)?.[1])
    .filter((f): f is string => !!f);
  const last = froms.at(-1);
  if (!last) return `${TOOLCHAIN_FILE} has no FROM line.`;
  return last === base || last === `${base}:latest` ? undefined : `${TOOLCHAIN_FILE} must end on \`FROM ${base}\` (its last stage is \`FROM ${last}\`).`;
}

/** A start that failed because of the repo (its clone, siblings, toolchain, base ref), not the machine: trying again won't help (#344). */
export const repoError = (message: string): Error => Object.assign(new Error(message), { repo: true });
export const isRepoError = (e: unknown): boolean => (e as { repo?: unknown } | null)?.repo === true;

/** The toolchain image's tag: the repo's folder name, and a hash of the base image and the file, so either changing builds anew. */
export function toolchainTag(repo: string, baseId: string, file: string): string {
  const name = (repo.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "repo";
  return `${SANDBOX_IMAGE}-${name}:${createHash("sha256").update(`${baseId}\n${file}`).digest("hex").slice(0, 16)}`;
}

/** The same repo's other toolchain tags in an image list (`container image list --format json`), but for `keep` and those in use (#232). */
export function staleToolchains(listJson: string, tag: string, inUse: Iterable<string>): string[] {
  const repo = tag.slice(0, tag.lastIndexOf(":") + 1);
  const keep = new Set([tag, ...inUse]);
  let list: unknown;
  try {
    list = JSON.parse(listJson);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const i of list) {
    const name = String((i as { configuration?: { name?: unknown } })?.configuration?.name ?? "").replace(/^(?:docker\.io\/)?(?:library\/)?/, "");
    if (name.startsWith(repo) && /^[0-9a-f]{16}$/.test(name.slice(repo.length)) && !keep.has(name)) out.push(name);
  }
  return out;
}

/** A toolchain image's folder under `<root>/.toolchain`. */
const toolchainDir = (tag: string) => tag.replace(/[^\w.-]+/g, "_");

/** The token as written by `claude setup-token`: one line, no spaces. */
export function readToken(file: string): string {
  let t: string;
  try {
    t = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`No sandbox token at ${file}. Run \`claude setup-token\` and save the token there (chmod 600).`);
  }
  if (!t || /\s/.test(t)) throw new Error(`The sandbox token at ${file} isn't one line.`);
  return t;
}

/** A run's folder under the root: its id, a UUID. */
const RUN_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Free space a run needs before it starts: its clone, its container, and what the agent builds. */
export const MIN_FREE = 10 * 2 ** 30;
const freeBytes = (dir: string): number => {
  const st = statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
};

export function appleContainer(o: { root: string; /** Free bytes on the disk holding `dir` (tests). */ free?: (dir: string) => number; checkout?: (repo: string) => string | undefined; tokenFile?: string; image?: string; memory?: string; cpus?: number; maxMs?: number; bin?: string; exec?: Exec; git?: (args: string[], cwd: string) => string; hostGit?: HostGit; egress?: typeof openEgress }): SandboxEngine {
  const bin = o.bin ?? "container";
  const image = o.image ?? SANDBOX_IMAGE;
  const tokenFile = o.tokenFile ?? sandboxTokenFile();
  const run = o.exec ?? exec;
  const git = o.git ?? ((args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
  /** A fetch from origin, bounded and never prompting. */
  const fetchGit = o.git ?? ((args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim());
  const hgit = o.hostGit ?? hostGit;
  const originOf = async (cwd: string) => originRepo(await hgit(["remote", "get-url", "origin"], cwd).catch(() => ""));
  const egress = o.egress ?? openEgress;
  /** Each box's key on the proxy. */
  const keys = new Map<string, string>();
  let proxy: Egress | undefined;
  let net: { gateway: string; subnet: string } | undefined;
  /** The base image's id, from the last check: part of every toolchain image's tag. */
  let baseId: string | undefined;
  /** Toolchain images by tag: there, being built, or failed (tried again after a while). */
  const images = new Map<string, { state: "ready" } | { state: "building" } | { state: "failed"; why: string; at: number }>();
  /** The toolchain image each prepared or running box uses, by box name. */
  const using = new Map<string, string>();
  /** After a build: removes the same repo's older toolchain images no box uses, and their folders (#232). */
  const pruneToolchains = async (tag: string) => {
    const inUse = [...using.values()];
    const list = await run(bin, ["image", "list", "--format", "json"]);
    for (const old of list.ok ? staleToolchains(list.out, tag, inUse) : []) {
      if ((await run(bin, ["image", "delete", old])).ok) images.delete(old);
    }
    // Folders go by name, even when their image is already gone.
    const keep = new Set([tag, ...inUse].map(toolchainDir));
    const prefix = toolchainDir(tag.slice(0, tag.lastIndexOf(":") + 1));
    let dirs: string[] = [];
    try {
      dirs = readdirSync(join(o.root, ".toolchain"));
    } catch {
      return;
    }
    for (const d of dirs) if (d.startsWith(prefix) && /^[0-9a-f]{16}$/.test(d.slice(prefix.length)) && !keep.has(d)) rmSync(join(o.root, ".toolchain", d), { recursive: true, force: true });
  };
  /** Makes sure a toolchain image is there: built from the file alone, with an empty context, so nothing of the host goes in. */
  const toolchain = async (tag: string, file: string) => {
    images.set(tag, { state: "building" });
    try {
      if ((await run(bin, ["image", "inspect", tag])).ok) return void images.set(tag, { state: "ready" });
      const dir = join(o.root, ".toolchain", toolchainDir(tag));
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, "context"), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "Containerfile"), file, { mode: 0o600 });
      const r = await run(bin, ["build", "--progress", "plain", "-t", tag, "-f", join(dir, "Containerfile"), join(dir, "context")], 30 * 60_000);
      writeFileSync(join(dir, "build.log"), `${r.out}\n${r.err ?? ""}`, { mode: 0o600 });
      if (r.ok) {
        images.set(tag, { state: "ready" });
        await pruneToolchains(tag).catch(() => undefined);
      } else images.set(tag, { state: "failed", why: (r.err || r.out).trim().split("\n").slice(-1)[0]?.slice(0, 200) || "the build failed", at: Date.now() });
    } catch (e) {
      images.set(tag, { state: "failed", why: String((e as Error).message).split("\n")[0] ?? "the build failed", at: Date.now() });
    }
  };
  /** The image a run at `sha` uses: the base, or its repo's toolchain once built. Throws why it can't start yet. */
  const imageFor = (repo: string, sha: string): string => {
    let file: string;
    try {
      file = git(["cat-file", "blob", `${sha}:${TOOLCHAIN_FILE}`], repo);
    } catch {
      return image;
    }
    const bad = toolchainWhy(file, image);
    if (bad) throw repoError(bad);
    if (!baseId) throw new Error(`The ${image} image isn't checked yet.`);
    const tag = toolchainTag(repo, baseId, file);
    const st = images.get(tag);
    if (st?.state === "ready") return tag;
    if (st?.state === "failed" && Date.now() - st.at < 10 * 60_000) throw repoError(`This repo's toolchain image (${TOOLCHAIN_FILE}) didn't build: ${st.why}`);
    if (st?.state !== "building") void toolchain(tag, file);
    throw new Error(`This repo's toolchain image (${TOOLCHAIN_FILE}) is being built; the run can start once it's ready.`);
  };
  let last: SandboxState = { ok: false, why: "Checking the sandbox engine." };
  let checked = 0;
  let checking = false;
  /** The host-only network, made once. */
  const network = async () => {
    let r = await run(bin, ["network", "inspect", SANDBOX_NET]);
    if (!netOf(r.out)) {
      await run(bin, ["network", "create", "--internal", SANDBOX_NET]);
      r = await run(bin, ["network", "inspect", SANDBOX_NET]);
    }
    return netOf(r.out);
  };
  /** Engine up, image built, token there, network host-only. Run in the background; `state()` returns the last answer. */
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const sys = await run(bin, ["system", "status"]);
      if (!sys.ok) last = { ok: false, why: "Apple container isn't running: `brew install container`, then `container system start`." };
      else if (!(baseId = imageIdOf((await run(bin, ["image", "inspect", image])).out))) last = { ok: false, why: `The ${image} image isn't built: container build -t ${image} -f scripts/sandbox/Containerfile scripts/sandbox` };
      else if (!existsSync(tokenFile)) last = { ok: false, why: `No sandbox token at ${tokenFile}: run \`claude setup-token\` and save it there.` };
      else if (!(net = await network())) last = { ok: false, why: `The ${SANDBOX_NET} network isn't host-only: \`container network rm ${SANDBOX_NET}\` and Dovre makes it again.` };
      else if (!(proxy ??= await egress({ subnet: net.subnet }).catch(() => undefined))) last = { ok: false, why: "The sandbox's proxy couldn't start." };
      else last = { ok: true };
    } finally {
      checked = Date.now();
      checking = false;
    }
  };
  if (process.platform === "darwin" || o.exec) void check();
  else last = { ok: false, why: "Sandbox runs need Apple container (macOS 26) for now." };
  const envFile = (box: SandboxBox) => join(box.dir, "env");
  return {
    maxMs: o.maxMs ?? 60 * 60_000,
    state() {
      if (Date.now() - checked > 30_000 && (process.platform === "darwin" || o.exec)) void check();
      return last;
    },
    prepare({ id, repo, base, onDeny }) {
      // A full disk fails runs halfway (and everything else on the machine): don't start one into it.
      mkdirSync(o.root, { recursive: true, mode: 0o700 });
      const free = (o.free ?? (o.exec ? () => Infinity : freeBytes))(o.root);
      if (free < MIN_FREE) throw new Error(`Only ${(free / 2 ** 30).toFixed(1)} GB free on this machine's disk; a sandbox run needs ${MIN_FREE / 2 ** 30} GB.`);
      const token = readToken(tokenFile);
      if (!net || !proxy) throw new Error("The sandbox network isn't ready yet.");
      const way = proxy;
      const gateway = net.gateway;
      let sha: string;
      try {
        try {
          sha = git(["rev-parse", "--verify", `${base ?? "HEAD"}^{commit}`], repo);
        } catch (e) {
          // A commit this checkout hasn't seen (a PR's head pushed from elsewhere, #326): fetched once from origin.
          if (!base || !SHA.test(base)) throw e;
          fetchGit(["fetch", "-q", "--no-tags", "--no-write-fetch-head", "origin", base], repo);
          sha = git(["rev-parse", "--verify", `${base}^{commit}`], repo);
        }
      } catch (e) {
        throw repoError(`Couldn't find the run's base commit: ${String((e as Error).message).split("\n")[0]}`);
      }
      // Read from the real checkout at the base, so the agent can't change it.
      const img = imageFor(repo, sha);
      const dir = join(o.root, id);
      const work = join(dir, "work");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // The base may be on no branch here (a fetched id, or `origin/main` ahead of a local main that's
      // behind): a branch points at it while the clone is made, so the clone has it, and goes right after.
      const pin = base ? `refs/heads/sandbox/base-${id.slice(0, 8)}` : undefined;
      try {
        try {
          if (pin) git(["update-ref", pin, sha], repo);
          git(["clone", "-q", "--no-local", "--no-checkout", repo, work], dir);
        } finally {
          if (pin) {
            try {
              git(["update-ref", "-d", pin], repo);
            } catch {}
          }
        }
        git(["checkout", "-q", "-b", "work", sha], work);
        git(["remote", "remove", "origin"], work);
        // Read from the real checkout at the base (cat-file: no filters run), so the agent can't widen it.
        const config = (() => {
          try {
            return git(["cat-file", "blob", `${sha}:${SANDBOX_CONFIG}`], repo);
          } catch {
            return undefined;
          }
        })();
        const allow = allowOf(config);
        // Siblings: a fresh clone of each from its checkout here (one of your repos), at origin's
        // default branch when the checkout knows it, else its HEAD. Mounted read-only.
        const siblings: string[] = [];
        for (const s of siblingsOf(config)) {
          const from = o.checkout?.(s);
          if (!from) throw new Error(`${s} (a sibling in ${SANDBOX_CONFIG}) has no checkout here`);
          const name = s.split("/")[1]!;
          const to = join(dir, "siblings", name);
          git(["clone", "-q", "--no-local", "--no-checkout", from, to], dir);
          try {
            git(["fetch", "-q", "--no-tags", "origin", "refs/remotes/origin/HEAD"], to);
            git(["checkout", "-q", "--detach", "FETCH_HEAD"], to);
          } catch {
            git(["checkout", "-q", "--detach", "HEAD"], to);
          }
          git(["remote", "remove", "origin"], to);
          siblings.push(name);
        }
        const name = `dovre-${id.slice(0, 8)}`;
        const key = randomBytes(18).toString("base64url");
        writeFileSync(join(dir, "env"), boxEnv(gateway, way.port, key), { mode: 0o600 });
        way.add(key, { token, allow, ...(onDeny ? { onDeny } : {}) });
        keys.set(name, key);
        if (img !== image) using.set(name, img);
        return { dir, name, base: sha, allow, ...(img !== image ? { image: img } : {}), ...(siblings.length ? { siblings } : {}) };
      } catch (e) {
        rmSync(dir, { recursive: true, force: true });
        // git's own reason is its last line on stderr; the first line only repeats the command.
        const why = String((e as { stderr?: unknown }).stderr ?? "").trim().split("\n").pop() || String((e as Error).message).split("\n")[0];
        throw repoError(`Couldn't make the sandbox's clone: ${why}`);
      }
    },
    command: (box, inner) => ({ bin, args: containerArgs({ name: box.name, work: join(box.dir, "work"), envFile: envFile(box), image: box.image ?? image, memory: o.memory ?? "4g", cpus: o.cpus ?? 4, network: SANDBOX_NET, siblings: (box.siblings ?? []).map((n) => ({ name: n, dir: join(box.dir, "siblings", n) })) }, inner) }),
    kill: (box) => void run(bin, ["kill", box.name]),
    ended: (box) => {
      const key = keys.get(box.name);
      if (key) proxy?.drop(key);
      keys.delete(box.name);
      using.delete(box.name);
      rmSync(envFile(box), { force: true });
    },
    remove: (box) => rmSync(box.dir, { recursive: true, force: true }),
    prune(keep) {
      const wanted = new Set(keep.map((d) => resolve(d)));
      let names: string[] = [];
      try {
        names = readdirSync(o.root);
      } catch {
        return;
      }
      // Only folders named as runs are (their ids); never .toolchain or anything else in the root.
      for (const n of names) if (RUN_DIR.test(n) && !wanted.has(resolve(o.root, n))) rmSync(join(o.root, n), { recursive: true, force: true });
    },
    async collect(box, { cwd, branch }) {
      const out = join(box.dir, "out");
      try {
        if (!SHA.test(box.base)) return { state: "failed", why: "The run's base commit isn't known." };
        if (!existsSync(join(box.dir, "work"))) return { state: "failed", why: "The sandbox's clone is gone." };
        rmSync(out, { recursive: true, force: true });
        mkdirSync(out, { recursive: true, mode: 0o700 });
        const r = await run(bin, ["run", "--progress", "none", "--rm", "--name", `${box.name}-out`, "--network", SANDBOX_NET, "-m", "1g", "-e", `DOVRE_BASE=${box.base}`, "-v", `${join(box.dir, "work")}:/work`, "-v", `${out}:/out`, "-w", "/work", image, "sh", "-c", BUNDLE_SCRIPT], 180_000);
        if (!r.ok) return { state: "failed", why: `Couldn't bundle its commits: ${(r.err || r.out).trim().split("\n").slice(-1)[0] || "the container failed"}` };
        const n = Number.parseInt(readFileSync(join(out, "count"), "utf8").trim(), 10);
        if (!Number.isFinite(n) || n < 0) return { state: "failed", why: "Couldn't tell how many commits it made." };
        if (n === 0) return { state: "none" };
        const bundle = join(out, "work.bundle");
        if (statSync(bundle).size > MAX_BUNDLE) return { state: "failed", why: "Its commits are too big to bring home (over 200 MB)." };
        // Only objects and one ref come in: a fetch runs nothing from the bundle.
        await hgit(["fetch", "-q", "--no-tags", "--no-write-fetch-head", bundle, `+refs/heads/dovre-out:refs/heads/${branch}`], cwd, 120_000);
        const head = (await hgit(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], cwd)).trim();
        const range = `${box.base}..${head}`;
        const commits = (await hgit(["log", "--no-show-signature", "--format=%H%x1f%s", "-n", "50", range, "--"], cwd))
          .split("\n")
          .map((l) => l.split("\x1f"))
          .filter((p) => SHA.test(p[0] ?? ""))
          .map(([sha, subject]) => ({ sha: sha!, subject: (subject ?? "").slice(0, 200) }));
        const files = numstat(await hgit(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", box.base, head, "--"], cwd));
        const all = (await hgit(["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", box.base, head, "--"], cwd)).split("\0").filter(Boolean);
        const repo = await originOf(cwd);
        return { state: "ready", branch, base: box.base, head, ...(repo ? { repo } : {}), commits, files, ci: all.some((p) => CI_PATH.test(p)) };
      } catch (e) {
        return { state: "failed", why: `Couldn't bring its commits home: ${String((e as Error).message).split("\n")[0]}` };
      } finally {
        rmSync(join(out, "work.bundle"), { force: true });
      }
    },
    async push({ cwd, branch, head, repo, to }) {
      if (!SHA.test(head) || !SANDBOX_BRANCH.test(branch)) throw new Error("That isn't a sandbox run's branch.");
      if (to !== undefined && !SANDBOX_BRANCH.test(to)) throw new Error("A run's commits go only onto a sandbox run's branch.");
      const now = (await hgit(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], cwd).catch(() => "")).trim();
      if (!now) throw new Error(`The branch ${branch} is gone from the checkout.`);
      if (now !== head) throw new Error(`The branch ${branch} changed since the run ended.`);
      if ((await originOf(cwd)) !== repo) throw new Error(`The checkout's origin isn't ${repo} any more.`);
      // --no-verify: the checkout's own pre-push hook would run on the host, next to the agent's work.
      // Never forced: onto `to`, it lands only when the branch there is the run's base or behind it.
      await hgit(["push", "-q", "--no-verify", "origin", `refs/heads/${branch}:refs/heads/${to ?? branch}`], cwd, 180_000);
    },
    async dropBranch({ cwd, branch }) {
      if (!SANDBOX_BRANCH.test(branch)) return;
      await hgit(["branch", "-q", "-D", branch], cwd).catch(() => {});
    },
  };
}
