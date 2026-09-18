---
status: in-progress
size: large
base: codex/preview-change-types-v3
---

# Keep useful preview runs, stop obsolete work, and wait across commits

Stacked follow-up to draft PR #2712. Specification committed first; implementation
and live acceptance follow. The existing change planner and lease renewal remain
on the parent branch.

## Request

- Disable automatic cancellation of an in-flight PR preview on a newer push.
- Implement conservative smart cancellation now: stop work proven unnecessary,
  while preserving an ancestor run a newer docs/test-only commit can use.
- Support workflow and job retries without a blanket ban or stale statuses,
  results, preparation artifacts or deployment identities being accepted.
- Extend `status.ts wait-for` with optional target parameters for another
  workflow/commit; existing calls continue to target this workflow and SHA.
- Publish settlement through ordinary `set preview-settled --values ...`.

## Decisions and constraints

- A docs-only successor can await a running ancestor and inherit its final
  success or failure. Test-only changes can await a reusable restored deployment.
  Keep the first-parent ancestry barriers and live lease/version checks.
- Pin each run to its checkout SHA, independently of the PR's moving head.
  Preserve exclusive ownership of the preview lifecycle until cleanup ends.
- Cancellation must be based on confirmed ancestry/change evidence, not simply
  "not latest". Unknown history, ambiguous runs or API errors cannot authorize
  destructive cancellation. Never strand running tests with an erased backend.
- A waiter identifies a specific producer execution/attempt and observes both
  its signal and liveness. A missing signal after termination is not success.
  Retries must have explicit semantics for completed prerequisites versus newly
  retried producers; do not combine unrelated attempts into a successful result.
- Test retries must run against a valid prepared environment. If a partial retry
  cannot safely use its old environment, recover via fresh preparation rather
  than silently running against changed state. Prefer reusing Depot's run model
  over inventing a scheduler or storing a new coordination database.
- Keep functionality first, trpc-cli commands, small workflow steps and readable
  decision code. Do not resurrect the deleted `status.test.ts`; test real
  coordination behavior through the CLI/API boundary and lifecycle scenarios.
- Scope automatic cancellation to this PR's Preview workflows, never unrelated
  unit/lint workflows or other PRs. PR close cleanup must still work.

## Work

- [ ] Verify Depot execution/attempt, cancellation, retry and artifact semantics.
- [ ] Define and test generic producer selection and cross-workflow waiting.
- [ ] Replace special settlement publication and update evidence readers.
- [ ] Pin preview identity and support pending-ancestor inheritance/reuse.
- [ ] Implement conservative cancellation and preserve cleanup/lease exclusion.
- [ ] Support retry recovery and reject stale artifacts/results with clear reasons.
- [ ] Validate types, lint, formatting and relevant/full required tests.
- [ ] Exercise live pending docs inheritance, useful ancestor preservation,
      obsolete-work cancellation, full rerun and partial retry behavior.
- [ ] Review the stacked diff independently, handle review feedback, and record
      operational evidence in the draft PR.

## Implementation log

- Stack starts at `e091e928c` on `codex/preview-change-types-v3` (PR #2712).
  Baseline already proved full → docs-only → tests-only work selection and
  near-expiry lease renewal. This follow-up owns pending runs and retries.
