/**
 * Whom the current request is for (hosted, Team T4): the verified email of the person whose page
 * or action this is, set around each request by src/app.ts. It decides what's private to someone:
 * the agents desk shows each person only the machines they paired (src/bridge/remote.ts).
 * Background work (cron, a gather) and every local request have none.
 *
 * Not src/actor.ts: that one names who a write to GitHub is made as (POSTs only, when the
 * instance tells people apart); this one is every request's reader.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const viewing = new AsyncLocalStorage<string | undefined>();

/** The person the current request is for (lowercased), if any. */
export const currentViewer = (): string | undefined => viewing.getStore();

/** Runs `fn` for `email`'s request. */
export const viewingAs = <T>(email: string | undefined, fn: () => T): T => viewing.run(email?.trim().toLowerCase() || undefined, fn);

/** Whether something `owner` paired is `viewer`'s to see: nobody's (shared) is everyone's. */
export const sees = (viewer: string | undefined, owner: string | undefined): boolean => !owner || (!!viewer && owner.trim().toLowerCase() === viewer);
