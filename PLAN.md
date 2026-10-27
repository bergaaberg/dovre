# Dovre — Architecture & Design Decisions

Dovre is a local-first and Cloudflare-hosted engineering cockpit that joins your repositories, CI/deploys, and local coding agents (`claude`, `codex`, `omp`, `copilot`, `agy`) into a single live morning view.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the three-layer Pack architecture, [docs/LEXICON.md](docs/LEXICON.md) for terminology, and [GitHub Issues](https://github.com/bergaaberg/dovre/issues) for the active roadmap.

## Locked Decisions

| # | Decision | Call |
|---|---|---|
| D1 | Name | **Dovre**. **Bino** is the assistant and each operator's ambient avatar |
| D2 | Local Runtime | `127.0.0.1:4848` with a launch-token cookie (`HttpOnly`, `SameSite=Strict`), local SQLite (`node:sqlite`), and optional desktop supervisor (`launcher/`) |
| D3 | Stack | Node 24 type-stripped TypeScript (`.ts` imports, no build step locally), Hono, `hono/html` server rendering, SQLite/D1 behind a unified `D1` interface, `pnpm`, `node --test` |
| D4 | Look | **The morning view**: Sitka serif headlines, warm light-mocha day palette (`#f8f4ee`) and deep fjord night palette (`#0a1117`), status-only semantic colours, and a 24 h horizon SVG |
| D5 | Liveness | **Server-pushed**: SSE `"changed"` events over `/events` swap `data-live` regions in place without full-page reloads. Hosted, pages listen on the hub's hibernatable `/live` WebSocket instead (an idle tab lets the Durable Object sleep), with `/events` as the fallback |
| D6 | Multi-Harness Agents | First-class support for **Claude Code** (`claude`), **OpenAI Codex** (`codex`), **Oh My Pi** (`omp`), **GitHub Copilot CLI** (`copilot`), and **Antigravity** (`agy`), individually toggleable via `AGENT_HARNESSES` |
| D7 | Pluggable Packs (`PACK_API = 1`) | Core (`src/packs/core/`) ships `agents`, `assistant` (Bino + Repo Atlas), `terminal`, and `docker` (the avatar, a pack for fun, moved to dovre-packs in #130). Pre-built and custom packs live in [`bergaaberg/dovre-packs`](https://github.com/bergaaberg/dovre-packs) or an instance repository (`pnpm packs add <id>`, `pnpm packs new <id>`) |
| D8 | Dual Topology | **Local-only mode** (`127.0.0.1:4848`) for strict local compliance, or **Hosted Cloudflare mode** (Workers + D1 + Durable Object hub behind Cloudflare Access RS256 JWT verification) |
| D9 | Assistant Routes | Configurable via `ASSISTANT_VIA` (`BINO_VIA`): Direct Provider API Key (`api-key`, cheap fast models recommended), Cloudflare AI Gateway (`cf-gateway`), OpenRouter (`openrouter`), or Local CLI seat (`claude`, `codex`, `omp`, `copilot`, `agy`) |
| D10 | Outbound Mac Bridge | In hosted mode, `pnpm bridge` dials outbound from your workstation to the Durable Object hub (`wss://<domain>/bridge`) with HMAC-SHA256 frame signing (`BRIDGE_KEY`) and WebSocket hibernation — zero inbound ports |
| D11 | Agent Tools over MCP | Packs offer tools (`Pack.tools`) to the agent turns Dovre starts, on core's MCP server (`POST /mcp`, `src/mcp.ts`). Each Claude Code turn gets a random token of its own, good only for `/mcp` while that turn runs; local mode, localhost Host, no Origin. Claude Code still asks for each tool; the tool enforces its own limits; calls are logged as `mcp.call` without arguments (dovre#153) |
