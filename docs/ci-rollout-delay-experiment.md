# Preview rollout-delay experiment

Status: **zero delay rejected**; testing 30 seconds next.

The first zero-delay smoke took **28.70s**, versus **115.43s** for the fresh
90-second control. The control spent 87.05s waiting. Both full workflows
passed with one test retry each; neither is a retry-free reliability sample.
The second zero-delay run passed without test retries but recorded a real
code-update reset during smoke project creation. Green checks alone would
have missed it.

## What changes

Only the minimum deployment age changes: 90 seconds → 0 seconds → 30 seconds. Smoke also
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

| Trial                                                                                  | Minimum age |   Smoke |   Wait | First project age | Test retries | Code-update resets observed |
| -------------------------------------------------------------------------------------- | ----------: | ------: | -----: | ----------------: | -----------: | --------------------------: |
| [Fresh control](https://depot.dev/orgs/0p91s0lz49/workflows/qkx92sflw7) (`4s9c5w1gmf`) |         90s | 115.43s | 87.05s |            91.20s |            1 |                           0 |
| [Zero 1](https://depot.dev/orgs/0p91s0lz49/workflows/lxgc0n6b4n) (`tvvdlqht59`)        |          0s |  28.70s |     0s |             2.79s |            1 |                           0 |
| [Zero 2](https://depot.dev/orgs/0p91s0lz49/workflows/9st263dlx0) (`10dgtcf6tc`)        |          0s |  21.96s |     0s |             3.04s |            0 |        5 records / 2 traces |

The control revision is `758ccc78a266c3ca16b5f1eda609086fa537e792`; both zero
trials used `22ac6998f4a28f03a5a406cedc7161c12d727c9c`. All used preview-11.
The OS versions were `c929d8f6-ce11-438e-8079-15f306ac4bdf` (control),
`645a90e7-c3de-4f9f-a7d4-de9be45356e6` (Zero 1), and
`343289ac-6d13-4943-aa7c-ecc7882d2b69` (Zero 2).

All three runs produced 16 raw telemetry artifacts, with 532 passed tests, nine
skipped and three expected failures emitted by the known-flake wrappers.
Expected failures and known-flake records are retained separately from real
test retries. Cleanup reported both `erased: true` and `restored: true`.

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
