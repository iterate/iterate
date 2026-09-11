# Live-reader scheduling diagnosis — 5 September 2026

**Under a finite 16-writer burst, most observed ACK delay occurs before the
server ACK handler runs. A temporary timer yield before commit reduced p99
live lag from about 1.25 seconds to 7–13 ms, at roughly 27% lower write
throughput with a reader. Removing the yield brought the lag back.**

At this diagnostic checkpoint no experimental runtime change was retained:
the original source was restored exactly at **4,999 raw authored lines**.
The [later fairness change](live-reader-fairness.md) records multi-reader and
delayed-ACK checks, a public regression, and the retained reader-aware yield
within the same line budget. This historical diagnosis is a measured local
tradeoff, not a deployed latency guarantee. It follows the
[initial live-reader probe](current-profile-and-live-delivery.md).

## Matched workload and correctness checks

Apple M4 Max, arm64, Node 26.5.0, Wrangler 4.127.1, workerd 1.20260828.1,
debug logging. Each case uses a fresh project, warmed with `inspect`:

- 160 HTTP append requests, 100 events per request, 16 concurrent writers.
- Each event has a unique ID and 1,024 ASCII characters in `data.text`.
- Payloads are constructed before timing. Each writer awaits and checks its
  decoded append receipt before issuing its next round-robin batch.
- Cases alternate no reader / one raw WebSocket reader, for three rounds
  per implementation. The reader opens at offset 0 before writing starts.
- The reader validates every offset, type, payload, and level-0 verification
  envelope before immediately sending the exact page ACK. Full live envelopes
  must equal append receipts. Full public replay then checks the same receipt
  envelopes, all cursors, and the final head, outside append timing.
- Reader open/close deadlines are five seconds; catch-up deadline is 30 seconds.
  Every case completes, and every reader closes normally.

The sequence is baseline A, separately instrumented A, unconditional yield B,
reader-only yield C, then restored baseline A. Each uninstrumented phase
checks 96,000 events; the instrumented phase checks 16,000. **All 400,000
events passed receipt/replay checks; the 208,000-event live subset additionally
matched subscription envelopes.** These are additional diagnostic probes,
not a rerun of the separate 33-test public-network suite.

The client records monotonic receive and ACK-send times. For the comparison
below, ACK-to-next-page intervals are included only when the previous page
already reports backlog (`head > throughOffset`). This excludes waiting for
new events. An interval crossing the final append response is reported
separately, not assigned to either phase.

```js
const hasBacklog = previous.head > previous.throughOffset;
const ackToPageMs = next.receivedAt - previous.ackSentAt;
const duringWrites = next.receivedAt <= appendEnd;
const afterWrites = previous.ackSentAt >= appendEnd;
```

Percentiles use `floor(N * p)`. Live lag is client `Date.now()` minus the
event's platform `time`: an approximate same-machine observation with
millisecond clock granularity, not clock-independent latency. Backlog is the
maximum `page.head - page.throughOffset` observed by that reader, not a
continuous global-head measurement. Drain starts after all append responses
are decoded, and is clamped to zero if the reader finishes first.

## Baseline controls

Values are rounds 1 / 2 / 3:

| Measurement                                     |                No reader | One immediate-ACK reader |
| ----------------------------------------------- | -----------------------: | -----------------------: |
| Append events/sec                               | 11,131 / 11,192 / 11,095 | 11,000 / 11,323 / 11,213 |
| Append request p99 ms                           | 155.43 / 153.19 / 156.48 | 190.91 / 198.15 / 189.85 |
| Live lag p99 ms                                 |                        — |       1266 / 1233 / 1253 |
| Max observed backlog                            |                        — | 13,880 / 13,724 / 14,108 |
| Post-write drain ms                             |                        — | 119.80 / 119.26 / 120.04 |
| Client receive-to-ACK median ms                 |                        — |    0.147 / 0.150 / 0.152 |
| Backlogged ACK-to-page median during writes, ms |                        — |   89.31 / 76.61 / 119.72 |
| Backlogged ACK-to-page median after writes, ms  |                        — |    0.883 / 0.825 / 0.852 |

The baseline reader has no consistent material effect on bulk write rate
in these three rounds. Client parsing, assertions, and ACK preparation are
small compared with the intervals between pages. There are 14 / 15 / 12
known-backlog intervals wholly during writing and 109 / 108 / 111 after it;
each case has one excluded crossing interval. All readers receive 126 pages.

This narrows the earlier hypothesis: the principal delay is not simply the
client spending tens of milliseconds preparing each ACK. It does not by
itself identify where that ACK waits on the server side.

## Two temporary server timestamps

One additional baseline case adds a tagged `Date.now()` immediately after
ACK schema parsing and immediately after `socket.send(JSON.stringify(page))`.
The client also records wall-clock receive and ACK-send times. All 252 tagged
rows are present: 126 sends and 126 ACKs. Records are joined by exact offsets.
The instrumentation is removed before the yield experiments.

```ts
// Diagnostic decomposition, not application code.
const inboundMs = serverAck.at - previousPage.ackSentWall;
const handlerMs = serverSend.at - serverAck.at;
const outboundMs = nextPage.receivedWall - serverSend.at;
```

| Segment                                | During writes: median / max ms | After writes: median / max ms |
| -------------------------------------- | -----------------------------: | ----------------------------: |
| Client ACK send → server ACK handler   |                       77 / 141 |                         0 / 1 |
| ACK handler → server next-page send    |                          1 / 1 |                         0 / 1 |
| Server send → client next-page receipt |                          2 / 6 |                         1 / 3 |
| Entire ACK → next-page interval        |                       80 / 145 |                         1 / 4 |

These are 15 during-write and 109 post-write transitions, including transitions
whose prior page reported no backlog; they are not the same filtered sample
as the baseline table. One crossing interval takes 102 ms, of which 101 ms is
before handler invocation. A concrete backlogged interval is 141 ms inbound,
1 ms inside the handler, and 3 ms outbound, while the next page reports 4,016
events still outstanding.

The instrumented case reaches 10,789 events/sec, p99 live lag 1281 ms, and
152 ms post-write drain. Logging changes timing; do not substitute these
numbers for the uninstrumented baseline. Within this probe, the delay is
overwhelmingly **before ACK handler invocation**. These timestamps do not
separate HTTP proxy queues, native RPC scheduling, and the DO input gate.

## Timer-yield experiments and reverse control

The insertion point is after asynchronous preparation and before the existing
synchronous transaction in [Context.append](../src/worker.ts). It is not an
await inside the transaction. Validation, transaction-local trust policy,
memory admission, receipt construction, and the ACK protocol are unchanged.

```ts
// Experiment B: unconditional. REMOVED.
await scheduler.wait(0);
const records = this.stream.commit(prepared);
```

```ts
// Experiment C: removed at this checkpoint; retained in the later follow-up.
if (this.ctx.getWebSockets("stream").some((socket) => socket.readyState === WebSocket.OPEN))
  await scheduler.wait(0);
const records = this.stream.commit(prepared);
```

Checking OPEN avoids yielding merely because a closing transport still exists.
Both prototypes typecheck. B temporarily counts 5,000 lines and C 5,001;
neither satisfies the strict size target at this checkpoint. Both were removed
before the separate follow-up recovered room through code consolidation.

| Phase                  |     No-reader events/sec |        Reader events/sec | Reader live p99 ms | Reader max observed backlog |          Reader drain ms |
| ---------------------- | -----------------------: | -----------------------: | -----------------: | --------------------------: | -----------------------: |
| A: baseline            | 11,131 / 11,192 / 11,095 | 11,000 / 11,323 / 11,213 | 1266 / 1233 / 1253 |    13,880 / 13,724 / 14,108 | 119.80 / 119.26 / 120.04 |
| B: unconditional yield | 10,506 / 10,811 / 10,639 |    8,177 / 8,398 / 8,170 |          9 / 8 / 8 |                   0 / 0 / 0 |                0 / 0 / 0 |
| C: reader-only yield   | 10,769 / 10,999 / 10,916 |    8,011 / 8,285 / 8,127 |         13 / 7 / 8 |                  72 / 0 / 0 |                0 / 0 / 0 |
| A: source restored     | 10,948 / 11,055 / 10,697 | 10,877 / 11,081 / 10,833 | 1280 / 1261 / 1286 |    14,008 / 13,880 / 13,980 | 121.35 / 116.55 / 122.37 |

Median reader write rate is 11,213 events/sec initially, 8,127 with the
conditional yield, and 10,877 after restoration. The reduction is 27.5%
against the initial control or 25.3% against the later control. Three finite
rounds on a shared machine are not a precise universal overhead estimate.
The yield variants deliver 159–160 pages, generally one page per 100-event
append, instead of accumulating 126 mostly full 128-event pages behind writes.

The reverse control supports a causal effect of this scheduling intervention
on this workload. It does **not** prove starvation in a specific native queue,
or that zero-delay timers provide a documented priority guarantee.

## What the workerd source supports

Source was inspected in the canonical checkout
`/Users/jonastemplestein/src/github.com/cloudflare/workerd` at commit
`c4e03fa1d2a3f2607e2b79567076d5fdd5179d03`. This source revision is not asserted
to be the exact source of the measured packaged binary.

- The [input/output gate contract](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/io-gate.h#L13)
  explains why an incoming event can wait before application code runs and why
  outbound visibility must respect persistence. It does not identify which
  particular gate or queue dominates this run.
- [Input-gate waiter order](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/io-gate.c++#L118)
  concerns events already waiting at that gate; it does not establish global
  fairness between native RPC requests and hibernating WebSocket events.
- [Scheduler.wait](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/basics.c++#L985)
  delegates to a timer and resolves its promise from the timer callback. This
  explains the intervention's mechanism without turning its observed effect
  into a cross-runtime scheduling contract.

## What this diagnostic checkpoint left to establish

The result makes a reader-aware yield worth evaluating, but admission and
network-window policy still need an explicit latency/throughput target.
The existing reader permits one outstanding page, capped at 128 events and
256 KiB. Even perfect scheduling cannot deliver a 10,000-event/sec stream
through 128 events per 100 ms ACK round trip:

```txt
128 events / 0.100 seconds = at most 1,280 events/sec
```

That is a protocol upper bound for full pages under the stated RTT, not a
measured WAN result. A loopback-only assertion such as `p99 < 50 ms` would
not be a suitable universal deployed E2E contract. A larger or multi-page
window changes bounded-memory and replay semantics and needs its own tests.

A retained change needs a public-interface regression/benchmark lane with an
explicit workload and network target, plus honest line-budget headroom.
No tests, guards, or features were removed for these experiments. The next
useful comparison should include a sustained producer, more than one reader,
and controlled ACK delay, measuring both freshness and bounded catch-up or
explicit overload outcomes. The [stalled-reader lease](stream-ack-deadline.md)
remains a separate guarantee; a healthy but lagging reader is not stalled.

## Captures and cleanup

- Persistence: `/tmp/project-core-live-control-pZ578v`.
- Log: `wrangler-2026-09-05_01-08-14_315.log` in the local Wrangler log directory.
- Project prefixes: `ack-control-`, `ack-stage-`, `ack-yield-`,
  `ack-reader-yield-`, `ack-restored-`. Every case uses a fresh generated suffix.
- Instrumented project: `ack-stage-1-true-mtnot3a9-ce999d0898bf`.
- Final restored reader: `ack-restored-3-true-mtnp5388-a0fec0e7bef2`.
- No exceptions, unexpected cancellations, processor/scheduler failures, or
  alarm diagnostics in the final runtime log. The 252 tagged diagnostic rows
  are expected instrumentation, and all instrumentation was removed.
- The owned fixture on port 8799 stopped normally; a subsequent connection
  failed as expected. The separate tutorial on port 8798 still returned 200.

Restored SHA-256 checks match the pre-experiment files exactly:

```txt
src/worker.ts 9c8766d8d17f9bd82a2e35ad8a2d8bfe2515a3e206e080731c28c0381d2511fc
src/stream.ts 974318f88e41a7e87a38197adc70b1d1e7484c5090655f8b26915b157f5da211
```

This document retains parameters, comparison results, and the interventions,
not a permanent executable benchmark driver. It is not counted as runtime or
test code and does not provide hidden functionality. No deployment occurred;
preview access policy and deployed performance/recovery proof remain pending.
