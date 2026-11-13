# Dovre on Cloudflare, step by step

`pnpm instance provision <folder> --deploy` goes from an instance folder (`pnpm instance new`) to a
working Dovre behind Cloudflare Access, with your laptop's bridge connected. This page says what
each step does, so you can see what it'll touch, or do it by hand in the dashboard.

It works the same on a new Cloudflare account and on one you already use:

- **Nothing yet:** it makes the Zero Trust team, a one-time-PIN login and a workers.dev subdomain.
  You don't need a domain.
- **Already set up:** your team, login methods, zones, other Access apps and service tokens are
  reused or left as they are. An Access app you already made for the host is adopted: its policies
  stay, and Dovre's join them.

Every step finds its thing by a fixed name and then **reuses**, **creates** or **fixes** it. So
running it again changes nothing, and after a failure it carries on from what's missing. It never
deletes anything. `--plan` prints the steps and changes nothing:

```text
$ pnpm instance provision ../home --plan
  create  workers.dev subdomain        home.workers.dev
  create  D1 database                  home-db
  create  Zero Trust team              home.cloudflareaccess.com
  create  Login method                 one-time PIN by email
  create  Bridge service token         dovre-bridge-home
  create  Policy "dovre home: people"  allow you@example.com
  create  Policy "dovre home: bridge"  service auth for dovre-bridge-home
  create  Access app                   self-hosted, home.home.workers.dev
  create  Bridge key                   BRIDGE_KEY, here and on the Worker
  create  GitHub token                 GITHUB_TOKEN from `gh auth token`
```

## Signing in

Two sign-ins, because `wrangler login` can't manage Access:

1. **`wrangler login`** (D1, secrets, deploy). Provision opens it if you aren't signed in.
2. **An API token for Access**, in `DOVRE_CF_API_TOKEN` (or `CLOUDFLARE_API_TOKEN`), or pasted when
   asked. It isn't saved anywhere. Provision prints a dashboard link that fills in the scopes:

   | Permission | Why |
   |---|---|
   | Access: Apps and Policies — Edit | the app and its two policies |
   | Access: Service Tokens — Edit | the bridge's token |
   | Access: Organizations, Identity Providers, and Groups — Edit | the team and a login, when there are none |
   | Workers Scripts — Edit | the workers.dev subdomain, when there's none |
   | Account Settings — Read | the account |

   With several accounts, pass `--account <id>` (from `wrangler whoami`).

## The steps

| Step | Found by | When it's missing | By hand |
|---|---|---|---|
| Where it lives | `--domain`, else workers.dev | claims `--subdomain` (default: the instance's name) | Workers → your subdomain |
| D1 database | the id in `wrangler.jsonc`, else the name | `wrangler d1 create` | `wrangler d1 create <name>` |
| Zero Trust team | the account's (there's one) | made as `--team` (default: the instance's name) | [one.dash.cloudflare.com](https://one.dash.cloudflare.com/), pick the Free plan |
| Login method | any the team has | adds one-time PIN by email | Settings → Authentication |
| Bridge service token | named `dovre-bridge-<worker>` | made, valid a year; renewed when a month is left | Access → Service credentials |
| People policy | named `dovre <worker>: people` | Allow, emails from `--email` (default: your Cloudflare email) | Access → Policies |
| Bridge policy | named `dovre <worker>: bridge` | Service Auth, that token | Access → Policies |
| Access app | the one whose domain is the host | Self-hosted, both policies | Access → Applications |
| `wrangler.jsonc` | — | `database_id`, `CF_ACCESS_TEAM`, `CF_ACCESS_AUD`, `ALLOWED_EMAILS`, `BRIDGE_CLIENT_ID`, `REPO_OWNERS`, `GITHUB_USER`; workers.dev on with `WORKERS_DEV_HOST` (the one workers.dev host the Worker serves), or the route on your domain | edit it |
| Bridge on this laptop | core's `.dev.vars` | `BRIDGE_URL`, `BRIDGE_KEY`, `BRIDGE_CLIENT_ID`, `BRIDGE_CLIENT_SECRET` | edit it |
| Worker secrets | `wrangler secret list` | `BRIDGE_KEY`; `GITHUB_TOKEN` from `gh auth token`, only if the Worker has none | `wrangler secret put` |
| Tables, deploy | — | `wrangler d1 migrations apply --remote`, then `wrangler deploy` (with `--deploy`) | the same |
| The bridge | — | on a Mac, `scripts/install-bridge.sh` (`--no-bridge` skips it); elsewhere `pnpm bridge` | the same |

Notes:

- **The app is on the hostname, not the Worker.** Access set on the Worker itself (the dashboard's
  "Protect this Worker") turns WebSocket upgrades away, and the bridge is a WebSocket. Provision
  makes a hostname app, which works on a workers.dev host too.
- **One bridge per instance.** A service token's secret is shown only when it's made. If this
  laptop doesn't have it, provision rotates the token (same id, a new secret) instead of making a
  second one. A bridge elsewhere that used the old secret then stops connecting.
- **A `.dev.vars` already used for another instance's bridge is left alone.** Provision says so
  and sets up no bridge. Pass `--vars <file>` for one of its own.
- **A new account:** if making the team fails, open one.dash.cloudflare.com once, pick the Free
  plan, and run provision again. If the team name is taken, pass `--team <another>`.
