/**
 * Docker in Dovre: the containers on the engine the launcher serves (launcher/docker.go,
 * scripts/docker.ps1), kept fresh by the engine's own event stream (a fallback read every 30 s),
 * never read per page. A change publishes "docker" on the hub.
 *
 * What it may do is a short list: start, stop, restart and remove a container (never its volumes),
 * the same for a compose project's containers, and the engine on or off. Each re-reads the
 * container first, runs in the background (a page redirects at once), and goes to the actions log
 * by name. Nothing creates, runs or execs; nothing pulls.
 *
 * Logs are streamed to the page that asked and dropped: never kept, logged, put in the snapshot or
 * given to a model. A container's output can hold connection strings and data.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { type Engine, demuxer } from "./engine.ts";
import { type Container, ID_RE, type Verb, allowed, parseContainers, shapeOf } from "./model.ts";

export type DockerView = {
  /** none: no engine set up; off: switched off here; starting; down: set up but not answering; ok. */
  state: "none" | "off" | "starting" | "down" | "ok";
  pipe?: string;
  /** Whether Dovre runs this engine (its own distro), so it can switch it on and off. */
  ours: boolean;
  containers: Container[];
  version?: string;
  at?: number;
  error?: string;
  /** Containers with an action under way, by id → what. */
  busy: Record<string, Verb>;
  /** The last action's outcome, until the page has shown it. */
  flash?: { ok: boolean; message: string };
};

export type Docker = {
  view(): DockerView;
  /** The flash, once: the page that shows it takes it. */
  takeFlash(): DockerView["flash"];
  refresh(): Promise<void>;
  act(id: string, verb: Verb): { ok: boolean; message: string };
  project(name: string, verb: "start" | "stop" | "restart"): { ok: boolean; message: string };
  engine(on: boolean): { ok: boolean; message: string };
  /** Follows a container's logs (the last 300 lines first) until `signal` aborts. */
  logs(id: string, out: (text: string) => void, signal: AbortSignal): Promise<{ ok: boolean; error?: string }>;
  find(id: string): Container | undefined;
  stop(): void;
};

export const DISTRO = "dovre-docker";

/** The pipe the launcher wrote it serves; only a local pipe's name is taken from the file. */
export function readPipe(file: string): string | undefined {
  try {
    const p = readFileSync(file, "utf8").trim();
    return /^\\\\\.\\pipe\\[\w.-]{1,80}$/.test(p) || /^\/[\w./-]{1,200}\.sock$/.test(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * On macOS and Linux, finds the Docker Engine socket using the first one that exists:
 * 1. DOCKER_PIPE, if set (already supported)
 * 2. DOCKER_HOST, when it's unix://… (ignore tcp:// hosts: Dovre never talks to a remote engine)
 * 3. ~/.docker/run/docker.sock (Docker Desktop)
 * 4. ~/.orbstack/run/docker.sock (OrbStack)
 * 5. ~/.colima/default/docker.sock (Colima)
 * 6. $XDG_RUNTIME_DIR/docker.sock (rootless)
 * 7. /var/run/docker.sock (native dockerd)
 */
export function findEngineSocket(
  env: Record<string, string | undefined>,
  home: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const candidates: (string | undefined)[] = [];
  if (env.DOCKER_PIPE) candidates.push(env.DOCKER_PIPE);
  const host = env.DOCKER_HOST?.trim();
  if (host?.startsWith("unix://")) {
    candidates.push(host.replace(/^unix:\/\/?\/?/, "/"));
  }
  if (home) {
    candidates.push(posix.join(home, ".docker", "run", "docker.sock"));
    candidates.push(posix.join(home, ".orbstack", "run", "docker.sock"));
    candidates.push(posix.join(home, ".colima", "default", "docker.sock"));
  }
  if (env.XDG_RUNTIME_DIR) {
    candidates.push(posix.join(env.XDG_RUNTIME_DIR, "docker.sock"));
  }
  candidates.push("/var/run/docker.sock");

  return candidates.find((p): p is string => Boolean(p && exists(p)));
}

export function createDocker(opts: {
  engine: Engine;
  /** Written by the launcher: the pipe it serves. */
  pipeFile: string;
  /** Its presence switches the engine off (the launcher lets the distro go). */
  offFile: string;
  /** A pipe or socket to use instead (DOCKER_PIPE: Docker Desktop's, say); Dovre then can't switch it. */
  pipe?: string | (() => string | undefined);
  /** Whether Dovre owns this engine (can switch on/off, runs WSL distro). Off Windows, ours is false. */
  ours?: boolean;
  onChange?: () => void;
  log?: (kind: string, target: string, ok: boolean, error?: string) => Promise<void>;
  /** Stops the distro at once (wsl --terminate); for tests, a fake. */
  terminate?: () => Promise<void>;
  everyMs?: number;
  now?: () => number;
}): Docker {
  const { engine } = opts;
  const now = opts.now ?? Date.now;
  const terminate = opts.terminate ?? (() => new Promise<void>((res) => execFile("wsl.exe", ["--terminate", DISTRO], { windowsHide: true }, () => res())));
  const pipeOf = () => (typeof opts.pipe === "function" ? opts.pipe() : opts.pipe) || readPipe(opts.pipeFile);
  const isWindows = process.platform === "win32";
  const ours = opts.ours ?? (isWindows && !opts.pipe);
  const isOff = () => ours && existsSync(opts.offFile);
  let view: DockerView = { state: pipeOf() ? "down" : "none", pipe: pipeOf(), ours, containers: [], busy: {} };
  let shape = "";
  let starting = 0;
  const set = (next: Partial<DockerView>) => {
    const before = `${view.state}|${view.error}|${JSON.stringify(view.busy)}|${!!view.flash}|${shape}`;
    view = { ...view, ...next };
    if (next.containers) shape = shapeOf(next.containers);
    const after = `${view.state}|${view.error}|${JSON.stringify(view.busy)}|${!!view.flash}|${shape}`;
    if (before !== after) opts.onChange?.();
  };

  let reading: Promise<void> | undefined;
  const refresh = () =>
    (reading ??= (async () => {
      const pipe = pipeOf();
      if (!pipe) return set({ state: "none", pipe, containers: [], error: undefined });
      if (isOff()) return set({ state: "off", pipe, containers: [], error: undefined });
      try {
        const [list, ver] = await Promise.all([engine.json("GET", "/containers/json?all=1"), view.version ? undefined : engine.json("GET", "/version")]);
        if (list.status !== 200) throw new Error(`Docker answered ${list.status}`);
        const version = ver && ver.status === 200 && typeof (ver.body as { Version?: unknown }).Version === "string" ? String((ver.body as { Version: string }).Version).slice(0, 40) : view.version;
        starting = 0;
        set({ state: "ok", pipe, containers: parseContainers(list.body), version, at: now(), error: undefined });
        follow();
      } catch (e) {
        // Just switched on: the distro and dockerd take a few seconds.
        const waiting = starting && now() - starting < 60_000;
        set({ state: waiting ? "starting" : "down", pipe, error: waiting ? undefined : (e as Error).message, version: undefined });
      }
    })().finally(() => (reading = undefined)));

  // The engine's events: any container change reads the list again (a burst reads it once).
  let events: AbortController | undefined;
  let soon: ReturnType<typeof setTimeout> | undefined;
  const again = () => {
    clearTimeout(soon);
    soon = setTimeout(() => void refresh(), 300);
  };
  let stopped = false;
  function follow() {
    if (events || stopped) return;
    const ac = new AbortController();
    events = ac;
    const filters = encodeURIComponent(JSON.stringify({ type: ["container"] }));
    engine
      .stream(`/events?filters=${filters}`, () => again(), ac.signal)
      .catch(() => {})
      .finally(() => {
        if (events === ac) events = undefined;
        // The stream ended (the engine restarted, say): follow again after a pause.
        if (!ac.signal.aborted && !stopped) setTimeout(() => void refresh(), 5000).unref?.();
      });
  }
  const timer = setInterval(() => void refresh(), opts.everyMs ?? 30_000);
  timer.unref?.();
  void refresh();

  const inspect = async (id: string): Promise<Container | undefined> => {
    await refresh();
    return view.containers.find((c) => c.id === id);
  };
  const run = async (c: Container, verb: Verb): Promise<string | undefined> => {
    const path = verb === "remove" ? `/containers/${c.id}` : `/containers/${c.id}/${verb}`;
    const r = await engine.json(verb === "remove" ? "DELETE" : "POST", path);
    // 304: already as asked. Anything else above 299 is Docker's refusal, in its words.
    if (r.status >= 300 && r.status !== 304) return (r.body as { message?: string })?.message?.slice(0, 300) ?? `Docker answered ${r.status}`;
    return undefined;
  };
  const PAST = { start: "Started", stop: "Stopped", restart: "Restarted", remove: "Removed" } as const;

  return {
    view: () => view,
    takeFlash() {
      const f = view.flash;
      if (f) view = { ...view, flash: undefined };
      return f;
    },
    refresh,
    find: (id) => view.containers.find((c) => c.id === id),
    act(id, verb) {
      if (!ID_RE.test(id)) return { ok: false, message: "That isn't a container." };
      if (view.busy[id]) return { ok: false, message: "That container is busy already." };
      if (view.state !== "ok") return { ok: false, message: "Docker isn't running." };
      set({ busy: { ...view.busy, [id]: verb } });
      void (async () => {
        let ok = false;
        let error: string | undefined;
        let name = id.slice(0, 12);
        try {
          const c = await inspect(id);
          if (!c) error = "It's gone.";
          else {
            name = c.name;
            if (!allowed(verb, c.state)) error = `It's ${c.state} now.`;
            else error = await run(c, verb);
            ok = !error;
          }
        } catch (e) {
          error = (e as Error).message;
        }
        await opts.log?.(`docker.${verb}`, name, ok, error).catch(() => {});
        const { [id]: _, ...busy } = view.busy;
        set({ busy, flash: ok ? { ok, message: `${PAST[verb]} ${name}.` } : { ok, message: `Couldn't ${verb} ${name}: ${error}` } });
        await refresh();
      })();
      return { ok: true, message: "" };
    },
    project(name, verb) {
      const cs = view.containers.filter((c) => c.project === name && allowed(verb, c.state) && !view.busy[c.id]);
      if (!cs.length) return { ok: false, message: `Nothing in ${name} to ${verb}.` };
      set({ busy: { ...view.busy, ...Object.fromEntries(cs.map((c) => [c.id, verb])) } });
      void (async () => {
        const failed: string[] = [];
        // One after another: compose's own order isn't known here, and a database first is the usual need.
        for (const c of cs.sort((a, b) => a.name.localeCompare(b.name))) {
          const error = await run(c, verb).catch((e: Error) => e.message);
          if (error) failed.push(`${c.name}: ${error}`);
        }
        await opts.log?.(`docker.project.${verb}`, name, !failed.length, failed.slice(0, 3).join("; ") || undefined).catch(() => {});
        const busy = { ...view.busy };
        for (const c of cs) delete busy[c.id];
        set({ busy, flash: failed.length ? { ok: false, message: `${name}: ${failed.join("; ")}` } : { ok: true, message: `${PAST[verb]} ${name} (${cs.length}).` } });
        await refresh();
      })();
      return { ok: true, message: "" };
    },
    engine(on) {
      if (!ours || !pipeOf()) return { ok: false, message: "This engine isn't Dovre's to switch." };
      if (on) {
        rmSync(opts.offFile, { force: true });
        starting = now();
        set({ state: "starting", error: undefined });
        // The launcher attaches within two seconds; dockerd then takes a few more.
        void (async () => {
          for (let i = 0; i < 30 && view.state !== "ok" && !isOff(); i++) {
            await new Promise((r) => setTimeout(r, 2000));
            await refresh();
          }
        })();
      } else {
        writeFileSync(opts.offFile, "");
        events?.abort();
        events = undefined;
        set({ state: "off", containers: [], busy: {} });
        void terminate();
      }
      void opts.log?.(on ? "docker.engine.on" : "docker.engine.off", DISTRO, true).catch(() => {});
      return { ok: true, message: on ? "Starting Docker…" : "Docker is off." };
    },
    async logs(id, out, signal) {
      if (!ID_RE.test(id) || view.state !== "ok") return { ok: false, error: "Docker isn't running." };
      try {
        const info = await engine.json("GET", `/containers/${id}/json`);
        if (info.status !== 200) return { ok: false, error: "That container is gone." };
        const tty = !!(info.body as { Config?: { Tty?: boolean } })?.Config?.Tty;
        const text = new TextDecoder("utf-8");
        const emit = (b: Buffer) => out(text.decode(b, { stream: true }));
        await engine.stream(`/containers/${id}/logs?follow=1&stdout=1&stderr=1&tail=300`, tty ? emit : demuxer(emit), signal);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(soon);
      events?.abort();
    },
  };
}
