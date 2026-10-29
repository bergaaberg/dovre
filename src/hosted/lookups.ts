/**
 * Bino's lookups hosted (#262): Bino answers in the Durable Object, but the packs run in the Worker.
 * The object asks the Worker through a service binding to itself (BINO_LOOKUPS, entrypoint
 * `BinoLookups`): what may be looked up, and one lookup at a time, run by the Worker's packs as
 * locally. Only Workers in this account can call an entrypoint; it has no URL.
 *
 * The instance exports the entrypoint's shell (it needs `cloudflare:workers`, which core doesn't
 * import):
 *
 *   import { WorkerEntrypoint } from "cloudflare:workers";
 *   import { hostedLookups } from "dovre/hosted/lookups.ts";
 *   export class BinoLookups extends WorkerEntrypoint {
 *     async specs() { return (await hostedLookups(this.env)).specs(); }
 *     async run(l) { return (await hostedLookups(this.env)).run(l); }
 *   }
 *
 * and binds it: `"services": [{ "binding": "BINO_LOOKUPS", "service": "<this worker>", "entrypoint": "BinoLookups" }]`.
 */
import type { Lookup, Lookups, LookupSpec } from "../packs/core/assistant/bino/lookups.ts";

let host: ((env: unknown) => Promise<Lookups>) | undefined;

/** createWorker says how its packs are reached (one Worker a module). */
export function serveLookups(fn: (env: unknown) => Promise<Lookups>): void {
  host = fn;
}

/** The Worker's lookups, for its BinoLookups entrypoint; none until createWorker has run. */
export async function hostedLookups(env: unknown): Promise<Lookups> {
  if (!host) return { specs: () => [], run: async () => ({ text: "Lookups aren't set up in this Worker.", error: true }) };
  return host(env);
}

/** The binding as the object sees it: an RPC stub, so whatever it answers is checked again. */
export type LookupsBinding = { specs(): Promise<unknown>; run(l: Lookup): Promise<unknown> };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Lookups for the object, through its binding: answers checked, a failure an error, never a throw. */
export function lookupsVia(b: LookupsBinding): Lookups {
  return {
    async specs(): Promise<LookupSpec[]> {
      const got = await b.specs().catch(() => []);
      if (!Array.isArray(got)) return [];
      return got.slice(0, 16).flatMap((x): LookupSpec[] => {
        const s = x as Partial<LookupSpec>;
        if (!s || typeof s.kind !== "string" || !Array.isArray(s.fields)) return [];
        const fields = s.fields.slice(0, 6).map((f) => ({ name: str(f?.name, 32), about: str(f?.about, 160), required: f?.required === true, max: Math.max(1, Math.min(1000, Number(f?.max) || 200)) })).filter((f) => f.name);
        return [{ kind: str(s.kind, 80), app: str(s.app, 60), when: str(s.when, 400), fields }];
      });
    },
    async run(l) {
      try {
        const r = (await b.run({ kind: l.kind, args: { ...l.args } })) as { text?: unknown; error?: unknown } | undefined;
        return { text: str(r?.text, 8000), ...(r?.error ? { error: true } : {}) };
      } catch (e) {
        return { text: `The lookup didn't reach the Worker: ${String((e as Error)?.message ?? e).slice(0, 200)}`, error: true };
      }
    },
  };
}
