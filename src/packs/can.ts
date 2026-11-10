/**
 * `ctx.can` (#484): one answer for what works only on my own machine or needs my OK, in place of
 * each member saying it its own way. `{ ok: true }`, or `{ ok: false, why }` with a line for me.
 */
import type { PackAgentCan, PackAi, PackCan, PackCanWhat, PackMcpCan } from "./types.ts";

export type CanHere = { hosted: boolean; codeDir?: string; rings: boolean; ai: () => PackAi; agent: () => PackAgentCan; mcp: () => PackMcpCan };

export function packCan(what: PackCanWhat, here: CanHere): PackCan {
  const no = (why: string): PackCan => ({ ok: false, why });
  const local = (thing: string): PackCan => (here.hosted ? no(`${thing} only where Dovre runs on your own machine`) : { ok: true });
  switch (what) {
    case "ask":
      return local("Questions are asked");
    case "ring":
      return here.rings ? { ok: true } : no("Nothing rings here");
    case "acts":
      return local("Bino proposes cards");
    case "tools":
      return local("Agent turns run");
    case "checkouts":
      return here.hosted ? local("Checkouts are") : here.codeDir ? { ok: true } : no("No code folder is set (CODE_DIR)");
    case "programs":
      return local("Programs run");
    case "text": {
      const ai = here.ai();
      return ai.text ? { ok: true } : no(ai.why);
    }
    case "agent": {
      const a = here.agent();
      return a.ok ? { ok: true } : no(a.why);
    }
    case "mcp": {
      const m = here.mcp();
      return m.ok ? { ok: true } : no(m.why);
    }
    default:
      return no("Not something Dovre knows of");
  }
}
