# Preview rollout-delay experiment

Status: **ten full 30-second trials are complete; compare 60 seconds next**.
Thirty seconds reduced median smoke from 111.45s (three 90s controls) to
46.57s. All ten full workflows passed, but three needed retries (18 total,
plus one wrapper-internal recovery), and three logged memory-limit resets.
No explicit code-update reset was observed at 30s. The two 90s controls with
resource queries recorded no memory-limit resets. This small, ordered sample
does not establish causality; the 60s comparison will test a more conservative
saving before making a default recommendation.

The first zero-delay smoke took **28.70s**, versus **115.43s** for the fresh
90-second control. The control spent 87.05s waiting. Both full workflows
passed with one test retry each; neither is a retry-free reliability sample.
The second zero-delay run passed without test retries but recorded a real
code-update reset during smoke project creation. Green checks alone would
have missed it.

## Comparison so far

Full-suite trials only; one incomplete 30s deployment remains in the ledger.
Workflow time excludes queueing and includes cleanup/restoration. These are
observed medians, not randomized estimates of savings caused by the delay.

| Minimum age | Full trials | Median smoke | Median whole workflow | Runs needing retries | Reported retries | Runs with code-update resets | Runs with memory-limit records |
| ----------- | ----------: | -----------: | --------------------: | -------------------: | ---------------: | ---------------------------: | -----------------------------: |
| 90s         |           3 |      111.45s |              8m36.06s |                    2 |                2 |                            0 |                    0/2 queried |
| 30s         |          10 |       46.57s |              6m42.30s |                    3 |               18 |                            0 |                           3/10 |
| 15s         |           3 |       32.49s |              6m13.00s |                    2 |                2 |                            0 |                            3/3 |
| 0s          |           2 |       25.33s |              7m32.37s |                    1 |                1 |                            1 |                    not queried |

The 15s sample includes one failed workflow and one unexpected known-flake
wrapper error; the 30s sample includes one extra wrapper-internal recovery.
Counts retain these separately from the framework retry total. All 19
completed deployments, including the incomplete run, erased and restored.

## What changes

Only the minimum deployment age changes: 90 seconds → 0 seconds → 30 seconds → 15 seconds → 30 seconds → 60 seconds. Smoke also
records the wait as its own phase, so waiting and useful work are separate.
Exact-version health checks, version-override headers, smoke, all six app
suites, six OS browser shards, concurrency, retries and watchdogs stay intact.

Each trial dispatches the canonical `preview-main.yml` workflow on the
experiment branch. The workflow owns the shared preview lease and lifecycle
lock, deploys fresh versions, runs the full suites, erases test data and
restores the preview. Repeated warm test invocations do not count as trials.

## Evidence ledger

Times below come from raw test telemetry. Project age means elapsed time from
the successful OS deploy command to the start of smoke project creation.

| Trial                                                                                          | Minimum age |   Smoke |   Wait | First project age | Test retries | Code-update resets observed |
| ---------------------------------------------------------------------------------------------- | ----------: | ------: | -----: | ----------------: | -----------: | --------------------------: |
| [Fresh control](https://depot.dev/orgs/0p91s0lz49/workflows/qkx92sflw7) (`4s9c5w1gmf`)         |         90s | 115.43s | 87.05s |            91.20s |            1 |                           0 |
| [Zero 1](https://depot.dev/orgs/0p91s0lz49/workflows/lxgc0n6b4n) (`tvvdlqht59`)                |          0s |  28.70s |     0s |             2.79s |            1 |                           0 |
| [Zero 2](https://depot.dev/orgs/0p91s0lz49/workflows/9st263dlx0) (`10dgtcf6tc`)                |          0s |  21.96s |     0s |             3.04s |            0 |        5 records / 2 traces |
| [Thirty 1](https://depot.dev/orgs/0p91s0lz49/workflows/sh7vz2jps9) (`q0vdpttdl5`)              |         30s |  55.76s | 29.28s |            31.07s |           11 |                           0 |
| [Control 2](https://depot.dev/orgs/0p91s0lz49/workflows/3cw4k5n3pn) (`s8l2d2x7n5`)             |         90s | 111.45s | 87.84s |            91.52s |            0 |                           0 |
| [Thirty 2](https://depot.dev/orgs/0p91s0lz49/workflows/h8mmbx4lvs) (`hnm33kz377`)              |         30s |  48.57s | 27.25s |            31.22s |            0 |                           0 |
| [Thirty 3 — incomplete](https://depot.dev/orgs/0p91s0lz49/workflows/1nrprknscl) (`vjw0tw5t7f`) |         30s |  47.19s | 27.16s |            31.78s |            2 |                           0 |
| [Thirty 4](https://depot.dev/orgs/0p91s0lz49/workflows/ttgj606pct) (`sd606x6w9v`)              |         30s |  42.66s | 21.53s |            31.06s |            0 |                           0 |
| [Thirty 5](https://depot.dev/orgs/0p91s0lz49/workflows/75rnq4s9b7) (`8gr4b2p5ld`)              |         30s |  46.51s | 28.14s |            31.01s |            0 |                           0 |
| [Fifteen 1 — failed](https://depot.dev/orgs/0p91s0lz49/workflows/n4brv1xt5p) (`424l7btjqk`)    |         15s |  32.49s |  7.11s |            16.10s |            1 |                           0 |
| [Fifteen 2](https://depot.dev/orgs/0p91s0lz49/workflows/x9x4bldsz0) (`11l285tklj`)             |         15s |  31.57s | 12.42s |            16.07s |            0 |                           0 |
| [Fifteen 3](https://depot.dev/orgs/0p91s0lz49/workflows/fxzn6p1t92) (`7q8x9g7hk2`)             |         15s |  35.57s | 12.59s |            16.03s |            1 |                           0 |
| [Control 3](https://depot.dev/orgs/0p91s0lz49/workflows/kk3mg5pkq2) (`pb4hf6lzfh`)             |         90s | 108.17s | 88.11s |            91.84s |            1 |                           0 |
| [Thirty 6](https://depot.dev/orgs/0p91s0lz49/workflows/t8snln3xm6) (`3265trd5m5`)              |         30s |  54.23s | 27.55s |            31.29s |            0 |                           0 |
| [Thirty 7](https://depot.dev/orgs/0p91s0lz49/workflows/0fx8qwv38x) (`6whwknjr01`)              |         30s |  38.86s | 20.51s |            31.17s |            3 |                           0 |
| [Thirty 8](https://depot.dev/orgs/0p91s0lz49/workflows/q5s00dx011) (`09967hf2pc`)              |         30s |  46.64s | 28.01s |            31.07s |            4 |                           0 |
| [Thirty 9](https://depot.dev/orgs/0p91s0lz49/workflows/jdkksggkhp) (`mbph95cv0d`)              |         30s |  47.79s | 28.21s |            30.89s |            0 |                           0 |
| [Thirty 10](https://depot.dev/orgs/0p91s0lz49/workflows/6b29xmq7m1) (`3kqx2pr9gv`)             |         30s |  45.13s | 28.08s |            30.97s |            0 |                           0 |
| [Thirty 11](https://depot.dev/orgs/0p91s0lz49/workflows/h149hdspqf) (`ds35cnqskh`)             |         30s |  46.13s | 28.12s |            31.15s |            0 |                           0 |

The control revision is `758ccc78a266c3ca16b5f1eda609086fa537e792`; both zero
trials used `22ac6998f4a28f03a5a406cedc7161c12d727c9c`. All used preview-11.
The OS versions were `c929d8f6-ce11-438e-8079-15f306ac4bdf` (control),
`645a90e7-c3de-4f9f-a7d4-de9be45356e6` (Zero 1), and
`343289ac-6d13-4943-aa7c-ecc7882d2b69` (Zero 2).

All seventeen successful full-suite runs produced 16 raw telemetry artifacts, with 532 passed tests, nine
skipped and three expected failures emitted by the known-flake wrappers.
Expected failures and known-flake records are retained separately from real
test retries. Cleanup reported both `erased: true` and `restored: true`.

### Whole-workflow timing

These clocks start at the prepare job's first log, excluding workflow queuing.
They include setup, deployment and concurrent tests; the last column also
includes cleanup, restoration and final reporting. They are observed totals,
not isolated estimates of savings from the age gate.

| Run                                  | Tests complete | Workflow complete |
| ------------------------------------ | -------------: | ----------------: |
| `4s9c5w1gmf` (90s gate)              |       7m 43.7s |          9m 31.2s |
| `tvvdlqht59` (0s gate)               |       5m 58.5s |          7m 39.2s |
| `10dgtcf6tc` (0s gate)               |       5m 50.5s |          7m 25.5s |
| `q0vdpttdl5` (30s gate)              |       5m 36.6s |          7m 22.6s |
| `s8l2d2x7n5` (90s gate)              |       6m 47.2s |          8m 36.1s |
| `hnm33kz377` (30s gate)              |       5m 57.8s |          7m 39.3s |
| `vjw0tw5t7f` (30s gate / incomplete) |       5m 59.4s |          7m 57.0s |
| `sd606x6w9v` (30s gate)              |       5m 46.0s |          7m 11.0s |
| `8gr4b2p5ld` (30s gate)              |        5m 6.8s |          6m 32.4s |
| `424l7btjqk` (15s gate / failed)     |       4m 54.1s |          6m 25.5s |
| `11l285tklj` (15s gate)              |       4m 36.9s |          6m 12.1s |
| `7q8x9g7hk2` (15s gate)              |       4m 26.8s |          6m 13.0s |
| `pb4hf6lzfh` (90s gate)              |       5m 44.1s |          7m 40.4s |
| `3265trd5m5` (30s gate)              |       5m 18.1s |          6m 52.1s |
| `6whwknjr01` (30s gate)              |       5m 55.0s |          7m 23.6s |
| `09967hf2pc` (30s gate)              |       4m 52.5s |          6m 15.4s |
| `mbph95cv0d` (30s gate)              |       4m 35.1s |           6m 5.2s |
| `3kqx2pr9gv` (30s gate)              |       4m 37.5s |          6m 11.2s |
| `ds35cnqskh` (30s gate)              |       4m 43.0s |          6m 20.4s |

[Sanitized measurements](ci-rollout-delay-evidence.json) retain every app's
version, test retries, known-failure outcomes, timing and cleanup evidence.

### Failures retained

- **Control:** the workspace namespace test retried after `An internal error occurred.` Cloudflare also recorded two distinct storage-reset references
  in OS and Streams. Neither is the code-update-reset signature. Exact
  correlation between the test retry and either storage reset is unproven.
- **Zero 1:** Streams' first-row performance assertion measured 15.44s against
  a 10s budget. Navigation took 12.93s; waiting for the row took another 2.82s.
  The retry passed in 2.68s. The failed attempt began **117.32s after Streams
  deployed**, already beyond the old 90s boundary. Timing suggests navigation
  latency rather than an early-rollout reset; it does not establish the cause.
- **Zero 2 — candidate rejected:** OS deployed at 19:47:50.232 UTC. At
  19:47:58.631, **8.399s later**, `SchedulerDurableObject` threw `Durable Object reset because its code was updated.` Trace
  `2434290c32d434238083ff5cb870e41e` contains both the exception and creation
  records for smoke project `prj_1a781a304ced4f24b9ad8a1aa5a185ce`, matching
  the smoke log. Smoke still passed on its first attempt. A separate repo
  callback logged the same error at deployment age 124.504s; its cause remains
  unclassified. Four duplicate records describe the early reset; the fifth
  belongs to that later callback. Neither is cleanup: tests ended at 19:50:34.
- The known `SAME-BOOT STALENESS` wrapper failed on both revisions. Existing
  pinned failures remained visible; they were not reclassified as clean tests.
- Zero 1's smoke API connection ended with `Network connection lost` 22ms
  after the smoke had passed and disposed its session. This is consistent
  with client teardown, not an interrupted smoke operation.

Cloudflare returned 463 error events for the control, 413 for Zero 1 and 417
for Zero 2 across the six app services. Many are negative-test or teardown events. These counts
are **not** claims of error-free operation. The targeted code-update-reset
query found no matching event in the control or Zero 1, and five records in
Zero 2, from OS deployment through the last test.

A broader `reset` query also retains product-level recoveries. In Zero 1,
ordinary REPL project description retried at deployment age 60.77s, and a
sandbox-egress secret read recovered from an object moving machines at 60.81s.
Those were not test retries and did not carry the code-update message. The
control also had product-level recoveries. They remain evidence to compare,
not grounds to call either run error-free.

### Thirty-second retry wave

Revision `f6018b02419d866caffcbc9e1e13230ab45384c7`, OS version
`1bc05a4c-4775-4d5f-ac46-23f888023867`. Smoke passed first attempt; all tests
eventually passed and cleanup succeeded. Nine tests retried after WebSocket
1006 closes, while one seeded Docs test timed out waiting for live state and
one REPL workspace-edit test timed out waiting for completion. The failures
span independent projects and both test runners. Cloudflare had no matching
code-update reset, but did record a Streams storage reset. The cause remains
unresolved; this trial does not validate 30 seconds. A fresh run at the
original 90-second revision finished with zero test retries and zero
code-update resets. Repeating the unchanged 30-second revision will test
whether its failure wave recurs. The first repeat (`hnm33kz377`) passed all
suites without test retries or code-update resets, with a 48.57s smoke. A second full repeat (`sd606x6w9v`) also passed without test retries or
code-update resets, with a 42.66s smoke. These repeats do not explain or
erase the earlier failures. A third full repeat (`8gr4b2p5ld`) passed with
zero test retries/code-update resets and 46.51s smoke. It retained a Streams
storage-reset reference; cleanup succeeded. The next probe is 15 seconds.

The latter run had an absorbed memory-limit reset at OS age 86.158s. Trace
`cff181db335e24d7ee92f051607d81a0` identifies project
`prj_bed29795f9bf43f19d4f7172062a964c` / `oversized-reset-fa8d8ac8`: the
oversized-journal regression test deliberately journals 84MB and evicts the
stream. The reset occurred while reading its persisted bodies; the test
still passed. It remains a real runtime recovery, with no code-update
signature. Streams also had one storage-reset reference at OS age 92.748s.
Neither event makes this an error-free run.

The first expanded 30s trial (`3265trd5m5`) passed all suites without test
retries, unexpected wrapper errors, code-update resets or memory-limit reset
records. Smoke took 54.23s. Two OS storage-error references and one Streams
storage-error reference were absorbed; cleanup succeeded. This brings the
full 30s sample to five, including its first noisy run.

The next expanded trial (`6whwknjr01`) passed after three retries. Two Vitest
cases saw object-moved errors, also recorded at OS ages77.678s and77.690s
(traces `70eb80842c076f6e2af1f8892390aac3` and
`cea86d6e3139b721f389441d4099b88c`). A browser clients test timed out after60s
waiting for closed tabs to become disconnected; its cause remains unresolved.
No code-update or memory-limit reset was observed, and no unexpected wrapper
error occurred. Smoke took38.86s and cleanup succeeded. These failures remain
in the six-full-run sample; four more full trials are planned.

`09967hf2pc` passed after four retries: a Docs navigation assertion, a mobile
approval script orphaned by eviction, and two internal errors in stateful-app
and slow-side-effect tests. Their underlying causes remain unproven. A
memory-limit reset at OS age 78.753s belongs to `oversized-reset-341596f5`
(trace `b7eb8f80e797d13012f00ce169df8f90`). No explicit code-update reset
was observed. Smoke took 46.64s and cleanup succeeded. Seven full 30s runs
now include retry counts 11,0,0,0,0,3,4, plus the extra wrapper recovery in
the first run. Speed improved; this is still mixed reliability evidence.

The eighth full 30s trial (`mbph95cv0d`) passed without framework retries,
unexpected wrapper errors, code-update resets or memory-limit reset records.
Smoke took 47.79s. Streams storage-reset reference
`qv1dop0ga0pbse0dq8u1ko2v` remains in recovery telemetry; cleanup succeeded.

`3kqx2pr9gv`, the ninth full 30s trial, passed without test retries,
unexpected wrapper errors or code-update resets. Smoke took 45.13s.
Two memory-limit records in trace `fc00f9a7f15433c3170ab59b5e9244bf`
match oversized-journal project `oversized-reset-58b1325c` at OS ages
86.601s/86.656s. Streams storage-reset telemetry remains; cleanup succeeded.

### Fifteen-second first trial failed

`424l7btjqk` ran the full 544-test record set but failed: 531 passed, nine
skipped, three expected failures and one real failure. The source-version
known-flake wrapper hit storage error `jrki45tjuhfhvkc7d188u0ci` at OS age
77.393s, outside its allowed `SAME-BOOT STALENESS` pattern. Trace
`d7d350ab9ca59c2532a6b2bd2234e507` matches the test's exact error reference.
The repo-edit-file CLI test also retried: its truncated JSON followed storage
error `skidcm22lmtkao06e0urfq1e`, confirmed in the CLI stderr and callback
trace `5037b5ecee5df881ce8ae26f0280e6c5` at OS age 77.713s.

An absorbed memory-limit reset at age 74.132s belongs to the oversized-journal
regression project `oversized-reset-b30f4fcf`, trace
`8777bb134446412d12007c02a1780999`. The nearby timestamps do not prove these
errors share a cause. No code-update reset was observed. Smoke passed in
32.49s and cleanup succeeded. Retain this failed trial while repeating 15s;
it is not reliability acceptance evidence.

The next 15s repeat (`11l285tklj`) passed all suites with no test retries,
unexpected wrapper errors, initial-connection recoveries or code-update
resets; smoke took 31.57s. It still recorded five memory-limit error records
across two traces: oversized-journal coverage at OS age 71.136s, and a
ProcessorFacet at102.856s whose project remains unidentified. Cleanup succeeded.
These absorbed errors remain distinct from code propagation and test retries.

The third 15s trial (`7q8x9g7hk2`) passed after one browser retry: the cache
status badge did not appear within 1s while its test deliberately stalled the
live WebSocket. Cached rows had already rendered. Smoke took 35.57s; no
code-update reset or unexpected wrapper error was observed. Two memory-limit
records appeared at ages 67.903s and69.652s. These resource errors now occur
in all three 15s trials, versus one of the five 30s deployments. A new 90s
control will test whether they also recur at the original delay. This small,
time-ordered comparison does not establish that a shorter delay causes them.

The interleaved 90s control (`pb4hf6lzfh`) passed after one disposable-project
test retried: `Durable Object is overloaded. Requests queued for too long.`
OS recovery logs contain overloads at deployment ages 137–143s. No code-update
or memory-limit reset was observed. One Streams storage-reset reference also
remains. Cleanup succeeded; smoke took 108.17s, including 88.11s waiting.

We selected 30s for broader validation before starting its next six trials.
It removes a minute of waiting and has three full repeats without test retries
or code-update resets. The first retry wave remains unexplained. Fifteen
seconds is not rejected as a proven rollout failure, but its resource-error
pattern makes the extra 15s saving less persuasive. Ten total full 30s trials
will include the first noisy run; this is not a search for a cherry-picked
clean streak. A confirmed rollout reset would reject 30s and trigger a 60s probe.

The raw reporter marks known-failing tests with static expected-failure
metadata. The experiment collector now also checks wrapper records for
`unexpected-error`, preserving the actual error separately. This exposed one
additional recovery in Thirty 1: disposed-project coverage first hit
WebSocket 1006, then recovered to its ordinary pinned failure. That recovery
is absent from the framework's count of 11 test retries. Both records remain
in the sanitized evidence, with the later known outcome identified.

### Incomplete trial retained

`vjw0tw5t7f` lost one browser shard when the CI dependency-status request
timed out before tests. It ran 529 test records versus the full 544. Its
other suites also had two real retries: interceptor-reset coverage received
an internal DO storage error, and conditional-edit coverage received an
object-moved error. Both recovered. Smoke passed in 47.19s and no code-update
reset was observed. Erase and restoration succeeded. This is excluded from
the full-suite reliability count; its two test failures remain in the ledger.

Replacement dispatch `3hz60tlhhq` was cancelled while queued, before any of
its nine jobs started. It supplies no deployment/test evidence. The local
controller now waits for the shared Preview Main queue to be idle before
dispatching; workflow concurrency and leases remain unchanged.

### Historical context

Five recent main smoke runs averaged 114.66s, of which 85.60s was the rollout
wait and 29.06s was useful work. Their total range was 105.4–121.2s.

The age gate was added after real failures: [the earlier investigation](preview-e2e-flake-hunt.md)
records a code-update reset about 51s after upload. Exact edge-version health
does not prove that every Durable Object placement has received the new code.
A handful of passing zero-delay runs cannot rule out that failure mode.

## Reproduce and assess

1. Publish the exact revision's first-party packages before deployment. This
   no-PR branch temporarily uses an explicit branch entry in `pkg-pr-new.yml`;
   remove it after the experiment. An unpublished spec-only revision failed
   setup in `zl16nw5xv4` and is excluded from latency/reliability comparisons.
2. Dispatch `depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate
--workflow preview-main.yml --ref codex/rollout-delay-experiment`.
3. Download `preview-ci-prepare`, `preview-ci-apps` and all six
   `preview-ci-playwright-*` artifacts. Deduplicate raw reports by artifact ID;
   count first-attempt failures, retries and initial-connection recoveries.
4. Record the plan's app deployment timestamps and Worker version IDs. Separate
   workflow queue time from execution time; dispatch-to-finish is misleading
   when the shared workflow is queued behind another preview.
5. Query Cloudflare Workers observability for the six deployed service names,
   from OS deployment through the last test. Retain the `code was updated`
   search, all error events, and counts grouped by service and severity. These
   are observed events, subject to telemetry coverage, not proof of absence.
6. Inspect finish logs for successful erase and restoration. Stop the batch
   on failures, retries or reset evidence; classify before continuing.

The local collector, dispatch ledger, raw artifacts and telemetry are retained
under `experiments.ignoreme/rollout/`. Raw telemetry is intentionally private;
the final report must retain run links and sanitized measurements for review.

Codex task: `01a0b054-bdd8-7d52-9c01-30d9b92576c8`.
