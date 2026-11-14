# Dovre on Cloudflare, step by step

`pnpm instance provision <folder> --deploy` goes from an instance folder (`pnpm instance new`) to a
working Dovre on Cloudflare, with your laptop's bridge connected. This page says what each step
does, so you can see what it'll touch, or do it by hand.

## Two ways in

- **The built-in login (the default).** Dovre signs you in itself, with a passkey. Setting it up
  needs only `wrangler login`: no API token, no Zero Trust, no domain (it's served at
  `<worker>.<your subdomain>.workers.dev`). Provision prints a link that makes your passkey; it
  works once, within a day. Another device, or every one lost: `provision --login-link`.
- **Cloudflare Access (`--access`).** Cloudflare checks who you are before a request reaches the
  Worker. It needs an API token besides `wrangler login`, because wrangler's login can't manage
  Access. Pick it if you already use Zero Trust, or want Cloudflare's edge in front.

With the built-in login every request reaches the Worker, which then checks the session: passkeys
are made only through a claim link, sessions are random tokens kept as hashes in D1, and every
sign-in POST is same-origin and rate-limited. The bridge proves `BRIDGE_KEY` on each dial.

**Sign in with GitHub, too (`--github`).** Provision makes the instance's own GitHub App through
GitHub's manifest flow: it opens a page on `127.0.0.1`, you check the app's name on GitHub and click
"Create GitHub App", and GitHub hands back the app's id, client secret and private key. The secrets
go up as `GITHUB_APP_CLIENT_SECRET` and `GITHUB_APP_PRIVATE_KEY`, and the ids go in `wrangler.jsonc`
as `GITHUB_APP_ID` and `GITHUB_APP_CLIENT_ID`. `--github-org <org>` makes it under an organisation.
The app is private and has no webhook. Sign-in uses PKCE and a state tied to the browser, and comes
in as a *verified* email on your GitHub account that `ALLOWED_EMAILS` names. With `ALLOWED_EMAILS`
empty, nobody gets in through GitHub. Passkeys keep working alongside it. Remove the client secret
and the GitHub sessions end.

**GitHub as you, instead of `GITHUB_TOKEN`.** With the app, provision puts a random
`GITHUB_TOKEN_SEAL` and doesn't upload `gh auth token`. Each sign-in with GitHub keeps that
person's user token and refresh token in D1 (`github_tokens`), sealed with AES-GCM under that
secret. Dovre then calls GitHub with them:

- A person's write goes as them.
- Pages, the background snapshot and cron go as the operator: `GITHUB_USER`'s row, else the first
  `ALLOWED_EMAILS` entry that has one.
- When nobody has signed in with GitHub yet, it's `GITHUB_TOKEN` if the Worker has one, else GitHub
  calls fail and say so.

Tokens are refreshed before their 8 hours run out. A refresh GitHub refuses (the app uninstalled or
the grant revoked) marks the row revoked until the next sign-in. A token only reaches repos that
the app is **installed** on, so install it on each owner in `REPO_OWNERS` (provision prints the
link). It then asks for contents, pull requests, issues, actions and deployments (write), checks,
statuses and Dependabot alerts (read), and your email addresses. GitHub App tokens can't read
notifications, so Today's notifications stay empty. A new `GITHUB_TOKEN_SEAL` makes the kept
tokens unreadable, so everyone has to sign in with GitHub again.

By hand: make a GitHub App with the callback URL `https://<host>/_auth/github/callback`, "Expire
user authorization tokens" on, and the permissions above. Then set `GITHUB_APP_CLIENT_ID` as a var,
and `GITHUB_APP_CLIENT_SECRET` and `GITHUB_TOKEN_SEAL` (32+ random characters) with
`wrangler secret put`.

```text
$ pnpm instance provision ../home --plan
  create  workers.dev subdomain  home.workers.dev
  create  D1 database            home-db
  create  Login                  built-in passkeys (AUTH_MODE=passkey); no Cloudflare Access
  create  Bridge key             BRIDGE_KEY, here and on the Worker
  create  GitHub token           GITHUB_TOKEN from `gh auth token`
  create  Passkey link           for you@example.com, once, within a day
```

Every step finds its thing by a fixed name and then **reuses**, **creates** or **fixes** it. So
running it again changes nothing, and after a failure it carries on from what's missing. It never
deletes anything. `--plan` prints the steps and changes nothing.

# With Cloudflare Access (`--access`)

It works the same on a new Cloudflare account and on one you already use:

- **Nothing yet:** it makes the Zero Trust team, a one-time-PIN login and a workers.dev subdomain.
- **Already set up:** your team, login methods, zones, other Access apps and service tokens are
  reused or left as they are. An Access app you already made for the host is adopted: its policies
  stay, and Dovre's join them.

```text
$ pnpm instance provision ../home --access --plan
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

## Signing in (Access)

Two sign-ins, because `wrangler login` can't manage Access:

1. **`wrangler login`** (D1, secrets, deploy). Provision opens it if you aren't signed in.
2. **An API token for Access**, in `DOVRE_CF_API_TOKEN` (setting it means `--access`), or pasted when
   asked. It isn't saved anywhere. Provision prints a dashboard link that fills in the scopes:

   | Permission | Why |
   |---|---|
   | Access: Apps and Policies — Edit | the app and its two policies |
   | Access: Service Tokens — Edit | the bridge's token |
   | Access: Organizations, Identity Providers, and Groups — Edit | the team and a login, when there are none |
   | Workers Scripts — Edit | the workers.dev subdomain, when there's none |
   | Account Settings — Read | the account |

   With several accounts, pass `--account <id>` (from `wrangler whoami`).

## The steps (Access)

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
| Worker secrets | `wrangler secret list` | `BRIDGE_KEY`; `GITHUB_TOKEN` from `gh auth token`, only if the Worker has none and there's no GitHub App; with the app, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_TOKEN_SEAL` | `wrangler secret put` |
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
