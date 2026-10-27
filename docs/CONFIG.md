# Configuration

Set these in `.dev.vars` (local) or as Worker secrets and vars (hosted). Most can also be changed on Settings.

| Key | Purpose | Default |
|---|---|---|
| `FORGE` | Where the code lives: `github`, or the id of a forge a pack brings (`Pack.forge`, e.g. `gitlab`). Pages that forge can't serve are hidden | `github` |
| `REPO_HOST` | GitHub host (`github.com` or GitHub Enterprise hostname) | `github.com` |
| `REPO_OWNERS` | Comma-separated GitHub orgs/users to track | auto-discovered on `/setup` |
| `GITHUB_TOKEN` / `GHE_TOKEN` | GitHub token (uses `gh auth token` locally when unset). Hosted, an instance can pass `createWorker({ githubToken: async (bindings) => … })` instead, for a rotating token such as a GitHub App's; it's asked before every call and wins over the secret | `gh auth token` |
| `PUBLIC_ORIGIN` | Local mode behind a sign-in proxy: the one public address it serves Dovre at, exactly `https://host[:port]` ([docs/SELF-HOST.md](docs/SELF-HOST.md)). Environment or `.dev.vars` only | unset (localhost only) |
| `LISTEN_HOST` | Address the server listens on. Only for a container whose port is published to the host's loopback | `127.0.0.1` |
| `CODE_DIR` | Parent directory of local repo checkouts | `~/Code` or `~/src` |
| `AGENT_HARNESSES` | Enabled local agent CLIs (`claude,codex,omp,copilot,agy`) | all detected on `PATH` |
| `ASSISTANT_VIA` (`BINO_VIA`) | Assistant route: `api-key`, `cf-gateway`, `openrouter`, `claude`, `codex`, `omp`, `copilot`, `agy`, or `off` | best detected harness |
| `ASSISTANT_API_KEY` | Provider API key when `ASSISTANT_VIA=api-key` (`claude-haiku-5-5`, `gpt-4o-mini`, or `gemini-2.5-flash`) | optional |
| `OPENROUTER_API_KEY` | OpenRouter key when `ASSISTANT_VIA=openrouter` | optional |
| `CF_ACCOUNT_ID`, `CF_AIG_TOKEN` | Cloudflare AI Gateway account & token (`ASSISTANT_VIA=cf-gateway`) | optional |
| `PACKS` | Comma-separated instance pack directories loaded locally | none |
| `PACK_<ID>` | Set `off` to disable any core or instance pack | `on` |
| `IS_HOSTED` | `1` on Cloudflare Workers (enforces the RS256 JWT check: Cloudflare Access or `AUTH_ISSUER`) | `0` (local loopback) |
| `CF_ACCESS_TEAM`, `CF_ACCESS_AUD` | Cloudflare Zero Trust team name and application Audience (AUD) tag | required when `IS_HOSTED=1`, unless `AUTH_ISSUER` is set |
| `AUTH_ISSUER`, `AUTH_AUD`, `AUTH_JWKS_URL` | Instead of Access: any issuer that signs RS256 JWTs (sent in `Cf-Access-Jwt-Assertion`). Its exact `iss` (https), the expected `aud`, and its keys. When set, it wins; a bad value lets nobody in | JWKS: `<issuer>/.well-known/jwks.json` |
| `BRIDGE_URL`, `BRIDGE_KEY` | Outbound bridge WebSocket URL (`wss://<host>/bridge`) and the root HMAC secret. Without `BRIDGE_KEY`, `/bridge` is closed | optional |
| `BRIDGE_CLIENT_ID` | The Access service token the one machine `mac` signs in with (it signs frames with `BRIDGE_KEY` itself). Machines an issuer names in a JWT's `service` claim (16–32 hex) need no setting: each signs with its own key, `HMAC(BRIDGE_KEY, "dovre-bridge/1\|machine\|<id>")`, and several can be online at once | optional |
| `CRON_KEY` | Hosts without cron triggers: `POST /_dovre/scheduled` with `Authorization: Bearer <CRON_KEY>` (32+ characters) runs the cron and answers `204`. Unset, the route is a `404` | optional |


`dovre bridge` keeps its sign-in, data, pinned Node and log in the user config folder (`~/Library/Application Support/dovre`, `~/.config/dovre`, `%AppData%\dovre`). `DOVRE_BRIDGE_HOME` moves it.
