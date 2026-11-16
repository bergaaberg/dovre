# Source

`owasp-code-review.ts` holds an unchanged copy of one play from the OWASP Secure Agent Playbook.
Auto review's security reviewer gets it with its instructions (`src/packs/core/autoreview/reviewer.ts`).

- Work: "Play: Security Code Review", `plugins/code-security-skills/plays/code-review-security.md`
- From: OWASP Secure Agent Playbook, an OWASP Foundation project, by its contributors
- Upstream: https://github.com/OWASP/secure-agent-playbook
- Commit: `65d4efd2cd0b081d52101e9708792b944e4ddebb` (release 0.2.11, 2026-10-15)
- Retrieved: 2026-11-16, from the GitHub contents API at that commit
- Licence: Creative Commons Attribution 4.0 International (CC BY 4.0),
  https://creativecommons.org/licenses/by/4.0/
- Changes: none to the text. It is wrapped in a TypeScript string so it loads the same way locally
  and in the hosted Worker (backticks, backslashes and `${` are escaped in the source only).

The rest of this repository is under the MIT licence (`LICENSE`); this one text stays under CC BY 4.0.

## What isn't here

The rest of the playbook: its other plays, skills and the reference data the play points to
(`data/asvs/…`, some of it under CC BY-SA 4.0). The reviewer has no tools and can't open them, and
its instructions say so.

## Updating

1. Download the play at the new commit into a new, empty folder.
2. Read the diff: this text goes into a reviewer's prompt.
3. Regenerate `owasp-code-review.ts` from it (escape `\`, `` ` `` and `${`), and update the commit,
   the SHA-256 and the dates here and there.
