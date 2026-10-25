/** Which forge an instance uses: FORGE names it; unset (or "github") is GitHub. */
import type { Pack } from "../packs/types.ts";
import type { Forge } from "./types.ts";

export const forgeIdOf = (want: string | undefined) => (want?.trim().toLowerCase() || "github");

/**
 * The forge FORGE names, from the packs that bring one. A name no pack brings, or one whose
 * `create` throws, gives a forge whose every call fails saying why: pages show the gather as failed,
 * never another forge's data.
 */
export function pickForge(want: string | undefined, packs: Pack[], github: () => Forge, env: Record<string, string | undefined>): Forge {
  const id = forgeIdOf(want);
  if (id === "github") return github();
  const decl = packs.find((p) => p.forge && p.forge.id.toLowerCase() === id)?.forge;
  if (!decl) return brokenForge(id, `No pack brings the forge "${id}" (FORGE). Add the pack that does to PACKS.`);
  try {
    return decl.create(env);
  } catch (e) {
    return brokenForge(id, `The ${decl.name} forge didn't start: ${(e as Error)?.message ?? e}`);
  }
}

export function brokenForge(id: string, why: string): Forge {
  const fail = () => Promise.reject(new Error(why));
  return { id, name: id, host: "", can: [], viewer: fail, prs: fail, notes: fail, moves: fail, prRefs: fail, prKeyOfUrl: () => undefined };
}
