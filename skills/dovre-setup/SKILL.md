---
name: dovre-setup
description: Bootstrap, configure, and verify a Dovre cockpit instance (Local loopback, Self-Hosted server, or Cloudflare Worker + Outbound Bridge), wire up agent harnesses (agy, claude, codex, omp, copilot), and configure the Assistant pack (Direct API, Cloudflare AI Gateway, OpenRouter, or Local CLI seat).
---

# Dovre Setup & Topology Skill (`dovre-setup`)

Use this skill when the user asks you to set up, configure, or deploy **Dovre** ("The view from the top"). Follow these steps deterministically.

## 1. Check Prerequisites & Zero-Touch GitHub Sign-In

Run a non-destructive check first, and if `gh` is not signed in, launch interactive browser login (`gh auth login --web`) and auto-discover the user's GitHub username and orgs:
```sh
node -v                  # Must be Node 24+ (native type stripping)
corepack enable
pnpm -v
command -v go || true    # Optional: builds native supervisor & launcher
command -v agy claude codex omp copilot || true

# Reuse existing gh CLI session, or launch 1-click browser login
if ! gh auth status >/dev/null 2>&1; then
  gh auth login --web -h github.com -s repo,read:org
fi
GH_USER=$(gh api user --jq .login)
GH_ORGS=$(gh api user/orgs --jq '.[].login' | paste -sd, - || true)
DETECTED_OWNERS="${GH_USER}${GH_ORGS:+,$GH_ORGS}"
```

## 2. Clone & Install Core (if not already in a Dovre checkout)

```sh
git clone https://github.com/bergaaberg/dovre.git
cd dovre
pnpm install
```

## 3. Configure `.dev.vars` Based on Chosen Hosting Model & Packs

Never commit `.dev.vars`. Create or update `.dev.vars` (`chmod 600 .dev.vars` on macOS/Linux) using `$DETECTED_OWNERS` so the user does not have to look up org names manually:

```ini
# 1. GitHub Host & Tracked Owners (auto-discovered from gh login)
REPO_HOST=github.com
REPO_OWNERS=<DETECTED_OWNERS>
CODE_DIR=~/src
PORT=4848

# 2. Agents Pack — Enabled Harnesses (agy, claude, codex, omp, copilot)
AGENT_HARNESSES=agy,claude,codex,omp

# 3. Assistant Pack — Route (api-key | cf-gateway | openrouter | claude | codex | omp | copilot | agy | off)
#    Unset: the best harness found on PATH.
ASSISTANT_VIA=api-key
ASSISTANT_MODEL=claude-haiku-5-5
BINO_REFLECT_MODEL=claude-haiku-5-5
# If api-key: set ASSISTANT_API_KEY (or ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY)
# If cf-gateway: set CF_ACCOUNT_ID, CF_AIG_TOKEN
# If openrouter: set OPENROUTER_API_KEY
# If a harness name: reuses that CLI's own login ($0 extra API token burn)
# PACK_TOPO=off leaves out Topo (the peak.yaml catalog) and keeps Bino.

# 4. Packs: core's are on unless PACK_<ID>=off; instance packs are listed in PACKS
# PACKS=../my-dovre
```

## 4. Start or Deploy According to the Chosen Topology

### Model A: Local Cockpit (`127.0.0.1:4848`)
* **macOS / Linux:**
  ```sh
  pnpm dev   # Opens on http://127.0.0.1:4848 (/setup wizard guides any missing fields)
  ```
* **Windows (with Go installed):**
  ```powershell
  pwsh scripts/install.ps1   # Builds bin/dovre(w).exe, registers Ctrl+Alt+D & startup
  dovre
  ```

### Model B: Self-Hosted Server (Your VM / Tailnet)
* Build the native Go supervisor so Dovre restarts on crash and keeps `agent-host` running across web server restarts:
  ```sh
  (cd launcher && go build -trimpath -ldflags "-s -w" -o ../bin/dovre .)
  ./bin/dovre supervise
  ```

### Model C: Cloudflare Worker + Outbound Laptop Bridge (Beginner-Friendly Auto-Provisioning)
Even if the user is brand new to Cloudflare, run these commands to create the instance, install pre-built packs from `bergaaberg/dovre-packs`, sign in via browser (`wrangler login`), auto-create D1, auto-patch `wrangler.jsonc`, apply migrations, push `BRIDGE_KEY` + `GITHUB_TOKEN`, and deploy:
```sh
pnpm instance new ../dovre-instance --domain <your-domain>
pnpm packs add cf-health --into ../dovre-instance
pnpm instance provision ../dovre-instance --domain <your-domain> --deploy
```
Then connect the laptop's agents via the Outbound Bridge (`pnpm bridge`) by writing `BRIDGE_URL=wss://<your-domain>/bridge` and `BRIDGE_KEY=$GENERATED_BRIDGE_KEY` to `.dev.vars` and running `sh scripts/install-bridge.sh`.

## 5. Verify

Always run:
```sh
pnpm typecheck && pnpm test
```
Then open `/settings` and `/packs` in the browser to confirm the expected harnesses and packs are on.
