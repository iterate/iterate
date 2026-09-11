# Trace-timing semantics audit

This is a read-only interpretation of the reported slow append trace: client
WebSocket out→in `1780 ms`; ingress/ITX region LHR `2104 ms`; DO custom span
AMS `0 ms`; native parent JS RPC `221 ms`; native worker wall `1765 ms` with
`0 ms` CPU. It does **not** identify a latency cause.

## What each number can prove

| Observation | Supported conclusion | It cannot prove |
| --- | --- | --- |
| Client WebSocket out→in | One end-to-end elapsed time on the client clock. | Which server phase consumed it. |
| `stream.repro.append` in the Stream DO | The synchronous `#appendUntraced` body took no measurable trace time in that DO invocation. | Admission, cross-location transit, reply transport, or any work after the body returns. |
| `stream.repro.ingress_append` / ITX custom span | Elapsed time while the ingress callback awaited the Stream DO RPC. | A subtractable parent duration around the DO span. |
| Native `wallTimeMs` | The affected worker invocation's `IoContext` wall time. | A child-span duration, a queue duration, or a phase that nests exactly with another worker invocation. |
| `0 ms` CPU | No measurable CPU was charged in that measurement. | That the request was not waiting on I/O, scheduling, transport, or another invocation. |

The only safe numerical comparison in this sample is client out→in itself.
Do not subtract `0`, `221`, `1765`, or `2104` from one another to label a
pre-entry or output-gate interval. The Stream DO and ingress execute in
different invocations (and here, different colo labels); trace parenting is
causal propagation, not a common-clock, strict-duration nesting guarantee.

## Source basis

- The repro's DO span deliberately surrounds only the synchronous append body:
  `apps/os/src/domains/streams/stream-durable-object.ts:2416-2430`.
- The ingress span awaits its DO-stub RPC, so it includes the awaiting side of
  that call: `apps/os/src/rpc-targets.ts:709-728`.
- The ITX RPC span is one logical Cap'n Web RPC span:
  `apps/os/src/itx/itx-observability.ts:93-134`.
- Workerd ends an auto span immediately after a synchronous callback returns,
  and ends a promise-returning callback at promise settlement:
  `workerd@c4e03fa1d src/workerd/api/tracing.c++:248-305`.
- Workerd explicitly distinguishes the metric request lifetime from the trace
  lifetime: `MetricsCollector::Request` measures one `IoContext` wall time in
  its destructor, while a `Tracer` may live through subrequests:
  `workerd@c4e03fa1d src/workerd/io/trace.h:975-984`. Its outcome records the
  supplied CPU/wall values but reports after the `IoContext` task set finishes:
  `src/workerd/io/tracer.c++:416-437`.
- Tail-event timestamps are Unix time at Spectre-mitigated resolution, so a
  displayed `0 ms` is not an exact zero-duration proof:
  `workerd@c4e03fa1d src/workerd/io/trace.h:934-956`.

## Diagnostic implication

The trace establishes an end-to-end slow operation whose small synchronous DO
append body is not the explanation. It does not distinguish worker/DO
admission, inter-colo RPC transport, a response/output gate, or client-side
transport. The existing probe-id spans and client frame correlation can join
one request's evidence, but need an independently timed boundary on either
side before any one of those candidates can be attributed.

## Why a server span may exceed the client frame interval

There is a real clock-semantics caveat, but the public source does not prove it
caused the observed `2104 ms` versus `1780 ms` difference. A user span's open
time comes from `IoContext::now()` (`src/workerd/io/tracer.c++:624-627`), which
delegates to a `TimerChannel`; its contract permits a Spectre-mitigated clock
that is constant between ticks and clamped for timeouts
(`src/workerd/io/io-channels.h:63-81`, `io-context.c++:1001-1017`). Its close
time instead uses `systemPreciseCalendarClock().now()` directly
(`src/workerd/io/trace.c++:1838-1845`). Therefore a stale/coarsened open time
can inflate a displayed user-span duration; it is not a wall-clock stopwatch.

However, the OSS worker runtime resynchronizes the timer immediately before
each isolate re-entry (`io-context.c++:1333-1343`). Both normal JS-RPC target
calls and retained target callbacks enter through `ctx.run()`
(`api/worker-rpc.c++:1008-1030`; `io-context.h:1699-1727`), so this source
does not establish a hundreds-of-milliseconds stale start for this call. The
comments only explicitly document a frozen clock *between actor requests* and
the onset-specific resync (`io-context.h:142-149`). Cloudflare's production
`TimerChannel` and trace ingestion/display are not in this source tree.

Thus the mismatch is evidence that the existing client-frame and trace views
do not yet define the same complete boundary, or that their clock/reporting
semantics differ. It is not evidence for any particular server delay. The
minimal discriminating run is one probe ID and one fresh WebSocket session per
sample (with a unique trace ID), recording that socket's exact out/in frames.
It removes concurrent multiplexed calls and a long-lived session from the
comparison; it cannot turn the current server span into a trusted stopwatch.
