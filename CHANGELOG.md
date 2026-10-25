# Changelog

## 0.2.0 (2026-10-25)

- **Pluggable Packs (`PACK_API = 1`)**: Modular architecture (`src/packs/`) with core packs (`agents`, `assistant`, `avatar`, `terminal`, `docker`), instance scaffolding (`pnpm instance new`, `pnpm instance provision`), and pre-built packs CLI (`pnpm packs add`, `pnpm packs new`, `pnpm packs list`).
- **Multi-Harness Agents**: First-class session discovery, headless turns, and per-harness compartmentalization (`AGENT_HARNESSES`) across Claude Code (`claude`), OpenAI Codex (`codex`), Oh My Pi (`omp`), GitHub Copilot CLI (`copilot`), and Antigravity (`agy`).
- **Assistant & Repo Atlas (`assistant` pack)**: Scoped SQLite/D1 memory via [`memlet`](https://github.com/bergaaberg/memlet), `range.yaml` repository catalog (`/atlas`), and configurable routes (`api-key`, `cf-gateway`, `openrouter`, or local CLI seats).
- **Dual Topology & Mac Bridge**: Run strictly local (`127.0.0.1:4848`) or hosted on Cloudflare Workers + D1 + Durable Objects behind Cloudflare Access with an outbound HMAC-signed Mac Bridge (`pnpm bridge`).
- **Plug-and-Play Onboarding**: Interactive `/setup` for GitHub CLI web device login or token setup, automatic owner discovery, and 1-command Cloudflare D1 + Worker provisioning (`pnpm instance provision`).
