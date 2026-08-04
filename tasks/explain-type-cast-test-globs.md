---
status: in-review
size: small
---

# Iterate Review: stop applying explain-type-cast to test code the globs miss

## Status summary

Spec written; one-file change to follow.

## Ask (from Misha)

Exclude the `typescript/explain-type-cast` rule from ANY test code. The rule's
frontmatter already excludes `*.{test,spec}.*` files and `__tests__/test/tests/spec/specs`
directories, but real test code still slips through — most recently the casts in
`apps/os/e2e/examples/example-cases.ts` on PR #2409. Test code shouldn't need
cast-justification comments (per the repo's own testing docs, test files are not the
place to get fancy about types).

## Gaps found in this repo

- `**/e2e/**` — eight e2e directories (apps/os, apps/mobile, apps/auth, …), none
  matched by the current negatives.
- Test scaffolding named by convention outside test dirs:
  `apps/os/src/domains/projects/project-processor-test-harness.ts`,
  `apps/os/e2e/vitest/test-helpers.ts` (the latter also covered by the e2e glob).
- Root `specs/` is already covered by the existing directory glob.

## Checklist

- [x] Add `!**/e2e/**` and `!**/*test-{helpers,harness,utils}.{ts,tsx,mts,cts}` to
      `rules/typescript/explain-type-cast.md`'s files globs.

## Out of scope

- The identical template copy at
  `apps/os/config-repo-template/rules/typescript/explain-type-cast.md` — that ships
  to customer projects' config repos, whose test layouts differ; changing their
  policy is a separate decision.
- The other rules (`no-inferable-type-annotation`, structure rules) keep their
  existing globs — the ask was specifically explain-type-cast.
