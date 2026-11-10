/**
 * The ids of Dovre's own packs (the folders in `core/`). They're wired by closure (#480) and get the plain
 * settings, bindings and database; every other pack reads its own through views (#475, #484). One
 * list, so local, hosted, the demo and the tests can't disagree on who's core.
 */
export const CORE_PACKS: readonly string[] = ["agents", "assistant", "autoreview", "dependabot", "deploys", "history", "prs", "reviews", "stacks", "terminal", "todo", "tracker"];
