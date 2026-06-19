---
status: in-progress
size: medium
---

# Prove itx catalogue examples through the REPL UI

## Status Summary

Just started. The task has been specified on `itx-repl-example-specs`; implementation, validation,
and PR updates are still pending.

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

- [ ] Open a draft PR with this task spec as the first commit.
- [ ] Add REPL-level coverage for each runnable catalogue example from `example-cases.ts`.
- [ ] Keep assertions delegated to the existing example cases so the expected behavior stays in one
      place.
- [ ] Validate the focused browser/e2e test command locally.
- [ ] Update this task file and the PR body with the implementation notes and validation results.

## Implementation Notes

- Existing coverage in `apps/os/src/itx/e2e/itx.browser.test.ts` runs the examples through the browser
  REPL evaluator directly. This task should cover the rendered REPL surface so regressions in
  injection, run button behavior, output serialization, or entry history are caught.
