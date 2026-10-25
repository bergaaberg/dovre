/**
 * Terminals, a core pack (PLAN WP-H9c): shells and agent CLIs from a fixed list (programs.ts),
 * in a checkout right under CODE_DIR, run in the launcher's pty host (terms.ts), on /terminal…
 * behind the stricter guard (routes.ts), output in memory only. What it puts in core pages goes
 * through slots: the panel on Agents, a worktree's button, resuming an ended session here.
 * Local only; Settings' Terminal pane decides whether the machine adds it, and PACK_TERMINAL=off
 * or Layout turns it off like any pack.
 */
import { type Pack, PACK_API } from "../../types.ts";
import { terminalRoutes } from "./routes.ts";
import type { Terminals } from "./terms.ts";
import { agentsPanel, resumeButton, worktreeButton } from "./view.ts";

export function terminalPack(terminals: Terminals): Pack {
  return {
    manifest: {
      api: PACK_API,
      id: "terminal",
      name: "Terminal",
      description: "Shells and agent CLIs in a checkout, inside Dovre",
      domain: "general",
      execution: "local-only",
    },
    nav: () => [{ href: "/terminal", title: "Terminal", icon: "agents", group: "Agents" }],
    pages: () => [{ title: "Terminal", href: "/terminal", icon: ">_", about: "Shells and agent CLIs in a checkout", also: ["shell", "pwsh", "console", "cmd", "open a terminal"] }],
    slots: () => ({
      "agents.panel": () => agentsPanel(terminals.list()),
      "worktree.actions": ({ name }) => worktreeButton(name),
      "session.resume": ({ session }) => resumeButton(session),
    }),
    routes: (app, ctx) => terminalRoutes(app, terminals, ctx),
  };
}
