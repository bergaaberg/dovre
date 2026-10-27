# Lexicon

The words Dovre uses, so the site, README, app and docs say the same thing.

## Voice

- Plain, short words: "what needs you", "runs on this laptop", "asks twice". No "platform",
  "seamless", "single pane of glass", "orchestration".
- Say what it does, with the number or rule: "pages draw from memory", "250 ms for all cards".
- The mountain theme (Dovrefjell: ridges, cairns, horizons) stays in the visuals and names, not
  in sentences.

## Pitches

- **Hero:** Code, agents and ops. One screen.
- **One line:** Dovre puts your pull requests, deploys, coding agents and apps on one live page.
- **Why:** GitHub can't see which local agent is working on which PR, what it's waiting to run,
  or which worktree is behind which branch. Dovre joins the two.

## Terms

| Term | Means |
|---|---|
| **Today** | The start page: greeting, glance counts, horizon, cards, live feed |
| **Horizon** | The ridge chart of the last 24 hours on Today |
| **Need** | Something waiting for you; rings once when new |
| **My list** | Your own to-do list |
| **Pack** | One app integration: a manifest and hooks (`src/packs/types.ts`) |
| **Core pack** | A pack shipped in core: `agents`, `assistant`, `terminal`, `docker`, `tracker`, `storybook` |
| **Instance** | A repo with one setup's packs and config (`../my-dovre`) |
| **Slot** | A named place on a core page that packs fill (14) |
| **Act** | A one-click action card Bino proposes for a pack |
| **Dock** | A pack panel opened with a key from any page |
| **Forge** | Where PRs and CI come from: GitHub, or a pack's (`FORGE`) |
| **Verified write** | A write that re-checks state, is logged, and asks to confirm |
| **Bino** | The built-in assistant |
| **memlet** | Bino's scoped memory (`operator`, `app:<id>`) |
| **Topo** | The repo map built from each checkout's `peak.yaml` |
| **Agent host** | `dovre agent-host`: runs agent turns apart from the web server |
| **Bridge** | Your machine dialing out to hosted Dovre to run agents (`pnpm bridge`, `dovre bridge`) |
| **Local / self-hosted / hosted** | Your machine on `127.0.0.1:4848` / your own server behind a sign-in proxy / Cloudflare Workers behind Access |

Harnesses by their command names: `claude`, `codex`, `omp`, `copilot`, `agy`.
