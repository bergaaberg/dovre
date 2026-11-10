# Architecture

Core, packs and instances, and how a pack gets from a folder to a page. Locked decisions are in
PLAN.md. Each hook is documented in `src/packs/types.ts`.

## Layers

```
 Instance repo (one per machine or setup)
   packs/<id>/, packs.ts, worker.ts + wrangler config, .dev.vars
        │ packs import core as `dovre/pack.ts`; core never imports an instance
 Core's packs (src/packs/core/)
   agents, assistant, autoreview, dependabot, deploys, history, prs, reviews, stacks,
   terminal, todo, tracker
 Core (this repo)
   shell + kit, hub (live.ts), gather + snapshot, agent runner, search,
   My list, Bino, notifications, actions log, Settings
   src/pack.ts            the contract, as packs import it (`dovre/pack.ts`)
   src/packs/types.ts     its types (PACK_API = "2.0")
   src/packs/registry.ts  core's side of every hook
   src/packs/hooks.ts     every hook, as one table
   src/packs/mount.ts     each pack's ctx, and where its hooks and routes are mounted
```

- **Core** never names, imports or defaults to an instance or its packs.
- **Core's packs** use the same hooks as any pack, so they can be switched off.
  `test/packs.test.ts` fails if core imports them anywhere but the entry points. They aren't a
  trust tier (#480): today the entry points hand them things no outside pack gets (the forge
  client, the agent runner, Bino's route), and that's a debt, not a rule. A pack outside core may
  get the same power through `ctx`, behind a grant where it matters (as `ctx.complete`,
  `ctx.agent` and `ctx.mcp` are). Each capability is designed once (a scoped forge client,
  `ctx.run`), not as one method per pack that leaves, and `ctx` grows as packs really leave.
- **An instance** is a repo such as `../my-dovre` holding one setup's packs and config.

## Entry points

| | Local (`src/index.ts`) | Hosted (`src/worker.ts`) |
|---|---|---|
| Packs from | `PACKS` folders, each `packs.ts` imported at start (`src/packs/load.ts`) | The instance's worker.ts calls `createWorker({ packs })` |
| Core's packs | all of them (terminal when enabled; history with GitHub; reviews, stacks and dependabot where the forge has them) | agents (over the bridge), autoreview, history (GitHub), assistant, todo, prs, deploys, stacks and dependabot (where the forge has them), tracker; never reviews or terminal |
| Refresh | interval, checked every 30 s | after a response (`waitUntil`) and on cron |
| Extra hooks | `callback`, `ingest`, `acts`, `tools` | `scheduled`, `email` |

Both put core's packs first, then the instance's, and pass the list to `activePacks`.

A pack session (`src/run.ts`, #353) is a fourth entry: one pack from dovre-packs, on `createApp`
with `session: { pack }`. Only the pack's paths, `/login`, `/assets/*` and `/events` answer
(`sessionPath`); the frame holds the pack's own menu entries and no Bino, docks or questions. The
launch token is made for the session and the database is in memory. Started on a checkout,
the code folder is its parent and `ctx.checkouts()` / `ctx.checkout()` hold only that one. Its
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
   never by importing it. The shares core reads itself have core's shapes (`PackShares` in
   types.ts: `agent`, `list`). Any other is its pack's own (1.38): core passes it along unread,
   `ctx.required` answers `unknown`, and the pack that shares it ships the type with a reader
   that narrows (the agents pack's `auto`: `AutoShare` and `autoOf` in its `share.ts`, which
   Auto review imports and nothing else of that pack).
   A pack that only `uses` another (1.11) reads its shares the same way while it's on, and stays
   on without it. Core reads shares too: Bino, search and New work find My list as `list`.
   Links to the agents pack's pages come from its `agent` share (1.12), so they go away with it.
4. **Mounted** (`createApp`). Each pack gets its own `PackContext`. If `available` says no or
   throws, the pack is off. Routes go on a sub-app mounted after the guard and all core routes.
   The mount is refused for a route outside `/<id>` and the manifest's `paths`, a path core or
   another pack owns, or a `routes` that throws. Its styles, script and files are served as
   below (A pack's assets).
5. **Started** (`initAll`). A pack whose `init` throws is turned off.
6. **Refreshed** (`refresher`). Every `everyMs` (default 5 min), one run at a time per pack.
   Runs longer than `maxMs` are abandoned (hosted). Starts, ends and errors go to the Packs page.
   A pack that's following something asks for the next one itself, `ctx.soon(ms)`, in place of
   a timer of its own: `refresh(ctx, { soon: true })` in about that long (5 s at least), once,
   after any run in flight; it asks again from `refresh` while there's more to follow, for 30
   minutes on end at most. Locally that's a timer core keeps; hosted nothing stays up, so it's
   due at the next request or cron. And when an agent turn the pack started ends, its refresh is
   told once, `refresh(ctx, { agent })` (local, where turns run). One refresher serves all of
   it (`packsOf(app).refresh`), so no two refreshes of a pack run beside each other.
   Not built: durable jobs hosted. That would take a Queue or a Durable Object alarm per pack
   to wake an isolate, and somewhere to keep what's pending between isolates.
7. **Hidden.** Settings → Layout hides a pack: it leaves every hook, its routes 404 and it
   isn't refreshed. `PACK_<ID>=off` stops it loading at all.

## A pack's assets

- **`styles`**: every pack's rules are served as one hashed file, each pack's scoped to its own
  markup (see Containment).
- **`script`**: a hashed file per pack, its body in a `try`. It hears what changed through
  `dovreOn(topics, fn, { notes })`; a script that listens to `dovre:change` itself isn't served
  (every open tab hears every change). On `document` it may hear `dovre:swap`. `dovreFiles` holds
  its `files`' paths on any page.
- **`wasm`**: each module (lowercase name, real WebAssembly) is served at a hashed path. While any
  pack ships WebAssembly, pages' CSP allows `'wasm-unsafe-eval'`. A module is either bytes (8 MB
  at most, carried in the Worker bundle: keep them small) or a `WasmFile` (`{ sha256, load }`,
  25 MB at most) kept out of the bundle. Locally core calls `load` on the first request and
  serves the bytes only if their SHA-256 matches. Hosted, the wrangler `build` step
  (`src/packs/assets.ts`) loads and checks each one under Node and writes it into the Worker's
  static assets, and the Worker serves it from `ASSETS` without calling `load`. A stale `sha256`
  fails the build, naming the pack.
- **`files`**: a browser library too big for the bundle (`mermaid.js`, `katex.css`; lowercase,
  `.js` or `.css`) goes the same way as a `WasmFile`, at `/assets/files/<id>.<name>.<sha>.<ext>`.
  The pack's own script loads them. The CSP widens only for a script marked `wasm` (it carries
  WebAssembly inside, like Graphviz's build), which counts as shipping WebAssembly.
- **Markdown.** Core's Markdown marks a closed fence's language (`pre.code[data-lang]`) and its
  math (`code[data-tex]`, a `$$` block as a `math` fence), so a pack's script may draw them in
  place (mermaid in Bino's answers). Without one, the source shows.
- **Motion.** A pack's motion stops under `prefers-reduced-motion` only while `<html>` isn't
  `data-motion="always"` (Settings → Look → Motion): scope those rules under
  `:root:not([data-motion="always"])`, and check the attribute in scripts too.

## The contract

`src/packs/types.ts` is the whole contract.

**`PackContext`** gives a pack:
- `env`, `bindings`, `hosted`, `db`. `env` is meant to hold the pack's own keys: its manifest's `settings`,
  the keys a `namesKeys` setting names, `PACK_<ID>`, and the shared few (`SHARED_ENV` in `src/packs/env.ts`). Nothing else (API 1.41): another key reads as unset,
  and asking for one that is set is logged once and named on the pack's card on the Packs page
  ("Asked for, not given"). The view is read-only (#475). `bindings` is the same for the Worker's
  bindings: the ones its manifest names (`requiredBindings`, and `bindings` for ones it can do without) and no other (#484).
  `db` is Dovre's database for a pack with `migrations` (its own tables) or the manifest line `db: "raw"`
  (named on its card, "Database: raw"); for any other pack it throws when used. Dovre's own packs
  (`CORE_PACKS` in `src/packs/own.ts`) get the plain settings, bindings and database.
- `can(what)`: whether something works here and why not (`{ ok: false, why }`): `ask`, `ring`, `acts`, `tools`, `checkouts`, `programs`, and `text`, `agent`, `mcp`. The one answer for what's local only or needs my OK
- `store.kv`: its own small state in Dovre's database, JSON by key under its id (`get`, `set` with `ttlMs`, `delete`, `list(prefix)`). Tables of its own are `migrations`
- `codeDir` (local), `checkouts()`, `checkout(name)`: the code folder and the git repos directly under it (none hosted); only the one in a pack session
- `run(binary, args, opts)`, `onPath(binary)`, `dir()` (local): run a program its manifest names (`requiredBinaries`, or `binaries` for ones it can do without), in a checkout or in its own folder. Never an agent CLI. The folder is where the program starts, not a fence around it
- `publish(topics)`: tell open pages a region changed
- `snapshot()`, `gathered()`: what the gather read from the forge
- `fill(slot, arg)`: host other packs' slots on its pages
- `fillOwn(name, arg)`: what other packs put in a place of its own (its manifest's `hosts`); they answer in `slots` under `"<its id>/<name>"`, and must list it in `uses` or `requires`
- `soon(ms?)`: its `refresh` again in about `ms` (10 s by default, 5 s at least), as `{ soon: true }`; no timers of its own
- `page()`, `dockPage()`: draw inside the shell
- `pageOn(href)`: whether a page answers here, to leave out a link to a pack that's off
- `viewer()`: whom the current request is for (hosted: their email; no one locally)
- `log()`, `ring()`: log, or a one-off notification
- `logged()`: a write it made, into the actions log as `<id>.<kind>`
- `ask()`, `asking()`: put a question in the top bar and wait for the answer (local only)
- `required(id, name)`: what a pack it `requires` or `uses` shares, while that pack is on
- `refs()`: every shown pack's kinds of reference, for linking what I write
- `setupDone()`: whether every step of its setup is done
- `forge()`: read-only, and undefined before the first gather. Who I am there (`id`, `name`, `host`, `login`, `owners`) and `owns(repo)`; the forge's `work`, `merged` and `untriaged`; `repos()`, `file()`, `dir()` and `pr()` to read the owners' repos, and `everyRepo(paths)` for every repo's files at once (one call per owner, kept for every isolate up to the age the pack takes); `propose()` to open a PR changing up to five files (one of the pack's `writes` kinds, re-checked against `expect`, logged)
- `ai()`, `complete()`: what it may ask the model, and a prompt in, text out. Off until I allow it on Settings → Packs, capped per day, logged by cost only
- `agent` (`can`, `start`, `result`, `land`): an agent turn in a repo I allowed, in plan mode in its checkout or in the sandbox
- `mcp` (`can`, `call`, `write`): exact calls to the one MCP server its manifest names, results in memory only (local)
- `startPicture(svg)`, `pulse()`
- `wasm(name)`: where one of its `wasm` modules is served
- `file(name)`: where one of its `files` is served

**Hooks**, by where they land:

| Where | Hooks | Timing |
|---|---|---|
| Declared | `manifest` (id, name, `api`, `settings`, `requires`, `uses`, `ai`…), `writes` (its write kinds), `shares` (what packs requiring it read) | at load; `shares` from memory |
| Own pages | `routes`, `styles`, `script`, `wasm`, `files`, `nav`, manifest `paths` | on request |
| Today | `today`, `glance`, `brief`, `lane`, `feed` | cards: 250 ms total; rest from memory |
| Stats | `stats` (chart, headline number or bar list); Stats exists only while a pack draws there | from memory |
| Search | `pages`, `finds` | from memory |
| Attention | `needs` (+ manifest `rings`), `banner`, `dock` | from memory |
| Bino | `bino`, `about`, `lookups`, `acts` (local) | `bino` from memory; `about` may read its app (2 s at most); lookups run when Bino asks (8 s at most); acts run in the background |
| Core pages | `slots` (18 in `SlotMap`) | from memory |
| Framing | `frames`: `https://` origins its pages may frame | from memory |
| Links | `refs` (ticket keys), `linked` (PR links to look up) | from memory |
| Settings | `settings` panel, manifest `settings` keys | from memory |
| Setup | `setup`: its page at `/setup/<id>`, a step for each in manifest `onboard` | on request |
| Pulse | `pulse`: working/asking counts, trouble, on duty | from memory |
| Lifecycle | `available`, `migrations` (its own tables, run once each before `init`), `init`, `refresh`, `beforePage`, `dispose` | `beforePage`: 1.5 s total |
| Outside callers | `callback`, `ingest`, `tools`, `scheduled` and `email` (hosted) | when called |
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

- Packs reach each other's pages through slots, never imports. A place on a pack's own page is
  that pack's (`hosts` in its manifest, `ctx.fillOwn`), not a name in core's `SlotMap`: core routes
  and checks it as any slot, and never learns what the place is for.
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
  (`dovre/pack-testing.ts`) gives safe defaults (pass `{ id }` to log as that pack, not `test.<kind>`); `assertScoped(pack)` fails on a selector that
  would be left out, `assertFragment(name, html)` on markup core would refuse.
- Layout: `index.ts` (manifest and hooks), `data.ts` (reads the app), `view.ts` (draws).
  `pnpm packs new <id> --into <instance>` scaffolds it.
- **One door (#473):** a pack imports core as `dovre/pack.ts` (the contract's types, the kit,
  `safeUrl` and friends, the act helpers, `markdown`), and `dovre/pack-testing.ts` in its tests.
  That file is the contract. Since 2.0 (#484) core's `package.json` exports the doors and what an
  instance's worker wires up (`dovre/worker.ts`, `dovre/demo/worker.ts`, …), and anything else
  under `dovre/…` may move without notice. A packs repo's `test/imports.test.ts` calls
  `assertDoors(packsDir)` (`src/packs/imports.ts`), which fails on any other import; an instance
  still moving may pass the reach-ins it has left, counted per module, in a list that only
  shrinks. `pnpm packs new` and `pnpm instance new` write that test.
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
- **A new hook**, only when no slot fits, is three edits:
  1. Add it to `Pack` in types.ts, documented there: when it's called and its time limit.
  2. Add a `…From` in registry.ts that calls it isolated, validates the result, and logs failures.
  3. Add its row to `HOOKS` (`src/packs/hooks.ts`): its label on the Packs page, its row in the
     hooks table above, how it's called, and its `…From` as `from`.

  `test/hooks.test.ts` then runs it with a throwing pack and hostile answers, and fails while a
  hook core calls has no `from`. Whatever reads it gets it from `src/packs/mount.ts` (one line
  there: the `…From` over `shown()` packs), or from the entry point. Test what's its own in
  test/packs.test.ts (what a good answer becomes, a hidden pack).
- **Changing the contract:** `PACK_API` is `"major.minor"` (#360, `src/packs/api.ts`). A new
  optional hook, slot, field or markup contract, or a new export of `src/pack.ts`, is additive:
  bump the minor and add a row below (`test/sdk.test.ts` lists the exports, and fails on a change;
  `test/docs.test.ts` fails while this doc lacks the row, a `ctx` member, a hook, or the slot count). A
  pack's manifest names the oldest API it works with (`api: "2.1"`; a plain `2` reads as `2.0`),
  so on an older core it shows as off ("needs core API 2.1, this is 2.0") instead of quietly doing
  nothing, and `packs update` refuses it. The number is checked (#482): each minor's names are
  also in `API_ADDED` (`src/packs/api.ts`), and a packs repo's test runs `assertApi` on each pack,
  which fails on "uses ctx.agent (1.23), declares 1.6" (2.x starts with nothing to check: a 2.0 pack may use all of 1.x). Removing or changing a hook, a field's meaning or a
  slot's `arg` is breaking: bump the major, and older packs show as off until updated ("written for pack contract 1, this Dovre speaks 2: update the pack"). A pack
  written `api: PACK_API` claims whatever core it links, so only a literal protects it.

  | API | Added |
  | --- | --- |
  | 2.0 | Everything 1.x added (docs/PACK-API-1.md), with the old ways gone (#484). A pack moving from 1.x: `ctx.db` only with `migrations` or the manifest line `db: "raw"`; `ctx.bindings` holds only `requiredBindings` and the new `bindings` (read when there); `ctx.checkouts()` and `ctx.checkout()` are always there (none hosted) and `forge().owns` too; `ctx.can(what)` is the one answer for what's local only or needs my OK; `span.actions` is otel-sink's own place, not core's slot; the door no longer names the agents pack's `auto` share types; and core's `package.json` exports the doors and an instance's wiring, not every file. |

## Open questions

Teams and Data moved to instance packs (2026-10-26), the avatar to dovre-packs (#130,
2026-10-27); `test/boundary.test.ts` keeps them out of core. Pack options live in manifest
`settings`; `src/config.ts` `KEYS` is core's only.

1. **Hosted Bino proposes nothing.** It runs in the Durable Object, which has no packs, so
   `acts` are local only. It does get packs' `bino` lines through the page context, and it
   looks up through the Worker: the instance exports a `BinoLookups` entrypoint and binds it to
   itself as `BINO_LOOKUPS` (`src/hosted/lookups.ts`).
