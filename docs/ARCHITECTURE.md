# Architecture

Core, packs and instances, and how a pack gets from a folder to a page. Locked decisions are in
PLAN.md. Each hook is documented in `src/packs/types.ts`.

## Layers

```
 Instance repo (one per machine or setup)
   packs/<id>/, packs.ts, worker.ts + wrangler config, .dev.vars
        │ imports core as `dovre/…`; core never imports an instance
 Core's packs (src/packs/core/)
   agents, autoreview, history, assistant, terminal, docker, tracker, storybook, movement, prs, deploys, dependabot, stacks
 Core (this repo)
   shell + kit, hub (live.ts), gather + snapshot, agent runner, search,
   My list, Bino, notifications, actions log, Settings
   src/packs/types.ts     the contract (PACK_API = "1.15")
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
| Core's packs | all of them (terminal and docker when enabled, history with GitHub) | agents (over the bridge), autoreview, history (GitHub), assistant, movement, prs, deploys, dependabot and stacks (GitHub), tracker |
| Refresh | interval, checked every 30 s | after a response (`waitUntil`) and on cron |
| Extra hooks | `callback`, `ingest`, `acts`, `tools` | `scheduled`, `email` |

Both put core's packs first, then the instance's, and pass the list to `activePacks`.

A pack session (`src/run.ts`, #353) is a fourth entry: one pack from dovre-packs, on `createApp`
with `session: { pack }`. Only the pack's paths, `/login`, `/assets/*` and `/events` answer
(`sessionPath`); the frame holds the pack's own menu entries and no Bino, docks or questions. The
launch token is made for the session and the database is in memory. Started on a checkout,
the code folder is its parent and `ctx.checkouts()` / `ctx.checkout()` hold only that one; a pack
on an API before 1.7 lists the folder itself, and the session warns that it may see the rest. Its
settings (#369) come from `--set`, the environment, then the core folder's `.dev.vars` (read only);
`GET /settings/packs/<id>` and `POST /packs/<id>/settings` also answer in a session, without a
`varsFile`, so what's saved there stays in `packs.env` and dies with the process.

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
   lowercase unique id; its `api` fits this `PACK_API` (same major, minor no newer); `PACK_<ID>` isn't `off`; `execution` fits;
   `requiredBindings` (hosted) or `requiredBinaries` (local) exist; required settings are set.
   Then `requires` (#326): a pack is off while any pack it requires is off or missing, and
   comes back with it. `on` is ordered so each pack starts and refreshes after what it requires.
   A pack switched off on the Packs page takes what requires it off too. A pack reaches what it
   requires only through what that pack shares (`shares`, read with `ctx.required(id, name)`),
   never by importing it. Each shared contract's shape is core's (`PackShares` in types.ts).
   A pack that only `uses` another (1.11) reads its shares the same way while it's on, and stays
   on without it. Core reads shares too: Bino, search and New work find My list as `list`.
   Links to the agents pack's pages come from its `agent` share (1.12), so they go away with it.
4. **Mounted** (`createApp`). Each pack gets its own `PackContext`. If `available` says no or
   throws, the pack is off. Routes go on a sub-app mounted after the guard and all core routes.
   The mount is refused for a route outside `/<id>` and the manifest's `paths`, a path core or
   another pack owns, or a `routes` that throws. Pack `styles` are served as one hashed file,
   each pack's rules scoped to its own markup (see Containment); each pack's `script` as a hashed
   file of its own, inside a `try`; and each `wasm` module (lowercase name, real WebAssembly) at a hashed path;
   while any pack ships WebAssembly, pages' CSP allows `'wasm-unsafe-eval'`. A module is either
   bytes (8 MB at most, carried in the Worker bundle: keep them small) or a `WasmFile`
   (`{ sha256, load }`, 25 MB at most) kept out of the bundle: locally core calls `load` on the
   first request and serves the bytes only if their SHA-256 matches; hosted, the wrangler `build`
   step (`src/packs/assets.ts`) loads and checks each one under Node and writes it into the
   Worker's static assets, and the Worker serves it from `ASSETS` without calling `load`. A stale
   `sha256` fails the build, naming the pack. A pack's `files` (a browser library too big for the
   bundle: `mermaid.js`, `katex.css`; lowercase, `.js` or `.css`) go the same way as a `WasmFile`,
   at `/assets/files/<id>.<name>.<sha>.<ext>`, and widen the CSP only for a script marked `wasm`
   (it carries WebAssembly inside, like Graphviz's build), which counts as shipping WebAssembly: its own script loads them, finding their paths in `dovreFiles` on any page. Core's Markdown marks a closed fence's language (`pre.code[data-lang]`), so a pack's script may draw it in place (mermaid in Bino's answers), and its math (`code[data-tex]`, a `$$` block as a `math` fence); without one, the source shows. Scripts listen for `dovre:change` and `dovre:swap` on `document`.
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
- `file(name)`: where one of its `files` is served

**Hooks**, by where they land:

| Where | Hooks | Timing |
|---|---|---|
| Own pages | `routes`, `styles`, `script`, `wasm`, `files`, `nav`, manifest `paths` | on request |
| Today | `today`, `glance`, `brief`, `lane`, `feed` | cards: 250 ms total; rest from memory |
| Stats | `stats` (chart, headline number or bar list); Stats exists only while a pack draws there | from memory |
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

**Containment** (`src/packs/guard.ts`). A pack's slip breaks only the pack:
- **Pages.** A pack route that throws, or takes longer than 30 s, answers 500 with the pack's
  broken page inside the shell, naming the pack, and logs to its line on the Packs page.
- **Markup.** Every fragment a pack hands core (its pages and docks, Today cards, slots, banners,
  Settings panel) is checked: a tag closed that wasn't opened, a container left open, `<html>`,
  `<head>`, `<body>`, `<base>` or `<style>` swaps the fragment for "<Pack> couldn't draw this part"
  and logs why. A fragment that's a failed promise does the same instead of failing the page.
- **Size.** Pages, docks, Today cards, Settings panels and block slots (`today.hero`,
  `agents.panel`, `todo.proposals`, `pr.lead`, `work.new`) sit in a `.pack-box`: its width is
  clipped at the box, media and `<pre>` fit it, long words wrap. Nothing a pack draws makes the page
  wider than the screen. The box is also its frame (`contain: layout`): something `position: fixed`
  or `absolute` inside it is placed in the box and stacks under core's bars, so a pack's overlay
  can't cover the page. A real dialog (`<dialog>` with `showModal()`, a popover) still opens on
  top of everything. Inline slots (buttons, facts) are checked, not boxed.
- **Styles.** A selector is kept only when the element it styles, or an ancestor, carries a class
  of the pack's own (one core's stylesheet doesn't use). `body`, `:root`, `.panel`, `.item .x` and
  `.mine ~ .panel` restyle core and are left out (logged); so is `@import`.
- **Scripts.** A file per pack, its body in a `try`: one pack's syntax error or throw stops only it.

These guard against mistakes, not malice: a pack is code its owner chose to run.

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
  reading `DOVRE_MCP_URL`/`DOVRE_MCP_TOKEN`. A pack session (`dovre run`, `src/run.ts`) makes one
  token for the session and prints a `claude mcp add` line with it. Local only, localhost Host, no Origin header.
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
- Styles: give every rule a class of the pack's own (`.<id>-…`); restyle a kit component only
  inside it (`.mypack .item`). Tables go in `.table-wrap`; wide content scrolls inside the pack.
- Tests live in `packs/<id>/test/`, with a hostile-input case per page. `testContext()`
  (`dovre/packs/testing.ts`) gives safe defaults; `assertScoped(pack)` fails on a selector that
  would be left out, `assertFragment(name, html)` on markup core would refuse.
- Layout: `index.ts` (manifest and hooks), `data.ts` (reads the app), `view.ts` (draws).
  `pnpm packs new <id> --into <instance>` scaffolds it.
- A pack from dovre-packs is a copy with a `.pack.json` (source, the commit and release tag it
  came from, the pack's own version, the `PACK_API` it needs, file hashes). Each pack is released
  on its own: a semver `version` in its manifest, `packs/<id>/CHANGELOG.md`, and a tag
  `<id>@x.y.z` in dovre-packs. `pnpm packs add` copies the newest release; `outdated` / `update
  [--to x.y.z]` / `track` (`src/packs/update.ts`) fetch the checkout's tags and compare the copy
  with the newest release, listing the changelog lines in between. A pack with no tags yet follows
  the checkout's HEAD. `update` reads the release from git, takes it for untouched files,
  `git merge-file`s the rest (base = the recorded commit), writes nothing on a conflict, and
  refuses a release needing a `PACK_API` this core lacks or a source outside `REPO_OWNERS`. A
  `.pack.json` from before releases has no version; its next update records one. Locally the
  Packs page shows each copy's version, the newest release and what changed, with **Update to
  x.y.z** (`packs.update`, always asks twice), which runs the instance's typecheck and tests and
  rolls back on failure. Below the packs, **Add from dovre-packs** (#88) lists the checkout's packs
  this instance doesn't have, each read from its newest release's `index.ts` as text (name,
  description, version, API, where it runs), never run. **Add** (`packs.add`) does `pnpm packs
  add`'s work into the first `PACKS` folder with a `packs.ts`, runs the same checks, and takes the
  pack and the `packs.ts` line out again on failure. New code loads on restart.
- Without a dovre-packs checkout (`--from`, `DOVRE_PACKS_DIR`, or one beside dovre), the CLI keeps
  its own blob-less clone in `~/.cache/dovre/dovre-packs` (`DOVRE_PACKS_CACHE`), made on first use
  and synced to origin on each `add` / `outdated` / `update`, so every tag and merge base is there.
- Hosted (`src/packs/releases.ts`), the Packs page reads dovre-packs' tags through the GitHub API
  at most once an hour (in the background, the page shows the kept answer): a bundled pack behind
  its newest release shows **x.y.z available**, whether this core can run it, and what changed.
  The released packs not bundled are listed to add. With `INSTANCE_REPO` set (an owner's repo, the
  token able to write contents and PRs there), **Add** (`src/actions/addpack.ts`) opens a PR on it
  with what `pnpm packs add` would write, as one commit on `dovre/add-<id>`: the files at the
  release tag (text inline, binaries as blobs), `.pack.json`, and the `packs.ts` line. It re-reads
  the release and the instance first, runs in the background, and logs the PR (or why not) to
  `actions`, which the page shows. Without it, the page gives the command to run.
  Taking it stays in the instance repo (`pnpm packs update <id>`, then deploy); a Worker can't
  rewrite itself.

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
- **Changing the contract:** `PACK_API` is `"major.minor"` (#360, `src/packs/api.ts`). A new
  optional hook, slot, field or markup contract is additive: bump the minor and add a row below. A
  pack's manifest names the oldest API it works with (`api: "1.4"`; a plain `1` reads as `1.0`),
  so on an older core it shows as off ("needs core API 1.4, this is 1.3") instead of quietly doing
  nothing, and `packs update` refuses it. Removing or changing a hook, a field's meaning or a
  slot's `arg` is breaking: bump the major, and older packs show as off until updated. A pack
  written `api: PACK_API` claims whatever core it links, so only a literal protects it.

  | API | Added |
  | --- | --- |
  | 1.0 | Everything through pack containment (#347, 2026-11-01) |
  | 1.1 | `Pack.files`: big scripts and stylesheets served outside the bundle (#354) |
  | 1.2 | The `pr.file` slot; `forge.file` at a commit (#355) |
  | 1.3 | A `Pack.files` script can carry WebAssembly (`wasm: true`) (#356) |
  | 1.4 | Closed fences in core Markdown name their language (`data-lang`); pack scripts get `dovreFiles` (#357) |
  | 1.5 | Math in core Markdown is marked for a pack to draw (`code[data-tex]`, `pre.code[data-lang=math]`) (#358) |
  | 1.6 | `manifest.version`, a pack's own release, on the Packs page (#364) |
  | 1.7 | `ctx.checkouts()` and `ctx.checkout(name)`: the git repos directly under the code folder, narrowed to one in a pack session (#368) |
  | 1.8 | A `PackStat` bar list (`bars`) and `partialLast`; `refresh(ctx, { asked })` when I pressed Gather again (#387) |
| 1.9 | Slots `pr.agent` (a block on a PR card) and `review.draft` (an agent's draft for my own review); agent reviews became the `reviews` pack (#389) |
| 1.10 | Slot `ai.summary` (a PR's or deploy's summary by key, drawn by core); AI summaries became the `summaries` pack (#390) |
| 1.11 | Manifest `uses` (packs it reads while they're on, without needing them); `ctx.refs()`; share `list` (My list, read by Bino, search and New work). My list became the `todo` pack (#393) |
| 1.12 | Share `agent` (where the agents pack starts an agent and shows a session or run): My list, New work, reviews and core link through it and leave the link out while agents is off (#394) |
| 1.13 | `ctx.pageOn(href)`: whether a page answers here, so a pack leaves out a tab to another pack's page that's off; slot `pr.stack` (the viewer's "2 of 3 in a stack", from the stacks pack) (#408) |
| 1.14 | Manifest `roles`, `answers` and `markers` (who it suits, which interview answers, which files the checkout scan looks for) and `onboard` (its own setup, up to 3 steps), for first run's suggestions (`src/packs/suggest.ts`) (#415) |
| 1.15 | A setting's `choices`: the values it takes, shown as a picker on its settings page; a value outside them isn't kept (the assistant's `ASSISTANT_VIA`, #417) |

## Open questions

Teams and Data moved to instance packs (2026-10-26), the avatar to dovre-packs (#130,
2026-10-27); `test/boundary.test.ts` keeps them out of core. Pack options live in manifest
`settings`; `src/config.ts` `KEYS` is core's only.

1. **Hosted Bino proposes nothing.** It runs in the Durable Object, which has no packs, so
   `acts` are local only. It does get packs' `bino` lines through the page context, and it
   looks up through the Worker: the instance exports a `BinoLookups` entrypoint and binds it to
   itself as `BINO_LOOKUPS` (`src/hosted/lookups.ts`).
