---
state: active
priority: high
size: small
dependsOn: []
---

# Reproduce ephemeral Stream append latency without voice

`stream-ephemeral-append-repro.ts` is a preview-only, source-level experiment.
It opens independent appender sessions against one owned project and creates two
fresh streams. For exactly two minutes it starts one fixed-payload ephemeral
append on each stream every 20 ms: 50 matched append pairs per second. It
records every observed client round-trip time and writes the full JSON artifact
under `/tmp`.

The `defaults` arm keeps the platform's automatic `project-worker` and
`iterate-platform-posthog` source-owned subscriptions. The `none` arm appends
supported `subscription-removed` events for those two subscriptions during its
creation turn. Before the timed phase, it reads `runtimeState()` and refuses to
continue unless the effective outbound subscription counts are exactly two and
zero respectively.

The experiment has explicit bounds: it stops dispatching when its oldest
unsettled append is older than 6,000 ms or when the shared pending set would
exceed 512 requests. It then waits at most 11,000 ms for outstanding appends.
Setup, runtime reads, and durable end markers each have a 15,000 ms deadline.
Those deadlines cannot cancel an in-flight RPC; a late fulfilled result is
released, and the artifact preserves any unresolved appends or fatal error.

No provider, voice facet, board, socket subscriber, or custom worker
participates. The durable markers only establish that each arm could append a
marker after its timed phase; they do not prove subscription delivery or cursor
acknowledgement.

Run it from the repository root against the owned Futurehomes preview project:

```bash
doppler run --project os --config preview_6 -- pnpm exec tsx tasks/stream-ephemeral-append-repro.ts
```

It uses `APP_CONFIG_BASE_URL` and `APP_CONFIG_ADMIN_API_SECRET` supplied by
Doppler, and it does not write them to the artifact. A sample at or above
2,000 ms counts as a multi-second result. The artifact is evidence about the
matched source-subscription configurations only; it does not attribute a slow
append to a particular subscription.

## Results

- 2026-09-10 preview6, run `defaults-vs-none-1789026757459-fe410a29`:
  6,001 frames per arm in 120.084 s; no samples at or above 2,000 ms. Defaults
  p50/p95/p99/max = 44/114/288/996 ms. Effective-zero p50/p95/p99/max =
  33/126/918/1933 ms. The artifact recorded effective outbound counts of two
  and zero both before and after the timed phase, and each durable marker
  append succeeded. Raw artifact:
  `/tmp/futurehomes-defaults-vs-none-1789026757459-fe410a29.json`.

- Earlier paired run `ephemeral-alarm-1789026349851-0a538e6b` showed a
  multi-second tail on the default-configured arm, but its comparison arm had
  an extra copy subscription. It is evidence of a symptom, not attribution.

Do not ship the previously proposed ephemeral-prefix optimization without a
repeatable matched failure followed by a green proof.

## WebSocket lifetime results

The original explanation that a growing client frame recorder caused the
correlated ten-minute run to fail is withdrawn. The run did stop after its
22,150th successful paired append, but it stopped because its peer closed the
WebSocket with code `1006`, not because the recorder reached a demonstrated
decoder bound. The repro now retains only a typed, bounded decoder walk and
records a bound hit only if one occurs; it no longer stores the first unrelated
wire frames.

Cloudflare provides an exact causal record for that close. In correlated run
`correlated-append-1789033808324-1ad42e82`, the client observed the `1006` at
2026-09-10T09:57:36.059Z. Its actual server request was
`d1d538f3f14b46fa580f05a14d57c8de`, trace
`1128760523f9e6932ab71a542e62ee8e`, root span `85637adf454f895e`. At
09:57:35.554Z, 505 ms earlier, that root `GET /api` request ended with
`Worker exceeded CPU time limit`: 445,429 ms wall time and 32,000 ms CPU time.
This is the request that owned the WebSocket, so its termination explains the
subsequent peer close. Raw audit:
`/tmp/futurehomes-correlated-close-full.json`.

The earlier ten-minute defaults-versus-none run had the same failure shape for
its defaults connection: its `1006` began at 08:30:46.531Z, after the root
`GET /api` request `a9d115c557a33be018728b6cc731dc9d` hit the same 32,000 ms
CPU limit at 08:30:46.340Z (540,517 ms wall time). Its actual trace is
`8e0999a4912728a970067f9ea909dc54`; raw audit:
`/tmp/futurehomes-defaults-close-discover.json`.

This classification does not cover the production HAVPE 08:08:23.654Z
capability-pager close. Its hibernatable socket close was a normal 47 ms / 0
CPU Durable Object turn. The contemporaneous root API request had a later
retryable capability-dispose error associated with a separate Durable Object
storage reset, but no CPU-limit record. Raw audit:
`/tmp/futurehomes-havpe-close-root-audit.json`.

## Read-only design audit (not an approved change)

This is a hypothesis and constraint record for the next discriminator. It does
not identify the latency's cause, approve an optimization, or replace a green
preview repro.

The empty append versus ephemeral append run should come first. It distinguishes
whether the extra work follows the event's ephemeral representation before any
storage change is considered.

### Current contracts

- Every append assigns `maxOffset + 1`. Before its response, the Stream Durable
  Object stores durable event rows and advances `stream_metadata.highest_assigned_offset`;
  the latter is the no-reuse floor for memory-only offsets.
  [`#append`](../apps/os/src/domains/streams/stream-durable-object.ts#L2485-L2556)
  and [`StreamEventLog`](../apps/os/src/domains/streams/stream-storage.ts#L105-L127)
  make that atomic boundary explicit.
- An ephemeral event changes only `maxOffset`. Its body and every other reduced
  effect must stay out of the core checkpoint, because a rebuild cannot replay
  it. [`StreamCoreProcessor.reduce`](../apps/os/src/domains/streams/core-processor.ts#L358-L364)
  and recovery's [`#applyHighestAssignedOffset`](../apps/os/src/domains/streams/stream-durable-object.ts#L2954-L2971)
  preserve that rule. The existing restart e2e requires the next durable event
  to have an offset greater than the vanished ephemeral event.
  [`streams.e2e.test.ts`](../apps/os/e2e/vitest/streams.e2e.test.ts#L173-L206)
- Durable subscriptions and session callbacks may cross a bounded missing
  suffix. A source-owned subscription records an empty suffix as a cursor ack;
  a session emits an empty scan through the current head. These scan envelopes
  keep cursor progress and replay contiguous without inventing event bodies.
  [`stream-event-sender.ts`](../apps/os/src/domains/streams/stream-event-sender.ts#L942-L958)
  [`stream-event-sender.ts`](../apps/os/src/domains/streams/stream-event-sender.ts#L2507-L2519)
  The browser processor's gap regression and catch-up's all-missing-range test
  cover the same public rule.
  [`processor-state-storage.test.ts`](../apps/os/src/domains/streams/client-libraries/browser/processor-state-storage.test.ts#L262-L280)
  [`catch-up-page.test.ts`](../apps/os/src/domains/streams/client-libraries/browser/catch-up-page.test.ts#L99-L110)

### Observed source-owned empty path

For every append, post-commit reconciliation calls `sendDue`.
[`stream-durable-object.ts`](../apps/os/src/domains/streams/stream-durable-object.ts#L2700-L2724)
A lagging copy, ITX-call, or webhook subscription starts a durable send check.
[`stream-event-sender.ts`](../apps/os/src/domains/streams/stream-event-sender.ts#L604-L716)
That work reads after its durable cursor. If only ephemeral offsets lie beyond
it, the read is empty and it calls `store.ack(name, state.maxOffset)`.
[`stream-event-sender.ts`](../apps/os/src/domains/streams/stream-event-sender.ts#L900-L958)
`ack` is an SQLite `UPDATE`, including `updated_at`.
[`stream-storage.ts`](../apps/os/src/domains/streams/stream-storage.ts#L570-L608)

So it is not safe to describe the current path as no-op. The ack happens once
per execution of the due send, not mechanically once per JavaScript append:
append turns arm/run the delivery work and an execution can absorb several
new offsets. Once a prior empty ack has caught up, a later ephemeral append
makes the row lag again and can schedule another empty ack. The measured run
must establish its actual cadence; this audit does not infer it from source.

### Bounded design hypothesis

A range allocator could reduce _allocator_ writes only by persisting an entire
range before the first ephemeral response that uses it. That reservation must
be irreversible. After an eviction, unused offsets in the reserved tail become
permanent no-body gaps and the next allocation starts above the reserved end.
This maintains no reuse, but it changes the observable recovered head: it may
jump from the last emitted ephemeral offset to the reserved end. Reserving a
range while publishing that end immediately is invalid, because a live session
could advance past an ephemeral event emitted later in that range.

The core-state KV checkpoint is a separate candidate: it is debounced at 64
new events or one second and is documented as a rebuild accelerator, while
SQL rows plus the allocator floor are the durable truth.
[`stream-durable-object.ts`](../apps/os/src/domains/streams/stream-durable-object.ts#L2866-L2905)
An ephemeral-only append need not force that checkpoint solely to retain its
body. Any change must still flush an earlier dirty durable state at the existing
quiet/alarm boundary and must not remove source-owned cursor persistence for a
durable event, a retry, a failure, or an explicit cursor change.

### Required regressions before an implementation is reviewable

1. A partially used reserved range survives abort: the first later durable
   event is above the reserved end, and no observed callback offset is reused.
2. A reconnect from the last observed ephemeral offset receives an empty scan
   through the reserved end, then the first post-restart durable event in order.
3. A source-owned subscription crosses an empty reserved suffix without
   permanent lag, duplicate durable delivery, lost retry state, or a skipped
   durable event that follows the gap.
4. Durable replay before and after an ephemeral gap remains ordered; browser
   processors retain their monotonic-offset rule.
5. During one live incarnation, `streamMaxOffset` never moves past an
   ephemeral offset that can still be emitted later from a reservation.

No range or cursor/checkpoint change should be proposed until the empty
append-versus-ephemeral preview repro is green and these invariants have a
failing regression first.

## Cap'n Web append-result ownership audit (read-only)

The workspace actually pins the Iterate fork `@iterate-com/capnweb@0.10.0`
(tag `capnweb@0.10.0`, `a709df328f2a7c1de023e942311be5e10d90f500`). The
ownership-critical `RpcPromise`/`pullPromise`, `deliverResolve`/`dispose`, and
export-release regions are byte-identical to the earlier upstream Cap'n Web
`v0.8.0` reference (`31adae850abdba0e0735aa60cd5fa31f2814c09c`).

`within()` pulls one RPC payload; `discardRpcResult()` releases the delivered
outer result, including a late success after a timeout. The ignored native
`.then()` continuation returns `void`; it does not retain an RPC export. The
server already detaches and releases its inner plain `StreamEvent[]` result.
This is therefore a no-leak source conclusion for successful append-result
ownership only. It does not identify the preview WebSocket `1006` cause or
clear any native/socket lifetime hypothesis.

Full audit: `/tmp/stream-append-capnweb-ownership-audit.md`.
