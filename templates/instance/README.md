# {{name}}

A Dovre instance: this machine's packs and its hosted Worker at {{domain}}. Dovre's core is a
checkout beside it (`../dovre`); this repo never goes into core, and core never names it.

## From here to a deployed Dovre

In `../dovre`:

```sh
pnpm instance provision <this folder> --plan     # what it'll do; changes nothing
pnpm instance provision <this folder> --deploy
```

It makes or reuses D1 and its tables and `BRIDGE_KEY`, sets `GITHUB_TOKEN` from `gh auth token`
(unless the Worker has one), deploys, starts the bridge on a Mac, and prints the link that makes
your passkey (the built-in login; `--access` puts Cloudflare Access in front instead). With no
`--domain` it's served at `{{name}}.<your subdomain>.workers.dev`. Run it again any time: it fixes what's missing and makes
nothing twice. Each step, and the same by hand: `../dovre/docs/CLOUDFLARE.md`.

Once in, Settings → Setup lists the rest, such as Bino's model (`CF_AIG_TOKEN`).

## Packs

In `../dovre`, `pnpm packs new <id> --into <this folder>` starts one in the shape core expects, then add it to
`packs.ts`. Locally, core's `PACKS` setting lists this folder. Packs (under You) shows each
one on or off and why.

`pnpm typecheck && pnpm test` before committing.
