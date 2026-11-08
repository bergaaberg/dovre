/**
 * The assistant, a core pack (PLAN WP-M4): Bino. PACK_ASSISTANT=off switches it off.
 *
 * It mounts Bino's pages (/bino, its conversations and the pane, routes.ts) under its own `paths`.
 * Bino's engine (conversations, memory, its model route) is still run by the core (src/app.ts,
 * src/hosted/hub.ts), which hands it to this pack (bino/host.ts). Topo, what each repo is (peak.yaml),
 * is its own pack in bergaaberg/dovre-packs (`pnpm packs add topo`, #147).
 */
import { type Pack, PACK_API } from "../../types.ts";
import { createBinoRoutes } from "./bino/routes.ts";
import { assistantHostOf } from "./bino/host.ts";
import { VIA_CHOICES } from "./bino/route.ts";

const MANIFEST = {
  api: PACK_API,
  id: "assistant",
  name: "Assistant",
  description: "Bino: scoped memory, what the packs know about your repos and apps, and plan proposals",
  domain: "general",
  roles: ["dev", "lead", "po", "op", "an"],
  paths: ["bino"],
} as const;

export function assistantPack(): Pack {
  const pack: Pack = {
    manifest: {
      ...MANIFEST,
      roles: [...MANIFEST.roles],
      paths: [...MANIFEST.paths],
      // How Bino answers (#417): read when Dovre starts. Unset: Claude Code if it's here, else Copilot.
      settings: [{ key: "ASSISTANT_VIA", label: "How it answers", help: "Applies when Dovre starts again. Its default: Claude Code if it's here, else Copilot.", choices: VIA_CHOICES.map((c) => ({ ...c })) }],
    },
    routes(app, ctx) {
      const host = assistantHostOf(pack);
      if (!host) return;
      app.route(
        "/",
        createBinoRoutes(
          { DB: ctx.db, GHE_ORG: host.org },
          {
            bino: host.bino,
            page: async () => ({ frame: await host.frame() }),
            hub: { publish: (topics) => ctx.publish(topics) },
            peek: () => ctx.snapshot(),
            packAct: (kind) => host.packAct(kind),
            list: host.list,
            assets: host.assets,
            context: host.context,
            apps: () => host.apps(),
          },
        ),
      );
    },
  };
  return pack;
}
