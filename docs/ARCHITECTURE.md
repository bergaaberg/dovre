# Architecture

Core, packs and instances, and how a pack gets from a folder to a page. Locked decisions are in
PLAN.md. Each hook is documented in `src/packs/types.ts`.

## Layers

```
 Instance repo (one per machine or setup)
   packs/<id>/, packs.ts, worker.ts + wrangler config, .dev.vars
        │ imports core as `dovre/…`; core never imports an instance
 Core's packs (src/packs/core/)
   agents, assistant, terminal, docker, tracker, storybook
 Core (this repo)
   shell + kit, hub (live.ts), gather + snapshot, agent runner, search,
   My list, Bino, notifications, actions log, Settings
   src/packs/types.ts     the contract (PACK_API = 1)
   src/packs/registry.ts  core's side of every hook
```

- **Core** never names, imports or defaults to an instance or its packs.
- **Core's packs** use the same contract as any pack, so they can be switched off.
  `test/packs.test.ts` fails if core imports them anywhere but the entry points.
- **An instance** is a repo such as `../my-dovre` holding one setup's packs and config.

## Entry points

| | Local (`src/index.ts`) | Hosted (`src/worker.ts`) |
|---|---|---|
| Packs from | `PACKS` folders, each `packs.ts` imported at start (`src/packs/load.ts`) | The instance's worker.ts calls `createWorker({ packs })` |
| Core's packs | all six (terminal and docker when enabled) | agents (over the bridge), assistant, tracker |
| Refresh | interval, checked every 30 s | after a response (`waitUntil`) and on cron |
| Extra hooks | `callback`, `ingest`, `acts`, `tools` | `scheduled`, `email` |

Both put core's packs first, then the instance's, and pass the list to `activePacks`.

The public demo uses a third entry, `createDemoWorker` (`dovre/demo/worker.ts`), from its own
repo. It has no secrets, no D1 (reads return nothing, writes are dropped), no Access and no
bridge. Every visitor is `visitor@demo.dovre.dev`, which no setting can enable in a real
instance. Non-GET requests get a read-only 403, except scripted Bino and what `allowWrite`
allows. The demo repo supplies fake packs, fixtures, a fake `fetch` and scripted `answers`.

## A pack's life

1. **Declared.** A pack is a `manifest` plus hooks. A packs module exports a list of packs, or a
   function from settings to that list.
2. **Loaded.** `loadPacks` imports each `PACKS` folder. One that fails to import shows as off
   with the error; the rest still load.
3. **Sorted** (`activePacks`). The first failed check keeps a pack off, shown on the Packs page:
   lowercase unique id; built for this `PACK_API`; `PACK_<ID>` isn't `off`; `execution` fits;
   `requiredBindings` (hosted) or `requiredBinaries` (local) exist; required settings are set.
4. **Mounted** (`createApp`). Each pack gets its own `PackContext`. If `available` says no or
   throws, the pack is off. Routes go on a sub-app mounted after the guard and all core routes.
   The mount is refused for a route outside `/<id>` and the manifest's `paths`, a path core or
   another pack owns, or a `routes` that throws. Pack `styles` and `script`s are served as one
   hashed file each, and each `wasm` module (lowercase name, 8 MB at most, real WebAssembly) at a
   hashed path; while any pack ships WebAssembly, pages' CSP allows `'wasm-unsafe-eval'`. Scripts listen for `dovre:change` and `dovre:swap` on `document`.
   A pack's motion stops under `prefers-reduced-motion` only while `<html>` isn't
   `data-motion="always"` (Settings → Look → Motion): scope those rules under
   `:root:not([data-motion="always"])`, and check the attribute in scripts too.
5. **Started** (`initAll`). A pack whose `init` throws is turned off.
6. **Refreshed** (`refresher`). Every `everyMs` (default 5 min), one run at a time per pack.
   Runs longer than `maxMs` are abandoned. Starts, ends and errors go to the Packs page.
7. **Hidden.** Settings → Layout hides a pack: it leaves every hook, its routes 404 and it
   isn't refreshed. `PACK_<ID>=off` stops it loading at all.

## The contract

`src/packs/types.ts` is the whole contract.

**`PackContext`** gives a pack:
- `env`, `bindings`, `hosted`, `db`
- `publish(topics)`: tell open pages a region changed
- `snapshot()`, `gathered()`: what the gather read from the forge
- `fill(slot, arg)`: host other packs' slots on its pages
- `page()`, `dockPage()`: draw inside the shell
- `log()`, `ring()`: log, or a one-off notification
- `ask()`, `asking()`: put a question in the top bar and wait for the answer (local only)
- `forge()`: user, owners, and the forge's `work` and `merged` (read-only); `repos()` and `file()` to read the owners' repos, and `everyRepo(paths)` for every repo's files at once (one call per owner, kept for every isolate up to the age the pack takes); `propose()` to open a PR changing one file (one of the pack's `writes` kinds, re-checked against `expect`, logged)
- `startPicture(svg)`, `pulse()`
- `wasm(name)`: where one of its `wasm` modules is served

**Hooks**, by where they land:

| Where | Hooks | Timing |
|---|---|---|
| Own pages | `routes`, `styles`, `script`, `wasm`, `nav`, manifest `paths` | on request |
| Today | `today`, `glance`, `brief`, `lane`, `feed` | cards: 250 ms total; rest from memory |
| Stats | `stats` (chart or headline number) | from memory |
| Search | `pages`, `finds` | from memory |
| Attention | `needs` (+ manifest `rings`), `banner`, `dock` | from memory |
| Bino | `bino`, `about`, `lookups`, `acts` (local) | `bino` from memory; `about` may read its app (2 s at most); lookups run when Bino asks (8 s at most); acts run in the background |
| Core pages | `slots` (14 in `SlotMap`) | from memory |
| Framing | `frames`: `https://` origins its pages may frame | from memory |
| Links | `refs` (ticket keys), `linked` (PR links to look up) | from memory |
| Settings | `settings` panel, manifest `settings` keys | from memory |
| Pulse | `pulse`: working/asking counts, trouble, on duty | from memory |
| Lifecycle | `available`, `init`, `refresh`, `beforePage`, `dispose` | `beforePage`: 1.5 s total |
| Outside callers | `callback`, `ingest`, `tools`, `scheduled`, `email` | when called |
| Forge | `forge` (`src/forge/types.ts`): PRs, CI, notifications, deploys when `FORGE` is its id | once, before `init` |

**Pages draw from memory.** A pack reads its app in `refresh` or `scheduled`, keeps the result,
and `publish`es on change. The only waits are Today's cards (250 ms for all) and `beforePage`
(1.5 s for all). After that the page renders and names the slow pack.

## What core enforces

**Isolation.** Every hook call goes through `safely` (sync) or `within` (async, time-boxed). A
throw adds nothing and is logged. A failed Today card shows "Didn't answer".

**Sanitising.**
- Text is truncated, and single-line where a line is drawn.
- Every `href` goes through `safeUrl`; anything but a local path or http(s) is dropped.
- Tones come from fixed lists.
- Caps: 3 docks; acts 5 per pack, 8 fields each, 12 total; lookups 5 per pack, 6 fields each, 16 total,
  4000 characters a result, 3 rounds an answer; finds 500 per pack; linked PRs 200;
  glance 2; brief 12; lane 200; pulse counts 0–99 and 5 troubles of 80 chars, local links only.
- A dock's `key` is one free capital letter (B is Bino's), first come first served.

**Namespaces.** Need keys, ring tags and act kinds are prefixed with the pack id. A ring kind
already taken is refused. A route can't shadow core or another pack.

**Gates.** The guard (launch token locally, Access hosted) runs before every pack route, except:
- `/<id>/callback`: local only, 404 when hidden.
- `POST /<id>/ingest/*`: needs an ingest token made on Settings (only its SHA-256 is stored).
  Core checks token, body size and rate before the pack sees the body; the pack gets no headers.
  Local: this machine's address only. Hosted: needs an Access Bypass policy for the path.
- `POST /mcp` (`src/mcp.ts`): serves pack `tools` to agent turns. Each turn or terminal gets its
  own random token, valid only for `/mcp` while it runs. Claude Code gets it via `--mcp-config`,
  Codex via `-c mcp_servers.dovre.*`, omp and agy via a stdio bridge (`src/mcp-stdio.ts`)
  reading `DOVRE_MCP_URL`/`DOVRE_MCP_TOKEN`. Local only, localhost Host, no Origin header.
  Agents still ask before each tool (agy needs its own allow rule; omp doesn't ask for MCP
  tools). Calls are logged as `mcp.call` with tool and repo, never arguments or results.

Also:
- Only `/<id>/dock` pages may be framed by Dovre's pages.
- A pack's pages may frame only the origins in its `frames` (CSP `frame-src`); core pages never do.
- An act is checked against its declared fields before drawing, and asks twice unless `oneClick`.

## Rules for packs

- Packs reach each other's pages through slots, never imports.
- Writes to a pack's own app re-check state, log to `actions`, and go through a Confirm with
  `kind: "<id>.<kind>"` (listed in `writes`). Each kind takes one click unless Settings →
  Writes sets it to ask twice.
- A pack showing content not fit for a model (chats, mail, query results) sets `private`: from
  its pages, Bino hears only the pack's name.
- `bino` and `about` give names, states and counts. Never content, addresses or tokens.
  A pack without `bino` is heard through what it shows on Today (glance, needs, pulse, the
  last day's feed), unless it's `private`. A page without `about` is named, with the pack's
  needs that point at it.
- `Investigate({ prompt, repo })` (kit) puts an Investigate button on a pack's card. It opens
  `/investigate`, which hands the prompt to Bino or to a new agent session in plan mode. The
  prompt follows the same rule as `bino`.
- Tests live in `packs/<id>/test/`, with a hostile-input case per page. `testContext()`
  (`dovre/packs/testing.ts`) gives safe defaults.
- Layout: `index.ts` (manifest and hooks), `data.ts` (reads the app), `view.ts` (draws).
  `pnpm packs new <id> --into <instance>` scaffolds it.
- A pack from dovre-packs is a copy with a `.pack.json` (source, commit, version, `PACK_API`,
  file hashes). `pnpm packs outdated` / `update` / `track` (`src/packs/update.ts`) compare it with
  the local dovre-packs checkout. `update` takes upstream for untouched files, `git merge-file`s
  the rest, writes nothing on a conflict, and refuses a newer `PACK_API` or a source outside
  `REPO_OWNERS`. Locally the Packs page has an **Update** (`packs.update`, always asks twice)
  that runs the instance's typecheck and tests and rolls back on failure. New code loads on restart.

## Extending

- **A new app:** `pnpm packs new`, add it to the instance's `packs.ts`. Config keys go in the
  manifest's `settings`, bindings in `requiredBindings` and the wrangler config.
- **A new machine:** `pnpm instance new <folder>` writes packs.ts, worker.ts, wrangler.jsonc,
  package.json and a README with deploy steps.
- **A new agent harness** (core only, not a pack: its flags and what's kept are the boundary,
  #107): a folder `src/agents/harnesses/<id>/harness.ts` with its adapter (args per mode, never a
  bypass; how its stream reads) and a `HarnessDef`; its filter `launcher/keep_<id>.go`, which
  `Keep` dispatches to; and an entry in `HARNESS_DEFS` (`src/agents/harnesses/index.ts`).
  `test/harnesses.test.ts` checks the pairs line up.
- **A new place on a core page:** add a slot to `SlotMap` (`arg` in, `out` back); the page calls
  `fill(name, arg)`. Prefer slots.
- **A new hook**, only when no slot fits:
  1. Add it to `Pack` in types.ts with when it's called and its time limit.
  2. Add a `…From` in registry.ts that calls it isolated, validates the result, and logs failures.
  3. Call it from app.ts or the entry point, for `shown()` packs only.
  4. Add its label to `hooksOf` and document it in types.ts.
  5. Test it in test/packs.test.ts: hostile answer, throwing pack, hidden pack.
- **Changing the contract:** a new optional hook or slot is additive. Removing or changing a
  hook, a field's meaning or a slot's `arg` is breaking: bump `PACK_API`, and older packs show as
  off until updated. Every change so far has been additive.

## Open questions

Teams and Data moved to instance packs (2026-10-26), the avatar to dovre-packs (#130,
2026-10-27); `test/boundary.test.ts` keeps them out of core. Pack options live in manifest
`settings`; `src/config.ts` `KEYS` is core's only.

1. **Core links to agents routes.** My list, New work, tasks, reviews and the desk link to
   `/agents/new` and `/agents/s/…`, which 404 with `PACK_AGENTS=off`. Fine while agents is a
   core pack. If it ever becomes truly optional, those links become a slot.
2. **Hosted Bino proposes nothing.** It runs in the Durable Object, which has no packs, so
   `acts` are local only. It does get packs' `bino` lines through the page context, and it
   looks up through the Worker: the instance exports a `BinoLookups` entrypoint and binds it to
   itself as `BINO_LOOKUPS` (`src/hosted/lookups.ts`).
