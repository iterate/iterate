# Preview rollout-delay experiment

Completed 2026-09-18. **30 seconds is the strongest candidate for further
validation: median agent-smoke time fell from 111.45s to 46.57s.** Ten fresh
full workflows at 30s all eventually passed, with no observed code-update
reset. Three needed 18 framework retries in total, and one also recovered
inside a known-flake wrapper. Their causes are not fully explained.

**No lower default is accepted by this experiment.** The final branch keeps
90 seconds, retains explicit smoke wait timing, and preserves the tested
candidates in commit history. Zero is rejected by a confirmed rollout reset;
60s costs another 31.57s of median smoke time over 30s without eliminating the
resource failures. Fifteen seconds has too little reliable evidence.

## Why agent-smoke is slow

The smoke waits until the deployment is old enough before creating its
project. This is one absolute deadline, shared with the other live suites;
time already spent on setup counts toward it. It is not 90 seconds of agent
inference or a second unconditional sleep.

Five recent main traces averaged 114.66s: 85.60s waiting and 29.06s doing
useful smoke work. The fresh 90s controls below reproduce that split: median
111.45s total, 87.84s waiting. The gate exists because edge-version health does
not prove that every Durable Object placement has received the new code.
The [earlier investigation](preview-e2e-flake-hunt.md) recorded a code-update
reset about 51 seconds after upload. Upload time and deploy-command completion
are different clocks; that observation does not establish a safe 51s gate.

## Measured comparison

Full-suite deployments only. One incomplete 30s deployment remains in the
ledger and JSON. Workflow time excludes queueing and includes cleanup and
restoration. These medians are observations, not randomized causal estimates.

| Minimum age | Full trials | Median smoke | Median whole workflow | Runs needing retries | Reported retries | Runs with code-update resets | Runs with memory-limit records |
| ----------- | ----------: | -----------: | --------------------: | -------------------: | ---------------: | ---------------------------: | -----------------------------: |
| 90s         |           3 |      111.45s |              8m36.06s |                    2 |                2 |                            0 |                    0/2 queried |
| 60s         |           3 |       78.14s |              7m11.27s |                    1 |                3 |                            0 |                            1/3 |
| 30s         |          10 |       46.57s |              6m42.30s |                    3 |               18 |                            0 |                           3/10 |
| 15s         |           3 |       32.49s |              6m13.00s |                    2 |                2 |                            0 |                            3/3 |
| 0s          |           2 |       25.33s |              7m32.37s |                    1 |                1 |                            1 |                    not queried |

The 15s sample includes one failed workflow. The 30s sample includes one
extra wrapper-internal recovery, separate from its 18 framework retries.
There were **22 measured deployments: 20 successful full workflows, one
failed full workflow, and one incomplete workflow. All 22 erased and restored.**

The 30s gate removes 60s of the configured wait. Its median observed smoke
saving was 64.88s (58%). Median prepare-to-last-test time fell from 407.21s
to 312.46s; prepare-to-workflow-finish fell from 516.06s to 402.30s. Deployment,
setup, suite timing and platform variance also affect those wider clocks.

## What the failures tell us

- **0s: reject.** Run `10dgtcf6tc` passed without test retries, yet its smoke
  project suffered a SchedulerDurableObject code-update reset at OS age
  **8.399s**. Trace `2434290c32d434238083ff5cb870e41e` identifies the same smoke
  project. Four duplicate records describe this event. A fifth record, in
  trace `3224f65104595c08b17f1d975d2e7fdb`, came from a later repo callback at
  age 124.504s; its precise origin remains unresolved. Green CI hid the first
  event, so smoke pass/fail alone is an inadequate acceptance signal.
- **15s: insufficient evidence.** One of three full workflows failed on a
  real storage error outside a known-flake wrapper's allowed pattern. Two
  workflows needed a retry; all three had memory-limit reset records. No
  explicit code-update reset was observed. These failures do not prove that
  deployment age caused them, but they do not justify the extra 15s saving.
- **30s: best speed lead, unresolved reliability.** The ten full runs needed
  `11, 0, 0, 0, 0, 3, 4, 0, 0, 0` framework retries. The first run had nine
  WebSocket 1006 failures, a Docs live-state timeout and a REPL workspace-edit
  timeout, plus the wrapper recovery. Later retries included object-moved
  storage errors, a browser disconnect timeout, an orphaned script and internal
  errors. No explicit code-update reset was observed, but absence of that
  signature does not explain the failures or prove absence of rollout trouble.
- **60s: no demonstrated reliability advantage.** The three full runs needed
  `3, 0, 0` retries. The first lost a child-agent script and a browser DO
  connection, and hit a storage error during reactivity project creation.
  It also had four memory-limit records across three traces. The other two
  had no recorded retries or memory resets. No explicit code-update reset
  was observed. Three trials cannot distinguish its reliability from 30s.
- **90s: a noisy control too.** Two of three controls needed one retry: an
  internal workspace error and a DO overload. Neither of the two controls
  queried specifically for memory resets had a match. This does not establish
  that 90s prevents memory failures or makes the full suite error-free.

The memory events have a useful concrete lead. All three affected 30s runs
include the existing oversized-journal regression, which writes about 84MB,
deliberately evicts its stream, then reads persisted bodies. The first 60s
run has the same test's memory failure at deployment age116.508s. The test
itself passed. Additional 15s/60s memory victims remain unidentified. This
points toward workload pressure, but does not prove that all resets or retries
share that cause. Deliberate `kill requested` events are tracked separately;
a memory-limit failure is not assumed to be an expected kill.

Selected correlations, with the full failures retained in the JSON:

| Run               | Evidence                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q0vdpttdl5` /30s | Initial11-retry wave; only the expected OS version appeared in platform outcomes; no explicit code-update or memory-limit record. Root cause unresolved.                                                   |
| `vjw0tw5t7f` /30s | One browser shard failed before tests on a CI status-poll timeout. Other suites still had two real storage/moved-object retries. Excluded only from the full-suite count.                                  |
| `424l7btjqk` /15s | Fatal storage reference `jrki45tjuhfhvkc7d188u0ci`, trace `d7d350ab9ca59c2532a6b2bd2234e507`, OS age77.393s. CLI retry matched a different storage reference at 77.713s.                                   |
| `6whwknjr01` /30s | Two moved-object errors match traces `70eb80842c076f6e2af1f8892390aac3` and `cea86d6e3139b721f389441d4099b88c` at 77.678/77.690s. Browser disconnection timeout remains unexplained.                       |
| `xx1qlqh727` /60s | Reactivity storage reference `s41vu3uchv97a2q2egp4c3sf` matches trace `5501d7d98fda0318811e4aba64345489` at 99.010s. Oversized-journal memory error: trace `f82a13dcc38baf78a1528cd3e8f5a006` at 116.508s. |

The collector also reads known-flake `unexpected-error` records. Static
expected-failure metadata would otherwise hide the real failed 15s wrapper
and the extra 30s wrapper recovery. Each is retained with its later known
outcome, when one exists. Framework retries, wrapper recoveries, product
recoveries and explicit code-update resets are distinct measurements.

## Decision and next experiment

Keep 90s as the accepted default for now. This is a limit of the proof, not
proof that 90s is necessary. The [engineering invariant](engineering-invariants.md)
requires operational acceptance evidence without new unexplained errors;
the initial 30s failure wave prevents that claim.

The next useful work is to explain the cross-project WebSocket failure wave
and the memory resets during oversized-journal coverage, then run interleaved
fresh 30s and 90s deployments after correcting the underlying defects or their
classification. More unstructured green reruns would not explain the retained
failures. Do not weaken the suites, add retries, raise timeouts or silently
exclude those runs to manufacture acceptance.

Thirty seconds is preserved at revision
`5cd0275438cc6d4d58d6e41f9ea03c3b2a5ba932` (same runtime source as
`f6018b02419d866caffcbc9e1e13230ab45384c7`). The final branch restores the
90s constant and its original behavior spec. The only runtime addition is
the named `wait for deployment rollout` smoke phase.

## Method and limits

Every measured trial deployed fresh versions to preview-11 through the
canonical serialized `preview-main.yml` workflow. All six apps deployed;
the six app test commands and six OS browser shards retained their suite
selection, concurrency, retry policy, watchdogs, exact-version checks,
version-override headers, lease and cleanup behavior. Existing quarantines
stayed visible and unchanged. A successful full trial has 16 raw telemetry
artifacts and 544 test records: 532 passed, three expected failures, nine skipped.
The failed 15s trial has 531 passed, three expected failures and one real failure.

The sample is small, uses one slot, and was collected sequentially rather than
randomized. Platform conditions, placement and warm services can vary between
runs. Code-update and memory counts are telemetry records, sometimes duplicated
or sampled, not incident counts or proof of absence. Memory-specific queries
were not run for the first 90s control or the two 0s trials; the JSON uses `null`,
not zero. The original noisy 30s trial is included in its ten-run sample.

Setup-only run `zl16nw5xv4` had no exact-head package publication and is excluded
from latency comparisons; cleanup completed. Queued run `3hz60tlhhq` was
cancelled before any of its nine jobs started and created no deployment.
Neither is silently counted as a successful trial.

## Deployment ledger

Project age starts at successful OS deploy-command completion and ends at
smoke project creation. Code-update counts below are observed records.

| Trial                                                                             | Minimum age |   Smoke |   Wait | First project age | Test retries | Code-update resets observed |
| --------------------------------------------------------------------------------- | ----------: | ------: | -----: | ----------------: | -----------: | --------------------------: |
| [4s9c5w1gmf](https://depot.dev/orgs/0p91s0lz49/workflows/qkx92sflw7)              |         90s | 115.43s | 87.05s |            91.20s |            1 |                   0 records |
| [tvvdlqht59](https://depot.dev/orgs/0p91s0lz49/workflows/lxgc0n6b4n)              |          0s |  28.70s |  0.00s |             2.79s |            1 |                   0 records |
| [10dgtcf6tc](https://depot.dev/orgs/0p91s0lz49/workflows/9st263dlx0)              |          0s |  21.95s |  0.00s |             3.04s |            0 |                   5 records |
| [q0vdpttdl5](https://depot.dev/orgs/0p91s0lz49/workflows/sh7vz2jps9)              |         30s |  55.76s | 29.28s |            31.07s |           11 |                   0 records |
| [s8l2d2x7n5](https://depot.dev/orgs/0p91s0lz49/workflows/3cw4k5n3pn)              |         90s | 111.45s | 87.84s |            91.52s |            0 |                   0 records |
| [hnm33kz377](https://depot.dev/orgs/0p91s0lz49/workflows/h8mmbx4lvs)              |         30s |  48.57s | 27.25s |            31.21s |            0 |                   0 records |
| [vjw0tw5t7f / incomplete](https://depot.dev/orgs/0p91s0lz49/workflows/1nrprknscl) |         30s |  47.19s | 27.16s |            31.78s |            2 |                   0 records |
| [sd606x6w9v](https://depot.dev/orgs/0p91s0lz49/workflows/ttgj606pct)              |         30s |  42.66s | 21.53s |            31.06s |            0 |                   0 records |
| [8gr4b2p5ld](https://depot.dev/orgs/0p91s0lz49/workflows/75rnq4s9b7)              |         30s |  46.51s | 28.14s |            31.01s |            0 |                   0 records |
| [424l7btjqk / failed](https://depot.dev/orgs/0p91s0lz49/workflows/n4brv1xt5p)     |         15s |  32.49s |  7.11s |            16.10s |            1 |                   0 records |
| [11l285tklj](https://depot.dev/orgs/0p91s0lz49/workflows/x9x4bldsz0)              |         15s |  31.57s | 12.42s |            16.07s |            0 |                   0 records |
| [7q8x9g7hk2](https://depot.dev/orgs/0p91s0lz49/workflows/fxzn6p1t92)              |         15s |  35.57s | 12.59s |            16.03s |            1 |                   0 records |
| [pb4hf6lzfh](https://depot.dev/orgs/0p91s0lz49/workflows/kk3mg5pkq2)              |         90s | 108.17s | 88.11s |            91.84s |            1 |                   0 records |
| [3265trd5m5](https://depot.dev/orgs/0p91s0lz49/workflows/t8snln3xm6)              |         30s |  54.23s | 27.55s |            31.29s |            0 |                   0 records |
| [6whwknjr01](https://depot.dev/orgs/0p91s0lz49/workflows/0fx8qwv38x)              |         30s |  38.86s | 20.50s |            31.17s |            3 |                   0 records |
| [09967hf2pc](https://depot.dev/orgs/0p91s0lz49/workflows/q5s00dx011)              |         30s |  46.64s | 28.01s |            31.07s |            4 |                   0 records |
| [mbph95cv0d](https://depot.dev/orgs/0p91s0lz49/workflows/jdkksggkhp)              |         30s |  47.79s | 28.21s |            30.89s |            0 |                   0 records |
| [3kqx2pr9gv](https://depot.dev/orgs/0p91s0lz49/workflows/6b29xmq7m1)              |         30s |  45.12s | 28.08s |            30.97s |            0 |                   0 records |
| [ds35cnqskh](https://depot.dev/orgs/0p91s0lz49/workflows/h149hdspqf)              |         30s |  46.13s | 28.12s |            31.15s |            0 |                   0 records |
| [xx1qlqh727](https://depot.dev/orgs/0p91s0lz49/workflows/zfql1sjx19)              |         60s |  82.37s | 57.19s |            61.23s |            3 |                   0 records |
| [grk8nr083z](https://depot.dev/orgs/0p91s0lz49/workflows/c89x30d7q5)              |         60s |  78.14s | 57.69s |            62.01s |            0 |                   0 records |
| [z1bmhp605p](https://depot.dev/orgs/0p91s0lz49/workflows/krcc5r0lh8)              |         60s |  74.67s | 57.91s |            61.34s |            0 |                   0 records |

### Whole-workflow clocks

Start: prepare job's first log. End: last test, or workflow finish including
cleanup/restoration. Queue time is excluded.

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
| `xx1qlqh727` (60s gate)              |        6m 6.0s |          7m 23.5s |
| `grk8nr083z` (60s gate)              |        5m 3.0s |          6m 40.1s |
| `z1bmhp605p` (60s gate)              |       5m 43.9s |          7m 11.3s |

[Sanitized measurements](ci-rollout-delay-evidence.json) include every run's
revision, app versions and deploy timestamps, clocks, retries, wrapper outcomes,
telemetry counts, trace IDs, classification and erase/restore result. Raw
telemetry and credentials are not committed; local artifacts remain under
`experiments.ignoreme/rollout/`.

## Reproduce

1. Use an isolated branch and publish its exact revision's first-party packages
   before deployment. Candidate revisions and versions are in the JSON. The
   temporary no-PR branch entry in `pkg-pr-new.yml` was removed from the final
   diff; copying this branch's final revision tests the retained 90s default.
2. Wait until the shared Preview Main workflow is idle, then dispatch the
   canonical workflow on the intended branch:
   `depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate --workflow preview-main.yml --ref <branch>`.
3. Download `preview-ci-prepare`, `preview-ci-apps` and all six
   `preview-ci-playwright-*` artifacts. Deduplicate raw reports by artifact ID;
   preserve all attempt failures, wrapper records and connection recoveries.
4. Query Cloudflare observability for the six deployed service names, from
   OS deployment through the last test. Inspect explicit `code was updated`
   records, memory-limit messages, lifecycle resets and error telemetry. Match
   errors to traces/project identity; deliberate reset tests are not rollout
   resets merely because both contain the word `reset`.
5. Verify fresh app-version IDs, actual first-project age and successful erase
   and restoration. Include whole-workflow clocks and preserve failed runs.
   Stop after recovery/reset evidence to classify it before another dispatch.

Validation: all 216 preview tests, scripts typecheck, repository lint, changed
file formatting and evidence consistency checks. The named smoke phase was
exercised in all 22 measured fresh deployments. No production change or PR.

Codex task: `01a0b054-bdd8-7d52-9c01-30d9b92576c8`.
