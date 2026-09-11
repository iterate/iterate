# Retained live-reader fairness change — 5 September 2026

**The core now yields before committing an append when an OPEN stream reader
exists. On the final source, three finite 16-writer probes deliver at 7–8 ms
p99 observed lag with zero observed backlog. The core, including a new public
regression test, remains 4,999 raw authored lines; 34 tests pass locally.**

This follows the [matched scheduling diagnosis](live-reader-scheduling.md).
It is a local latency/throughput tradeoff, not a deployed latency guarantee.
Peak write throughput with readers is lower. Slow readers remain limited by
their own acknowledgement cycle; the change does not make every reader keep up.
A later [current-source CPU measurement](fairness-cpu.md) repeats a larger
64,000-event workload per case. Unprofiled delivery remains at 7–8 ms p99,
while the combined reader/fairness path raises median main-workerd CPU from
86.1 to 115.0 µs/event. Separate profiles and their attribution limits are
recorded there; these figures are not Cloudflare billable CPU.

## Retained policy

In [Context.append](../src/worker.ts), after asynchronous preparation and
before the existing synchronous commit:

```ts
if (this.ctx.getWebSockets("stream").some((socket) => socket.readyState === WebSocket.OPEN))
  await scheduler.wait(0);
const records = this.stream.commit(prepared);
```

There is no await inside the SQL transaction. Admission, pending-byte limits,
signature preparation, transaction-local trust decisions, repository CAS,
receipts, and the one-outstanding-page ACK protocol are unchanged. Checking
OPEN excludes closing transports from the scheduling decision. The workerd
source interpretation remains the one in the preceding diagnosis: a timer
provides a scheduling opportunity, not a documented global priority contract.
Any OPEN reader, including an idle one, activates this policy; write-only peak
rates must not be advertised for a context with readers attached.

## Three readers, paced and saturated

Apple M4 Max, arm64, Node 26.5.0, Wrangler 4.127.1, workerd 1.20260828.1,
debug logging. Each case uses a fresh project and 320 requests of 100 events,
with 16 writer loops and 1,024 ASCII characters in each event's `data.text`.
Each writer awaits its decoded receipt before issuing another batch.

Three raw WebSocket readers start before appending and deliberately wait
0, 25, or 100 ms before sending each exact page ACK. These are **client ACK
processing delays**, not emulated WAN latency, packet loss, or bandwidth.
The paced case schedules batches 50 ms apart, targeting 2,000 events/sec for
about 16 seconds; the saturated case removes that pacing. Reader open/close
deadlines are five seconds and the catch-up deadline is 60 seconds.

All four cases pass: **128,000 append events replayed, and all 384,000 live
reader envelopes equal their receipts**. Checks cover IDs, offsets, type,
payload, verification, page cursors, and final head. Replay is outside append
timing. This comparison precedes the code consolidation below; the final-source
probe is recorded separately.

| Workload  | Policy             | Write events/sec | Append request p99 ms |
| --------- | ------------------ | ---------------: | --------------------: |
| Paced     | Baseline           |            2,004 |                 21.13 |
| Paced     | Reader-aware yield |            2,004 |                 23.56 |
| Saturated | Baseline           |           10,937 |                194.29 |
| Saturated | Reader-aware yield |            7,414 |                254.47 |

| Workload  | Policy   | ACK delay ms | Live p99 lag ms | Max observed backlog | Post-write drain ms |
| --------- | -------- | -----------: | --------------: | -------------------: | ------------------: |
| Paced     | Baseline |            0 |               9 |                    0 |                   0 |
| Paced     | Yield    |            0 |               9 |                    0 |                   0 |
| Paced     | Baseline |           25 |              10 |                    0 |                   0 |
| Paced     | Yield    |           25 |              10 |                    0 |                   0 |
| Paced     | Baseline |          100 |          10,125 |               12,188 |              10,281 |
| Paced     | Yield    |          100 |          10,119 |               12,088 |              10,270 |
| Saturated | Baseline |            0 |           2,568 |               28,116 |                 276 |
| Saturated | Yield    |            0 |               7 |                    0 |                   0 |
| Saturated | Baseline |           25 |           6,753 |               28,700 |               6,781 |
| Saturated | Yield    |           25 |           3,879 |               16,568 |               3,917 |
| Saturated | Baseline |          100 |          24,624 |               29,752 |              24,880 |
| Saturated | Yield    |          100 |          22,326 |               26,908 |              22,599 |

Live lag is client `Date.now()` minus the event's platform `time`, with
same-machine millisecond clock granularity. Percentiles use `floor(N * p)`.
Backlog is the maximum `page.head - page.throughOffset` observed at a page,
not a continuous measurement of the latest global head. Drain is time from
the final decoded append response to the reader's final receive, clamped at
zero. Final delayed ACK completion is not included in drain.

At the paced rate the baseline already serves the 0/25 ms readers with
9–10 ms p99 lag. The saturation result is not evidence that every ordinary
collaborative workload previously had second-long lag. With the yield, the
fast reader stays current even alongside two slower readers. Saturated write
rate falls about 32% in this three-reader comparison.

The 100 ms reader cannot sustain the paced producer: at 4/8/12/16 seconds it
has received about 5k/10k/15k/20k events, while the producer reaches
8k/16k/24k/32k. The existing 128-event page cap bounds an ideal full-page
100 ms ACK cycle to 1,280 events/sec, before other overhead:

```txt
128 events / 0.100 seconds = 1,280 events/sec
```

All readers eventually catch up after these finite producers stop. Continuous
unbounded production, native-memory behavior, eviction, and a different
network window remain separate acceptance work.

## Public regression: red, then green

The new [network test](../e2e/core.test.ts), `streams concurrent appends within
the configured backlog budget`, opens one reader and sends 16 simultaneous
100-event batches with 1 KiB payloads. It checks exact live/receipt envelope
equality, the independent expected ID set, cursor continuity, and exact ACKs
before applying an optional backlog budget:

```ts
backlog = Math.max(backlog, current.head - current.throughOffset);
// After every live envelope has been compared with its append receipt:
const limit = Number(process.env.LIVE_READER_MAX_BACKLOG?.trim() || 1600);
assert.ok(Number.isSafeInteger(limit) && backlog <= limit);
```

The default, including blank/whitespace input, is the entire 1,600-event
burst: a portable functional check, **not a fairness-performance assertion**.
This local run explicitly selects 256. That target is workload-, runtime-,
machine-, and network-dependent even though it avoids cross-machine clocks.
Do not silently apply it as a universal deployed or WAN contract.

```sh
WORKER_BASE_URL=http://127.0.0.1:8799 LIVE_READER_MAX_BACKLOG=256 \
  node --test --test-name-pattern='streams concurrent appends' e2e/core.test.ts
```

Before retaining the yield, three executions fail with observed backlog
**1,244 / 1,272 / 1,372**, after passing all envelope and ID assertions.
With the two-line yield retained, the same test passes. These client assertion
failures are the intended red test, not ignored runtime errors.

The full suite then passes **34/34, zero failures/cancellations/skips**, in
20.943 seconds, using the isolated synthetic-secret fixture from
[local verification](local-verification.md) and:

```sh
WORKER_BASE_URL=http://127.0.0.1:8799 \
  EGRESS_E2E_ADMIN_TOKEN=synthetic-egress-admin-token \
  LIVE_READER_MAX_BACKLOG=256 pnpm test
```

After that full run, the test's environment parsing was adjusted so whitespace
also selects the default. Targeted checks on the final test pass for whitespace
and `256`, and deliberately fail for `invalid` (`NaN` is not a safe integer).
The runtime did not change between those checks. No suite test was removed,
skipped, or weakened to make room for the regression.

## Staying below 5,000 lines

The regression costs 45 formatted lines and the yield two. Shared operations
and redundant work were consolidated to recover 47 lines, without moving
runtime code into uncounted documentation or dependencies:

- [encoding.ts](../src/encoding.ts) supplies the existing UTF-8 SHA-256 hex
  encoding and base64url byte encoding to their previous duplicate callers.
  The two decoders retain their distinct validation and error behavior.
- [runtime.ts](../src/runtime.ts) no longer maintains a second four-name
  forbidden-method set already enforced by `methodPath`; its prototype-member
  rejection remains.
- [repositories.ts](../src/repositories.ts) returns the explicitly selected
  SQLite columns without redundant conversions of non-null INTEGER offsets
  or nullable TEXT parents. A missing-head condition already rejected by CAS
  is not tested a second time. Queries, ownership, CAS, and revision filters
  remain intact.
- [processors.ts](../src/processors.ts) checks the committed event type before
  reading a setting key; the documented `committedSetting.parse` invariant
  establishes the key shape. Platform-generated events cannot be `itx.set`.
- The outer worker shares project resolution after the existing `/secrets`
  method/auth checks. Five before/after public error responses retain their
  exact statuses and bodies, including unauthenticated and missing-project
  requests. Unknown failures still produce the existing INTERNAL error/log.
- The egress/provenance test input shapes share the existing generic public
  event type; runtime input validation and the required signatures array
  inside a present provenance object are unchanged.

The resulting count is **4,999**, including source, tests, UI, configuration,
scripts, and the counter. This is real duplication removal, but leaves no
spare line budget; a further feature still needs a deliberate size tradeoff.
Final type checking, scoped lint (23 files, 73 rules), formatting (64 files),
and `git diff --check` pass. The documentation audit resolves all 161 relative
links across 36 Markdown files. Source hashes below match after formatting.

## Final-source three-round check

After consolidation and the full suite, the preceding diagnosis's original
160-request × 100-event workload was repeated for three alternating no-reader
and immediate-ACK-reader pairs, with 16 writer loops. No other test suite ran
concurrently. **All 96,000 events replay; all 48,000 live envelopes equal
receipts.** No server timestamp instrumentation is present.

| Measurement                      | Round 1 | Round 2 | Round 3 |
| -------------------------------- | ------: | ------: | ------: |
| No-reader write events/sec       |  10,686 |  10,893 |  10,893 |
| One-reader write events/sec      |   8,159 |   8,360 |   8,308 |
| One-reader append request p99 ms |  216.37 |  215.08 |  220.83 |
| One-reader live p99 lag ms       |       7 |       8 |       7 |
| One-reader maximum lag ms        |       9 |       9 |       8 |
| Maximum observed backlog         |       0 |       0 |       0 |
| Post-write drain ms              |       0 |       0 |       0 |
| Client receive-to-ACK median ms  |   0.123 |   0.125 |   0.127 |

Each reader receives 160 pages. There are no known-backlog ACK intervals in
these final runs because every received page reports `head === throughOffset`.
The historical matched/reverse controls establish the scheduling tradeoff;
these final-source repetitions check that consolidation preserved the observed
result. They are not a fresh CPU profile or a universal overhead estimate.

## Failed fixture, log classification, and cleanup

The first consolidation-suite invocation passes 31/33. The other two cases
fail because the initial CLI's synthetic `EGRESS_KEY` decodes to 35 bytes,
not the required 32. One gets the explicit key-length error instead of a
successful secret write; the other consequently cannot reach its intended
approval assertion. The decoder was unchanged. Generating the literal from
`Buffer.alloc(32, 65).toString("base64url")` and restarting the owned fixture
corrects the setup; the 33-test consolidation suite then passes, followed by
the 34-test suite above. No production credentials or data were involved.

Both owned runtimes use `/tmp/project-core-sustained-nLjX31` and debug logs:

- `wrangler-2026-09-05_01-30-33_681.log`: the initial fixture has 18 intentional
  worker exceptions (12 deliberate failures, three broken-source failures,
  three mounted rejections), 15 classified processor warnings (five each at
  attempts 1/2/3), and two expected lending/disposal peer disconnects.
- `wrangler-2026-09-05_01-42-15_504.log`: the corrected fixture's two full suites
  have 36 intentional worker exceptions (24 deliberate failures, six
  broken-source failures, six mounted rejections), 30 classified processor
  warnings (ten each at attempts 1/2/3), and four expected peer disconnects.
  Two inspector code-1006 closures occur during reload/teardown, not app stream
  failures.
- Both logs have zero extra async/hung-response cancellations, `NOSENTRY`,
  alarm/scheduler errors, unhandled rejections, or subscription-callback
  failures. The invalid key produces a modeled request failure, not an
  unclassified runtime exception. There are no ACK instrumentation rows.

Three-reader projects use prefixes `sustained-baseline-true-`,
`sustained-baseline-false-`, `sustained-yield-true-`, and
`sustained-yield-false-`. Final-source projects use `ack-final-fair-1-` through
`ack-final-fair-3-`, with `false`/`true` selecting reader presence. Each has a
fresh generated suffix. The final reader project is
`ack-final-fair-3-true-mtnq313a-f6a068a3ad33`.

Both owned port-8799 runtimes stopped normally. A subsequent connection to
8799 failed as expected; the separate tutorial on 8798 still returned 200.
No fixture data was deleted. No deployment, commit, push, or PR occurred.

Final-source SHA-256 checkpoints:

```txt
src/worker.ts abdc28fdbb6bc257b07b96878b55bc9e141fd8555bcbf747b69a9fc36f61046d
src/encoding.ts 1d6ba2a3bd670ecaafb18e58604b825c6907f235b963f0967b1023c823ca8e63
e2e/core.test.ts 10871f07943b2d26981cc8eae6225955eba792921c4b412b5c989bc7e5cb32bb
```

The public regression is retained executable code and counted. The larger
probe drivers were temporary commands; this note preserves their parameters
and results, not hidden runtime functionality. Deployed tests, access policy,
hostile-load/native-memory acceptance, synchronous-commit crash/eviction checks,
and deployed throughput/CPU comparisons remain outstanding.
The subsequent [current-source processor recovery probe](fairness-recovery.md)
passes both pending-retry and interrupted-delivery SIGKILL cases with live
readers; secret/approval crash checks still predate this change.
