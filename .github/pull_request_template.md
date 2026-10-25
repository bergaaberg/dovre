## What

<!-- One or two sentences: what this PR changes. -->

Closes #<!-- N --> <!-- or "Part of #N" if it's one phase of a larger issue -->

## Why / notes for the reviewer

<!-- Anything the issue got wrong, decisions you made, anything left out on purpose. -->

## How I tested it

<!-- Paste the result of `pnpm check`: test counts, plus any failure you checked separately and why. -->

## Checklist (see CONTRIBUTING.md and CLAUDE.md)

- [ ] Branched from an up-to-date `main`; this PR covers one issue
- [ ] `pnpm check` passes, and I ran it myself
- [ ] Data in views is escaped (`html\`…\``), and every data-built `href` goes through `safeUrl()`
- [ ] Every new page has a hostile-input test case
- [ ] Styles are only in `src/ui/style.ts`, with no inline `style="…"`
- [ ] Every write re-checks state, is logged and goes through `Confirm` (or this PR has no writes)
- [ ] Terminal and agent permission limits are unchanged (or this PR doesn't touch them)
- [ ] No secrets, real personal data or AI-attribution trailers
