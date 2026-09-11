# Read-page cost: rejected encoder reuse — 5 September 2026

**Reusing a `TextEncoder` did not establish a useful CPU reduction in the
measured public workload. The experiment was reverted; the core is still
4,999 raw authored lines, with the original source hash restored.**

The [preceding CPU profile](fairness-cpu.md) identified page construction and
GC alongside commit work. The smallest candidate left parsing, serialization,
byte accounting, and transport unchanged:

```ts
const utf8 = new TextEncoder(); // temporary module-scoped instance
// Inside the existing bounded read loop:
bytes += utf8.encode(JSON.stringify(record)).byteLength;
```

This avoids encoder-wrapper allocations, not output byte-array allocation or
JSON serialization. Canonical workerd source itself uses a retained
[encoder instance](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/per_isolate/webstreams/identity.ts#L131).
Its [encode implementation](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/encoding.c%2B%2B#L525)
still allocates the result. That source revision is not asserted to be the
exact commit of the packaged binary measured here. Native byte-length APIs
would introduce Node compatibility configuration, while `encodeInto` needs
buffer ownership and truncation rules; neither was added for this small probe.

## Baseline → candidate → restored baseline

Same machine and runtime as [the preceding measurement](fairness-cpu.md):
Apple M4 Max, Node 26.5.0, Wrangler 4.127.1, workerd 1.20260828.1, debug logging.
Each phase has three alternating no-reader/immediate-ACK-reader pairs, reader
first in round 2. Each case uses a fresh project, 16 writer loops, and
640 × 100 unsigned events with 1,024 ASCII characters in `data.text`.

Payload preparation and project initialization precede timing. Decoded append
responses end append wall timing. Unprofiled process CPU uses cumulative
`ps time` deltas on exact checked PIDs, ending after live catch-up and normal
close; public replay is outside that window. No Inspector CPU profiler is
enabled. The same complete receipt/live/replay assertions from the preceding
driver are retained, including IDs, payloads, verification, offsets, and cursors.

| Phase             | Reader | Main CPU ms, rounds 1 / 2 / 3 | Write events/sec, rounds 1 / 2 / 3 |
| ----------------- | ------ | ----------------------------: | ---------------------------------: |
| Baseline          | No     |            5460 / 5410 / 5490 |           10,980 / 10,957 / 10,913 |
| Baseline          | Yes    |            7350 / 7350 / 7430 |              6,966 / 6,952 / 6,859 |
| Reused encoder    | No     |            5560 / 5470 / 5520 |           10,760 / 10,937 / 10,871 |
| Reused encoder    | Yes    |            7290 / 7350 / 7410 |              7,064 / 7,173 / 6,851 |
| Restored baseline | No     |            5700 / 5620 / 5580 |           10,786 / 10,700 / 10,738 |
| Restored baseline | Yes    |            7340 / 7430 / 7460 |              7,014 / 7,056 / 6,964 |

Reader median main CPU is **7,350 → 7,350 → 7,430 ms per 64,000 events**:
114.8 → 114.8 → 116.1 µs/event. The candidate does not improve on the initial
CPU baseline; its roughly 1.1% difference from the restored baseline is not
enough to establish a reproducible benefit here. Unchanged no-reader behavior
also varies: phase medians are 5,460 → 5,520 → 5,620 ms. This is a rejection
of the evidence for retaining the change, not proof that allocation reuse
can never help any workload.

All nine readers have zero observed backlog and post-write drain. Live p99
is 7 ms in both initial/candidate phases and 7/8/8 ms after restoration.
All **1,152,000 events replay; all 576,000 live envelopes match receipts**.
Replay wall times range from 2,392 to 2,470 ms per case, without a consistent
phase improvement. Lag/backlog use the same approximate same-machine clock
and page-head definitions as the preceding evidence, not deployed guarantees.

Hot reload replaces main workerd between phases, so JIT/GC state resets;
storage is retained but every workload uses a fresh project. There is no
discarded warm-up round. The first restored no-reader case also overlaps a
short local typecheck/size command. These shared-machine measurements do not
justify attributing small timing differences to the source edit. `ps` has
10 ms resolution and counts the whole process, not the selected isolate or
Cloudflare billable CPU. Proxy/Node processes were measured separately by the
driver, not included in the main-process column.

## Public byte-boundary preservation

Before the candidate, with it, and after restoration, the same three fresh
project probes check exact append/replay/live envelopes and page boundaries.
Their independent client uses `Buffer.byteLength(JSON.stringify(event))`,
while the server uses `TextEncoder`; literal expected page counts additionally
catch an accidental code-unit count. Every live page receives its exact ACK.

| Input                                               | Expected page counts | Observed sum of event UTF-8 bytes per page |
| --------------------------------------------------- | -------------------- | -----------------------------------------: |
| Five `{ text: "🦀".repeat(16350) }` events          | 3, then 2            |                          196,752 / 131,168 |
| Five `{ text: "\ud800".repeat(10000) }` events      | 4, then 1            |                           240,744 / 60,186 |
| Small event, oversized signed envelope, small event | 1, then 1, then 1    |                        176 / 300,550 / 175 |

Each data value is legal under the 65,536-byte data limit. The lone-surrogate
case exercises JSON escaping, not invalid JSON transport. Checks compare
every full envelope against append receipts, page head, `afterOffset`,
`throughOffset`, and the final empty read. Across all phases these are another
**39 committed/replayed/live events**, separate from the performance totals.
The initial, candidate, and restored phases all return exactly those byte sums.

### The oversized envelope is publicly reachable

`PublicKeySchema` currently passes through additional JWK metadata. Data has
a 65,536-byte limit, but an append may be up to 524,288 bytes, so a valid
signature can carry enough extra key metadata to exceed the read page's
262,144-byte budget:

```js
const signature = await sign(projectId + "/", event, pair);
signature.key.padding = "x".repeat(300_000);
event.provenance.signatures.push(signature);
```

The signature still verifies at level 1 in an unconfigured project: the
signing payload excludes signatures, and key identity/import use only
`kty`, `crv`, and `x`. The extra metadata is retained in the receipt, so it
must not be represented as signer-attested provenance. This is not a trust
escalation; it is an explicit boundary on what the signature proves.

The existing reader returns an oversized event alone if it is the first
candidate for that page, permitting forward progress. The probe places it
between two small events to check both rejection from the previous page and
successful delivery alone on the next page. It exercises public HTTP and
WebSocket interfaces only, not direct storage mutation. These checks do not
cover legacy persisted envelope formats or every adversarial input.

## Decision, captures, and limits

The candidate passes type checking and the boundary probes, but it adds a
line: the strict counter correctly fails at **5,000**, not fewer than 5,000.
With no demonstrated CPU improvement, no unrelated consolidation was made
to create room. The original implementation was restored before the reverse
control, and type checking and the 4,999-line counter pass again. No permanent
test or production instrumentation was added, and the full 34-test suite was
not rerun for the restored, byte-identical runtime.

Restored `src/stream.ts` SHA-256:

```txt
974318f88e41a7e87a38197adc70b1d1e7484c5090655f8b26915b157f5da211
```

The owned fixture used `/tmp/project-core-read-cost-SElwbA`. Its log is
`wrangler-2026-09-05_02-28-43_993.log` in the local Wrangler log directory.
Wrangler PID 58951 and proxy workerd PID 58953 stay fixed; main workerd PIDs
are 58954 / 60018 / 60311 for the three phases, checked within every case.
The two deliberate reloads each cause an Inspector-proxy `1006` close followed
by a successful new attachment. They are not application subscription failures.
The log audit finds no application errors, unhandled rejections, extra async
cancellations, or alarm/scheduler failures. The log does not contain the
application request lines and therefore does not independently prove replay.

The runtime stops normally with exit code 0; its measured process tree is
gone. Temporary persistence is retained. Measurement commands, full compact
rows, and project IDs are in the agent session; this document is a methodology
and result record, not a checked-in executable benchmark or raw CPU profile.
Deployed performance and access-policy acceptance remain open.
