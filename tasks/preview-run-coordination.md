---
status: implemented
size: large
base: codex/preview-change-types-v3
---

# Keep useful preview runs, stop obsolete work, and wait across commits

Compare-only follow-up to #2712; draft #2741 was closed at the user's request.
Implementation and local checks pass. Live runs prove exclusive cleanup,
cross-commit waiting, smart cancellation and both forms of job retry recovery.
The last pending-docs trial preserved its ancestor and queued its successor;
the final inheritance outcome was not observed before closure.

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

- [x] Verify Depot execution/attempt, cancellation, retry and artifact semantics. *Live Depot calls distinguished active retries from full executions; artifacts include execution IDs.*
- [x] Define and test generic producer selection and cross-workflow waiting. *status.ts follows current producer attempts and supports workflow/SHA targets.*
- [x] Replace special settlement publication and update evidence readers. *Ordinary set publishes preview-settled; the reader verifies all current producers.*
- [x] Pin preview identity and support pending-ancestor inheritance/reuse. *Pinned checkout SHA and workflow-level exclusion preserve useful ancestors.*
- [x] Implement conservative cancellation and preserve cleanup/lease exclusion. *The independent coordinator cancels proven-obsolete consumers and preserves both mutators.*
- [x] Support retry recovery and reject stale artifacts/results with clear reasons. *Partial attempts stop at the guard; recovery drains then requests a full rerun.*
- [x] Validate types, lint, formatting and relevant/full required tests. *Full local checks passed; after merging parent review fixes, all 489 scripts tests, scripts typecheck and affected-file lint passed again.*
- [ ] Exercise live pending docs inheritance, useful ancestor preservation,
      obsolete-work cancellation, full rerun and partial retry behavior.
- [x] Review the stacked diff independently, handle review feedback, and record
      operational evidence. *Independent review found no remaining safety blocker. Evidence and the proposed PR body are in the latest commit message; #2741 is closed.*

## Implementation log

- Stack starts at `e091e928c` on `codex/preview-change-types-v3` (PR #2712).
  Baseline already proved full → docs-only → tests-only work selection and
  near-expiry lease renewal. This follow-up owns pending runs and retries.

- Generic waits now select the highest current attempt, ignore queued old
  attempts, accept retained prerequisites and support an explicit workflow/SHA.
- A coordinator runs outside the lifecycle lock. It cancels only obsolete test
  consumers; preparation/cleanup retain ownership. Closed PR cleanup uses the
  same policy. Pending waits are restricted to the caller's actual ancestors.
- Partial retries request `preview-retry.yml`: serialize recovery by workflow,
  let prepare/finalizer settle, then rerun everything. Duplicate requests check
  the expected execution and become no-ops after recovery. Full reruns get fresh
  preparation and execution-scoped internal artifacts.
- Independent design/code review found and corrected queued-finalizer cancellation,
  a descendant-wait deadlock, and externally consumed artifact-name compatibility.
- Local evidence so far: scripts typecheck, targeted lint and 85 focused tests pass.
  Raw Depot API confirmed basename workflow paths and ascending attempt arrays.

- First live implementation run (`m93ntlm7zj`, `7fa4d5322`) stopped before
  deployment: trpc-cli ignored a class with constructor arguments, and its
  zero-argument command schema did not invoke the guard. Fixed in `4cd98a94b`;
  real CLI tests now exercise publication and guard output through a local API.
- Pending-docs acceptance: this documentation commit is pushed while
  `pxsf5zjflf` (`4cd98a94b`) is preparing its preview. Expected: preserve that
  run through restoration, then inherit its conclusive result.

- Live overlap test exposed that Depot ignores concurrency on a reusable caller
  job. Both preparations stopped before any new test run; manual erase of our
  preview-17 retired all DOs and wiped test data. The fix uses workflow-level
  serialization plus a separate coordinator workflow, which is free to act while
  Preview queues. Close cleanup shares that same workflow-level group.
- The documentation successor also hit a pkg.pr.new network publish failure;
  deployment correctly refused to use missing commit-pinned packages.
- Second pending-docs acceptance: push while `x8lrhr8zfx` (`8f058d6da`)
  prepares. The separate coordinator was automatically triggered by Depot on
  this branch; no manual dispatch was necessary. Expect only one live preparation.

- `x8lrhr8zfx` (`8f058d6da`) passed all preview tests and restoration while
  docs successor `r9jq256fkb` queued. At 13:53:03Z GitHub was green but the new
  evidence reader returned no result; at 13:54:13Z it returned settled success.
  The coordinator correctly waited across commits. Depot's expanded reusable
  check names exposed a reader mismatch; a red/green regression fixes that.
- Full local `pnpm test` passed, including 486 scripts tests. Subsequent focused
  retry/race tests and scripts typecheck pass. CI lint found one import-order
  change, now corrected. Pending acceptance uses the corrected check-name reader.
- Active retry acceptance: cancelled a waiting shard in `m5c0nmbxbt`, then
  retried it. Depot kept execution `lf0cmlswq4` and made attempt 2. The guard
  refused stale preparation and dispatched recovery `ctbngk1ssc`; recovery
  cancelled the remaining consumers, preserved preparation/finalization, and
  started fresh execution `4p0dr1mhn8` only after restoration finished.
- CLI tests now invoke trpc-cli's real file loader/parser in-process. Cold child
  Node startup exceeded 5s under CI contention; no timeout increase was needed.
  Full local tests pass again, and the cancellation-generation regression passes.
- This code push also exercises product obsolescence against that active full
  rerun: stop its consumers, preserve cleanup, queue the replacement workflow.

- Product-obsolescence acceptance: coordinator `l12kfph70w` cancelled all seven
  consumers in `m5c0nmbxbt` at 14:06:20–22Z. Preparation finished; finalizer
  `rlgzw5gcq4` erased preview-17 at 14:07:43Z and skipped obsolete restoration.
  Replacement `dsr4rt0rdh` stayed queued until the old lifecycle released its lock.
- All local required checks pass. Under CI contention, even in-process trpc-cli
  schema loading exceeded a 5s individual-test deadline; schemas now load once
  during test-file collection, while real CLI invocation/assertions remain inside
  each test. No timeout increase or product change.

- Terminal retry acceptance: after `dsr4rt0rdh` completed cleanup/restoration,
  retrying its cancelled shard created execution 2 `jg2msr3qtv` with old
  prerequisites. The guard refused it before test setup; recovery `0kv9871rcs`
  started full execution 3 `lbdzcj6sdd` at 14:18:21Z. Both active and terminal
  partial retry cases therefore recover with fresh preparation.
- Merged parent review fixes `83c4e345b` without rewriting history; all 489
  scripts tests, scripts typecheck and affected-file lint pass.
- Final pending-docs trial: push this documentation while the merged implementation
  is running. The ancestor must finish restoration; this successor must inherit its
  conclusive outcome without deploying or testing again.

- User requested compare-only review and closure of #2741. The pending-docs
  trial had confirmed that `3lm1lnnm8x` preserves `lpbht2t3w8` and waits for
  its `preview-settled` signal; successor `bhvxcldzbt` remained queued.
  Final docs inheritance was not observed before closing the PR. Do not mistake
  this partially observed acceptance scenario for a completed one.
