/**
 * Who is making the current write (hosted, PLAN D16): the verified email on a person's POST, set
 * around that request by src/worker.ts. Background work (pages' gathers, cron) runs as nobody, and
 * so does every local request: there the one person is the instance.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The person a write is made by: the verified email on a POST. Background work has none.
 * `own`: only this person's own token will do, never the instance's in its place. Their own
 * gather asks so (src/hosted/people.ts): gathered with another's token, it would show them that
 * person's notifications.
 */
export type Actor = { email: string; own?: true };

/**
 * What a token provider throws for an `own` actor who has no token of their own: told apart from
 * a failure, so a page can offer them the sign-in (#544, src/hosted/people.ts `guest`).
 */
export class NoOwnToken extends Error {
  constructor() {
    super("No GitHub token of your own: sign in with GitHub.");
    this.name = "NoOwnToken";
  }
}

const acting = new AsyncLocalStorage<Actor | undefined>();

/** The person the current call is for, if any. */
export const currentActor = (): Actor | undefined => acting.getStore();

/** Runs `fn` as `who`'s write (undefined: as nobody in particular, the instance's own). */
export const actingAs = <T>(who: Actor | undefined, fn: () => T): T => acting.run(who, fn);
