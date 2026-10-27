# Dovre — Lexicon, Positioning & Feature Formulations

This document establishes the canonical vocabulary, elevator pitches, feature formulations, and pack compartmentalization for **Dovre**. Use these formulations across the marketing site, README, onboarding, and documentation so we always speak about Dovre in one clear, grounded voice.

---

## 1. Voice & Tone Principles

1. **Plain, concrete words over marketing buzzwords.** Prefer short Anglo-Saxon words ("what needs you", "runs on this laptop", "from memory", "two clicks") over enterprise jargon ("synergistic AI orchestration platform", "unified single-pane-of-glass observability").
2. **Geography & mountain craft as quiet metaphor.** Dovre is named after the Norwegian mountain plateau (*Dovrefjell*). The visual and verbal language draws from clear mountain mornings, ridges, cairns (*varder*), horizons, and viewpoints—never laid on so thick that it obscures what the software actually does.
3. **Architecture as a feature.** Dovre's strongest selling points are its boundaries: zero-wait pages rendered from memory, strict two-click write guards, fault-isolated **Packs** (250ms budget), and hosting models that respect air-gapped corporate laptops as well as personal edge Workers. State the numbers and rules plainly.

---

## 2. Elevator Pitches

### Splash Hero (Terse)
> **THE VIEW FROM THE TOP**
> **Code, agents, and ops. One screen.**
> Run locally, self-hosted, or on Cloudflare Workers. Plug in the packs you need.

### One-sentence
> **Dovre** links your pull requests, deploys, coding agents, assistant, and operations on one server-pushed screen.

### Extended Pitch (README / Docs)
> GitHub and your ops dashboard can't see which local coding agent is working on which PR, what command it's waiting to run, or which worktree sits behind which branch. **Dovre is the join.** Run it locally, self-hosted, or on Cloudflare Workers with an outbound laptop bridge, and extend it with 3-file **Pluggable Packs**.

---

## 3. Core Concepts & Standardized Formulations

### "The Join" (Why Dovre exists)
* **Problem:** Your work is split between remote systems (GitHub/GHE, issue trackers, deploy pipelines, prod telemetry) and local state on your machine (Claude Code, Antigravity `agy`, Codex `codex`, `omp`, Copilot CLI sessions, git worktrees, local terminals). Neither side knows about the other.
* **Formulation:** *"What only Dovre can do is the join: linking the coding agent running in a local worktree to the PR it opened, the review comments it drafted, the ticket it answers, and the deploy waiting on your approval."*

### Today & The 24-Hour Horizon
* **Formulation:** *"One morning briefing, open from boot."*
* **Parts:**
  * **The Greeting & Glance:** A plain-English opening sentence naming only what needs your attention right now, flanked by live counts (and, with the avatar pack, a creature reacting to the weather of your stack).
  * **The 24-Hour Horizon:** A deterministic mountain-ridge SVG of the last 24 hours across your org and repos. Ridge height reflects activity; merges plant flags on the peaks (yours in fjord blue); below the ridge sit lanes for shipped releases and coding agent sessions sized by cost, with Oslo's real night/sunrise band drawn across the sky.
  * **Two Columns of Cards + Live Feed:** Ready to ship, My pull requests, Reviews, My list, and cards from your active packs, beside a live SSE event stream. Every row expands in place; pages draw from memory in <5ms and never block on GitHub or an agent.

---

## 4. Pillar 1: Three Hosting Models ("Run it where your boundaries are")

Always present Dovre's deployment flexibility as **three clear topologies** built from the exact same Hono + TypeScript + SQLite/D1 codebase:

| Model | Name & Tagline | How it runs | Best for |
|---|---|---|---|
| **1. Local** | **Local Cockpit**<br>*Loopback only (`127.0.0.1:4848`)* | Runs on your Mac, Linux, or Windows machine via Node 24 + `node:sqlite` + native Go launcher/supervisor (`dovre`). Protected by a local launch-token cookie and strict `Origin` checks. Reads your existing `gh auth` and local agent CLIs directly. | Work laptops, GitHub Enterprise (GHE), strict corporate compliance where data must never leave the machine. |
| **2. Self-Hosted** | **Self-Hosted Server**<br>*Your hardware, your network* | Run the standard Node 24 server and SQLite database on a home server, VM, or private tailnet (Tailscale / WireGuard), with persistent local disk, Docker socket access, and background intervals. | Developers and small teams who want 24/7 uptime, local container/CLI access, and full data ownership on their own box. |
| **3. Cloudflare Worker** | **Edge Worker + Outbound Bridge**<br>*Anywhere access, laptop power* | Deployed via `pnpm instance new` to Cloudflare Workers + D1 + a Durable Object live hub, gated on every request by **Cloudflare Access** (`Cf-Access-Jwt-Assertion`). Pair it with `pnpm bridge` on your Mac to control local coding agents over a single outbound, hibernating WebSocket. | Personal projects, checking status and steering agents from your phone or another machine, with zero inbound ports or tunnels on your laptop. |

### How to explain the Bridge (`pnpm bridge`)
> *"Hosted Dovre can't run local CLI agents itself; your laptop can. `pnpm bridge` on your Mac dials out to your Worker's Durable Object (`wss://<host>/bridge`) using a Cloudflare Access service token and HMAC-signed frames. Nothing on your laptop listens on a port. When no page is open, the socket hibernates at zero cost; when you open `/agents` on your phone, your Mac streams live turns from its local `CODE_DIR` checkouts."*

---

## 5. Pillar 2: Pluggable Packs & Sub-Pack Compartmentalization

We standardize on **"Pluggable Packs"** (`src/packs/` in code) and compartmentalize each pack so users don't just toggle a monolith—they configure **which harnesses, routes, and sub-modules** plug into each pack:

### 1. The `agents` Pack (Multi-Harness Coding Agents)
* **What it is:** The coding agent desk, worktree manager, and supervisor (`dovre agent-host`).
* **Configurable Harnesses (Plug in the ones you use):**
  * **Antigravity (`agy`)** — Session discovery, headless streaming turns, and summary routing.
  * **Claude Code (`claude`)** — Live transcript watcher, headless turns, PR review & triage skills, MCP reads.
  * **Codex (`codex`)** — OpenAI Codex CLI local sessions, headless turns, and worktree execution.
  * **oh-my-pi (`omp`)** — Headless turns (`omp -p --mode json`), resumed and forked sessions.
  * **GitHub Copilot CLI (`copilot`)** — Lightweight runs and fast PR/deploy summaries.
* **Key Guarantees:**
  * Survives server restarts via `dovre agent-host`.
  * Never widens permissions (`default`, `acceptEdits`, `plan`; narrowest allow rule per blocked call).

### 2. The `assistant` Pack (Ambient Assistant, Scoped Memory & Model Routing)
* *(Bino and Topo in one **Assistant** pack; the assistant itself is called Bino)*
* **What it is:** Your ambient cockpit assistant, accessible from its dedicated page or the docked drawer on any screen. It sees what you see in Dovre (names and states only—never raw customer rows or secrets), proposes multi-step task breakdowns for **My List**, and drafts one-click action cards (`acts`) for other packs to carry out.
* **Internal Scoped Memory (`memlet`):**
  * Remembers concise, one-sentence facts across conversations, partitioned by scope: `operator` (you) and `app:<pack-id>` (e.g. `app:my-app`), so context you teach it about one app stays with that app.
  * **Cheap reflection model recommended:** After each reply, a lightweight reflection pass (`reflectModel`, e.g., Haiku / Flash / Mini) proposes memory updates—deduplicated, stripped of secrets, capped at 3 per turn, and fully inspectable/deletable on the Assistant page.
* **Flexible Model & Provider Routing (Bring Your Own Route):**
  * **Direct Provider API Key (Cheap model recommended):** Connect directly with `ASSISTANT_API_KEY` (or `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`). Because Dovre pre-digests your stack's state and scoped memories in memory before calling the model, fast/inexpensive models (`claude-haiku`, `gemini-flash`, `gpt-5-mini`) answer almost instantly for fractions of a cent.
  * **Cloudflare AI Gateway (`cf-gateway`):** Route through your Cloudflare AI Gateway (`CF_ACCOUNT_ID`, `AI_GATEWAY`, `CF_AIG_TOKEN`) with BYOK provider keys stored at the edge, unified cost tracking, caching, and rate limits. Required default in Cloudflare Worker mode.
  * **OpenRouter (`openrouter`):** Plug in a single `OPENROUTER_API_KEY` to mix and match any frontier or open-weight model for chat and ultra-cheap models for background memory reflection and PR summaries.
  * **Local CLI Seat Routing (`claude` / `agy` / `codex` / `omp` / `copilot`):** On a work laptop, route Assistant turns through your already-authenticated local CLI seat (run with `--tools ""` and zero MCP servers in an empty temp dir) so you burn zero external API tokens.
* **Repo Context (Topo, the `peak.yaml` catalog):**
  * Reads each repo's [`peak.yaml`](https://github.com/bergaaberg/peak) across your repos so the Assistant (and `/agents/new` via the `agents.new` slot) knows your project tiers, architecture docs, and component file boundaries.

### 3. The Other Core Packs, Pre-Built Packs, and Custom Packs
* **Terminal (`terminal`) & Docker (`docker`) Packs:** Local-only packs for guarded ConPTY/PTY web terminals inside `CODE_DIR` checkouts and container management.
* **Issues (`tracker`) & Storybook (`storybook`) Packs:** My open issues on `/tracker`; a PR's stories before and after (local only).
* **Pre-Built Packs ([`bergaaberg/dovre-packs`](https://github.com/bergaaberg/dovre-packs)):** Operations (`cf-health`, `http-otel`, `otel`, `otel-sink`, `kafka`, `service-bus`, `pubsub`), work apps (`linear`, `jira`, `slack`, `gitlab`), and tools (`duckdb`, `json`, `http`, `docker`), plus the `avatar` for fun.
* **Custom App Packs (`pnpm packs new <id>` / `pnpm packs add <id>`):** Write your own pack in 3 files (`index.ts` manifest & hooks, `data.ts` in-memory reader, `view.ts` escaped `hono/html` templates). Plugs into 14 named UI **Slots** (`SlotMap`) and answers Today within a strict **250ms budget** so a slow or failing pack never slows down Dovre.

### 4. Pre-Packed Agent Skills (`skills/`)
* Dovre ships with drop-in `SKILL.md` skills for any coding agent (`agy`, `claude`, `codex`, `omp`, `copilot`):
  * **`dovre-setup` (`skills/dovre-setup/SKILL.md`):** Drop into your coding agent to let it inspect your machine, clone Dovre, generate `.dev.vars`, configure your chosen hosting model (Local, Self-Hosted, or Cloudflare Worker + Bridge), and verify all tests.
  * **`dovre-pack-builder` (`skills/dovre-pack-builder/SKILL.md`):** Teaches your coding agent how to scaffold and test a custom 3-file Pluggable Pack (`index.ts`, `data.ts`, `view.ts`, plus hostile-input XSS test).
