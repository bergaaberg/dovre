/**
 * The owners Dovre tracks on its one host (PLAN WP-N9): orgs and users alike, from a
 * comma-separated setting (REPO_OWNERS; GHE_ORG and GITHUB_USER still read). Every guard that
 * keeps writes inside "my repos" asks `owns`; searches ask GitHub for all of them at once. What
 * only an org has (Issue Types, teams) goes to the first one.
 */

const OWNER = /^[\w.-]{1,100}$/;

/** The owners in a setting, each once, in order; anything that isn't a plain login is dropped. */
export function ownersOf(list: string | undefined | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(list ?? "").split(",")) {
    const o = raw.trim();
    if (!OWNER.test(o) || o === "." || o === ".." || seen.has(o.toLowerCase())) continue;
    seen.add(o.toLowerCase());
    out.push(o);
  }
  return out;
}

/** The first owner: where short names (`repo#12`) belong, and the org asked for org-only things. */
export const primaryOf = (list: string | undefined | null): string => ownersOf(list)[0] ?? "";

/** Is `owner` one of them? Logins are case-insensitive on GitHub. */
export const owns = (list: string | undefined | null, owner: string): boolean => ownersOf(list).some((o) => o.toLowerCase() === owner.toLowerCase());

/** For GitHub search: repos of any of them. `user:` matches orgs and users alike; repeated, it's an or. */
export const ownerQuery = (list: string | undefined | null): string => ownersOf(list).map((o) => `user:${o}`).join(" ");

/** The owners an instance tracks: OWNERS when loadEnv set it, else the single GHE_ORG. */
export const ownersIn = (env: { OWNERS?: string; GHE_ORG: string }): string => env.OWNERS || env.GHE_ORG;
