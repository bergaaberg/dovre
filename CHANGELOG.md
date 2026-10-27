# Changelog

## Unreleased

Added:

- **Self-host**: the Docker pane can see the host's containers when Dovre runs in Docker. It's opt-in, with a commented-out socket mount and `group_add` in `deploy/compose.yaml`; read the warning in docs/SELF-HOST.md first, since the socket is root on the host (#102).
- **Agent CLIs**: Settings → Work has a box per agent CLI (Claude Code, omp, Copilot CLI, agy, Codex) instead of a comma-separated list, and marks the ones not found here. Only ticked, installed ones are offered for turns and in the model pickers. `AGENT_HARNESSES` keeps its format (#107).

Changed:

- **Harnesses** have one folder each in core, `src/agents/harnesses/<id>/`, with the agent host's filter split to match (`launcher/keep_<id>.go`). Adding one touches its folder, its keep file and one list (docs/ARCHITECTURE.md, "Extending") (#107).

## 0.5.0 (2026-10-27)

Added:

- **What Dovre sends**: a new Settings area lists every call Dovre can make to Dovre's own services, and the record of the ones it made (#145). The bridge writes each call home to `sent.jsonl` on its machine (field names and sizes, never values; frames counted per hour) and `dovre bridge sent` prints it. The hosted cockpit counts what each machine sent it. Download the record as JSON for a security review. A test fails if a call home skips the record. See [docs/SENT.md](docs/SENT.md).

## 0.4.0 (2026-10-27)

Breaking:

- **Topo** left core for dovre-packs (#147). Add it with `pnpm packs add topo`, then `pnpm add github:bergaaberg/peak#v0.1.0` in your instance for the `peak.yaml` parser. `PACK_TOPO` is gone: Topo is on when it's installed. Packs get the code folder as `ctx.codeDir` (local only).

Added:

- **Settings** has an overview and a page per area: Look, Layout, Notifications, Writes, Keys, Panes, Work, Agents, Packs and About (#184). Find any setting by name on the overview or in the palette, and see what you changed from the default, there and on each area. Each pack's settings have one page, `/settings/packs/<id>`, and `/packs` links to it. Look and Layout save and reset apart.
- **Dropdowns** have their own chevron, a hover and room for long text; where the browser allows it (Chrome and Edge), the open list is a panel in the theme with the picked option marked.

## 0.3.0 (2026-10-27)

Breaking:

- **Topo**: Atlas is now Topo (`/topo`; `/atlas` redirects; `PACK_TOPO=off`, `PACK_ATLAS` still read) (#148). The catalog is `peak.yaml` from [bergaaberg/peak](https://github.com/bergaaberg/peak) (#128); `range.yaml`, its old name, is no longer read, so rename the file. The format is the same (#138).
- **Avatar**: the avatar left core for dovre-packs (#130). Add it with `pnpm packs add avatar`.

Added:

- **Pull requests**: review a PR yourself: comment on lines and ranges, then post as Comment, Approve or Request changes, starting from the agent's draft if you like (#106). Reply to and resolve threads; `c` comments on a line, `v` marks a file viewed. List views, filters and sorts (Needs me, Open threads, CI failing, …), kept per viewer (#157). An agent's review draft shows its comments at their lines in the diff, editable in place (#160).
- **Diffs**: `/code/<checkout>/diff` shows a checkout's own changes: uncommitted (untracked files too), a branch against a ref, or one commit; an agent session links to its checkout's diff. Changed words are marked in every diff, and a local diff can be read side by side. `/compare` diffs two pasted texts, or two JSON documents with keys sorted. Local only (#105).
- **Dependabot**: a Dependabot tab combines a repo's bumps into one PR, merges green combined PRs at once, and adds groups to `dependabot.yml`; lockfiles made again in local mode, Python and .NET included (#108).
- **Storybook**: a PR's stories before and after, side by side, from the Storybook CI publishes, or built here when CI publishes none (local only) (#160, #166).
- **Stats**: packs add panels; Settings chooses what Stats shows, in what order, over 14 or 28 days or 4, 12 or 26 weeks (#93, #142).
- **Packs**: ingest routes, token-checked POSTs from apps into a pack (#109); packs list their own write kinds (#104); MCP tools for agent turns over `POST /mcp`, each turn with its own token, in Claude Code, Codex, omp, agy and terminals (#153, #172); `.pack.json` on add and `pnpm packs outdated / update / track`, with the Packs page updating a copied pack locally (#152); `span.actions` slot (#165); packs read the forge and give the starting page a picture (#130); a test kit for packs (#130).
- **Bulk actions**: tick several waiting deploy runs or issues and act on them at once; Settings chooses which writes take one click (#104).
- **Look**: three more themes, Birch, Polar and Ember (#95); font, text size and line height under Look and layout (#183).
- **Keys**: Settings → Keys sets how far j/k scroll and which shortcut groups are on (#87); `a` adds to My list, with details in one form (#86).
- **Bino**: keyboard-first chat (Enter sends, ↑ last message, `g b`) (#85); stop an answer mid-way (#119); an assistant icon instead of the avatar (#131).
- **Self-host**: `PUBLIC_ORIGIN` behind a sign-in proxy, and a server recipe with Docker, systemd and Caddy (#74, #99). `sh scripts/docker.sh` sets up Colima on a Mac (#101).
- **Bridge**: `dovre bridge logout` stops, revokes the sign-in and forgets it.

Fixes:

- An allowed agent call that's refused again says why (#163); Claude Code turns are told to keep work inside the repo.
- A `.cmd` shim that runs a program (pnpm 12) starts as that program on Windows (#168).
- Charts are readable on a phone (#149, #150); settings forms line up (#155); Look and layout saves as you change it (#146); a refused button in the demo explains itself (#90).

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
