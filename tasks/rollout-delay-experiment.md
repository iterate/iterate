---
status: in-progress
size: medium
---

# Find the shortest defensible preview rollout delay

Status: 30 seconds selected for broader validation; six more fresh full runs
will bring its sample to ten. Zero is rejected. Fifteen-second probes were
faster but noisy; the original 90s control also retried after overload.
All failures and absorbed errors remain in the evidence. Cleanup succeeded
for every completed deployment. Final checks/report and recommendation remain.

## Request and assumptions

Find the sweet spot below 90 seconds using real evidence. Work in an isolated
worktree, commit and push the work, and **do not open a PR**. The user is AFK
and authorized sustained deployment experiments. This is an experiment, not
permission to claim reliability from a few green smoke tests.

- Branch: `codex/rollout-delay-experiment`, based on main `3f0c2021a7`.
- Use the existing serialized Depot `preview-main.yml` workflow dispatched
  on this feature branch. It already supports branch validation without
  replacing the main dashboard baseline. Respect its lease and lifecycle lock.
- Each trial must deploy fresh Worker versions and execute the canonical
  preview suites. Warm-slot reruns without deployment are not evidence about
  rollout propagation. No production deployments or changes to secrets.
- Keep existing timeouts, retry policy, suite selection and worker counts.
  Record first-attempt failures and recoveries, including on otherwise-green runs.
- Begin with a 90-second control and a zero-delay probe. If zero exposes
  rollout failures, compare 30 and 60 seconds, then refine the boundary.
  Interleave controls if unrelated failures or platform drift obscure the result.
- Aim for at least ten fresh-deployment trials at the best candidate, with
  broader repeated proof if results warrant it. Report sample size and
  limitations; zero observed failures does not prove zero risk.
- A confirmed rollout reset rejects that candidate. Classify other failures
  against their artifacts and telemetry before treating them as delay evidence.
- Include smoke and whole-workflow timing, actual age at first project
  creation, slot/version identity, test failures/retries and cleanup outcome.
- Instrument missing timing where needed; add behavior tests before changing
  any nontrivial configuration or evidence-processing logic.
- Recommend a lower default only if evidence supports it. Otherwise preserve
  the default and deliver the experiment and findings with explicit uncertainty.

## Work

- [x] Commit this specification before implementation and push the branch. *Commit `fc4599939`.*
- [x] Record a fresh 90-second control through the canonical Depot workflow. *`4s9c5w1gmf` finished; smoke 115.43s, wait 87.05s, first project age 91.20s. One workspace test retried, so this is not a retry-free control.*
- [x] Make the rollout wait visible as its own smoke phase. *`agent-smoke.ts` records the deployment wait separately from connection and project creation.*
- [ ] Run shorter-delay experiments; retain a per-run evidence ledger.
- [ ] Inspect deployment/version-reset telemetry and explain observed failures.
- [ ] Repeat the best candidate against fresh deployments and all suites.
- [ ] Record a recommendation, tradeoffs, sample limitations and reproduction steps.
- [ ] Run appropriate tests/checks, commit and push the final result.
- [ ] Confirm experiment cleanup, move this task to complete and return a compare link.

## Implementation log

- Control revision `758ccc78a`, package build [35264059614](https://github.com/iterate/iterate/actions/runs/35264059614)
  succeeded; fresh control dispatch `4s9c5w1gmf` uses the unchanged 90-second gate.
- Zero-delay spec failed as expected (`expected 90 to be 0`) before the constant
  changed. This candidate removes only the artificial deployment-age delay;
  exact-version health checks and the agent smoke prerequisite stay enabled.
- The initial setup dispatch `zl16nw5xv4` used the specification-only commit.
  Feature branches without PRs do not publish their SDK packages automatically,
  so this cannot serve as the control. Added an experiment-only push trigger to
  the existing package publisher; remove it before final delivery. Later trials
  will wait for the exact-head package publication before dispatch.
- 2026-09-17: initial baseline from five main runs: 105.4–121.2 seconds total,
  78.6–87.6 seconds of rollout wait, 26.8–34.5 seconds of actual smoke work;
  all smoke attempts passed without retries. This is historical context,
  not the fresh experimental control.

Codex task: `01a0b054-bdd8-7d52-9c01-30d9b92576c8`.

- 2026-09-17 19:33 UTC: control `4s9c5w1gmf` completed all suites and cleanup.
  The workspace namespace test retried after `An internal error occurred.`
  Cloudflare recorded two storage-reset references, including OS trace
  `1116b76e067186c40f29059b4e7d17f9` at 19:29:14 UTC (over three minutes after
  OS deployment) and Streams trace `d6e9892ef1298b2e3b8f8a09b7e96be4`.
  These are storage-error resets, not the code-update-reset signature (zero
  matches across all six deployed services). Exact correlation between the
  workspace retry and a storage-reset trace remains unproven. Retain this
  control as a latency sample and baseline failure evidence, not a clean streak.
  Known failing specs and `SAME-BOOT STALENESS` were also retained separately.
  The zero-delay batch is alive on the immutable candidate, first run `tvvdlqht59`.

- 2026-09-17 19:45 UTC: zero-delay run `tvvdlqht59` finished all suites and
  cleanup. Smoke passed first attempt in 28.70s, creating its project at
  deployment age 2.79s. No code-update resets or initial-connection recoveries.
  The Streams first-paint test retried: first navigation took 12.93s, row
  appeared 2.82s later, exceeding the 10s threshold; retry passed in 2.68s.
  Its first attempt began 117.32s after Streams deployed, beyond the old
  90s boundary. This does not establish a rollout failure, but the trial is
  not retry-free. Continue zero-delay fresh deployments while retaining it.

- 2026-09-17 19:54 UTC: second zero-delay run `10dgtcf6tc` passed all suites
  with zero test retries and a 21.96s smoke, but CF recorded five code-update
  reset records across two traces. Scheduler reset at deployment age 8.399s
  belongs to smoke project `prj_1a781a304ced4f24b9ad8a1aa5a185ce`; the same
  trace contains its creation timing and the explicit platform exception.
  A later repo callback reset at age 124.504s remains unclassified. Cleanup
  succeeded. Zero is rejected; stop its batch and test 30 seconds.
  `docs/ci-rollout-delay-experiment.md` retains the evidence and reproduction
  steps. Broader lifecycle queries now capture absorbed product recoveries
  as well as explicit code-update errors.

- 30-second candidate validation: changed the existing deployment-age spec
  first (red: expected 30, received 0), then the constant. All 216 preview
  tests, scripts typecheck and changed-file lint passed. No retries,
  watchdogs, worker counts or suite selection changed.

- 2026-09-17 20:00 UTC: 30-second revision `f6018b024` pushed; exact-head
  package publication [35267841382](https://github.com/iterate/iterate/actions/runs/35267841382)
  succeeded. Fresh trial `q0vdpttdl5` is running in the bounded batch. If 30
  holds up, probe 15 seconds before selecting the final candidate. No PR.
- Further trace inspection places Zero 2's late repo callback failure inside
  config-repo Artifact creation for a newly created `subscriptions-*` project
  (creation starts at OS age 114.94s). It is not an intentional rebuild or
  cleanup. Whether the reset originated in our Repo DO or the external
  Artifacts service remains unproven; retain that uncertainty. The earlier
  smoke Scheduler reset is independently sufficient to reject zero.

- 2026-09-17 20:10 UTC: first 30s trial `q0vdpttdl5` completed; smoke
  55.764s (29.276s wait), first project at age 31.067s. Eleven tests retried:
  nine WebSocket 1006 failures, one Docs live-state timeout and one REPL
  workspace-edit timeout. No code-update reset or initial connection retry.
  One Streams storage-reset reference was also retained; causality is not
  established. This is not accepted reliability evidence.
- Interleaved 90s control `s8l2d2x7n5` uses the original published control
  revision through temporary branch `codex/rollout-delay-control`. Candidate
  branch remains unchanged at 30s. The batch stops after this one control.
  Compare its retries before choosing whether to repeat30 or test60.

- The 30s trial's platform-outcome query showed only the expected OS Worker
  version, with `ok`, `aborted` and `responseStreamDisconnected` outcomes.
  The focused platform-log memory query returned zero records; there is no
  positive memory-limit evidence for the WebSocket failures. Do not label
  the failure wave as either OOM or rollout without further evidence.

- 2026-09-17 20:19 UTC: interleaved 90s control `s8l2d2x7n5` finished
  without test retries, code-update resets or initial-connection recoveries.
  Smoke took 111.449s including 87.837s waiting; first project age 91.518s.
  Cleanup succeeded. Three fresh repeats of unchanged 30s revision `f6018b024`
  are now running to test whether the first trial's retry wave recurs.

- 2026-09-17 20:40 UTC: 30s repeat `hnm33kz377` passed all suites with zero
  retries, code-update resets or initial-connection recoveries. Smoke 48.566s,
  wait 27.252s, first project age 31.215s; erase and restore succeeded.
- The following repeat `vjw0tw5t7f` lost Playwright matrix-3 before tests:
  `scripts/ci/status.ts wait-for prepare preview-ready` exited at 20:36:48
  with `TimeoutError: The operation was aborted due to timeout`. Browser and
  Metro setup had succeeded. This is incomplete suite coverage, not an
  accepted delay trial. Wait for all jobs/cleanup, then deploy afresh.

- 2026-09-17 20:53 UTC: incomplete `vjw0tw5t7f` finished with all remaining
  suites passing after two real test retries. Interceptor reset coverage saw
  an internal DO storage error; conditional-edit coverage saw a DO moved to
  another machine. Retain these failures despite the unrelated missing
  browser shard. Smoke 47.187s, wait 27.160s, first project age 31.778s.
  No code-update resets. Erase and restoration both succeeded.
- Started two fresh 30s trials on unchanged `f6018b024` via
  `thirty-repeat-2.log`; these replace incomplete coverage and finish the
  planned repeats. The full existing 90s controls also contain generic
  storage-reset telemetry, so do not equate it with code propagation.

- Replacement dispatch `3hz60tlhhq` was cancelled while queued: all nine
  jobs have zero attempts, so it supplies no deployment/test evidence.
  The local experiment dispatcher now waits for the existing Preview Main
  queue to empty before starting a trial, respecting main's ordinary runs
  and avoiding pending-run replacement. It does not cancel jobs, alter
  workflow concurrency or touch leases. Two replacements remain queued in
  the local controller (`thirty-idle-guard.log`).

- 2026-09-17 21:16 UTC: `sd606x6w9v` passed all suites without test retries,
  code-update resets or initial-connection recoveries. Smoke 42.662s, wait
  21.530s, first project age 31.063s. Erase and restore succeeded. CF did
  record an absorbed memory-limit reset at OS age 86.158s: trace
  `cff181db335e24d7ee92f051607d81a0` identifies `oversized-reset-fa8d8ac8`,
  the regression test that journals 84MB and evicts its stream. That test
  passed; retain this runtime failure separately from rollout evidence.
  Streams also recorded storage reset `h5q5p84ug96i489cj8ubphuo` at OS age
  92.748s. One final 30s repeat awaits the shared main queue in the same
  bounded batch; then probe 15s before choosing the final candidate.

- 2026-09-17 21:25 UTC: `8gr4b2p5ld` completed all suites without test
  retries, code-update resets or initial-connection recoveries. Smoke 46.510s,
  wait 28.141s, first project age 31.006s; erase and restoration succeeded.
  One Streams storage-reset reference remains recorded. This completes four
  full 30s trials (11, 0, 0, 0 retries), plus the incomplete trial with two
  retries. Three repeats do not erase the first retry wave. Probe 15s next.
- Changed the deployment-age spec first: it failed with `expected 30 to be 15`,
  then changed the constant. No retry, timeout, concurrency or suite change.
- 15s candidate: all 216 preview tests, scripts typecheck and changed-file lint
  passed. Fresh canonical previews will begin after its SDK publication.
- 15s revision `b13344b705` pushed. Controller session 67002 waits for package
  build [35276735533](https://github.com/iterate/iterate/actions/runs/35276735533)
  to succeed, then runs three fresh canonical trials. It waits for the shared
  queue and stops on real test retries or code-update reset evidence. Do not
  move the branch while this batch is alive; raw log is `fifteen-probe.log`.

- 2026-09-17 21:45 UTC: first 15s trial `424l7btjqk` finished all suites but
  failed. Smoke 32.494s, wait 7.106s, project age 16.098s. One repo-edit-file CLI
  retry follows storage reference `skidcm22lmtkao06e0urfq1e` at OS age 77.713s.
  A real source-version wrapper failure matches storage reference
  `jrki45tjuhfhvkc7d188u0ci` at age 77.393s. No code-update reset; erase and
  restore succeeded. An absorbed memory reset at age 74.132s belongs to the
  oversized-journal test. Timing alone cannot establish a shared cause.
- The local collector now exposes wrapper `unexpected-error` records
  separately, including whether a later known outcome recovered. Regression
  checks against saved raw results confirmed the failed 15s wrapper and a
  previously uncounted internal recovery in Thirty1 (WebSocket 1006 then pinned
  failure). Framework retry count remains 11; the extra recovery stays visible.
  No tests or retry settings changed. Repeat 15 twice, retaining this failed run.

- 2026-09-17 21:59 UTC: 15s repeat `11l285tklj` passed all suites without
  test retries, unexpected wrapper errors, initial-connection recoveries or
  code-update resets. Smoke 31.567s, wait 12.423s, first project 16.067s.
  Five memory-limit records across two traces remain: oversized-journal
  test at age 71.136s; ProcessorFacet at 102.856s (victim project unidentified).
  Cleanup succeeded. Third 15s trial `7q8x9g7hk2` finished its workflow;
  the controller is collecting artifacts and telemetry.

- Third 15s trial `7q8x9g7hk2` passed after one browser retry for the cache badge
  while the test intentionally stalled live traffic. Smoke 35.573s,
  wait 12.592s, project age 16.030s. No code-update reset or unexpected wrapper
  error; two memory-limit records remain. Cleanup succeeded. Because all
  three 15s trials show resource errors (and one 30s run did), interleave a fresh
  original 90s control to compare current platform behavior before selecting
  the candidate for 10+ deployments. Candidate branch stays at b13344b705.

- 2026-09-17 22:15 UTC: third 90s control `pb4hf6lzfh` passed after one
  disposable-project test retried following DO overload. No code-update or
  memory-limit reset was observed; Streams storage-reset telemetry remains.
  Smoke 108.172s, wait 88.111s, project age 91.837s; erase/restore succeeded.
- Selected 30s for broader validation before collecting its next six full
  trials: it removes 60s of waiting, while 15s had resource errors in all three
  probes and two had test failures/retries. This does not prove delay causality.
  Retain all 30s results including the initial retry wave; ten full trials is
  not ten cherry-picked clean ones. A confirmed rollout reset rejects 30s.
- Changed the spec first (red: expected 30, received 15), then restored 30s.
  Runtime source is the same as the earlier 30s candidate; pending report
  changes preserve the additional controls, failed 15s trial and recoveries.
- Expanded 30s candidate validation: all 216 preview tests, scripts typecheck
  and changed-file lint passed.
