# Dovre

**Local-first and Cloudflare-hosted engineering cockpit.**

Dovre joins your GitHub repositories (`github.com` or GitHub Enterprise), CI/deploys, pluggable app packs, and local coding agents (`claude`, `codex`, `omp`, `copilot`, `agy`) into a single live morning view.

- **Interactive Demo & Setup Generator:** [dovre.dev](https://dovre.dev) · **Docs:** [dovre.dev/docs](https://dovre.dev/docs)
- **Pre-Built Packs:** [`bergaaberg/dovre-packs`](https://github.com/bergaaberg/dovre-packs)
- **Scoped Assistant Memory:** [`bergaaberg/memlet`](https://github.com/bergaaberg/memlet)
- **Architecture & Pack API:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/LEXICON.md](docs/LEXICON.md) · [PLAN.md](PLAN.md)

---

## Quick Start (Local)

Requires **Node 24+** and **pnpm** (`corepack enable`). Sign in with **GitHub CLI** (`gh auth login`), or start Dovre and complete the one-click interactive browser sign-in on `/setup`.

### macOS & Linux

```sh
git clone https://github.com/bergaaberg/dovre.git && cd dovre
pnpm install
pnpm dev                         # opens http://127.0.0.1:4848
```

### Windows

```powershell
git clone https://github.com/bergaaberg/dovre; cd dovre
pnpm install
pwsh scripts/install.ps1         # optional (requires Go): builds native supervisor, Ctrl+Alt+D, login start
pnpm dev                         # or `dovre` if launcher is installed
```

On first start, `/setup` auto-discovers your authenticated GitHub user and organisations (`REPO_OWNERS`) and writes `.dev.vars` (`0600`).

---

## Hosted on Cloudflare Workers + Mac Bridge

Run Dovre at the edge on **Cloudflare Workers + D1 + Durable Objects** behind **Cloudflare Access** (`IS_HOSTED=1`), while your workstation dials outbound (`pnpm bridge`) to run local coding agents with zero inbound ports:

```sh
# 1. Scaffold a separate instance repo beside dovre
pnpm instance new ../my-dovre --domain dovre.example.com

# 2. Auto-provision D1, apply migrations, generate BRIDGE_KEY, and push Worker secrets
pnpm instance provision ../my-dovre --deploy

# 3. Start the outbound Mac Bridge (or install at login via scripts/install-bridge.sh)
pnpm bridge
```

---

## Pluggable Packs (`PACK_API = 1`)

Dovre Core ships five built-in packs under `src/packs/core/`:

| Core Pack | Purpose | Toggle |
|---|---|---|
| `agents` | Multi-harness session discovery, live streaming turns, worktrees, and tool approval bar (`claude`, `codex`, `omp`, `copilot`, `agy`) | `PACK_AGENTS=off` / `AGENT_HARNESSES` |
| `assistant` | **Bino** assistant + **Repo Atlas** (`range.yaml` catalog) + [`memlet`](https://github.com/bergaaberg/memlet) scoped SQLite/D1 memory | `PACK_ASSISTANT=off` / `PACK_ATLAS=off` |
| `avatar` | Ambient SVG companion reflecting active work, review load, and operational health | `PACK_AVATAR=off` |
| `terminal` | Strict-origin local PTY web terminals (`/terminal`) | `PACK_TERMINAL=off` |
| `docker` | Container and compose project controls + live SSE logs (`/docker`) | `PACK_DOCKER=off` |

A pack can also bring a **forge** (`forge` hook, `src/forge/types.ts`) so that PRs/MRs, CI, notifications and deploys come from somewhere other than GitHub. Set `FORGE=<its id>` to use it. There's one forge per instance, and GitHub is the default.

### Add a Pre-Built or Custom Pack

Install pre-built packs from [`bergaaberg/dovre-packs`](https://github.com/bergaaberg/dovre-packs) (`cf-health`, `http-otel`, `docker`, `jira`, `custom-app`) or scaffold a new one:

```sh
pnpm packs list
pnpm packs add cf-health --into ../my-dovre
pnpm packs new my-app --into ../my-dovre
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full `Pack` contract (`src/packs/types.ts`), hooks (`today`, `routes`, `slots`, `needs`, `bino`, `acts`, `dock`, `scheduled`, `email`), and isolation guarantees.

---

## Repo Atlas (`range.yaml`)

Drop a `range.yaml` manifest into any checkout under `CODE_DIR` to catalog components, file ownership boundaries, and rules in `/atlas` and `/agents/new`:

```yaml
name: Quill
description: Publishing platform and worker queue
url: https://quill.example
tier: active
components:
  - name: web
    owns: [src/web/, src/ui/]
    rules: .claude/rules/web.md
docs:
  plan: docs/PLAN.md
  architecture: ARCHITECTURE.md
health:
  workers: [quill-web, quill-dispatcher]
```

---

## Configuration (`.dev.vars` or Settings Page)

| Key | Purpose | Default |
|---|---|---|
| `FORGE` | Where the code lives: `github`, or the id of a forge a pack brings (`Pack.forge`, e.g. `gitlab`). Pages that forge can't serve are hidden | `github` |
| `REPO_HOST` | GitHub host (`github.com` or GitHub Enterprise hostname) | `github.com` |
| `REPO_OWNERS` | Comma-separated GitHub orgs/users to track | auto-discovered on `/setup` |
| `GITHUB_TOKEN` / `GHE_TOKEN` | GitHub token (uses `gh auth token` locally when unset) | `gh auth token` |
| `CODE_DIR` | Parent directory of local repo checkouts | `~/Code` or `~/src` |
| `AGENT_HARNESSES` | Enabled local agent CLIs (`claude,codex,omp,copilot,agy`) | all detected on `PATH` |
| `ASSISTANT_VIA` (`BINO_VIA`) | Assistant route: `api-key`, `cf-gateway`, `openrouter`, `claude`, `codex`, `omp`, `copilot`, `agy`, or `off` | best detected harness |
| `ASSISTANT_API_KEY` | Provider API key when `ASSISTANT_VIA=api-key` (`claude-haiku-5-5`, `gpt-4o-mini`, or `gemini-2.5-flash`) | optional |
| `OPENROUTER_API_KEY` | OpenRouter key when `ASSISTANT_VIA=openrouter` | optional |
| `CF_ACCOUNT_ID`, `CF_AIG_TOKEN` | Cloudflare AI Gateway account & token (`ASSISTANT_VIA=cf-gateway`) | optional |
| `PACKS` | Comma-separated instance pack directories loaded locally | none |
| `PACK_<ID>` | Set `off` to disable any core or instance pack | `on` |
| `IS_HOSTED` | `1` on Cloudflare Workers (enforces Cloudflare Access RS256 JWT check) | `0` (local loopback) |
| `CF_ACCESS_TEAM`, `CF_ACCESS_AUD` | Cloudflare Zero Trust team name and application Audience (AUD) tag | required when `IS_HOSTED=1` |
| `BRIDGE_URL`, `BRIDGE_KEY` | Outbound Mac Bridge WebSocket URL (`wss://<host>/bridge`) and shared HMAC secret | optional |

---

## Development

```sh
pnpm dev       # Start local server on http://127.0.0.1:4848 (watch mode)
pnpm check     # Run tsc --noEmit, Node test suite, and Go launcher tests
```

## License

MIT. See [LICENSE](LICENSE).
