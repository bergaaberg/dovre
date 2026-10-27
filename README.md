# Dovre

**A self-hosted cockpit for your repos, CI and coding agents.** Runs on your machine, your own server, or Cloudflare Workers.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) · **[Try the demo](https://demo.dovre.dev)** · [dovre.dev](https://dovre.dev) · [Docs](https://dovre.dev/docs)

[![Dovre's morning view: what waits for you, the last 24 hours, agents, pull requests and what's happening](docs/img/today.png)](https://demo.dovre.dev)

- **One morning view.** Pull requests, red builds, deploys waiting for approval and what changed in your apps, across every repo on `github.com` or GitHub Enterprise.
- **Your coding agents in one place.** `claude`, `codex`, `omp`, `copilot` and `agy` sessions: who is working, who needs you, what they cost.
- **Packs for the rest.** Linear, Slack, OpenTelemetry, Kafka, DuckDB and more each add a card, a page and answers to Bino, the built-in assistant.

## Run it locally

Needs Node 24+, pnpm (`corepack enable`), and `gh auth login` (or sign in on `/setup`).

```sh
git clone https://github.com/bergaaberg/dovre.git && cd dovre
pnpm install
pnpm dev        # http://127.0.0.1:4848
```

`/setup` finds your GitHub user and orgs and writes `.dev.vars`. On Windows, `pwsh scripts/install.ps1` (needs Go) also installs the `dovre` launcher, a Ctrl+Alt+D hotkey and start at login.

## Run it hosted

On Cloudflare Workers, D1 and Durable Objects, behind Cloudflare Access. Your laptop dials out to it (`pnpm bridge`) to run agents, with no open ports:

```sh
pnpm instance new ../my-dovre --domain dovre.example.com
pnpm instance provision ../my-dovre --deploy
pnpm bridge
```

On dovre.dev, pair a machine with the `dovre` launcher instead: `dovre bridge login <handle>`, then `dovre bridge install` to start it at login (`status`, `uninstall`, `logout` too).

Your own server instead: [docs/SELF-HOST.md](docs/SELF-HOST.md). Reaching a local Dovre from another machine: [docs/REMOTE.md](docs/REMOTE.md). What Dovre sends to its own services, and how to check: [docs/SENT.md](docs/SENT.md).

## Packs

Each app Dovre works with is a pack. Six ship with core, each switched off with `PACK_<ID>=off`:

| Pack | What it does |
|---|---|
| `agents` | Agent sessions, live turns, worktrees, tool approvals |
| `assistant` | Bino and its [memlet](https://github.com/bergaaberg/memlet) memory |
| `terminal` | Web terminals in your checkouts (local) |
| `docker` | Containers, compose projects, logs (local; `sh scripts/docker.sh` sets up Colima on a Mac) |
| `tracker` | Your open issues on `/tracker` |
| `storybook` | A PR's stories before and after (local) |

More in [`bergaaberg/dovre-packs`](https://github.com/bergaaberg/dovre-packs). A pack is copied into your instance repo, so you can edit it:

```sh
pnpm packs list
pnpm packs add cf-health --into ../my-dovre
pnpm packs new my-app --into ../my-dovre
pnpm packs outdated --into ../my-dovre   # then: packs update <id> (merges your edits)
```

A pack can also replace GitHub as the forge (`FORGE=<its id>`). How packs work: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Topo

Put a [`peak.yaml`](https://github.com/bergaaberg/peak) at the root of a checkout to say what the repo is, how much care it gets, who owns which files and what to read first. The `topo` pack (local) shows it on `/topo`, gives it to Bino and agents, and shows the tier on pull requests. Add it with `pnpm packs add topo`.

## Code and diffs (local)

`/code` browses any checkout under `CODE_DIR` at any ref. `/code/<checkout>/diff` shows uncommitted changes, a branch against a ref, or one commit. `/compare` diffs two pasted texts or JSON documents.

## More

- [docs/CONFIG.md](docs/CONFIG.md): every setting
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): core, packs, the Pack contract
- [PLAN.md](PLAN.md): locked decisions · [docs/LEXICON.md](docs/LEXICON.md): words we use

```sh
pnpm dev       # local server, watch mode
pnpm check     # typecheck, tests, Go launcher tests
```

MIT. See [LICENSE](LICENSE).
