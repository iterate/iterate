---
status: done
size: medium
---

# Prove itx catalogue examples through the REPL UI

## Status Summary

Implementation is done in draft PR #1570. The REPL now has stable test hooks, the catalogue example
assertions accept the active runner's `expect`, and a root Playwright spec injects every runnable
`example-cases.ts` snippet into the project REPL. Remaining work is external review/CI feedback.

## Assumptions

- The desired coverage is browser-facing REPL coverage: examples should be injected into the actual
  REPL experience and run from there, not only passed to the lower-level `evalBrowserReplSessionCode`
  helper.
- The existing `apps/os/src/itx/e2e/example-cases.ts` remains the source of truth for runnable
  examples, per-example vars, and result assertions.
- The intentionally excluded examples in `EXAMPLE_IDS_WITHOUT_CASES` stay excluded from this sweep.
- The suite should share as much intent with `example-matrix.ts` as makes sense, but should not import
  or depend on the server-runtime matrix runner because the browser/Playwright lane is a different
  execution path.
- It is acceptable to add small testability hooks to the REPL UI when they make the spec stable and
  less coupled to CodeMirror internals.

## Checklist

- [x] Open a draft PR with this task spec as the first commit. _Draft PR #1570 was opened after the isolated task-spec commit `c6fddf9b5`._
- [x] Add REPL-level coverage for each runnable catalogue example from `example-cases.ts`. _`specs/repl-examples.spec.ts` defines one Playwright test per case; each opens a forged-session project REPL, sets per-example `vars`, injects the exact catalogue `example.code` into CodeMirror, clicks Run, and reads the rendered entry result._
- [x] Keep assertions delegated to the existing example cases so the expected behavior stays in one place. _`example-cases.ts` takes an injected `expect`, so Vitest and Playwright use the same case table without a homegrown assertion layer._
- [x] Validate the focused browser/e2e test command locally. _Passed `pnpm spec -- specs/repl-examples.spec.ts` after seeding the missing local dev Artifacts base repo with `pnpm --dir apps/os cli artifacts seed-config-base`; also passed focused Vitest catalogue smoke, `pnpm --dir apps/os typecheck`, root `pnpm lint`, and targeted `oxfmt --check`._
- [x] Update this task file and the PR body with the implementation notes and validation results. _Task details are recorded here; PR #1570 body was updated with the final behavior and validation commands._

## Implementation Notes

- Existing coverage in `apps/os/src/itx/e2e/itx.browser.test.ts` runs the examples through the browser
  REPL evaluator directly. This task should cover the rendered REPL surface so regressions in
  injection, run button behavior, output serialization, or entry history are caught.
- Review follow-up split the root Playwright sweep into separate generated tests. Each case owns its
  project fixture, which makes individual example failures visible in the Playwright report and avoids
  a suite-level timeout override.
- Local validation initially failed before the page opened because the dev stage was missing the
  Iterate config base Artifact repo; seeding `os-dev-misha-repos` fixed project creation and verified
  forks.
