# {{name}}

A Dovre instance: this machine's packs and its hosted Worker at {{domain}}. Dovre's core is a
checkout beside it (`../dovre`); this repo never goes into core, and core never names it.

## From here to a deployed Dovre

1. `pnpm install` (core is linked from `../dovre`).
2. `pnpm wrangler d1 create {{db}}`, and put the id it prints in `wrangler.jsonc`.
3. In Cloudflare Zero Trust, make a self-hosted Access application for {{domain}} with a policy
   for you. Put the team name in `CF_ACCESS_TEAM`, the application's AUD tag in `CF_ACCESS_AUD`,
   and your email in `ALLOWED_EMAILS` (wrangler.jsonc, vars).
4. Set `REPO_OWNERS` and `GITHUB_USER`, then `pnpm wrangler secret put GITHUB_TOKEN`
   (fine-grained, read-only on those repos).
5. `pnpm deploy:worker`: it applies core's migrations to D1, then deploys.

Open {{domain}}. Until D1, its tables and Access are there, the Worker shows a page listing what's
missing (names only). Once in, Settings → Setup lists the rest: live pages (HUB), Bino's model
(`CF_AIG_TOKEN`), the Mac's agents (`BRIDGE_CLIENT_ID`, `BRIDGE_KEY`).

## Packs

`pnpm --dir ../dovre pack new <id> --into .` starts one in the shape core expects, then add it to
`packs.ts`. Locally, core's `PACKS` setting lists this folder. Packs (under You) shows each
one on or off and why.

`pnpm typecheck && pnpm test` before committing.
