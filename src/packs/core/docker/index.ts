/**
 * Docker, a core pack (PLAN WP-H9): the containers on the engine the launcher serves
 * (launcher/docker.go, scripts/docker.ps1). Windows only; Settings' Docker pane decides whether
 * the machine adds it, and PACK_DOCKER=off or Layout turns it off like any pack.
 * What it may do, and that logs are never kept, is docker.ts's header.
 */
import { type Pack, PACK_API, type PackContext } from "../../types.ts";
import type { Docker } from "./docker.ts";
import { dockerRoutes } from "./routes.ts";

/** `make` builds the service once the pack starts, from its context (publish, the actions log). */
export function dockerPack(make: (ctx: PackContext) => Docker): Pack {
  let docker: Docker | undefined;
  const get = () => {
    if (!docker) throw new Error("docker hasn't started");
    return docker;
  };
  return {
    manifest: {
      api: PACK_API,
      id: "docker",
      name: "Docker",
      description: "Containers on Docker Engine in its own WSL distro: start, stop, logs",
      domain: "general",
      execution: "local-only",
      settings: [{ key: "DOCKER_PIPE", label: "Another engine's pipe instead of the launcher's (Docker Desktop's is \\\\.\\pipe\\docker_engine)" }],
    },
    init(ctx) {
      docker = make(ctx);
    },
    // The engine's event stream keeps it fresh; this is the slow fallback.
    refresh: async () => get().refresh(),
    dispose: () => docker?.stop(),
    nav: () => [{ href: "/docker", title: "Docker", icon: "box", group: "Ops" }],
    pages: () => [{ title: "Docker", href: "/docker", icon: "▣", about: "Containers: start, stop, logs", also: ["containers", "compose", "engine", "wsl", "logs"] }],
    routes: (app, ctx) => dockerRoutes(app, get, ctx.page),
  };
}
