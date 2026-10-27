# Changelog

## Unreleased

- **Code**: `/code/<checkout>/diff` shows a checkout's own changes in the PR viewer's diff: what's uncommitted (untracked files too), a branch against another ref, or one commit. Local only (#105, part 1). An agent session working in a checkout links to it with **Diff** (#105).
- **Diffs**: the words that changed in a line are marked, in pull requests and local diffs; a local diff can be read side by side (#105).
- **Docker**: `sh scripts/docker.sh` sets up Colima on a Mac and starts it at login (#101).
- **Topo**: `range.yaml`, `peak.yaml`'s old name, is no longer read, and `/topo` no longer shows the rename notice. Rename the file to `peak.yaml`; the format is the same (#138).

## 0.2.1 (2026-10-26)

- **Hosted teams**: each person's GitHub writes use their own token and name them (#57, #59); each person sees only the machines they paired (#79).
- **Hosted hub**: live pages over hibernatable WebSockets (#56), table export at `GET /export` (#61) and storage size at `GET /size` (#80).
- **Bridge**: machines sign in with issuer JWTs, several per hub (#76); `dovre bridge login|run|install|uninstall|status|restart` and `dovre version` (#77, #78).
- **Issues pack**: `/tracker`, Today needs and verified row actions, and starting an agent session on an issue (#43–#46, #73).
- **Core**: Teams and Data left core for instance packs (#66, #71); a pack whose `available()` says no is off before it mounts (#70).
- **Fixes**: a Confirm in an item's trail opens as a popover (#81); chart day labels never touch (#82); theme-coloured browser bar (#63); steady tab bar on Android Chrome (#53).

## 0.2.0 (2026-10-25)

- **Pluggable Packs (`PACK_API = 1`)**: Modular architecture (`src/packs/`) with core packs (`agents`, `assistant`, `avatar`, `terminal`, `docker`), instance scaffolding (`pnpm instance new`, `pnpm instance provision`), and pre-built packs CLI (`pnpm packs add`, `pnpm packs new`, `pnpm packs list`).
- **Multi-Harness Agents**: First-class session discovery, headless turns, and per-harness compartmentalization (`AGENT_HARNESSES`) across Claude Code (`claude`), OpenAI Codex (`codex`), Oh My Pi (`omp`), GitHub Copilot CLI (`copilot`), and Antigravity (`agy`).
- **Assistant & Repo Atlas (`assistant` pack)**: Scoped SQLite/D1 memory via [`memlet`](https://github.com/bergaaberg/memlet), `range.yaml` repository catalog (`/atlas`), and configurable routes (`api-key`, `cf-gateway`, `openrouter`, or local CLI seats).
- **Dual Topology & Mac Bridge**: Run strictly local (`127.0.0.1:4848`) or hosted on Cloudflare Workers + D1 + Durable Objects behind Cloudflare Access with an outbound HMAC-signed Mac Bridge (`pnpm bridge`).
- **Plug-and-Play Onboarding**: Interactive `/setup` for GitHub CLI web device login or token setup, automatic owner discovery, and 1-command Cloudflare D1 + Worker provisioning (`pnpm instance provision`).
