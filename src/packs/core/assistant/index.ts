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

const MANIFEST = {
  api: PACK_API,
  id: "assistant",
  name: "Assistant",
  description: "Bino: scoped memory, what the packs know about your repos and apps, and plan proposals",
  domain: "general",
  paths: ["bino"],
} as const;

export function assistantPack(): Pack {
  const pack: Pack = {
    manifest: { ...MANIFEST, paths: [...MANIFEST.paths] },
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
