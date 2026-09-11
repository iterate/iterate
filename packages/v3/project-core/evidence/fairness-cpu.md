# Reader-aware scheduling: local CPU evidence — 5 September 2026

**With the retained reader-aware policy, adding one immediate-ACK reader
raises median main-workerd process CPU from 86.1 to 115.0 µs per event in this
local workload. Unprofiled live delivery stays at 7–8 ms p99, with zero observed
backlog.** This measures the whole reader path, not the timer's isolated cost,
Cloudflare billable CPU, or deployed capacity.

No source, test, configuration, or retained instrumentation changes. The
[fairness/consolidation implementation](live-reader-fairness.md) remains
**4,999 raw authored lines**. Its source hashes match that checkpoint. The
34-test suite was not rerun for this documentation-only measurement.

## Workload and correctness boundary

Apple M4 Max, arm64, Node 26.5.0, Wrangler 4.127.1, workerd 1.20260828.1,
debug logging, isolated local fixture on port 8799. There are two successive
measurement sets: unprofiled process CPU, then Inspector samples. Each set
uses six fresh projects: three no-reader/immediate-reader pairs, reversing
the order in round 2. Each case sends **640 requests × 100 unsigned events =
64,000 events**, distributed round-robin over 16 writer loops. Each writer
awaits its decoded response before its next request. Every event has a unique
ID, type `bench.note`, and 1,024 ASCII `x` characters in `data.text`.

Batches are constructed before timing; `inspect` initializes the project.
For reader cases, a raw `/events` WebSocket opens at offset 0 before writes.
The client validates each event's offset, type, full payload, and level-0
verification, then ACKs exactly the received page:

```ts
assert.equal(page.afterOffset, live.length);
for (const event of page.events) {
  assert.equal(event.offset, live.length + 1);
  live.push(event);
}
assert.equal(page.throughOffset, live.length);
socket.send(JSON.stringify({ afterOffset: page.throughOffset }));
```

Append receipts must contain every expected ID, consecutive offsets within
each batch, and no repeated offsets across writers. Every live envelope is
then compared in full with its receipt. After the measurement window, public
`readEvents` pages independently replay every full receipt, checking consecutive
offsets, final head, and page cursors. Open/close deadlines are five seconds;
live catch-up has a 30-second deadline.

**Both sets pass: 768,000 events replayed, including 384,000 live envelopes
that equal their append receipts.** These are finite append/live/replay
checks, not a sustained-capacity or crash-recovery test. No application traffic
from other tests was directed at this fixture. There is no discarded warm-up
workload; alternation does not eliminate JIT/GC, database-growth, machine-load,
or ordering effects.

## Unprofiled process CPU

The cumulative macOS `ps time` field is user plus system CPU. Before and after
each case, the driver checks the exact PIDs, parent PIDs, and command shapes:

```sh
ps -p 53346,53337,53333 -o pid=,ppid=,time=,command=
```

- `53346`: main workerd, parent `53333`, direct Inspector listener `58355`.
- `53337`: proxy workerd, parent `53333`, local entry listener `8799`.
- `53333`: Wrangler Node process, parent `53327`.

All stay unchanged across this set. The profiler is not enabled in this
measurement; Wrangler's ordinary Inspector connection remains present.
Process CPU is read before starting writers and after all append responses,
live catch-up, and normal reader close. Replay is outside this interval.
Append wall time ends at the last decoded append response, so it excludes the
final close and `ps` overhead. The CPU window is about 45 ms longer here.

`ps` reports centiseconds: raw deltas below are rounded to milliseconds, but
the underlying resolution is 10 ms. Main workerd includes all its isolates,
native runtime, SQLite, persistence, GC/JIT, and networking work. It is not a
per-request or per-DO accounting API. The separate proxy/Node columns avoid
silently attributing their work to the application isolate.

| Round | Reader | Append ms | Events/sec | CPU window ms | Main CPU ms | Proxy CPU ms | Wrangler CPU ms | Main µs/event |
| ----- | ------ | --------: | ---------: | ------------: | ----------: | -----------: | --------------: | ------------: |
| 1     | No     |   5665.03 |     11,297 |       5709.70 |        5450 |          300 |             110 |          85.2 |
| 1     | Yes    |   9122.76 |      7,015 |       9168.01 |        7340 |          430 |             120 |         114.7 |
| 2     | Yes    |   9182.84 |      6,970 |       9228.02 |        7360 |          440 |             170 |         115.0 |
| 2     | No     |   5932.20 |     10,789 |       5976.90 |        5560 |          300 |              60 |          86.9 |
| 3     | No     |   5889.18 |     10,867 |       5934.20 |        5510 |          300 |             110 |          86.1 |
| 3     | Yes    |   9350.28 |      6,845 |       9395.53 |        7530 |          430 |             120 |         117.7 |

The median main-process increment is **33.6%**; individual paired increases
are 34.7%, 32.4%, and 36.7%. Summing the three measured server processes gives
median 92.5 → 124.5 µs/event, a 34.6% increase. Main workerd accounts for most
of the extra measured CPU; the local proxy is not its dominant source.
Client CPU is separate: 846/1061/1068 ms without a reader and
1499/1443/1860 ms with one, including client JSON/assertions and measurement
overhead. None of those client figures is included in the server totals.

| Reader measurement       | Round 1 | Round 2 | Round 3 |
| ------------------------ | ------: | ------: | ------: |
| Append request p99 ms    |  264.38 |  265.41 |  274.19 |
| Live lag p99 ms          |       8 |       7 |       8 |
| Maximum live lag ms      |      11 |       9 |      15 |
| Maximum observed backlog |       0 |       0 |       0 |
| Post-write drain ms      |       0 |       0 |       0 |
| Pages received           |     640 |     640 |     640 |

Lag is same-machine `Date.now() - event.time`, not clock-independent network
latency or a storage-flush timestamp. Percentiles use `floor(N * p)`. Backlog
is maximum `page.head - page.throughOffset` at received pages, not continuously
sampled global head. Replay took 2405–2456 ms per case outside CPU timing.

Median write throughput is 10,867 without a reader and 6,970 with one, about
36% lower. The earlier [final-source probe](live-reader-fairness.md) used
16,000 events per case and observed 8,159–8,360 with a reader. This run uses
four times as many events; it is not a matched before/after source regression.
Main CPU divided by its measurement window is roughly 93–95% without a reader
and 80% with one. Thus the longer reader case contains both additional CPU
work and additional elapsed time without main-process CPU consumption; it is
not explained by a timer that merely waits. It does not isolate which waits
or scheduling interactions account for the remaining time.

## Separate Inspector samples

After process-CPU measurement, a new driver connects directly to the user
worker target discovered through `/json/list` on `127.0.0.1:58355`:

```js
await cdp("Runtime.enable");
await cdp("Profiler.enable");
await cdp("Profiler.setSamplingInterval", { interval: 1000 });
await cdp("Profiler.start");
// Same writers; await decoded receipts, reader catch-up, and normal close.
const { profile } = await cdp("Profiler.stop");
```

The first connection opens but `Runtime.enable` hits its five-second client
timeout, before any profiling project or append. A small same-target probe
then receives both `Runtime.executionContextCreated` and the matching command
result. The unchanged six-case driver subsequently completes. There is no
runtime restart or source change. This is a disclosed Inspector-attachment
failure followed by successful verification, not a diagnosed connection bug
or an application-workload retry.

| Round | Reader | Events/sec | Samples | Profile duration µs | Commit callback leaf | Named `exec` leaf | Named `one` leaf | `readEvents` leaf | GC leaf |
| ----- | ------ | ---------: | ------: | ------------------: | -------------------: | ----------------: | ---------------: | ----------------: | ------: |
| 1     | No     |     10,807 |    1100 |           5,944,724 |                  610 |                 0 |                0 |                 0 |      46 |
| 1     | Yes    |      6,850 |    1447 |           9,383,663 |                  666 |                 5 |                0 |                74 |     121 |
| 2     | Yes    |      6,796 |    1473 |           9,555,687 |                  432 |               230 |               22 |                62 |     120 |
| 2     | No     |     10,856 |    1095 |           5,934,339 |                   36 |               506 |               58 |                 0 |      53 |
| 3     | No     |     10,799 |    1090 |           5,982,518 |                   38 |               506 |               76 |                 0 |      47 |
| 3     | Yes    |      6,632 |    1501 |           9,729,687 |                   41 |               609 |               67 |                76 |     122 |

These columns are sampled leaf counts, not percentages of process CPU. The
anonymous commit callback maps to `prepared.map(...)` in
[Stream.#commit](../src/stream.ts), compiled `worker.js:18393`; it contains
canonicalization, duplicate lookup, trust decisions, and insertion. Named
attribution changes markedly across these rounds without a source change.
For example, round 1 mostly reports that callback, whereas later rounds show
frames named `exec` and `one`. Zero named SQL samples does not mean zero SQL work.
In the final reader case, 602 of 609 named `exec` samples have the commit
callback as their immediate parent. This confirms a hot commit path but does
not separate duplicate lookup from insertion cost.

Reader cases additionally sample `Stream.readEvents` 62–76 times and GC
120–122 times, versus 46–53 GC samples without readers. The concrete page
path decodes stored envelopes and serializes them for byte budgeting, then
serializes the complete page for transport:

```ts
const record = { ...JSON.parse(row.record), offset: row.offset };
bytes += new TextEncoder().encode(JSON.stringify(record)).byteLength;
// After bounded page construction:
socket.send(JSON.stringify(page));
```

This is a specific candidate for further measurement, not proof that removing
one serialization would recover the measured increment. UTF-8 byte limits,
exact envelopes, and the first-large-event behavior must survive any change;
`JSON.stringify(record).length` is not a safe replacement for byte counting.
No validation, idempotency check, durability boundary, or page bound was
removed on the strength of these samples.

Profiled reader p99 lag is 7/8/8 ms, maxima 18/26/11 ms. One case observes a
72-event backlog and 639 pages; the other two have zero backlog and 640 pages.
All have zero post-write drain. Profiled append-request p99 is
274.04/279.73/392.72 ms. These are kept separate from the unprofiled result;
profiling is not free. Replay still passes every envelope.

### What the Inspector measures

The primary source checked is the canonical workerd checkout at
`c4e03fa1d2a3f2607e2b79567076d5fdd5179d03`, not asserted to be the exact commit
of the packaged binary measured above. Its
[profiler command handling](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/worker.c%2B%2B#L2976)
creates a V8 profiler for the selected isolate. Its
[sample serialization](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/worker.c%2B%2B#L796)
defines `timeDeltas` as differences between successive sample timestamps,
starting at profile start. Summing them gives elapsed timestamp gaps, **not
CPU microseconds**. Neither sample counts, requested interval, profile duration,
nor timestamp-gap sum supplies a Cloudflare billing meter. The
[upstream Inspector test](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/server/tests/inspector/driver.mjs#L61)
uses hit counts to check that its deliberately expensive function dominates.

The process-CPU pair also cannot measure the timer alone. Adding a reader
activates both live delivery and the fairness policy: page construction,
transport, ACK processing, alarm/deadline housekeeping, timer yielding, and
changed scheduling/GC behavior all participate. These measurements support
that composite local cost and a few hot paths, not an attribution of every
extra microsecond.

## Captures and remaining acceptance

Persistence is `/tmp/project-core-fair-cpu-GVLD3Y`; runtime log is
`wrangler-2026-09-05_02-11-01_508.log` in the local Wrangler log directory.
Before teardown its 528-line audit has zero runtime/application errors,
cancellations, alarm failures, unhandled rejections, or abnormal WebSocket
closures. Normal Inspector attachment/proxy lifecycle messages are present.
The initial client CDP timeout is recorded above, not visible as a runtime
error in that log. No application processor or negative fixture was installed.
The owned fixture then stopped normally with exit code 0. All three measured
PIDs are gone and port 8799 refuses connections. The separate tutorial runtime
on port 8798 still returns HTTP 200; it was not stopped. Persistence was retained.

Project IDs, in actual execution order:

```txt
cpu-process-1-false-mtnr1jwb-5f30fd864381
cpu-process-1-true-mtnr1q7p-d14ce55bde34
cpu-process-2-true-mtnr1z88-8735e2d9827a
cpu-process-2-false-mtnr28ak-652389fff747
cpu-process-3-false-mtnr2et9-a26267b0d0e6
cpu-process-3-true-mtnr2lbs-8bbe20bec2a2
cpu-profile-fair-1-false-mtnr8evv-98b0e15953d2
cpu-profile-fair-1-true-mtnr8lcq-9f7d65acbb1b
cpu-profile-fair-2-true-mtnr8uiq-07db417d4260
cpu-profile-fair-2-false-mtnr93si-be153d94ad7f
cpu-profile-fair-3-false-mtnr9a9v-b00f04e34798
cpu-profile-fair-3-true-mtnr9gsb-b85b513f663d
```

The inline measurement drivers and compact profile summaries were collected
in the agent session. This document retains methodology and results, not a
complete raw `.cpuprofile` or a checked-in runnable benchmark driver. No
executable implementation is hidden under excluded evidence files. Deployed
CPU/latency acceptance, longer sustained load, and the comparison with the
existing core remain open; this local measurement does not complete them.

The subsequent [encoder-reuse experiment](read-page-cost.md) finds no useful
CPU reduction and restores this implementation. Its public byte-boundary
probes additionally cover emoji, escaped lone surrogates, and a valid signed
envelope larger than the normal page budget; no optimization is retained.
