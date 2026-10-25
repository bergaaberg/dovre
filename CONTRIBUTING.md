# Working on Dovre issues

This is the process for every agent or person who takes an issue in `bergaaberg/dovre` or `bergaaberg/dovre-packs`. Follow it step by step. If a step doesn't fit your situation, stop and ask on the issue. Don't improvise around it.

**Roles.** Implementers take an issue, build it on a branch and open a pull request. The **arbiter** (the maintainer's lead agent) reviews every pull request, runs the checks again and merges. Implementers never merge, and never push to `main`.

## 1. Before you start

1. Read [CLAUDE.md](CLAUDE.md) (the code rules), [PLAN.md](PLAN.md) (locked decisions) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (the Pack contract). They apply to every change.
2. Pick an issue nobody is assigned to. Take only one at a time.
3. Claim it, so other agents can see it's taken:
   ```bash
   gh issue edit <N> --add-assignee @me
   gh issue comment <N> --body "Taking this. — <your agent name>"
   ```
4. **Check the issue against the code.** Issue text can be wrong or out of date. For example, an issue once said core used the `gh` CLI, but it calls GitHub's APIs directly. If the issue is wrong, too big, or clashes with CLAUDE.md or PLAN.md, comment on it with what you found and wait. Don't build something different from what it asks.

## 2. Branch

Always start from an up-to-date `main`, on a new branch:

```bash
git switch main && git pull --ff-only
git switch -c <type>/<N>-<short-slug>     # e.g. feat/4-pack-settings-editor
```

`<type>` is one of `feat`, `fix`, `refactor`, `docs`, `test` or `chore`. **Never commit on `main`.** One issue gets one branch and one pull request.

## 3. Build

- Keep the change to what the issue asks. Don't rename, reformat or "tidy" code you aren't changing.
- Follow every rule in CLAUDE.md. Reviewers reject these most often:
  - **Escaping:** views use `html\`…\`` from `hono/html`. Use `raw()` only around static constants. Every `href` built from data goes through `safeUrl()`.
  - **Hostile-input test:** every new page gets a test case in `test/app.test.ts` that feeds `<script>alert(1)</script>` and `javascript:alert(1)` through it and checks they come out inert.
  - **One stylesheet:** styles go only in `src/ui/style.ts`, with no `style="…"` attributes. Build pages from `src/ui/kit.ts` inside `shell()`. `ok`, `warn` and `bad` colours mean status only.
  - **Verified writes:** any write (to GitHub or a pack's own app) re-checks the current state first, logs to the `actions` table and goes through the two-click `Confirm`. Repos outside `REPO_OWNERS` are refused.
  - **Terminals:** only programs from the fixed list, only in checkouts directly under `CODE_DIR`, and every write checks the exact `Origin` (`src/strict.ts`). Never widen this.
  - **Agent permissions:** agent turns run in `default`, `acceptEdits` or `plan` mode only. Never store or render raw tool results.
  - **Non-blocking pages:** pages read `gatherer.get()`, and actions call `gatherer.stale()` before redirecting.
  - **Core stays generic:** core never names, imports or defaults to a specific instance repo, or to the site repo.
  - **TypeScript is type-stripped:** imports use `.ts` extensions. No enums and no parameter properties.
- Add tests for the behaviour you add. Pack tests go in `packs/<id>/test/`.
- Never put secrets, tokens or real personal data in code, tests, commits or PR text.

## 4. Check

Run the full gate in the repo you changed:

```bash
pnpm check        # dovre: typecheck, Node tests and Go tests (launcher/)
pnpm check        # dovre-packs: typecheck and tests
```

It must pass with zero failures. Note the test counts, because they go in the PR. If a test fails for a reason that has nothing to do with your change (a known one is the hub test in `test/bridge.test.ts` under full load), run it on its own and say so in the PR. **Never write that you ran or verified a check you didn't run.**

## 5. Commit and open the pull request

- Commit messages use the `<type>(<scope>): <summary>` format, for example `feat(packs): settings editor on /packs`. Don't add AI-attribution trailers (`Co-Authored-By`, `Claude-Session` and so on).
- Push **your branch** (never `main`) and open the PR:
  ```bash
  git push -u origin HEAD
  gh pr create --fill   # then edit the body to match the template
  ```
- Fill in every section of the PR template. Link the issue with `Closes #N` when the PR finishes it, or `Part of #N` when it's one phase of a larger issue.
- If you're unsure about the approach, open it as a draft (`--draft`) and ask your question in the body.

## 6. Review and merge

- The arbiter checks the diff against CLAUDE.md, checks your claims in the code, runs the gate again and then squash-merges, or leaves review comments.
- Answer review comments with new commits on the same branch. Don't force-push over reviewed commits, and don't open a second PR.
- **Never merge your own PR**, even if you have the rights to.

## Never

- Commit or push to `main`, or force-push to any shared branch.
- Deploy anything (`wrangler deploy` or any release). Deploys need the maintainer's explicit go.
- Change repo settings, secrets, labels or other people's issues.
- Close an issue by hand. The merged PR closes it.

## When you're stuck

Comment on the issue with what you tried, what failed and what you need. Then either wait, or unassign yourself (`gh issue edit <N> --remove-assignee @me`) so someone else can pick it up. A clear "stuck" comment is better than a PR that guesses.
