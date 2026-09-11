# Current append profile and live delivery — 5 September 2026

**At the transaction-local trust checkpoint, the core profiles around 9,200 events/sec for sequential 100-event
JSON batches. Concurrent writers increase write throughput, but a live reader
does not stay caught up during the burst.** At 16 writers, batch throughput is
about 10,800 events/sec while p99 observed delivery lag is about 1.3 seconds.
All measured events passed public replay. These are finite, local measurements,
not deployed capacity, sustained-load acceptance, or billable CPU.

No source, test, or runtime configuration changed for this measurement. The
implementation is the **4,999-line** [transaction-local trust checkpoint](transaction-trust-cost.md).
The [33-test suite checkpoint](local-verification.md) remains separate; it
was not rerun for a documentation-only update.
The [later scheduling diagnosis](live-reader-scheduling.md) and
[retained reader-aware yield](live-reader-fairness.md) address the observed
live lag. This profile predates that scheduling/consolidation change; it is
not a CPU measurement of the current implementation.
The later [reader-aware CPU evidence](fairness-cpu.md) measures current-source
process CPU separately from Inspector samples, with and without a reader.

## Current CPU sample

Apple M4 Max, arm64, Node 26.5.0, Wrangler 4.127.1, workerd 1.20260828.1,
debug logging. Three fresh projects, one sequential caller per project,
500 × 100 unsigned events, each with 1,024 ASCII characters in `data.text`.
No subscribers, processors, or egress. Warm `inspect` before profiling.

The Inspector sequence is `Runtime.enable`, `Profiler.enable`,
`Profiler.setSamplingInterval({ interval: 1000 })`, then start/stop around
each workload. The timer includes payload construction, HTTP requests,
decoded receipts, and checking each receipt count. Full replay is outside
the timer and profile: every ID, consecutive offset, type, full payload,
level-0 verification envelope, page head, and cursor is checked.
**All 150,000 events passed.**

| Round | Append ms | Events/sec | Samples | Profile duration µs | Replay ms |
| ----- | --------: | ---------: | ------: | ------------------: | --------: |
| 1     |   5424.73 |      9,217 |     890 |           5,431,604 |   1875.03 |
| 2     |   5398.16 |      9,262 |     885 |           5,412,049 |   1854.97 |
| 3     |   5440.80 |      9,190 |     885 |           5,461,849 |   1914.26 |

Aggregated leaf-frame counts and shares:

| Leaf                |      Round 1 |      Round 2 |      Round 3 |
| ------------------- | -----------: | -----------: | -----------: |
| Native SQL `exec`   | 393 (44.16%) | 409 (46.21%) | 435 (49.15%) |
| Native cursor `one` |   44 (4.94%) |   59 (6.67%) |   61 (6.89%) |
| Canonical JSON      |   41 (4.61%) |   32 (3.62%) |   34 (3.84%) |
| Garbage collector   |   38 (4.27%) |   34 (3.84%) |   31 (3.50%) |
| `(program)`         |   62 (6.97%) |   76 (8.59%) |   56 (6.33%) |

SQL remains the largest sampled leaf category. A similar percentage before
and after SQL reductions does not mean unchanged absolute CPU cost: the
workloads finish sooner. Samples are not continuous wall-time coverage,
whole-process CPU, or billable CPU/request. Schema parsing remains visible
in several generated functions; this profile does not justify removing
untrusted-input validation or admission bounds.

The previous profile predates three storage reductions, and there was no
matched current before/after profiling run here. Do not attribute the timing
difference solely to a particular refactor. No optimization was made from
these samples.

### Inspector setup failures retained

The first advertised Wrangler inspector connection exited with an unsettled
top-level await. Adding an owned timer made the next connection attempt
observe its five-second timeout. A direct workerd target using `localhost`
also timed out before the workload. A probe using `127.0.0.1` immediately
opened and received `Runtime.executionContextCreated`; all three profiles
then completed through that direct IPv4 target. This is a successful
connection alternative, not a proven diagnosis of the failed hostname/proxy
path. None of those failed attempts appended profiling events.

The direct target was discovered from `http://localhost:53248/json/list`,
selecting exactly `core:user:iterate-project-core-experiment-preview`,
then connecting to:

```txt
ws://127.0.0.1:53248/core:user:iterate-project-core-experiment-preview
```

The inspector port is ephemeral; discover it for a new run. Setup follows
the local workerd inspector driver at commit
`c4e03fa1d2a3f2607e2b79567076d5fdd5179d03`. Compact summaries were collected
before raw profile output; the latter exceeded the tool-output budget.
This document retains the summary values, not a complete raw-profile capture.

## Concurrent writers with one immediate-ACK reader

Three rounds, each in this order: batch size 1 with 1/4/16 writers, then
batch size 100 with 1/4/16 writers. Each case has a fresh project. Singleton
cases send 960 requests/events; batch cases send 160 requests/16,000 events.
Every event has the same 1,024-character ASCII payload and a unique ID.

Payloads are constructed before the timer. A writer awaits decoded receipts
before its next request; batches are distributed round-robin across writers.
A raw `/events` WebSocket is open at offset 0 before writing starts. Its
listener immediately validates each page and sends the exact ACK:

```js
assert.equal(page.afterOffset, live.length);
for (const event of page.events) {
  assert.equal(event.offset, live.length + 1);
  live.push(event);
}
assert.equal(page.throughOffset, live.length);
socket.send(JSON.stringify({ afterOffset: page.throughOffset }));
```

The actual probe additionally validates type, full payload, and verification
on every live event. Appends must return all expected IDs, consecutive offsets
inside each atomic batch, and no repeated offsets across writers. After the
reader catches up, every live envelope is compared with its append receipt.
Public replay then compares every full envelope with the same receipt,
checking final head and all page cursors. **All 152,640 events passed all
three views**, with no observed loss, reordering, or envelope drift in this
workload. Every reader closes after verification; no production data is used.

Values are rounds 1 / 2 / 3. Append p99 is per request, not per event.
Percentiles use `floor(N * p)`. Delivery lag is the client's `Date.now()`
minus the event's platform `time`, sampled when the page arrives; it is an
approximate same-machine observation, not clock-independent latency or a
measurement of storage flush completion. Drain time starts when all append
responses have been decoded and ends when the last live event arrives,
clamped to zero if the reader finishes first.

| Batch | Writers |               Events/sec |            Append p99 ms |    Live lag p99 ms |     Max observed backlog |                 Drain ms |
| ----: | ------: | -----------------------: | -----------------------: | -----------------: | -----------------------: | -----------------------: |
|     1 |       1 |          291 / 294 / 294 |       7.07 / 7.65 / 8.91 |          1 / 1 / 1 |                0 / 0 / 0 |       0.00 / 0.00 / 0.00 |
|     1 |       4 |          556 / 557 / 556 |    15.49 / 15.04 / 16.71 |          7 / 8 / 9 |                0 / 0 / 0 |       0.00 / 0.22 / 0.13 |
|     1 |      16 |          689 / 672 / 670 |    35.85 / 42.81 / 41.51 |       24 / 26 / 24 |                0 / 0 / 0 |       0.00 / 0.25 / 0.00 |
|   100 |       1 |    8,688 / 8,382 / 8,671 |    17.12 / 19.51 / 17.06 |          8 / 7 / 7 |                0 / 0 / 0 |       0.00 / 0.00 / 0.00 |
|   100 |       4 | 10,571 / 10,344 / 10,460 |    48.15 / 49.45 / 49.65 |    539 / 561 / 563 |    5,716 / 5,688 / 5,688 |    57.90 / 51.82 / 49.44 |
|   100 |      16 | 10,883 / 10,836 / 10,698 | 199.66 / 209.83 / 204.93 | 1282 / 1294 / 1300 | 13,880 / 14,008 / 13,624 | 124.00 / 126.65 / 117.53 |

The backlog is the maximum `page.head - page.throughOffset` seen by this
reader, not the latest global head at every instant or a native-memory
measurement. Replay after writing took 35–44 ms for singleton cases and
580–646 ms for batch cases. The reader caught up within 127 ms after all
writes completed, but that does **not** mean it kept pace while they ran.

## Interpretation and next discriminating check

The proposed check below has since been completed in the
[matched scheduling diagnosis](live-reader-scheduling.md). It locates most
observed delay before the ACK handler and compares two temporary timer-yield
variants with a restored-baseline control. This section preserves the
interpretation at the time of the initial measurement.

At 16 writers, about 14,000 events can be outstanding from the reader's
observed head. The [raw stream](../src/stream.ts) permits one outstanding
page per reader. `publish()` does not send another while it awaits an ACK;
the next ACK enables a page capped at 128 events and 256 KiB. A 13,880-event
backlog therefore needs at least 109 more serial page/ACK turns.

That mechanism plus the short post-burst drain is consistent with contention
between write requests and ACK processing. It does not identify the exact
workerd scheduling behavior, or distinguish transport, JSON work, SQL work,
and DO event scheduling. There is no reader-absent concurrent control in this
run, so do not attribute the write plateau to subscriptions.

The next diagnostic proposed at this checkpoint changes no implementation: run identical
16-writer workloads with and without a reader, and record for each page:

```ts
type PageTiming = {
  receivedAt: number;
  ackSentAt: number;
  head: number;
  throughOffset: number;
  eventCount: number;
};
```

Compare ACK-to-next-page intervals during writing and after it stops, alongside
append throughput and the same full receipt/replay checks. A longer sustained
run is also needed before making any bounded-lag claim. Do not raise the ACK
window or bypass validation on the strength of this finite burst alone.

The follow-up linked above retains a locally tested scheduling change;
deployed performance acceptance remains open. The earlier
[stalled-reader lease proof](stream-ack-deadline.md) covers a different concern:
releasing inactive readers, not guaranteeing fresh delivery under write load.

## Local captures

- Persistence: `/tmp/project-core-profile-fanout-ZUQwZY`.
- Runtime log: `wrangler-2026-09-05_00-54-26_882.log` under the local Wrangler
  log directory. The measurement run had zero uncaught exceptions, processor
  failures, hung/extra async cancellations, or alarm-manager mismatches.
- Profile projects:
  - `cpu-current-1-mtnofhbg-f96c4bcad749`.
  - `cpu-current-2-mtnofmyr-e0bf6c69be0f`.
  - `cpu-current-3-mtnofsks-f76434dd06db`.
- Live projects:
  - `live-1-1-1-mtnohe3y-0cf04c46c26d`.
  - `live-1-1-4-mtnohgpa-3abad97c412f`.
  - `live-1-1-16-mtnohi2l-c5612c881757`.
  - `live-1-100-1-mtnohj6l-0fc2f2af8ea4`.
  - `live-1-100-4-mtnohl32-5bec2c720449`.
  - `live-1-100-16-mtnohms3-d292634d4b7a`.
  - `live-2-1-1-mtnohohp-9f4dc4150305`.
  - `live-2-1-4-mtnohr1k-6153e43278eb`.
  - `live-2-1-16-mtnohsev-23995095b877`.
  - `live-2-100-1-mtnohtjs-3502bfa0719c`.
  - `live-2-100-4-mtnohvj8-66b0880b0297`.
  - `live-2-100-16-mtnohx9n-2d2e414d1c84`.
  - `live-3-1-1-mtnohyz5-6a584cb71a15`.
  - `live-3-1-4-mtnoi1jd-df2e202709a2`.
  - `live-3-1-16-mtnoi2wo-7d7afa96f7d7`.
  - `live-3-100-1-mtnoi41v-c38b24e77ecc`.
  - `live-3-100-4-mtnoi5xo-e0e756976d0d`.
  - `live-3-100-16-mtnoi7mw-dab1fe97ea16`.

Only the owned local fixture was used; public preview access policy and all
deployed performance/recovery evidence remain pending. The fixture was stopped
normally after measurement. The tutorial at `http://localhost:8798` is a
separate runtime and remains available.
