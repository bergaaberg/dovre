/**
 * For a pack's tests: a PackContext with harmless defaults (nothing gathered, an empty page, no
 * slots filled), so a test names only what it needs and keeps compiling when the context grows.
 * A pack imports it as `dovre/packs/testing.ts`.
 */
import type { D1 } from "../db.ts";
import type { PackContext } from "./types.ts";

export function testContext(over: Partial<PackContext> = {}): PackContext {
  return {
    env: {},
    bindings: {},
    hosted: false,
    db: undefined as unknown as D1,
    publish: () => {},
    snapshot: () => undefined,
    gathered: async () => undefined,
    fill: () => [],
    page: async () => new Response(),
    dockPage: () => new Response(),
    log: () => {},
    ring: () => {},
    ask: async () => ({ action: "cancel" }),
    asking: () => false,
    pulse: () => ({ working: 0, asking: 0, trouble: [], busy: false }),
    ...over,
  };
}
