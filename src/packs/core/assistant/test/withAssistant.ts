// Test apps get Bino as an instance does: through core's assistant pack, which mounts its pages.
import { CORE_PACKS } from "../../../own.ts";
import { activePacks } from "../../../registry.ts";
import type { Pack } from "../../../types.ts";
import { assistantPack } from "../index.ts";

export const withAssistant = (others: Pack[] = [], o: { env?: Record<string, string>; hosted?: boolean } = {}) => {
  const env = o.env ?? {};
  return { ...activePacks([assistantPack(), ...others], { env, hosted: o.hosted ?? false }), env, core: [...CORE_PACKS] };
};
