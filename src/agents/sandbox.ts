/**
 * Sandbox runs (#201, #205): an agent turn in yolo mode (`--dangerously-skip-permissions`) inside
 * a container, so it needs no approvals and still reaches nothing of this machine.
 *
 * - Code in: a fresh clone of the checkout at a base commit, origin removed. Never a worktree:
 *   that shares `.git` with the real checkout, and the agent could plant hooks there that run on
 *   the host.
 * - The stream still goes through the agent host on the host, so `Keep` filters outside the box.
 * - Nothing of the host inside: no home folder, no `gh` token, no SSH agent. The one secret is the
 *   subscription token (`claude setup-token`), read from a 0600 file so a run never waits on a
 *   prompt, and passed in through a 0600 env file that goes when the run ends.
 * - Yolo is only ever turned on by the runner for a sandbox run (`HarnessOpts.yolo`).
 *
 * The engine here is Apple's `container` (a light VM per container, macOS 26). Docker/berth can
 * sit behind the same `SandboxEngine` later.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SANDBOX_IMAGE = "dovre-sandbox";

/** Where the subscription token is read from: SANDBOX_TOKEN_FILE, else ~/.dovre/sandbox-token. */
export const sandboxTokenFile = (v: string | undefined = process.env.SANDBOX_TOKEN_FILE, home = homedir()) => v?.trim() || join(home, ".dovre", "sandbox-token");

/** A sandbox run as the runner keeps it: its folder (the clone is `work/` in it), its container, the commit it started from. */
export type SandboxBox = { dir: string; name: string; base: string };

/** What a sandbox run needs from where it runs. */
export type SandboxEngine = {
  /** Whether a run can start now, and why not when it can't. Cheap: the last known answer. */
  state(): SandboxState;
  /** Makes the run's clone and env file. Throws with a reason a page can show. */
  prepare(o: { id: string; repo: string; base?: string }): SandboxBox;
  /** The program and arguments that run `inner` (the harness's command) inside the box. */
  command(box: SandboxBox, inner: string[]): { bin: string; args: string[] };
  /** Ends the container (Stop, the wall-clock cap). Killing the client alone may leave the VM running. */
  kill(box: SandboxBox): void;
  /** The run ended: the token's env file goes. */
  ended(box: SandboxBox): void;
  /** The run is discarded: its whole folder goes. */
  remove(box: SandboxBox): void;
  /** How long a run may take before it's stopped. */
  maxMs: number;
};

export type SandboxState = { ok: true } | { ok: false; why: string };

type Exec = (bin: string, args: string[]) => Promise<{ ok: boolean; out: string }>;
const exec: Exec = (bin, args) => new Promise((res) => execFile(bin, args, { timeout: 15_000 }, (e, out) => res({ ok: !e, out: String(out ?? "") })));

/** The `container run` arguments for one run. `-i` so the prompt reaches the agent on stdin. */
export function containerArgs(o: { name: string; work: string; envFile: string; image: string; memory: string; cpus: number }, inner: string[]): string[] {
  return ["run", "--progress", "none", "--rm", "-i", "--name", o.name, "-m", o.memory, "-c", String(o.cpus), "--env-file", o.envFile, "-v", `${o.work}:/work`, "-w", "/work", o.image, ...inner];
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

export function appleContainer(o: { root: string; tokenFile?: string; image?: string; memory?: string; cpus?: number; maxMs?: number; bin?: string; exec?: Exec; git?: (args: string[], cwd: string) => string }): SandboxEngine {
  const bin = o.bin ?? "container";
  const image = o.image ?? SANDBOX_IMAGE;
  const tokenFile = o.tokenFile ?? sandboxTokenFile();
  const run = o.exec ?? exec;
  const git = o.git ?? ((args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
  let last: SandboxState = { ok: false, why: "Checking the sandbox engine." };
  let checked = 0;
  let checking = false;
  /** Engine up, image built, token there. Run in the background; `state()` returns the last answer. */
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const sys = await run(bin, ["system", "status"]);
      if (!sys.ok) last = { ok: false, why: "Apple container isn't running: `brew install container`, then `container system start`." };
      else if (!(await run(bin, ["image", "inspect", image])).ok) last = { ok: false, why: `The ${image} image isn't built: container build -t ${image} -f scripts/sandbox/Containerfile scripts/sandbox` };
      else if (!existsSync(tokenFile)) last = { ok: false, why: `No sandbox token at ${tokenFile}: run \`claude setup-token\` and save it there.` };
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
    prepare({ id, repo, base }) {
      const token = readToken(tokenFile);
      const dir = join(o.root, id);
      const work = join(dir, "work");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        const sha = git(["rev-parse", "--verify", `${base ?? "HEAD"}^{commit}`], repo);
        git(["clone", "-q", "--no-local", "--no-checkout", repo, work], dir);
        git(["checkout", "-q", "-b", "work", sha], work);
        git(["remote", "remove", "origin"], work);
        writeFileSync(join(dir, "env"), `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`, { mode: 0o600 });
        return { dir, name: `dovre-${id.slice(0, 8)}`, base: sha };
      } catch (e) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`Couldn't make the sandbox's clone: ${String((e as Error).message).split("\n")[0]}`);
      }
    },
    command: (box, inner) => ({ bin, args: containerArgs({ name: box.name, work: join(box.dir, "work"), envFile: envFile(box), image, memory: o.memory ?? "4g", cpus: o.cpus ?? 4 }, inner) }),
    kill: (box) => void run(bin, ["kill", box.name]),
    ended: (box) => rmSync(envFile(box), { force: true }),
    remove: (box) => rmSync(box.dir, { recursive: true, force: true }),
  };
}
