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
 *
 * The engine here is Apple's `container` (a light VM per container, macOS 26). Docker/berth can
 * sit behind the same `SandboxEngine` later.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { allowOf, type Egress, openEgress, PLACEHOLDER_TOKEN } from "./egress.ts";

export const SANDBOX_IMAGE = "dovre-sandbox";
/** The host-only network every box is on. */
export const SANDBOX_NET = "dovre-sandbox";
/** A repo's sandbox settings, read from its checkout at the run's base commit. */
export const SANDBOX_CONFIG = ".dovre/sandbox.json";

/** Where the subscription token is read from: SANDBOX_TOKEN_FILE, else ~/.dovre/sandbox-token. */
export const sandboxTokenFile = (v: string | undefined = process.env.SANDBOX_TOKEN_FILE, home = homedir()) => v?.trim() || join(home, ".dovre", "sandbox-token");

/** A sandbox run as the runner keeps it: its folder (the clone is `work/` in it), its container, the commit it started from, and the hosts it may reach. */
export type SandboxBox = { dir: string; name: string; base: string; allow?: string[] };

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
  /** The run is discarded: its whole folder goes. */
  remove(box: SandboxBox): void;
  /**
   * The run ended: a second container bundles its commits, and the bundle is fetched into `cwd`
   * (the checkout it was cloned from) as `branch`. Never throws: a failure is the answer's `why`.
   */
  collect(box: SandboxBox, o: { cwd: string; branch: string }): Promise<SandboxOut>;
  /**
   * Pushes `branch` from `cwd` to origin with the user's own git credentials, once it's checked:
   * still at `head`, and origin still `repo`. Hooks don't run. Throws why not.
   */
  push(o: { cwd: string; branch: string; head: string; repo: string }): Promise<void>;
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

/** The `container run` arguments for one run. `-i` so the prompt reaches the agent on stdin. */
export function containerArgs(o: { name: string; work: string; envFile: string; image: string; memory: string; cpus: number; network: string }, inner: string[]): string[] {
  return ["run", "--progress", "none", "--rm", "-i", "--name", o.name, "--network", o.network, "-m", o.memory, "-c", String(o.cpus), "--env-file", o.envFile, "-v", `${o.work}:/work`, "-w", "/work", o.image, ...inner];
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

export function appleContainer(o: { root: string; tokenFile?: string; image?: string; memory?: string; cpus?: number; maxMs?: number; bin?: string; exec?: Exec; git?: (args: string[], cwd: string) => string; hostGit?: HostGit; egress?: typeof openEgress }): SandboxEngine {
  const bin = o.bin ?? "container";
  const image = o.image ?? SANDBOX_IMAGE;
  const tokenFile = o.tokenFile ?? sandboxTokenFile();
  const run = o.exec ?? exec;
  const git = o.git ?? ((args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
  const hgit = o.hostGit ?? hostGit;
  const originOf = async (cwd: string) => originRepo(await hgit(["remote", "get-url", "origin"], cwd).catch(() => ""));
  const egress = o.egress ?? openEgress;
  /** Each box's key on the proxy. */
  const keys = new Map<string, string>();
  let proxy: Egress | undefined;
  let net: { gateway: string; subnet: string } | undefined;
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
      else if (!(await run(bin, ["image", "inspect", image])).ok) last = { ok: false, why: `The ${image} image isn't built: container build -t ${image} -f scripts/sandbox/Containerfile scripts/sandbox` };
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
      const token = readToken(tokenFile);
      if (!net || !proxy) throw new Error("The sandbox network isn't ready yet.");
      const way = proxy;
      const gateway = net.gateway;
      const dir = join(o.root, id);
      const work = join(dir, "work");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        const sha = git(["rev-parse", "--verify", `${base ?? "HEAD"}^{commit}`], repo);
        git(["clone", "-q", "--no-local", "--no-checkout", repo, work], dir);
        git(["checkout", "-q", "-b", "work", sha], work);
        git(["remote", "remove", "origin"], work);
        // Read from the real checkout at the base (cat-file: no filters run), so the agent can't widen it.
        const allow = allowOf((() => {
          try {
            return git(["cat-file", "blob", `${sha}:${SANDBOX_CONFIG}`], repo);
          } catch {
            return undefined;
          }
        })());
        const name = `dovre-${id.slice(0, 8)}`;
        const key = randomBytes(18).toString("base64url");
        writeFileSync(join(dir, "env"), boxEnv(gateway, way.port, key), { mode: 0o600 });
        way.add(key, { token, allow, ...(onDeny ? { onDeny } : {}) });
        keys.set(name, key);
        return { dir, name, base: sha, allow };
      } catch (e) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`Couldn't make the sandbox's clone: ${String((e as Error).message).split("\n")[0]}`);
      }
    },
    command: (box, inner) => ({ bin, args: containerArgs({ name: box.name, work: join(box.dir, "work"), envFile: envFile(box), image, memory: o.memory ?? "4g", cpus: o.cpus ?? 4, network: SANDBOX_NET }, inner) }),
    kill: (box) => void run(bin, ["kill", box.name]),
    ended: (box) => {
      const key = keys.get(box.name);
      if (key) proxy?.drop(key);
      keys.delete(box.name);
      rmSync(envFile(box), { force: true });
    },
    remove: (box) => rmSync(box.dir, { recursive: true, force: true }),
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
    async push({ cwd, branch, head, repo }) {
      if (!SHA.test(head) || !/^sandbox\/[\w-]{1,64}$/.test(branch)) throw new Error("That isn't a sandbox run's branch.");
      const now = (await hgit(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], cwd).catch(() => "")).trim();
      if (!now) throw new Error(`The branch ${branch} is gone from the checkout.`);
      if (now !== head) throw new Error(`The branch ${branch} changed since the run ended.`);
      if ((await originOf(cwd)) !== repo) throw new Error(`The checkout's origin isn't ${repo} any more.`);
      // --no-verify: the checkout's own pre-push hook would run on the host, next to the agent's work.
      await hgit(["push", "-q", "--no-verify", "origin", `refs/heads/${branch}:refs/heads/${branch}`], cwd, 180_000);
    },
    async dropBranch({ cwd, branch }) {
      if (!/^sandbox\/[\w-]{1,64}$/.test(branch)) return;
      await hgit(["branch", "-q", "-D", branch], cwd).catch(() => {});
    },
  };
}
