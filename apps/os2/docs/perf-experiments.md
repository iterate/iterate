# OS2 Stream Processor Performance Experiments

This is the running log for the OS2 Durable Object stream-processing performance
investigation. Keep raw numbers, commands, hypotheses, rejected explanations,
and next experiments here as they happen.

## Objective

We need the Durable Object based stream processing system to handle high-velocity
streams with many processors and publishers. Target direction:

- processors must never receive stream events out of order;
- processors must always reduce in stream offset order;
- `afterAppend` should run in sequence per `{ processor, stream }`;
- processor implementors may deliberately start background work and return from
  `afterAppend` quickly, but the runner should not concurrently call
  `afterAppend` for the same processor/stream;
- processor reduction for non-interesting events should be effectively instant;
- `afterAppend` that does no useful work should be effectively instant;
- processor runners should process all events and advance cursors, not hide cost
  by outright skipping non-consuming events;
- self-publish delivery lag should be approximately zero in normal cases;
- the system should have a credible path to `1000+` events/second streams.

## Source Reading

Initial Cloudflare/Kenton Varda reading:

- Kenton Varda, "Durable Objects: Easy, Fast, Correct - Choose three"
  <https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/>
  - Relevant point: Durable Objects use input/output gates to prevent race
    classes around storage while preserving performance.
- Kenton Varda, "We've added JavaScript-native RPC to Cloudflare Workers"
  <https://blog.cloudflare.com/javascript-native-rpc/>
  - Relevant point: Workers RPC is intended to make Worker-to-Worker and
    Worker-to-DO calls feel like function calls, but they are still remote
    invocations through the runtime.
- Kenton Varda, "Zero-latency SQLite storage in every Durable Object"
  <https://blog.cloudflare.com/sqlite-in-durable-objects/>
  - Relevant point: local SQLite in a DO should be very fast when hot/cached;
    multi-second lag is unlikely to be explained by pure local reducer state
    writes alone.
- Cloudflare docs, Durable Object rules/input-output gates
  <https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/>
  - Relevant point: input gates block new events while synchronous JS is
    running; awaits can allow interleaving, but storage operations have special
    gate behavior.
- Cloudflare docs, Workers RPC
  <https://developers.cloudflare.com/workers/runtime-apis/rpc/>
  - Relevant point: RPC is a first-class transport for DO methods, but each
    method call is still an event delivered to the target object.
- Cloudflare docs, Durable Object WebSockets
  <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
  - Relevant point: WebSockets are supported DO-to-DO; docs explicitly call out
    that batching `10-100` logical messages per frame reduces context switch
    overhead.
- Cloudflare docs, Durable Object alarms
  <https://developers.cloudflare.com/durable-objects/api/alarms/>
  - Relevant point: each DO has one alarm at a time; alarms are durable,
    at-least-once, and retrying. They are not a low-latency per-event fanout
    primitive.

## Code Paths Under Test

Current OS2 agent stream delivery:

- `StreamDurableObject.append()` commits an event locally.
- `StreamDurableObject.afterAppend()` publishes to live pull readers, runs
  built-in processors, and queues callable subscriber delivery.
- Callable subscribers are delivered later by `StreamDurableObject.alarm()`.
- The callable subscriber invokes `AgentDurableObject.afterAppend({ event })`
  through Workers RPC.
- `AgentDurableObject` hosts `agent-chat`, `agent`, and one LLM processor via
  `withStreamProcessor`.
- Processors append derived events back to the same stream. Those events must
  then be delivered back to the same `AgentDurableObject` before downstream
  processors observe them.

Important historical context:

- Subscription delivery was moved to originate from the Stream DO alarm handler
  to avoid maximum-subrequest / recursive call depth problems in chains like
  `stream.append -> processor.afterAppend -> stream.append ->
processor.afterAppend -> ...`.
- That may have traded a correctness/platform-limit issue for a
  latency/throughput issue.
- Any replacement must preserve the benefit: processor-generated append chains
  cannot synchronously recurse until Cloudflare subrequest limits or stack-like
  scheduling limits are hit.

Experimental WebSocket delivery path added during this investigation:

- `AgentDurableObject.fetch("/stream-subscription")` accepts a WebSocket.
- Stream websocket subscribers send `StreamSocketEventFrame` messages to the
  agent object.
- The WebSocket message handler calls the same processing function as RPC
  `afterAppend`.

Important current code change under evaluation:

- Removed the live guard that skipped processors when
  `!processor.contract.consumes.includes(event.type)`.
- Non-consuming events now still go through the normal runner path so cursors
  advance. `reduceProcessorRuntime()` returns `undefined`, no `afterAppend` is
  called, and the cursor is advanced.

## Local Benchmark Script

Added:

```sh
pnpm --dir apps/os2 benchmark:agent-stream -- \
  --count 150 \
  --rate 75 \
  --concurrency 15 \
  --traffic raw-openai-ws \
  --payload-bytes 128 \
  --subscription-transport rpc
```

File:

- `apps/os2/scripts/benchmark-agent-stream.ts`

Modes:

- `--traffic raw-openai-ws`: synthetic
  `openai-ws/websocket-message-received` events.
- `--traffic mixed-control`: mostly raw websocket events, with occasional
  `agent/system-prompt-updated` and `openai-ws/config-updated`.
- `--traffic agent-chat-responses`: synthetic
  `agent-chat/assistant-response-added`, which causes processor-emitted
  `agent/input-added` follow-up events.
- `--subscription-transport rpc`: default callable RPC delivery path.
- `--subscription-transport websocket`: configure a stream websocket subscriber
  to the Agent DO experimental endpoint.

Metrics currently reported:

- client-observed append latency;
- committed benchmark event count;
- committed `createdAt` gaps;
- time for processor cursors to reach terminal target offsets;
- `AgentDurableObject.getRuntimeState().lastAppendDeliveryDelays`, which tracks
  local append-to-self-delivery delay by offset when a processor appends an
  event and later receives that same event back.

Limitations:

- The current script is client-driven, so append latency includes public
  network and oRPC/OpenAPI overhead.
- The script can reveal self-delivery lag, but cannot isolate runtime transport
  from public append pressure.
- We need server-side benchmark endpoints to simulate an OpenAI WebSocket
  publisher from inside the Worker/DO environment.

## Results So Far

All preview runs below targeted `https://os2.iterate-preview-2.com`.

### 2026-05-07: baseline raw OpenAI websocket replay

Command:

```sh
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- \
pnpm --dir apps/os2 benchmark:agent-stream -- \
  --count 50 --rate 25 --concurrency 5 \
  --traffic raw-openai-ws --payload-bytes 128
```

Result:

- append latency: p50 `114ms`, p90 `280ms`, p99/max `1822ms`;
- committed event gaps: p50 `37ms`, p90 `95ms`, p99/max `671ms`;
- processor terminal wait: `272ms`;
- early local delivery samples: roughly `37-517ms`.

Interpretation:

- For mostly raw events and low rate, processor catch-up was not the terminal
  bottleneck.
- There was already append latency variance, likely outside pure reducer CPU.

### 2026-05-07: mixed-control replay

Command:

```sh
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- \
pnpm --dir apps/os2 benchmark:agent-stream -- \
  --count 150 --rate 75 --concurrency 15 \
  --traffic mixed-control --payload-bytes 128
```

Result:

- append latency: p50 `130ms`, p90 `265ms`, p99 `1314ms`, max `1398ms`;
- committed event gaps: p50 `7ms`, p90 `53ms`, p99 `193ms`, max `367ms`;
- processor terminal wait: `2724ms`.

Interpretation:

- Adding occasional real consumed events among raw noise increased processor
  settling time into seconds.
- Still not enough evidence that reducer CPU is the bottleneck.

### 2026-05-07: agent-chat response replay, RPC delivery

Command:

```sh
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- \
pnpm --dir apps/os2 benchmark:agent-stream -- \
  --count 80 --rate 40 --concurrency 10 \
  --traffic agent-chat-responses --payload-bytes 64
```

Result:

- append latency: p50 `157ms`, p90 `589ms`, p99/max `1344ms`;
- committed event gaps: p50 `5ms`, p90 `133ms`, p99/max `901ms`;
- processor terminal wait: `7015ms`;
- local self-delivery delay for processor-emitted events: mostly
  `~6.3-7.4s`.

Interpretation:

- This reproduced the shape of the original codemode delay.
- The lag appears around delivery of events appended by `agent-chat` back to
  the same `AgentDurableObject`.
- This points away from reducer CPU alone and toward subscription delivery
  architecture/backpressure.

### 2026-05-07: agent-chat response replay, low-rate RPC delivery

Command:

```sh
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- \
pnpm --dir apps/os2 benchmark:agent-stream -- \
  --count 40 --rate 5 --concurrency 2 \
  --traffic agent-chat-responses --payload-bytes 64
```

Result:

- append latency: p50 `188ms`, p90 `301ms`, p99/max `361ms`;
- processor terminal wait: `74ms`;
- local self-delivery delay: mostly `~29-40ms`.

Interpretation:

- The system is fine at low throughput.
- The multi-second lag appears once event fanout pressure builds.

### 2026-05-07: paired RPC vs WebSocket, agent-chat responses

RPC command:

```sh
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- \
pnpm --dir apps/os2 benchmark:agent-stream -- \
  --count 80 --rate 40 --concurrency 10 \
  --traffic agent-chat-responses --payload-bytes 64 \
  --subscription-transport rpc
```

RPC result:

- append latency: p50 `99ms`, p90 `929ms`, p99/max `1392ms`;
- processor terminal wait: `3977ms`;
- local self-delivery delay: mostly `~3.3-3.8s`.

WebSocket command:

```sh
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- \
pnpm --dir apps/os2 benchmark:agent-stream -- \
  --count 80 --rate 40 --concurrency 10 \
  --traffic agent-chat-responses --payload-bytes 64 \
  --subscription-transport websocket
```

WebSocket result:

- append latency: p50 `150ms`, p90 `451ms`, p99/max `1334ms`;
- processor terminal wait: `3406ms`;
- local self-delivery delay: roughly `66-1400ms`.

Interpretation:

- WebSocket delivery materially improved self-delivery lag compared with alarm
  backed callable RPC.
- It is still not close to zero.
- The remaining seconds in terminal wait likely include per-event downstream
  effects and/or sequential WebSocket message invocation overhead.

### 2026-05-07: paired RPC vs WebSocket, raw OpenAI websocket events

RPC command:

```sh
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- \
pnpm --dir apps/os2 benchmark:agent-stream -- \
  --count 150 --rate 75 --concurrency 15 \
  --traffic raw-openai-ws --payload-bytes 128 \
  --subscription-transport rpc
```

RPC result:

- append latency: p50 `106ms`, p90 `166ms`, p99 `1003ms`, max `1069ms`;
- processor terminal wait: `3408ms`;
- local self-delivery delay samples: `31-470ms` around derived setup events.

WebSocket command:

```sh
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- \
pnpm --dir apps/os2 benchmark:agent-stream -- \
  --count 150 --rate 75 --concurrency 15 \
  --traffic raw-openai-ws --payload-bytes 128 \
  --subscription-transport websocket
```

WebSocket result:

- append latency: p50 `164ms`, p90 `499ms`, p99 `1287ms`, max `1337ms`;
- processor terminal wait: `130ms`;
- local self-delivery delay samples: `15-263ms`.

Interpretation:

- For raw event storms, WebSocket delivery is dramatically better than alarm
  backed callable RPC for processor cursor catch-up.
- Because raw events do not trigger much derived-event fanout, this is a clearer
  transport comparison.

### 2026-05-07: paired RPC vs WebSocket, mixed-control events

RPC result at `150` events, `75/s`:

- append latency: p50 `102ms`, p90 `159ms`, p99 `1178ms`, max `1225ms`;
- processor terminal wait: `2770ms`;
- local self-delivery samples: `37-634ms`.

WebSocket result at `150` events, `75/s`:

- append latency: p50 `112ms`, p90 `147ms`, p99 `220ms`, max `1306ms`;
- processor terminal wait: `125ms`;
- local self-delivery samples: `17-449ms`.

Interpretation:

- WebSocket again removes most cursor-settling lag for mixed traffic.
- The remaining self-delivery samples still are not near-zero.

## Current Hypotheses

### H1: Alarm-backed callable subscriber delivery is the wrong hot path

Evidence:

- Callable subscriber delivery is queued and later processed by
  `StreamDurableObject.alarm()`.
- Cloudflare alarms are durable background wakeups, not low-latency fanout.
- RPC runs showed multi-second cursor settle under moderate event pressure.
- WebSocket delivery lowered cursor settle from seconds to around `125-130ms`
  for raw/mixed traffic.

Current confidence: high.

Counter-pressure:

- Alarm delivery was introduced to avoid recursive append/subscriber/append
  chains exceeding platform limits. A replacement cannot simply go back to
  unbounded synchronous fanout.

### H2: Same-DO self-delivery via stream subscription is architecturally suspect

Evidence:

- Processor appends an event to the stream DO.
- The stream DO then delivers the event back into the same Agent DO through a
  separate subscription callback.
- Under pressure, this creates an avoidable round-trip and runtime scheduling
  dependency for events that the producer already has in hand.

Current confidence: high.

Potential fix direction:

- For processor-emitted events, allow the processor host to synchronously feed
  the committed returned event back into the local processor pipeline after
  append, while still writing the raw event to the stream.
- Need ordering safeguards so local re-entry cannot observe offset `N+1` before
  offset `N`, and cannot duplicate side effects when the stream subscription
  later delivers the same event.

### H3: One event per WebSocket frame is still too expensive

Evidence:

- Cloudflare WebSocket docs explicitly recommend batching `10-100` logical
  messages per frame for high-frequency workloads.
- Experimental WebSocket transport improved results but did not make
  self-delivery approximately zero.

Current confidence: medium-high.

Potential fix direction:

- Add batch frames to stream websocket subscriber protocol:
  `{ type: "events", events: Event[] }`.
- Stream DO should batch fanout every small time window or count threshold.
- Agent DO should process a batch with one invocation and one ordered loop.

### H4: Per-event cursor persistence is probably too chatty for 1000+/s

Evidence:

- `withStreamProcessor` saves stored state after reduction and again after
  `afterAppend` for consumed events.
- Non-consuming events now still advance cursors, which is correct for the
  experiment but may create one KV/SQLite write per processor per event.
- Cloudflare SQLite can be very fast, but `events * processors * writes` will
  grow badly at 1000+/s.

Current confidence: medium.

Potential fix direction:

- Maintain in-memory cursor per processor during hot processing.
- Persist cursor periodically, at batch boundaries, or after side-effectful
  consumed events.
- Need crash/replay semantics: after restart, replay from last durable cursor;
  idempotency must make repeated non-side-effect reductions harmless.

### H5: Gap catch-up reads can amplify out-of-order delivery

Evidence:

- Current runner reads missing offsets if live event offset is greater than
  `reducedThroughOffset + 1`.
- This is a correctness repair for out-of-order callbacks, but under unordered
  high-throughput delivery it can add extra stream reads while callbacks are
  still in flight.
- Hard requirement: processors must never receive events out of order from the
  Stream DO, and must always reduce in order. Relying on catch-up repair as a
  normal path is not acceptable.

Current confidence: medium.

Potential fix direction:

- Ordered delivery contract from stream DO to processor host.
- Batch delivery with contiguous offset ranges.
- Pending-offset buffer in runner instead of immediate catch-up reads.

### H6: Ordered per-subscriber lanes are the missing primitive

Evidence:

- Current callable path has one durable queue, but drains only one offset per
  alarm, which is too slow.
- Current WebSocket path is faster, but individual messages can still force
  runner-side gap repair if they do not arrive as a contiguous ordered lane.
- The desired contract is not "deliver this event somehow"; it is "deliver a
  contiguous stream of offsets to this subscriber in order".

Current confidence: high.

Potential fix direction:

- Store per-subscriber delivery cursors rather than a global offset queue.
- Drain each subscriber from its cursor in bounded ordered batches.
- For WebSocket subscribers, send batch frames containing contiguous events.
- For callable subscribers, call a batch RPC method rather than one event per
  alarm tick.
- Keep the alarm/outbox only as a wake/retry mechanism, not as one work item per
  event.

### H7: Recursion avoidance needs an explicit async lane, not one alarm per event

Evidence:

- The alarm-based design avoided synchronous recursive subrequests.
- But an alarm-per-event queue introduces large scheduling latency.
- Server-side app-worker benchmark confirmed appends can be fast inside
  Cloudflare while subscriber delivery still lags by seconds.

Current confidence: medium-high.

Potential fix direction:

- Use alarms, but only as the async wake/keepalive mechanism:
  1. one ongoing continuous "send events to subscribers" process starts from an
     alarm;
  2. that process keeps draining until there are no more events to deliver to
     any subscriber;
  3. if more events arrive while draining, they are picked up by the same
     process or by a follow-up alarm;
  4. delivery state is per subscriber, not one global queue entry per event.
- This keeps the recursion/subrequest-limit protection without making every
  committed event wait for its own alarm tick.

Potential implementation model:

- `external-subscriber` state stores subscriber config plus a per-subscriber
  cursor/delivery status.
- `StreamDurableObject.afterAppend()` only marks "delivery work needed" and
  schedules an alarm if a drain is not already active/scheduled.
- `StreamDurableObject.alarm()` runs a bounded drain loop:
  - for each subscriber with `cursor < stream.eventCount`, read a contiguous
    range after its cursor;
  - deliver in order;
  - advance that subscriber cursor only after successful delivery;
  - continue until no subscriber has work or until a bounded time/event budget is
    reached;
  - if work remains, set another immediate alarm.
- Per-subscriber queues can be represented as cursors over the durable event log
  rather than copying offsets into a separate global array.

## Experiments In Progress

### E1: Server-side benchmark endpoint

Goal:

- Stop measuring public client/oRPC/network append overhead.
- Simulate OpenAI WebSocket event publisher from inside OS2 runtime.

Design:

- Add `project.agents.benchmarkStream` debug endpoint.
- Modes:
  - `publisher: "app-worker"` appends from the app Worker via stream capability.
  - `publisher: "agent-durable-object"` asks the Agent DO to append a burst and
    return immediately.
- Router then polls processor runtime state externally to avoid holding the
  Agent DO invocation open while waiting for deliveries.
- Report ordering violations explicitly:
  - append offset order;
  - committed benchmark event offset gaps;
  - processor cursor monotonicity;
  - whether runtime state required gap catch-up once instrumentation exists.

Risk:

- If the Agent DO publisher awaits delivery inside the same invocation, it can
  hold the input gate and manufacture the exact lag we are trying to measure.

### 2026-05-07: server-side app-worker publisher baseline

Endpoint:

- `project.agents.benchmarkStream`

App-worker publisher, RPC transport, `80` agent-chat response events at `40/s`:

- publish duration: `2025ms`;
- append latency inside Cloudflare: p50 `13ms`, p90 `14ms`, p99 `16ms`;
- committed event gaps: p50 `25ms`, p90 `26ms`, p99 `27ms`;
- processor wait: `4724ms`;
- self-delivery lag samples: `1592-4500ms`;
- stream subscribers:
  - Agent subscriber: callable RPC;
  - CodemodeSession subscriber: callable RPC.

App-worker publisher, WebSocket transport, same traffic:

- publish duration: `2023ms`;
- append latency inside Cloudflare: p50 `12ms`, p90 `14ms`, p99 `22ms`;
- committed event gaps: p50 `24ms`, p90 `26ms`, p99 `34ms`;
- processor wait: `2360ms`;
- self-delivery lag samples: `43-863ms`;
- stream subscribers:
  - Agent subscriber: WebSocket, replacing the Agent callable subscriber for
    the same slug;
  - CodemodeSession subscriber: still callable RPC.

Interpretation:

- The public client was not the reason for multi-second delivery lag.
- Stream appends are plausibly fast enough at this modest rate.
- Alarm-backed callable subscriber delivery remains the strongest bottleneck.
- WebSocket helps, but the remaining CodemodeSession callable subscriber and
  per-event delivery/processing still leave seconds of processor wait.
- This strengthens H7: alarms may still be the right async boundary, but not
  one alarm queue item per event.

### 2026-05-07: per-subscriber callable cursor drain

Change:

- Replaced the global callable alarm offset queue with per-subscriber delivery
  cursors.
- `StreamDurableObject.afterAppend()` now only schedules an alarm.
- `StreamDurableObject.alarm()` drains contiguous batches per callable
  subscriber.
- Each subscriber cursor advances only after its batch call returns delivered.
- This preserves ordered per-subscriber delivery and removes the old
  "dequeue before successful delivery" failure mode.

Direct comparison, `80` `agent-chat/assistant-response-added` events at `40/s`:

- Before cursor drain, after idempotency explainer fix:
  - app-worker append latency: p50 `14ms`, p90 `16ms`, p99 `77ms`
  - processor wait: `1398ms`
- After cursor drain:
  - project: `proj__os__01kr2ds5dme4er8e6c8jn00p3g`
  - benchmark: `agent-server-bench-1778198030637-41fccd3a`
  - app-worker append latency: p50 `9ms`, p90 `9ms`, p99 `18ms`
  - processor wait: `891ms`

Rate sweep after cursor drain:

- Raw OpenAI websocket-like traffic, `250` events at `250/s`:
  - project: `proj__os__01kr2dv7ske03rr6gvxcexqqrg`
  - processor wait: `141ms`
  - append latency: p50 `17ms`, p90 `18ms`, p99 `40ms`
  - self-delivery samples: `47-352ms`
- Mixed control traffic, `250` events at `250/s`:
  - project: `proj__os__01kr2dvhmze03rr6h1wpv7fzk0`
  - processor wait: `127ms`
  - append latency: p50 `12ms`, p90 `20ms`, p99 `92ms`
  - self-delivery samples: `0-245ms`
- Agent-chat response fanout, `160` events at `80/s`:
  - project: `proj__os__01kr2dvv2je03rr6h95e55rcp8`
  - processor wait: `5725ms`
  - append latency: p50 `13ms`, p90 `16ms`, p99 `20ms`
  - self-delivery samples: `88-1378ms`
- Repeated detailed fanout run:
  - project: `proj__os__01kr2dx38jeh5ba0nfgpsa947j`
  - benchmark: `agent-server-bench-1778198160870-909b3c25`
  - processor wait: `3697ms`
  - final stream offset: `346`
  - all Agent DO hosted processors caught up to offset `346`
  - tail self-delivery samples: `65-644ms`

Interpretation:

- Cursor drain is a real improvement for generic delivery. Raw/mixed streams now
  settle around `130-140ms` at `250/s`.
- The remaining bad case is processor-emitted fanout: `agent-chat` receives
  source events and appends one derived `agent/input-added` event per source
  event.
- The likely bottleneck is the Agent DO doing one cross-DO stream append per
  source event while `afterAppend` is intentionally sequential per
  `{ processor, stream }`.
- This is not solved by per-subscriber delivery alone. The next candidate is a
  batch append path for processor-emitted events, or a carefully ordered local
  feed-through queue that keeps raw event writes durable while avoiding one
  remote append round-trip per derived event.

### E2: Cloudflare traces

Goal:

- Use Cloudflare telemetry to inspect preview benchmark requests and quantify
  span chains for stream append, alarm delivery, RPC `afterAppend`, and
  WebSocket fetch/message delivery.

Current plan:

- Run one RPC benchmark and one WebSocket benchmark with unique benchmark IDs.
- Query preview slot 2 traces around those request windows.
- Look for:
  - stream append request spans;
  - alarm invocation spans;
  - Agent DO RPC/fetch/message spans;
  - repeated subrequest chains;
  - long idle gaps not visible in app-level timestamps.

### 2026-05-07: hidden idempotency duplicate attempts

User suspicion:

- We may be appending the same logical event many times with the same
  idempotency key, so the stream looks clean while the system is doing repeated
  hidden work.

Diagnostic change:

- Added bounded in-memory diagnostics to `StreamDurableObject` for
  idempotency-key conflicts. When an append hits an existing idempotency key, we
  record:
  - idempotency key;
  - requested event type;
  - target existing offset;
  - duplicate attempt count;
  - first/last duplicate timestamps.
- Exposed the diagnostics through the server-side benchmark response.

Preview run:

- Project: `proj__os__01kr2cys34eh5srtg308t15hpe`
- Agent stream: `/agents/idempotency-diag-1778197165460`
- Traffic: `80` `agent-chat/assistant-response-added` events at `40/s`
- Transport: callable RPC
- App-worker append latency: p50 `20ms`, p90 `21ms`, p99 `28ms`
- Processor wait: `1852ms`

Duplicate attempts observed:

- `agent-chat/event-type-explainer/events.iterate.com/agent-chat/assistant-response-added`
  - duplicate attempts: `80`
  - requested event type: `events.iterate.com/agent/input-added`
  - target offset: `26`
- `processor-registered:agent:0.1.0`
  - duplicate attempts: `6`
- `processor-registered:openai-ws:0.1.0`
  - duplicate attempts: `3`
- `events.iterate.com/codemode/session-started`
  - duplicate attempts: `3`
- `agent/event-type-explainer/events.iterate.com/codemode/tool-provider-registered`
  - duplicate attempts: `3`

Interpretation:

- The suspicion was correct. Idempotency was hiding a real repeated append
  pattern.
- The largest concrete bug was `agent-chat` trying to append the same
  event-type explanation once per assistant response. The stream stayed
  logically clean only because the idempotency key collapsed the repeats.
- Idempotency should be retry protection, not normal control flow for
  "append this once per stream" behavior.

Fix in progress:

- Add `explainedEventTypes` to the `agent-chat` and `agent` reduced state.
- Reducers mark an event type as explained when the source event is first
  reduced.
- `afterAppend` checks `previousState.explainedEventTypes` before appending the
  one-time explanation event.
- Added regression tests proving repeated source events do not append repeated
  explanation events.

After deploy:

- Project: `proj__os__01kr2ddtwpendv3dw6vw9jep6a`
- Benchmark: `agent-server-bench-1778197660705-46baa6f2`
- Same traffic: `80` `agent-chat/assistant-response-added` events at `40/s`
- App-worker append latency: p50 `14ms`, p90 `16ms`, p99 `77ms`
- Processor wait: `1398ms`
- The previous `80` duplicate attempts for
  `agent-chat/event-type-explainer/events.iterate.com/agent-chat/assistant-response-added`
  disappeared.

Remaining duplicate attempts in that run:

- `processor-registered:agent:0.1.0`: `6`
- `events.iterate.com/codemode/session-started`: `3`
- `processor-registered:openai-ws:0.1.0`: `2`
- `processor-registered:agent-chat:0.1.0`: `2`
- `processor-registered:codemode:0.4.0`: `1`
- `codemode-session-callable-subscription:...:afterAppendBatch`: `1`

Remaining duplicate classes to investigate:

- `processor-registered:*` duplicates likely come from first-attach/catch-up or
  runner lifecycle races around standard processor registration.
- `codemode/session-started` duplicates likely come from session-start
  initialization being retried across wake paths.
- These need separate state-backed guards after the explainer fix is deployed
  and remeasured.

Follow-up diagnostic hardening:

- In-memory top-N duplicate diagnostics are useful for spotting the hottest
  offender, but they are not enough to prove that every event is not being
  attempted repeatedly.
- Added a Stream DO SQLite aggregate table keyed by `idempotency_key` for
  duplicate append attempts. The stream now records:
  - total duplicate attempt count;
  - distinct duplicate idempotency-key count;
  - top duplicate keys with event type, target committed offset, and first/last
    duplicate timestamps.
- This gives the invariant we need for benchmarks:
  `attempted logical appends = committed idempotent events + duplicate attempts`.
- If every committed event were attempted ten times with the same idempotency
  key, a benchmark with `N` idempotent events should report roughly `9N`
  duplicate attempts. That should fail the run even though the event log itself
  looks clean.
- This remains separate from the append-only stream: duplicate attempts are not
  committed as stream events, because doing so would turn retry noise into real
  domain events and could recursively perturb the system under test.

### 2026-05-08: append failure instrumentation exposed stream pause

Change:

- The server-side benchmark publisher now catches individual append failures
  and returns them instead of letting a benchmark request collapse into a
  generic `500`.
- Both app-worker and Agent DO publishers return:
  - successful appended event count;
  - append failure count;
  - first failures with benchmark index and serialized error.

Preview run:

- Project: `proj__os__01kr2f2kbpf6db8qk2mf5tmhhk`
- Benchmark: `agent-server-bench-1778199387820-702ffc27`
- Agent stream: `/agents/diag-300-1778199387441`
- Traffic: `300` `agent-chat/assistant-response-added` events at `150/s`
- Publisher: app-worker
- Transport: callable RPC

Result:

- successful benchmark appends: `260`;
- append failures: `43`;
- first failed benchmark index: `260`;
- first failure: `StreamPausedError: stream is paused; only stream/resumed is allowed`;
- terminal events: `0`, because terminal appends also failed after pause;
- successful append latency: p50 `12ms`, p90 `23ms`, p99 `36ms`;
- self-delivery samples around the pause were still low:
  - offset `526`: `18ms`;
  - offsets `515-523`: `53ms`.

Interpretation:

- The earlier `300+` event app-worker `500` was not enough signal. The real
  symptom is that the stream circuit breaker paused the stream after sustained
  pressure.
- Self-delivery lag was not obviously exploding immediately before the pause,
  so the next question is why the circuit breaker tripped: subscriber delivery
  errors, processor-appended error events, or another built-in error threshold.
- Next benchmark responses should expose circuit-breaker state and stream tail
  events so we can correlate the pause with the exact preceding error events.

Follow-up:

- Queried the stream tail and confirmed the pause was exactly the built-in
  circuit breaker:
  - config: `burstCapacity: 500`, `refillRatePerMinute: 500`;
  - pause offset: `525`;
  - pause reason: `circuit breaker tripped: burst rate limit exceeded`.
- The benchmark stream was producing roughly two committed events per source
  event once `agent-chat` derived `agent/input-added`, so the default shared
  stream breaker was far below the target load for agent streams.
- Changed OS2 agent setup to append
  `events.iterate.com/core/circuit-breaker-configured` with:
  - `burstCapacity: 10000`;
  - `refillRatePerMinute: 120000`.
- This is intentionally scoped to agent streams rather than changing the
  package-wide shared stream default.

After deploy, same shape:

- Project: `proj__os__01kr2frc5bects2h8k8zwd0skj`
- Benchmark: `agent-server-bench-1778200101990-ca41cdb4`
- Traffic: `300` `agent-chat/assistant-response-added` events at `150/s`
- Result:
  - appends: `300`;
  - append failures: `0`;
  - processor wait: `34ms`;
  - tail self-delivery samples: `15-23ms`;
  - duplicate attempts: `15` across `5` startup/setup keys.

Interpretation:

- For this moderate high-fanout run, the previous failure was breaker config,
  not stream delivery.
- Idempotency diagnostics also proved there was no "every event appended ten
  times" pattern in this run.

### 2026-05-08: high-rate 1000/s fanout and retry-storm fix

First `1000` event run after raising the agent stream circuit breaker:

- Project: `proj__os__01kr2fsatwfewte8140c7theyh`
- Benchmark: `agent-server-bench-1778200132899-60551777`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Appends: `1000`
- Append failures: `0`
- Processor wait: `2831ms`
- Tail self-delivery samples: roughly `2355ms`
- Duplicate attempts: `7212` across `204` keys.

Worst duplicate class:

- `stream-do:external-subscriber-error:<offset>:codemode-session:...`
- Top keys had `36` duplicate attempts each.
- Stream tail showed repeated
  `Subrequest depth limit exceeded. This request recursed through Workers too
many times.`

Cause:

- The callable subscriber alarm drain used live `this.state.eventCount` while
  the Agent DO was appending derived events back to the same stream.
- That let one alarm invocation chase newly appended events in the same request
  chain: `Stream alarm -> Agent/Codemode subscriber -> Stream append -> same
Stream alarm continues`.
- When a batch failed fully, the same alarm invocation could retry the same
  cursor repeatedly and append the same idempotent external-subscriber error
  attempts over and over.

Fix:

- Snapshot `targetEventCount` at the start of each
  `drainCallableSubscriberDelivery()` turn.
- Deliver only offsets up to that snapshot during the current alarm invocation.
- If processors append new events while draining, schedule a follow-up alarm
  instead of chasing the tail in the same request chain.
- If a subscriber batch fully fails, schedule another alarm and yield
  immediately instead of retrying the same failed batch in the same invocation.

After deploy:

- Project: `proj__os__01kr2g0k7vfansg9xqp8776hk1`
- Benchmark: `agent-server-bench-1778200373024-cfa821b7`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Appends: `1000`
- Append failures: `0`
- Duplicate attempts: `13` across `4` startup/setup keys
- Processor wait: `2468ms`
- Tail self-delivery samples: roughly `1589ms`

Interpretation:

- The hidden idempotency retry storm is fixed for this case.
- The remaining `1000/s` lag is real delivery architecture cost, not duplicate
  append attempts.
- The likely next candidates are:
  - local ordered feed-through for processor-emitted events after durable append;
  - WebSocket batch frames for subscriber delivery;
  - larger alarm batch sizes with strict snapshot boundaries;
  - reducing per-batch/per-subscriber RPC and cursor persistence overhead.

### 2026-05-08: local ordered feed-through experiment

Goal:

- Remove the same-runner subscription round trip for events that a processor
  just appended itself.
- Keep every raw event written into the stream.
- Preserve the stream subscription as the canonical cross-runner delivery
  mechanism.
- Make later subscription delivery of locally-fed events a no-op by advancing
  each processor's durable cursor through the same normal reduction path.

Implementation:

- Added local feed-through in `withStreamProcessor`.
- `streamApiForProcessor().append()` and `.appendBatch()` still append to the
  Stream DO first and only enqueue the committed returned events.
- Feed-through is same-stream only: if a processor appends to another
  `streamPath`, the current Durable Object runner does not process it locally.
- Feed-through events are sorted by committed offset before local processing.
- Added a single in-memory delivery lane in the mixin so external subscription
  delivery and local feed-through cannot mutate the same processor/runtime state
  concurrently.
- Local feed-through drains after the currently delivered batch finishes. Nested
  processor appends enqueue more committed events and the active drain continues;
  it does not recursively call the public subscription entrypoint.

Ordering model:

- External subscription delivery enters the ordered lane.
- Processors reduce the delivered source batch in order.
- Processor `afterAppend` / `afterAppendBatch` may append derived events.
- Returned committed derived events are queued.
- The lane drains those returned events through the same processor consumption
  machinery.
- When the Stream DO later delivers the same derived events through the
  subscription, processors skip them because
  `afterAppendCompletedThroughOffset` has already advanced.

First deployed run, before adding the explicit delivery lane:

- Project: `proj__os__01kr2gb3zhesqt5pjyv4qp4tb6`
- Benchmark: `agent-server-bench-1778200716466-f79ef31e`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Appends: `1000`
- Append failures: `0`
- Duplicate attempts: `23` across `5` startup/setup keys
- Processor wait: `755ms`
- Tail self-delivery samples: `0ms`

After adding the ordered delivery lane:

- Project: `proj__os__01kr2ggffffzs8z2xfzvetkxy9`
- Benchmark: `agent-server-bench-1778200895339-f1a77aa9`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Appends: `1000`
- Append failures: `0`
- Duplicate attempts: `21` across `5` startup/setup keys
- Processor wait: `1136ms`
- Tail self-delivery samples: `0ms`
- Stream history check:
  - final event count: `2029`;
  - `events.iterate.com/core/error-occurred` count: `0`.

Raw source-event comparison after ordered feed-through:

- Project: `proj__os__01kr2gkc4ze059dytcppmfws3s`
- Benchmark: `agent-server-bench-1778200986895-4ec2c3a7`
- Traffic: `1000` `openai-ws/websocket-message-received` events at `1000/s`
- Appends: `1000`
- Append failures: `0`
- Duplicate attempts: `19` across `5` startup/setup keys
- Append latency: p50 `19ms`, p90 `45ms`, p99 `86ms`, max `96ms`
- Committed `createdAt` gaps: p50 `0ms`, p90 `1ms`, p99 `15ms`, max
  `42ms`
- Processor wait: `222ms`
- Runtime entries reached offset `1027`
- Tail self-delivery samples for processor-emitted terminal/setup events:
  `0ms`

Interpretation:

- Local feed-through achieved the main target for processor-emitted events:
  measured self-delivery is now effectively `0ms` instead of `~1.6-2.3s`.
- Raw source-event delivery at `1000/s` now settles in hundreds of milliseconds,
  not seconds.
- The ordered lane costs some total settle time compared with the first
  un-serialized feed-through experiment, but it removes the race where
  concurrent subscription RPCs and local feed-through could mutate the same
  processor cursors in parallel.
- Remaining wait at `1000/s` is no longer self-delivery of processor-emitted
  events. It is likely now dominated by:
  - app-worker publisher append latency;
  - Stream DO alarm delivery of external source events;
  - CodemodeSession subscriber delivery;
  - per-batch cursor/state persistence.
- Next experiments should compare:
  - `1000/s` raw traffic vs agent-chat fanout after feed-through;
  - app-worker publisher vs Agent DO publisher after feed-through;
  - callable RPC delivery vs WebSocket batch delivery now that local derived
    event feed-through removes the largest same-runner round trip.

### 2026-05-08: cursor persistence and alarm delivery experiments

Reusable command added:

```sh
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- \
pnpm --dir apps/os2 benchmark:agent-stream:server -- \
  --traffic agent-chat-responses \
  --count 1000 \
  --rate 1000 \
  --concurrency 100
```

Processor batch cursor persistence change:

- Before this change, `withStreamProcessor.consumeBatchForProcessor()` called
  `saveStoredState()` inside `reduceOneEvent()` for every event, then saved
  again after `afterAppend`/`afterAppendBatch` completed.
- For a `1000` event source batch and three processors, that creates thousands
  of local storage writes even if most events just advance cursors.
- Changed batch consumption so reduction updates in-memory stored state for each
  event, saves once after reduction, and saves once after afterAppend completes.
- Single-event consumption keeps the old per-event persistence behavior.

Preview result after batch cursor persistence, with callable batch size still
`100`:

- Project: `proj__os__01kr2h22xhfvn9jrmhta2gzayb`
- Benchmark: `agent-server-bench-1778201468618-4592aa90`
- Traffic: `1000` `agent-chat/assistant-response-added` at `1000/s`
- Appends: `1000`
- Append failures: `0`
- Duplicate attempts: `15` across `5` startup/setup keys
- Append latency: p50 `27ms`, p90 `98ms`, p99 `142ms`
- Processor wait: `721ms`
- Tail self-delivery samples: `0ms`

Raw comparison after the same change:

- Project: `proj__os__01kr2h2yv8fvha4563dggh9fyz`
- Benchmark: `agent-server-bench-1778201496728-453ca55c`
- Traffic: `1000` `openai-ws/websocket-message-received` at `1000/s`
- Appends: `1000`
- Append failures: `0`
- Duplicate attempts: `12` across `4` startup/setup keys
- Append latency: p50 `26ms`, p90 `85ms`, p99 `113ms`
- Processor wait: `245ms`
- Tail self-delivery samples for terminal derived events: `0ms`

Interpretation:

- The persistence change is a real win for fanout: agent-chat improved from
  `1136ms` to `721ms`.
- Raw traffic stayed in the same rough range (`222ms` before, `245ms` after),
  so the change mainly removes fanout write amplification rather than source
  delivery cost.

Rejected experiment: immediate in-memory callable subscriber pump.

- Implementation tried:
  - keep the durable alarm fallback;
  - coalesce alarm writes;
  - start a guarded in-memory drain from `afterAppend`;
  - do not recursively start another pump when processor-generated appends come
    back through the same Stream DO.
- Agent-chat result:
  - project: `proj__os__01kr2h9wr8fesvv76xy59xvn7z`
  - benchmark: `agent-server-bench-1778201725316-774edbc2`
  - processor wait: `396ms`
  - append latency: p50 `118ms`, p90 `259ms`, p99 `280ms`
- Raw result:
  - project: `proj__os__01kr2has3recw84c19e8h5mp6p`
  - benchmark: `agent-server-bench-1778201753801-991a698b`
  - processor wait: `751ms`
  - append latency: p50 `43ms`, p90 `118ms`, p99 `123ms`
- Rejected because it improves fanout terminal settling while badly hurting raw
  delivery and append contention. The Stream DO should not run a live subscriber
  pump that competes with a high-rate publisher in the same object.

Rejected experiment: callable subscriber alarm batch size `500`.

- Implementation tried:
  - no immediate pump;
  - keep alarm write coalescing;
  - change `CALLABLE_SUBSCRIBER_ALARM_BATCH_SIZE` from `100` to `500`.
- Raw result:
  - project: `proj__os__01kr2hg031fetrdvjneaanqm8s`
  - benchmark: `agent-server-bench-1778201924150-ea0d037c`
  - processor wait: `317ms`
  - append latency: p50 `15ms`, p90 `65ms`, p99 `115ms`
- Agent-chat result:
  - project: `proj__os__01kr2hgtkre01sr2rq88dcjdpt`
  - benchmark: `agent-server-bench-1778201951182-ed3a021b`
  - processor wait: `682ms`
  - append latency: p50 `117ms`, p90 `201ms`, p99 `244ms`
- Rejected for now because the fanout win over batch size `100` is small
  (`721ms -> 682ms`) and raw delivery worsened (`245ms -> 317ms`).

Rejected experiment: alarm write coalescing.

- Implementation tried:
  - keep callable subscriber batch size at `100`;
  - only call `ctx.storage.setAlarm(Date.now())` once while an alarm is already
    known to be scheduled.
- Raw confirmation after reverting batch size but keeping alarm coalescing:
  - project: `proj__os__01kr2hsxx8e8jtd7cb7h43tg82`
  - benchmark: `agent-server-bench-1778202249886-ead216b2`
  - processor wait: `441ms`
  - append latency: p50 `15ms`, p90 `56ms`, p99 `106ms`
- A prior raw run in the same deployed state was worse:
  - project: `proj__os__01kr2hs5amecybmv3tz3b7we02`
  - benchmark: `agent-server-bench-1778202224608-cefb7ba2`
  - processor wait: `854ms`
  - append latency: p50 `125ms`, p90 `155ms`, p99 `157ms`
- Rejected because the proven batch-persistence-only raw run was `245ms`, and
  repeated immediate `setAlarm(Date.now())` may be helping Cloudflare's alarm
  scheduler notice hot streams faster than an application-level coalescing flag.

Current candidate kept:

- Batch cursor persistence in `withStreamProcessor`.
- Callable subscriber alarm batch size remains `100`.
- Final preview confirmation after reverting rejected alarm experiments:
  - project: `proj__os__01kr2hz2ajeh4a983g7n62h9sa`
  - benchmark: `agent-server-bench-1778202417965-6d8c81ec`
  - traffic: `1000` `agent-chat/assistant-response-added` at `1000/s`
  - processor wait: `834ms`
  - append latency: p50 `101ms`, p90 `147ms`, p99 `211ms`
  - self-delivery samples: `0ms`
  - interpretation: preview results have meaningful run-to-run variance; the
    stable finding is not the exact wait number, but that local self-delivery is
    gone and batch cursor persistence was the only non-regressing improvement in
    this pass.
- Next experiment should isolate CodemodeSession subscriber cost and shared
  history reads per subscriber, because every agent stream currently has both
  Agent and CodemodeSession callable subscribers.

### E3: Batching WebSocket stream event frames

Goal:

- Test Cloudflare docs' batching advice directly.

Design:

- Add stream websocket batch frame support:
  `{ type: "events", events: Event[] }`.
- Add a stream-side subscriber delivery mode that batches every `N` events or
  every `T` ms.
- Ensure batches are contiguous and ordered per subscriber.
- Compare:
  - RPC one event per alarm delivery;
  - WebSocket one event per frame;
  - WebSocket batches of `10`, `50`, `100`.

### E4: Local processor immediate feed-through

Goal:

- Test whether same-runner processor-emitted events should bypass subscription
  delivery delay entirely while still being committed to the stream.

Design:

- In `streamApiForProcessor().append`, after committed event is returned, enqueue
  it into the local host's ordered processor work queue.
- Still let the stream subscription deliver it later; duplicate delivery should
  become a no-op because cursors already advanced.

Risk:

- Needs a strict ordered queue; naive recursive calls can reintroduce
  out-of-order processing.
- Needs an explicit async boundary or bounded queue so we do not reintroduce the
  original maximum-subrequest recursion problem.

### 2026-05-08: processor batch append experiment

Finding before the change:

- After per-subscriber cursor drain, generic stream delivery was acceptable for
  moderate rates, but `agent-chat` fanout remained bad.
- `160` `agent-chat/assistant-response-added` events at `80/s` produced one
  derived `agent/input-added` per source event.
- Because `afterAppend` runs sequentially per processor/stream, `agent-chat`
  paid one cross-DO `StreamDurableObject.append()` call per source event.
- That explained the multi-second settle time better than generic subscriber
  lag did.

Change:

- Added optional `ProcessorStreamApi.appendBatch`.
- Added `StreamDurableObject.appendBatch`.
- Added `ProcessorImplementation.afterAppendBatch`.
- `AgentDurableObject.afterAppendBatch` now reduces a delivered event batch
  through `withStreamProcessor` in one call.
- `agent-chat` implements `afterAppendBatch` and emits all derived
  `agent/input-added` rows through `streamApi.appendBatch`.
- Single-event `afterAppend` still falls back to ordered single appends.

Result, same fanout shape that previously took seconds:

- Project: `proj__os__01kr2ehjacf2295t7a1f84c919`
- Benchmark: `agent-server-bench-1778198829765-b9ee3ebd`
- Traffic: `160` `agent-chat/assistant-response-added` events at `80/s`
- App-worker append latency: p50 `11ms`, p90 `13ms`, p99 `19ms`
- Processor wait: `119ms`
- Tail self-delivery samples: `11-20ms`
- Final stream offset: `346`
- All Agent DO hosted processors caught up to offset `346`

Follow-up scale checks:

- `200` `agent-chat/assistant-response-added` at `100/s`, app-worker
  publisher:
  - project: `proj__os__01kr2eq3fyfk3tnwmvqg8wdh4d`
  - benchmark: `agent-server-bench-1778199011529-e5b007f3`
  - processor wait: `129ms`
  - self-delivery samples: `30-33ms`
- `300+` events through the app-worker benchmark publisher started returning
  generic `500`s. Current interpretation: this is likely the benchmark harness
  doing hundreds of subrequests from one app-worker HTTP request, not the stream
  processor hot path.
- Switching to `publisher: "agent-durable-object"` for a `500` event request
  did not 500:
  - project: `proj__os__01kr2er38ge4cb9zpx9m0d4ar9`
  - benchmark: `agent-server-bench-1778199045034-ddfd1255`
  - publish duration: `2316ms`
  - reported appended count: `236` of requested `500`, which means the
    benchmark publisher itself still needs investigation before using it as a
    high-throughput source of truth.
  - processor wait: `527ms`
  - self-delivery samples: `13-115ms`

Cloudflare trace/log check:

- Queried account `cc7f6f461fbe823c199da2b27f9e0ff3` for `os2-preview-2`
  around `2026-05-08T00:07:00Z` to `2026-05-08T00:10:00Z`.
- Telemetry keys included `$metadata.error`, `$metadata.level`,
  `$metadata.traceId`, and `$metadata.transactionName`.
- Filtering `$metadata.service = os2-preview-2` and
  `$metadata.level = error` returned no rows despite the client seeing generic
  oRPC `500`s.
- Next trace step: capture the failing request's `cf-ray`/trace id or add
  explicit error logging around `project.agents.benchmarkStream`, because the
  current generic 500 is not visible as an error-level Workers event.

Interpretation:

- Batch append is the highest-impact change so far.
- For realistic agent-chat fanout at `80-100/s`, self-delivery is now near the
  target rather than multi-second.
- The remaining high-rate work is now mostly benchmark harness correctness and
  larger-scale publisher design, not the already-fixed one-append-per-derived
  event bottleneck.

## Immediate Next Steps

1. Finish `project.agents.benchmarkStream`.
2. Deploy it to preview slot 2.
3. Run server-side paired benchmarks:
   - app-worker publisher vs agent-DO publisher;
   - RPC vs WebSocket;
   - raw, mixed, agent-chat response traffic;
   - rates: `50/s`, `250/s`, `1000/s`.
4. Query Cloudflare traces for the worst and best runs.
5. Implement batch WebSocket delivery if traces confirm per-message invocation
   overhead.
6. Implement local feed-through if self-published events remain non-zero after
   batching.

### 2026-05-08: shared callable-subscriber history windows

Hypothesis:

- Every agent stream currently has both the Agent subscriber and the
  CodemodeSession subscriber.
- In the Stream DO alarm drain, each callable subscriber independently read
  `history({ after: cursor, before })`.
- Those subscribers are usually at the same cursor, so the Stream DO was doing
  duplicate SQLite reads and event JSON parsing for the same event window.

Change:

- In `StreamDurableObject.drainCallableSubscriberDelivery`, read all callable
  subscriber cursors first.
- Cache each history window by `{cursor, before}` for one drain batch.
- Reuse the same immutable event array for subscribers aligned on that window.
- Keep per-subscriber delivery, failure handling, and cursor writes independent.
- Ordering semantics are unchanged: each subscriber still receives a contiguous
  ordered window, and the cursor only advances after that subscriber's publish
  attempt succeeds enough to avoid a full-batch yield.

Validation:

- `pnpm exec vitest run src/streams/*.test.ts src/durable-object-utils/mixins/with-stream-processor-runner.unit.test.ts src/stream-processors/stream-processor.test.ts`
  from `packages/shared`: passed.
- `pnpm --filter @iterate-com/shared typecheck`: passed.
- Deployed to preview slot 2 with `doppler run --project os2 --config preview_2 -- pnpm tsx ./alchemy.run.ts`.

Preview benchmarks, RPC subscription:

- Agent-chat response traffic:
  - project: `proj__os__01kr2jb64yfvmvcg331dc6p0cx`
  - benchmark: `agent-server-bench-1778202814459-da7ffbb1`
  - traffic: `1000` `agent-chat/assistant-response-added` at `1000/s`
  - append failures: `0`
  - duplicate attempts: `13` across `5` startup/setup keys
  - append latency: p50 `53ms`, p90 `101ms`, p99 `155ms`
  - processor wait: `574ms`
  - self-delivery tail samples: `0ms`
- Raw OpenAI websocket-shaped traffic, first sample:
  - project: `proj__os__01kr2jbqbpf6fv2nwgm6e35mr9`
  - benchmark: `agent-server-bench-1778202832894-7c83b634`
  - traffic: `1000` raw events at `1000/s`
  - append failures: `0`
  - duplicate attempts: `13` across `4` startup/setup keys
  - append latency: p50 `20ms`, p90 `77ms`, p99 `119ms`
  - processor wait: `1510ms`
- Raw OpenAI websocket-shaped traffic, repeat sample:
  - project: `proj__os__01kr2jcbmxenfvamq4dkwj7v65`
  - benchmark: `agent-server-bench-1778202853939-2272e562`
  - traffic: `1000` raw events at `1000/s`
  - append failures: `0`
  - duplicate attempts: `12` across `4` startup/setup keys
  - append latency: p50 `116ms`, p90 `152ms`, p99 `168ms`
  - processor wait: `323ms`

Interpretation:

- Agent-chat improved from the prior conservative baseline of `834ms` wait to
  `574ms`, with self-delivery still `0ms`.
- Raw traffic remained noisy. One run was bad and one was good. The change is
  likely neutral-to-positive, not a proven raw regression.
- The remaining duplicate attempts are still startup/setup races
  (`processor-registered:*`, `codemode/session-started`, codemode subscription),
  not per-traffic-event duplicate storms.

WebSocket transport comparison:

- Agent-chat response traffic with Agent subscriber over websocket:
  - project: `proj__os__01kr2jcyqnecr8s6ef0fhvxq4y`
  - benchmark: `agent-server-bench-1778202873102-733e00dc`
  - append latency: p50 `77ms`, p90 `111ms`, p99 `148ms`
  - processor wait: `711ms`
- Raw traffic with Agent subscriber over websocket:
  - project: `proj__os__01kr2jdvtje4bsqj6w7msp3r59`
  - benchmark: `agent-server-bench-1778202905330-26b5cb56`
  - append latency: p50 `20ms`, p90 `69ms`, p99 `103ms`
  - processor wait: `1706ms`
- Current result: the existing websocket subscription path is not better for
  this benchmark shape. It is also not a clean apples-to-apples transport test
  because CodemodeSession still remains a callable RPC subscriber on the same
  stream.

Cloudflare trace sample:

- Queried Cloudflare Workers telemetry in account
  `cc7f6f461fbe823c199da2b27f9e0ff3` for `os2-preview-2` around
  `2026-05-08T01:13:00Z` to `2026-05-08T01:16:00Z`.
- RPC agent-chat benchmark trace:
  - trace id: `9a56f33987cf6944fb0575b064e18ac9`
  - request:
    `POST https://os2.iterate-preview-2.com/api/projects/proj__os__01kr2jb64yfvmvcg331dc6p0cx/agents/benchmark-stream/%2Fagents%2Fserver-bench-1778202809609`
  - trace duration: `6074ms`
  - spans: `9811`
  - sampled first `1000` spans: `676` SQL exec spans, `224` alarm writes,
    `40` KV gets, `20` DO subrequests, `18` KV puts, `14` JS RPC spans,
    `5` KV lists.
  - The sampled SQL was dominated by append/idempotency/reduced-state writes;
    only `5` sampled history reads appeared, consistent with the shared-window
    cache.
- Websocket agent-chat benchmark trace:
  - trace id: `46c86d6baaba772b29616594b6760833`
  - trace duration: `15286ms`
  - spans: `7996`
  - sampled first `1000` spans: `849` KV gets, `141` KV lists, `7` DO
    subrequests, `2` SQL exec spans, `1` JS RPC span.
  - This points at the existing websocket runner/subscription path doing a lot
    of Durable Object storage work, not obviously reducing overhead.

Cloudflare docs and Kenton notes read for this pass:

- Durable Object rules:
  <https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/>
- Workers RPC:
  <https://developers.cloudflare.com/workers/runtime-apis/rpc/>
- Zero-latency SQLite storage in Durable Objects:
  <https://blog.cloudflare.com/sqlite-in-durable-objects/>
- Durable Objects: Easy, Fast, Correct - Choose three:
  <https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/>

Next experiments:

- Isolate CodemodeSession subscriber cost with a benchmark path that can run
  Agent-only, Codemode-only, and Agent+Codemode subscriptions against identical
  traffic.
- Reduce startup/setup duplicate attempts with explicit state-backed guards for
  processor registration and codemode session start.
- Add a Stream DO delivery trace/debug endpoint that returns per-drain counts:
  subscriber count, unique history windows, cursor reads/writes, delivered event
  count, and drain duration.
- Do not pursue the current websocket subscription path as a primary fix until
  it has batched frames and lower storage churn.

### 2026-05-08: corrected subscriber delivery wait

Benchmark flaw found:

- The previous `processorWait` measurement polled `AgentDurableObject.getRuntimeState()`.
- `getRuntimeState()` can wake the Agent DO and run processor catch-up from stream
  history.
- That means the benchmark could accidentally measure "Agent caught itself up
  by reading history" instead of "Stream DO delivered subscription events
  promptly."

Change:

- `StreamDurableObject.getDiagnostics()` now exposes durable callable
  subscriber cursors, keyed by subscriber slug.
- The server-side benchmark now waits for callable subscriber cursors before
  polling processor runtime state.
- It reports:
  - `sourceSubscriberWait`: time for subscribers to receive all source traffic
    appends;
  - `processorWait`: time for processor cursors to reach their expected source
    offsets after subscriber delivery;
  - `finalSubscriberWait`: time for subscribers to receive final derived events
    appended by processors.
- `getDiagnostics()` also returns an in-memory ring of recent callable delivery
  drains with batch count, history read count, cursor reads/writes, delivered
  events, duration, reschedule/yield flags, and errors.

Corrected preview run:

- Project: `proj__os__01kr2kcbshfk6tq0xq5fdvfg0f`
- Benchmark: `agent-server-bench-1778203902264-0b5ae775`
- Traffic: `300` `agent-chat/assistant-response-added` events at `300/s`
- Publisher: app-worker
- Transport: callable RPC
- Append failures: `0`
- Append latency: p50 `21ms`, p90 `83ms`, p99 `169ms`
- `sourceSubscriberWait`: `1037ms`
- `processorWait`: `10ms`
- `finalSubscriberWait`: `10ms`
- Final stream offset: `627`
- Final callable subscriber cursors: both `627`

Main delivery drain sample:

- `batchIterations`: `6`
- `historyReadCount`: `6`
- `uniqueHistoryWindowCount`: `6`
- `cursorReadCount`: `12`
- `cursorWriteCount`: `12`
- `deliveredEventCount`: `1200`
- `targetEventCount`: `627`
- `durationMs`: `922`

Interpretation:

- The current main tail is Stream DO subscription delivery, not reducer compute
  after delivery.
- Once source events reach the Agent/Codemode subscribers, the processors are
  already close to caught up and final derived-event delivery can be nearly
  immediate.
- The in-memory delivery drain ring is useful for a hot object, but it can reset
  on a new DO instance. Durable callable subscriber cursors are the trustworthy
  completion signal.

Corrected high-rate source wait run:

- Project: `proj__os__01kr2k79vrf22bn9terjmsmj39`
- Benchmark: `agent-server-bench-1778203736304-a2b8e2b5`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Append failures: `0`
- Append latency: p50 `101ms`, p90 `143ms`, p99 `232ms`
- Source subscriber wait: `2247ms`
- Processor wait after source delivery: `8ms`
- Final stream offset: `2027`

Interpretation:

- At `1000/s`, source subscriber delivery is still multiple seconds behind the
  append workload.
- The corrected benchmark also shows why earlier green-looking processor waits
  were incomplete: they did not prove that Stream DO subscriber delivery itself
  was prompt.

### 2026-05-08: idempotency duplicate attempts as a benchmark invariant

Suspicion:

- The stream can look logically clean even if the system tries to append every
  idempotent event many times, because duplicate attempts return the existing
  committed event.

How we detect it:

- `StreamDurableObject.append()` records a duplicate attempt at the idempotency
  check boundary, before returning the existing event.
- The duplicate-attempt aggregate is durable SQLite state, keyed by
  `idempotency_key`.
- Benchmark responses expose:
  - total duplicate append attempts;
  - distinct duplicate key count;
  - top duplicate keys with attempted event type, target committed offset, and
    first/last duplicate timestamps.

Invariant:

- For a benchmark with `N` unique idempotent events, a bug that attempts each
  event ten times should produce roughly `9N` duplicate attempts even though the
  committed event log contains only `N` events.
- A clean stream is therefore not enough. We should treat unexpected duplicate
  attempts as failures, or at least as a separate red metric, because idempotency
  is retry protection rather than normal control flow.

Current known duplicate classes:

- Fixed: per-event `agent-chat` explainer duplicates.
- Still present in small counts: startup/setup races such as
  `processor-registered:*`, `codemode/session-started`, and codemode callable
  subscription setup.

Next check:

- Done: add expected-duplicate thresholds to benchmark scripts so traffic tests
  fail when duplicate attempts exceed a small allowlist of known startup/setup
  keys.
- The benchmark CLI now reports:
  - committed idempotent event count;
  - duplicate append attempts observed before the idempotency return path;
  - logical idempotent append attempts
    (`committed idempotent events + duplicate attempts`);
  - duplicate-attempt ratio;
  - unexpected duplicate keys outside the setup allowlist.
- Default invariant:
  - total duplicate attempts must be <= `25`;
  - unexpected duplicate attempts must be `0`.
- The defaults intentionally allow known startup/setup cleanup work to continue
  while making a hidden per-traffic-event duplicate storm fail the benchmark
  immediately.

Fresh check from the `2026-05-08` Agent DO timing run:

- Project: `proj__os__01kr2may2hf26vhtc4dkywd5xs`
- Benchmark: `agent-server-bench-1778205490536-8b301e8e`
- Traffic: `300` `agent-chat/assistant-response-added` events at `300/s`
- Duplicate attempts: `39` across `9` keys
- Top duplicate keys:
  - `7` duplicate attempts:
    `codemode-session-callable-subscription:{...}:afterAppendBatch`
  - `6` duplicate attempts:
    `events.iterate.com/codemode/session-started`
  - `6` duplicate attempts:
    `processor-registered:agent:0.1.0`
  - `5` duplicate attempts:
    `processor-registered:codemode:0.4.0`
  - `3` duplicate attempts each for the default codemode tool providers and
    Agent callable subscription setup

Interpretation:

- The user's suspicion is confirmed for setup traffic: idempotency is hiding
  repeated append attempts.
- These are not the high-volume benchmark source events themselves, but they are
  still real work and a real signal that wake/setup paths are not cleanly
  one-shot.
- A benchmark can only prove "the stream contains one committed event per key."
  It cannot prove "callers only attempted one append per key" unless we inspect
  pre-idempotency diagnostics.
- The Stream DO diagnostic table is the right source of truth because it is
  recorded before the duplicate event is returned from `append()`.

### 2026-05-08: subscriber-mode isolation

Question:

- Is the slow source subscriber delivery caused by the Stream DO fanout loop,
  Agent subscriber work, Codemode subscriber work, or the interaction between
  Agent and Codemode on the same stream?

Change:

- Added `subscriberMode` to `project.agents.benchmarkStream` and
  `apps/os2/scripts/benchmark-agent-stream-server.ts`.
- Modes:
  - `both`: normal Agent + Codemode callable subscribers;
  - `agent-only`: keep the Agent subscriber active and overwrite the Codemode
    subscriber with `jsonataFilter: "false"`;
  - `codemode-only`: keep the Codemode subscriber active and overwrite the Agent
    subscriber with `jsonataFilter: "false"`.
- This is a benchmark-only isolation tool. It does not add unsubscribe
  semantics. The disabled side still has a cursor lane and filter evaluation,
  but no RPC work.

Validation:

- `pnpm --dir apps/os2 typecheck`: passed.
- `pnpm --filter @iterate-com/os2-contract typecheck`: passed.
- Deployed to preview slot 2.

Preview runs, `300` `agent-chat/assistant-response-added` events at `300/s`,
RPC transport, app-worker publisher:

- `both`
  - project: `proj__os__01kr2kwg80ecxse1ym9kzsyyp5`
  - benchmark: `agent-server-bench-1778204431393-ae08bb89`
  - append failures: `0`
  - append latency: p50 `17ms`, p90 `39ms`, p99 `69ms`
  - duplicate attempts: `15` across `5` setup keys
  - source subscriber wait: `965ms`
  - final subscriber wait: `11ms`
  - processor wait: `11ms`
  - final stream offset: `627`
  - main delivery drain: `6` batches, `12` cursor reads, `12` cursor writes,
    `6` history reads, `1192` delivered events, `906ms`
- `agent-only`
  - project: `proj__os__01kr2kx4yjesmbxwphbh9hafdx`
  - benchmark: `agent-server-bench-1778204452780-cb7d2f7e`
  - append failures: `0`
  - append latency: p50 `17ms`, p90 `38ms`, p99 `80ms`
  - duplicate attempts: `14` across `5` setup keys
  - source subscriber wait: `295ms`
  - final subscriber wait: `8ms`
  - processor wait: `14ms`
  - final stream offset: `628`
  - main delivery drain: `6` batches, `12` cursor reads, `12` cursor writes,
    `6` history reads, `593` delivered events, `92ms`
- `codemode-only`
  - project: `proj__os__01kr2m2xvmexr8bc8dpzp4zq0v`
  - benchmark: `agent-server-bench-1778204641454-3b5c0b27`
  - append failures: `0`
  - append latency: p50 `9ms`, p90 `17ms`, p99 `61ms`
  - duplicate attempts: `13` across `4` setup keys
  - source subscriber wait: `107ms`
  - final subscriber wait: `1ms`
  - processor wait: skipped because the Agent subscriber is disabled
  - final stream offset: `326`
  - largest delivery drain: `3` batches, `6` cursor reads, `6` cursor writes,
    `3` history reads, `202` delivered events, `161ms`

Interpretation:

- Codemode by itself is not the source of the second-scale lag for this traffic.
- Agent by itself is much faster than Agent+Codemode even though it produces a
  similar final stream offset.
- The expensive shape is the interaction: active Agent subscriber processes
  source events and appends derived events, while active Codemode also receives
  the source and derived stream traffic in the same catch-up/drain cycle.
- The `both` run delivered roughly twice as many events as `agent-only`, but its
  main drain duration was almost ten times larger (`906ms` vs `92ms`). That
  suggests per-event Codemode processing of Agent-derived traffic, or
  cross-subscriber interference while one subscriber appends derived events, not
  just raw history read/cursor overhead.

Benchmark issue found and fixed:

- The first `codemode-only` run spent `30s` waiting for Agent processor cursors,
  even though the Agent subscriber was deliberately disabled.
- The benchmark now skips Agent processor cursor wait in `codemode-only` mode.

Next experiments:

- Add per-subscriber drain diagnostics so one delivery drain reports duration,
  delivered count, failed count, and RPC time by subscriber slug.
- Add event-type filter subscriptions for processors so Codemode does not pay
  for Agent/OpenAI events it does not consume.
- Re-run the same three-mode comparison at `1000/s` after per-subscriber timing
  is available.

### 2026-05-08: per-subscriber drain timing

Change:

- Added per-subscriber attempt timings inside each
  `StreamDurableObject.drainCallableSubscriberDelivery()` diagnostic.
- Each drain now records, per subscriber/window:
  - subscriber slug;
  - starting cursor and `beforeOffset`;
  - history event count;
  - delivered/failed event counts;
  - duration.

Validation:

- Focused shared tests passed: `4` files, `56` tests.
- `pnpm --filter @iterate-com/shared typecheck`: passed.
- `pnpm --dir apps/os2 typecheck`: passed.
- Deployed to preview slot 2.

Cold-ish `both` run:

- Project: `proj__os__01kr2may2hf26vhtc4dkywd5xs`
- Benchmark: `agent-server-bench-1778204903801-01d95396`
- Traffic: `300` `agent-chat/assistant-response-added` events at `300/s`
- Source subscriber wait: `781ms`
- Final subscriber wait: `8ms`
- Processor wait: `5ms`
- Append latency: p50 `16ms`, p90 `31ms`, p99 `79ms`
- Duplicate attempts: `18` across `4` setup keys

Notable drain timings:

- Early drain to offset `12`:
  - Agent: `10` delivered from `12` history events in `442ms`
  - Codemode: `4` delivered from `5` history events in `146ms`
- Early drain to offset `62`:
  - Agent: `40` delivered in `1009ms`
  - Codemode: `40` delivered in `46ms`
- Bulk drain to offset `627`:
  - Total: `587ms`
  - Agent windows: mostly `25-57ms` per `100` events
  - Codemode windows: mostly `55-152ms` per `100` events

Warm `agent-only` run:

- Project: `proj__os__01kr2mc4psesqvn1xa16619ra4`
- Benchmark: `agent-server-bench-1778204942985-55f55189`
- Source subscriber wait: `292ms`
- Final subscriber wait: `4ms`
- Processor wait: `5ms`
- Append latency: p50 `10ms`, p90 `26ms`, p99 `53ms`

Notable drain timings:

- Early drain to offset `40`:
  - Agent: `17` delivered from `18` history events in `980ms`
  - Disabled Codemode lane: `0ms`
- Bulk drain to offset `628`:
  - Total: `115ms`
  - Agent windows: `16-29ms` per `100` events
  - Disabled Codemode lane: `0ms`

Warm `both` rerun on the same stream as the cold-ish `both` run:

- Project: `proj__os__01kr2may2hf26vhtc4dkywd5xs`
- Benchmark: `agent-server-bench-1778204966862-e62bf963`
- Source subscriber wait: `712ms`
- Final subscriber wait: `10ms`
- Processor wait: `63ms`
- Append latency: p50 `17ms`, p90 `31ms`, p99 `55ms`

Notable drain timings:

- Early drain to offset `628`:
  - Agent: `1` delivered in `657ms`
  - Codemode: `1` delivered in `31ms`
- Early drain to offset `634`:
  - Agent: `6` delivered in `1098ms`
  - Codemode: `6` delivered in `20ms`
- Bulk drain to offset `1232`:
  - Total: `560ms`
  - Agent windows: usually `24-38ms` per `100` events, one `86ms` window
  - Codemode windows: `70-125ms` per `100` events

Interpretation:

- The second-scale tail is not primarily Stream DO history reads or cursor
  writes.
- It is also not simply "Codemode is slow." Codemode is slower than Agent in the
  steady bulk windows, but the largest tail samples are tiny Agent subscriber
  batches.
- The suspicious shape is inside `AgentDurableObject.afterAppendBatch` /
  `withStreamProcessor`: small early batches that include Agent/AgentChat setup
  or derived-event production can take `650-1100ms`.
- Once the system is in the bulk catch-up section, Agent handles `100` event
  windows in roughly `20-40ms`; Codemode handles them in roughly `70-150ms`.
- Next instrumentation needs to break the Agent subscriber RPC into per-processor
  timings:
  - `agent-chat` reduce/afterAppendBatch;
  - local feed-through of processor-appended events;
  - `agent` reduce/afterAppendBatch;
  - `openai-ws` reduce/afterAppendBatch;
  - stream append/appendBatch time inside processor APIs.

### 2026-05-08: rejected legacy runner local feed-through

Question:

- Would adding same-stream local feed-through to the legacy
  `withStreamProcessorRunner` reduce Codemode duplicate idempotency attempts and
  improve Codemode subscriber latency?

Change tested on preview slot 2, then reverted:

- Wrapped `withStreamProcessorRunner`'s processor stream API so events appended
  back to the same stream were queued locally.
- After `consumeStreamProcessorEvent()` or `catchUpStreamProcessor()` returned,
  the runner drained that local queue by consuming those returned events without
  waiting for Stream DO subscription redelivery.

Fresh `both` run after the patch:

- Project: `proj__os__01kr2nbmhzexzrav9ckp02qsrn`
- Benchmark: `agent-server-bench-1778205975566-b7458867`
- Traffic: `300` `agent-chat/assistant-response-added` events at `300/s`
- Source subscriber wait: `1174ms`
- Final subscriber wait: `3ms`
- Processor wait: `6ms`
- Append latency: p50 `13ms`, p90 `39ms`, p99 `115ms`
- Duplicate attempts: `11` across `4` keys
- Top duplicates:
  - `processor-registered:agent:0.1.0`: `7`
  - `events.iterate.com/codemode/session-started`: `2`
  - `processor-registered:openai-ws:0.1.0`: `1`
  - Codemode callable subscription: `1`
- Slow early Agent subscriber batch:
  - `23` delivered events took `1098ms`
  - Agent `afterAppendBatch` timing for offsets `23-45`: `1134ms`
- Bulk Codemode windows were `137-223ms` per about `100` events.

Fresh `codemode-only` run after the patch:

- Project: `proj__os__01kr2nckw4e49sqsh6zfw51jgx`
- Benchmark: `agent-server-bench-1778206007279-56dff8cc`
- Traffic: `300` `agent-chat/assistant-response-added` events at `300/s`
- Source subscriber wait: `257ms`
- Final subscriber wait: `2ms`
- Append latency: p50 `10ms`, p90 `16ms`, p99 `52ms`
- Duplicate attempts: `15` across `5` keys
- Bulk Codemode windows were `149-187ms` per about `100` events.

Interpretation:

- The patch was not a performance improvement.
- It reduced duplicate attempts in the `both` run compared with the cumulative
  earlier same-stream run, but did not eliminate the core duplicate pattern.
- It made `codemode-only` slower than the previous `107ms` source-wait shape and
  still produced similar duplicate setup keys.
- This suggests naive local feed-through in the legacy runner adds work to the
  hot subscriber call without fixing the main ordering/setup issue.
- Reverted locally. The next better direction is not "consume all local appends
  immediately inside the legacy runner"; it is either:
  - make setup/registration helpers avoid repeated idempotent appends directly;
  - move CodemodeSession onto the newer batched `withStreamProcessor` model; or
  - make processor registration/session-started an explicit runner-level
    invariant instead of emitted opportunistically from every early
    `afterAppend`.

### 2026-05-08: contiguous-only local feed-through

Question:

- Is the second-scale early Agent subscriber stall caused by local feed-through
  trying to consume processor-emitted events whose offsets are far ahead of the
  Agent runner's current contiguous cursor?

Background:

- The first shared-gap experiment changed `withStreamProcessor` so all
  processors shared one history read when a delivered batch started after the
  earliest processor cursor.
- That removed per-processor "reduce nothing" costs, but a fresh run showed the
  shared history read itself could take `998ms`.
- The bad shape was: AgentChat appends derived `agent/input-added` events while
  source traffic is still being appended concurrently. Those derived events get
  higher offsets than not-yet-processed source events. Local feed-through then
  tries to consume the derived events immediately and has to synchronously read
  the missing source gap from the Stream DO.

Change:

- Keep shared gap timing diagnostics.
- Change local feed-through so it only consumes locally appended events when
  they are already contiguous with the earliest hosted processor cursor.
- If a local appended event is ahead of a gap, do not process it locally; let the
  normal ordered Stream DO subscription deliver it later.

Validation:

- `pnpm --filter @iterate-com/shared exec vitest run
src/durable-object-utils/mixins/with-stream-processor-runner.unit.test.ts
src/stream-processors/stream-processor.test.ts`: passed, `33` tests.
- `pnpm --filter @iterate-com/shared typecheck`: passed.
- `pnpm --dir apps/os2 typecheck`: passed.
- Deployed to preview slot 2.

Fresh preview run:

- Project: `proj__os__01kr2p4a55enabtbg5ebbs7frk`
- Benchmark: `agent-server-bench-1778206784414-c6f5b39b`
- Traffic: `300` `agent-chat/assistant-response-added` events at `300/s`
- Source subscriber wait: `869ms`
- Final subscriber wait: `226ms`
- Processor wait: `4ms`
- Append latency: p50 `27ms`, p90 `40ms`, p99 `77ms`
- Duplicate attempts: `18` across `5` keys
- Shared gap catch-up timings: none
- Early Agent delivery:
  - offsets `23-37`: `15` events in `94ms`
  - offsets `38-137`: `100` events in `229ms`
  - offsets `138-237`: `100` events in `187ms`
  - offsets `238-337`: `100` events in `290ms`
- Previous bad runs saw tiny/early Agent batches in roughly `900-1500ms`.
- Local append delivery delays for late AgentChat-derived events were
  `331-424ms`, because non-contiguous local feed-through now waits for normal
  subscription delivery instead of forcing synchronous gap catch-up.

Interpretation:

- This confirms the big early stalls were self-inflicted by eager local
  feed-through under concurrent source append pressure.
- Local feed-through is good only when the appended event is contiguous. If it
  is ahead of the current source cursor, trying to force zero self-delivery lag
  is worse than waiting for ordered subscription delivery.
- This is still not the final target. We removed the second-scale stall, but
  self-delivery lag is still hundreds of milliseconds under this workload.
- Next directions:
  - make Stream DO delivery drain faster so the ordered path approaches zero;
  - benchmark `1000/s` with contiguous-only feed-through;
  - add metrics for skipped local feed-through events so this tradeoff is
    visible directly;
  - consider event-type/subscriber filters so Codemode does less work on
    AgentChat-derived traffic.

### 2026-05-08: duplicate invariant plus 1000/s subscriber isolation

Change deployed:

- Deployed commit `1581eff0d` to preview slot 2.
- Benchmark CLI now fails when duplicate attempts exceed the default budget or
  when duplicate keys fall outside the setup allowlist.
- Stream diagnostics now include committed idempotent event count and logical
  idempotent append attempts.

`both` subscribers, `1000/s`:

- Project: `proj__os__01kr2pn7m7endvxy4c8a550rzc`
- Benchmark: `agent-server-bench-1778207338305-0735b44c`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Duplicate invariant: passed
- Committed idempotent events: `1023`
- Duplicate attempts: `13`
- Logical idempotent append attempts: `1036`
- Duplicate-attempt ratio: `0.01`
- Unexpected duplicate attempts: `0`
- Source subscriber wait: `2419ms`
- Final subscriber wait: `612ms`
- Processor wait: `29ms`
- Append latency: p50 `103ms`, p90 `135ms`, p99 `153ms`
- Slow delivery windows:
  - `1992` delivered events took `2446ms`
  - one Codemode subscriber delivery inside that drain took `1367ms`
  - same-window Agent delivery took `129ms`

`agent-only`, `1000/s`:

- Project: `proj__os__01kr2ppd3ce48v4wa2pdwynmj0`
- Benchmark: `agent-server-bench-1778207378824-24290dd1`
- Duplicate invariant: passed
- Duplicate attempts: `17`
- Source subscriber wait: `1831ms`
- Final subscriber wait: `2937ms`
- Processor wait: `11ms`
- Append latency: p50 `102ms`, p90 `152ms`, p99 `169ms`
- Slow delivery windows:
  - `838` delivered events took `3314ms`
  - one Agent subscriber delivery inside that drain took `2268ms`

`codemode-only`, `1000/s`:

- Project: `proj__os__01kr2pr52ne8n9nwgre05xg190`
- Benchmark: `agent-server-bench-1778207434059-a72801f8`
- Duplicate invariant: passed
- Duplicate attempts: `14`
- Source subscriber wait: `279ms`
- Final subscriber wait: `4ms`
- Append latency: p50 `14ms`, p90 `30ms`, p99 `48ms`
- Delivery windows were `134-287ms`.

Interpretation:

- The hidden idempotency storm is not the remaining high-rate bottleneck in
  these runs. Duplicate attempts are small, known setup keys, and the invariant
  passes.
- `codemode-only` is now much faster than `both` or `agent-only`; the current
  hot path is more strongly tied to Agent/AgentChat same-stream derived appends
  and/or Agent DO scheduling than to Codemode's reducer.
- Stream DO delivery duration and Agent DO method timings disagree in an
  important way: the Stream DO can spend seconds awaiting an Agent subscriber
  call, while the Agent runtime often records `consumeDurationMs` near zero once
  the method body runs.
- That suggests a missing queue/transit measurement: Worker RPC or Durable
  Object input-queue wait before `AgentDurableObject.afterAppendBatch()` starts.

Follow-up instrumentation:

- Added `deliveryStartedAtMs` to callable `afterAppendBatch` payloads.
- Agent subscriber timings now record `deliveryLagMs`, measured as local
  receive time minus Stream DO send time.
- This should separate:
  - time waiting to enter the Agent DO;
  - `ensureStarted`;
  - actual stream processor consumption.

### 2026-05-08: Agent delivery lag instrumentation result

Change deployed:

- Deployed commit `eac42f66d` to preview slot 2.
- Callable `afterAppendBatch` payloads include `deliveryStartedAtMs`.
- `AgentDurableObject.afterAppendBatch()` records `deliveryLagMs`.

Run:

- Project: `proj__os__01kr2q1gs0fahv12t30vgavan6`
- Benchmark: `agent-server-bench-1778207741231-ccf58b08`
- Mode: `agent-only`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Duplicate invariant: passed
- Duplicate attempts: `13`
- Source subscriber wait: `3074ms`
- Final subscriber wait: `414ms`
- Processor wait: `142ms`
- Append latency: p50 `76ms`, p90 `114ms`, p99 `149ms`

Slow Stream DO delivery windows:

- `680` delivered events took `2844ms`.
- Slowest Agent subscriber delivery inside that drain:
  - `beforeOffset`: `639`
  - duration: `1656ms`
- Later drains were shorter:
  - `811` delivered events took `1040ms`
  - `299` delivered events took `309ms`

Matching Agent-side timings:

- Batch offsets `639-738`:
  - `deliveryLagMs`: `409`
  - `consumeDurationMs`: `250`
  - `totalDurationMs`: `250`
- Max observed Agent `deliveryLagMs` in retained timings: `416ms`.
- Max observed Agent method `totalDurationMs` in retained timings: `250ms`.
- Late batches often had `deliveryLagMs: 0` and `consumeDurationMs: 0`.

Interpretation:

- Agent DO queue/entry lag is real and can be hundreds of milliseconds in the
  high-rate same-stream derived-append case.
- Agent-side method time is also non-zero for some windows, but retained
  receiver timings do not explain the full Stream DO sender-side wait. Example:
  Stream DO saw `1656ms`; Agent-side `deliveryLagMs + totalDurationMs` explains
  about `659ms`.
- `Date.now()` across Durable Object instances may include clock skew, so the
  absolute `deliveryLagMs` should be treated as directional rather than exact.
- We need one more Stream DO-side timestamp per subscriber delivery:
  - started before filtering/dispatch;
  - started immediately before `dispatchCallable`;
  - returned immediately after `dispatchCallable`.
- That will separate JSONata/filter work, RPC dispatch wait, and post-return
  bookkeeping without relying on cross-object clocks.

Follow-up change:

- Added Stream DO-side per-subscriber `filterDurationMs` and
  `dispatchDurationMs` to callable subscriber delivery diagnostics.
- Next run should compare:
  - subscriber delivery `durationMs`;
  - `filterDurationMs`;
  - `dispatchDurationMs`;
  - Agent receiver `deliveryLagMs`;
  - Agent receiver `totalDurationMs`.

### 2026-05-08: dispatch split result and batch-size hypothesis

Run:

- Project: `proj__os__01kr2qacrgfk3rjsc1pcsqe44c`
- Benchmark: `agent-server-bench-1778208031827-5750556c`
- Mode: `agent-only`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Duplicate invariant: passed
- Duplicate attempts: `15`
- Source subscriber wait: `1194ms`
- Final subscriber wait: `413ms`
- Processor wait: `74ms`
- Append latency: p50 `73ms`, p90 `109ms`, p99 `136ms`

Key delivery split:

- Slowest Stream DO subscriber attempts:
  - offset window ending `19`: `durationMs=257`,
    `dispatchDurationMs=257`, `filterDurationMs=0`
  - offset window ending `425`: `durationMs=203`,
    `dispatchDurationMs=203`, `filterDurationMs=0`
  - offset window ending `525`: `durationMs=161`,
    `dispatchDurationMs=161`, `filterDurationMs=0`
- Slowest retained Agent receiver timings:
  - max `deliveryLagMs`: `466ms`
  - max `totalDurationMs`: `206ms`

Interpretation:

- On the Stream DO side, JSONata/filtering is not the hot path for this run.
- The sender-side subscriber time is essentially Worker RPC / Durable Object
  dispatch time.
- Current callable delivery uses `CALLABLE_SUBSCRIBER_ALARM_BATCH_SIZE = 100`.
  At `1000` source events plus derived events, that creates many serialized
  RPC batches even when each receiver batch is mostly cheap.
- Next experiment: raise callable subscriber batch size from `100` to `1000`.
  Hypothesis: fewer Worker RPC calls should reduce source subscriber wait
  materially. Risk: a too-large batch can make one receiver invocation too
  chunky and worsen tail latency or CPU time.

### 2026-05-08: callable subscriber batch size 1000

Change deployed:

- Deployed commit `a75224d71` to preview slot 2.
- Changed `CALLABLE_SUBSCRIBER_ALARM_BATCH_SIZE` from `100` to `1000`.

Run:

- Project: `proj__os__01kr2qg0b0e49rbkwqwdmzt9sj`
- Benchmark: `agent-server-bench-1778208215924-13ecfe64`
- Mode: `agent-only`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Duplicate invariant: passed
- Duplicate attempts: `12`
- Source subscriber wait: `870ms`
- Final subscriber wait: `3ms`
- Processor wait: `10ms`
- Append latency: p50 `117ms`, p90 `170ms`, p99 `454ms`

Comparison with previous `100` batch run:

- Source subscriber wait improved: `1194ms` -> `870ms`.
- Final subscriber wait improved: `413ms` -> `3ms`.
- Processor wait improved: `74ms` -> `10ms`.
- Append latency got worse:
  - p50 `73ms` -> `117ms`
  - p90 `109ms` -> `170ms`
  - p99 `136ms` -> `454ms`

Delivery shape:

- The Stream DO now does one history read and one dispatch for each large drain.
- Slow attempts:
  - `927` delivered events: `dispatchDurationMs=695`
  - `571` delivered events: `dispatchDurationMs=527`
  - `433` delivered events: `dispatchDurationMs=307`
- Filter time remained `0ms`.
- The largest retained Agent receiver batch was `571` events:
  - `consumeDurationMs=645`
  - `deliveryLagMs=1030`

Interpretation:

- Larger delivery batches materially reduce cursor tail lag because they remove
  many serialized Worker RPC calls.
- `1000` looks too large as a blanket default: one receiver invocation becomes
  chunky, and append p99 regressed badly.
- Next experiment: test an intermediate batch size, likely `500`, to find a
  better balance between fewer RPC dispatches and less receiver/append tail
  pressure.

### 2026-05-08: callable subscriber batch size 500

Change deployed:

- Deployed commit `c31a529ec` to preview slot 2.
- Changed `CALLABLE_SUBSCRIBER_ALARM_BATCH_SIZE` from `1000` to `500`.
- First benchmark attempt immediately after deploy failed with a generic `500`.
- Cloudflare traces showed the only error in the window was:
  `Durable Object reset because its code was updated.`
  - Trace id: `fd4899c1f364b511a52ec0d9472e0f21`
  - Service/script: `os2-preview-2`
  - Entrypoint: `StreamDurableObject`
  - Handler: `alarm`
  - Outcome: `exception`
  - Wall time: `13592ms`
  - This was deploy-induced, not a benchmark logic error.
- Reran after the preview settled.

`agent-only`, `1000/s`:

- Project: `proj__os__01kr2qrve2fzrtrp9c11wdsszh`
- Benchmark: `agent-server-bench-1778208506102-1c34e11e`
- Duplicate invariant: passed
- Duplicate attempts: `12`
- Source subscriber wait: `686ms`
- Final subscriber wait: `2ms`
- Processor wait: `159ms`
- Append latency: p50 `84ms`, p90 `117ms`, p99 `158ms`
- Slow attempts:
  - `500` events: `dispatchDurationMs=398`
  - `323` events: `dispatchDurationMs=304`
  - `500` events: `dispatchDurationMs=298`
- Max retained Agent receiver timing:
  - `323` events
  - `consumeDurationMs=337`
  - `deliveryLagMs=514`

`both`, `1000/s`:

- Project: `proj__os__01kr2qszbve06azj9kv3emr4pq`
- Benchmark: `agent-server-bench-1778208543502-a60523ac`
- Duplicate invariant: passed
- Duplicate attempts: `15`
- Source subscriber wait: `889ms`
- Final subscriber wait: `32ms`
- Processor wait: `6ms`
- Append latency: p50 `92ms`, p90 `135ms`, p99 `199ms`
- Slow attempts:
  - Agent, `500` events: `dispatchDurationMs=466`
  - Agent, `500` events: `dispatchDurationMs=396`
  - Codemode, `500` events: `dispatchDurationMs=393`
  - Codemode, `500` events: `dispatchDurationMs=295`
- Max retained Agent receiver timing:
  - `500` events
  - `consumeDurationMs=353`
  - `deliveryLagMs=605`

Batch-size comparison for `agent-only`, app-worker publisher:

| Batch size | Source wait | Final wait | Processor wait | Append p50 | Append p90 | Append p99 |
| ---------- | ----------: | ---------: | -------------: | ---------: | ---------: | ---------: |
| `100`      |    `1194ms` |    `413ms` |         `74ms` |     `73ms` |    `109ms` |    `136ms` |
| `500`      |     `686ms` |      `2ms` |        `159ms` |     `84ms` |    `117ms` |    `158ms` |
| `1000`     |     `870ms` |      `3ms` |         `10ms` |    `117ms` |    `170ms` |    `454ms` |

Interpretation:

- `500` is the best tested static batch size so far.
- It keeps most of the subscriber-tail improvement while avoiding the severe
  append p99 regression from `1000`.
- It is still not the target: `686-889ms` source wait is much better than
  multi-second lag, but not close to zero.
- The hot path is now clearly a small number of large Worker RPC / DO dispatches
  per drain. Filter time remains `0ms`.

Next checks:

- Test `publisher=agent-durable-object` to simulate a server-side publisher
  closer to OpenAI/WebSocket event production.
- Consider adaptive batch sizing instead of one static constant:
  - small batches for low traffic / first delivery;
  - larger batches while backlog is large;
  - cap receiver invocation size to avoid p99 append regressions.

`both`, `1000/s`, `publisher=agent-durable-object`:

- Project: `proj__os__01kr2qw92ye06azj9wrxz8bm04`
- Benchmark: `agent-server-bench-1778208618034-cd1d7037`
- Duplicate invariant: passed
- Duplicate attempts: `15`
- Source subscriber wait: `94ms`
- Final subscriber wait: `2ms`
- Processor wait: `6ms`
- Publish duration: `2776ms`
- Append latency: p50 `180ms`, p90 `335ms`, p99 `399ms`

Comparison with app-worker publisher for `both`, `1000/s`, batch `500`:

| Publisher              | Publish duration | Source wait | Final wait | Append p50 | Append p90 | Append p99 |
| ---------------------- | ---------------: | ----------: | ---------: | ---------: | ---------: | ---------: |
| `app-worker`           |         `1231ms` |     `889ms` |     `32ms` |     `92ms` |    `135ms` |    `199ms` |
| `agent-durable-object` |         `2776ms` |      `94ms` |      `2ms` |    `180ms` |    `335ms` |    `399ms` |

Interpretation:

- Publishing from the Agent DO makes post-publish delivery lag look much better,
  but the work did not disappear. It shifted into publisher backpressure.
- This is not a good default shape for high-throughput event production unless
  producer backpressure is explicitly desired.
- The app-worker publisher remains the better benchmark for detecting subscriber
  delivery lag because it can outrun subscriber dispatch and expose backlog.

### 2026-05-08: filter Codemode callable subscription by consumed event type

Hypothesis:

- In `both` mode, CodemodeSession receives the same high-volume AgentChat source
  traffic as AgentDurableObject even though the Codemode processor only consumes
  core processor registration and `events.iterate.com/codemode/*` events.
- With batch size `500`, the previous `both` run showed Codemode dispatches for
  `500`-event windows taking `393ms` and `295ms`.
- Adding a `jsonataFilter` to the Codemode callable subscription should avoid
  dispatching AgentChat/source-event-only batches to Codemode.
- This should reduce `both` mode subscriber delivery lag without changing
  committed stream contents or processor ordering.

Change:

- Set the Codemode callable subscription `jsonataFilter` from
  `CodemodeProcessorContract.consumes`.
- This keeps the filter tied to the processor contract instead of maintaining a
  separate hard-coded event list.

Results after deploying commit `15ce22f6b` to preview slot 2:

`both`, `1000/s`, app-worker publisher, run 1:

- Benchmark: `agent-server-bench-1778209092887-dd98cfb8`
- Duplicate invariant: passed
- Duplicate attempts: `14`
- Publish duration: `1217ms`
- Source subscriber wait: `723ms`
- Final subscriber wait: `2ms`
- Processor wait: `192ms`
- Append latency: p50 `91ms`, p90 `170ms`, p99 `198ms`
- Codemode totals:
  - delivered events: `9`
  - dispatch duration: `226ms`
  - attempts: `12`
  - max dispatch: `129ms`
- Agent totals:
  - delivered events: `2025`
  - dispatch duration: `2040ms`
  - attempts: `9`
  - max dispatch: `371ms`

`both`, `1000/s`, app-worker publisher, run 2:

- Benchmark: `agent-server-bench-1778209138636-62eddb73`
- Duplicate invariant: passed
- Duplicate attempts: `15`
- Publish duration: `1655ms`
- Source subscriber wait: `988ms`
- Final subscriber wait: `2ms`
- Processor wait: `31ms`
- Append latency: p50 `126ms`, p90 `184ms`, p99 `354ms`
- Codemode totals:
  - delivered events: `9`
  - dispatch duration: `248ms`
  - attempts: `12`
  - max dispatch: `133ms`
- Agent totals:
  - delivered events: `2025`
  - dispatch duration: `2270ms`
  - attempts: `9`
  - max dispatch: `496ms`

Comparison with previous unfiltered `both`, `1000/s`, batch `500`:

- Before filtering, the slow delivery list included Codemode `500`-event source
  windows at `393ms` and `295ms`.
- After filtering, Codemode no longer receives high-volume AgentChat/source-only
  windows. It delivered only startup/codemode-relevant events.
- Source subscriber wait moved from `889ms` to `723ms` in one run and `988ms` in
  the replicate. That is in the same broad range, not a decisive system-level
  improvement.
- The hot path is now explicitly AgentDurableObject dispatch and receiver work:
  Agent delivered `2025` events over `9` calls and spent `2040-2270ms` in
  dispatch.

Interpretation:

- The Codemode filter is still a good correctness and efficiency change: it
  prevents unnecessary receiver invocations and avoids wasting Codemode CPU on
  source traffic it cannot consume.
- It does not solve overall self-delivery lag because AgentDurableObject must
  still process nearly every event in this traffic shape.
- Next experiments should focus on reducing AgentDurableObject receiver cost and
  Stream DO dispatch shape, not Codemode.

### 2026-05-08: true Stream DO batch commit for `appendBatch`

Observation from the filtered Codemode runs:

- AgentDurableObject receiver work is dominated by AgentChat derived appends.
- `lastProcessorBatchTimings` showed AgentChat `afterAppendBatch` spending most
  of its time inside `streamApi.appendBatch`:
  - run 1: `264` derived appends took `348ms`; `236` took `290ms`; `300` took
    `227ms`.
  - run 2: `381` derived appends took `570ms`; `101` took `277ms`; `300` took
    `268ms`; `200` took `264ms`.
- The Stream DO implementation of `appendBatch` was just
  `inputEvents.map((inputEvent) => this.append(inputEvent))`.
- That means one parse/idempotency/reduce/SQLite transaction/afterAppend path
  per event, even though AgentChat already hands us a batch.

Hypothesis:

- A true Stream DO batch commit should reduce AgentChat derived append time by
  removing hundreds of separate SQLite transactions per batch.
- The implementation must still:
  - assign offsets sequentially;
  - reduce state in event order;
  - preserve idempotency behavior, including duplicate attempts inside a batch;
  - run `afterAppend` in order after commit;
  - expose each raw event in the stream.

Change under test:

- Parse all batch inputs.
- Build new events and reduce the stream state sequentially in memory.
- Insert all new events and the final reduced state in one SQLite transaction.
- Replay `afterAppend` in event order, temporarily setting the in-memory state to
  the reduced state after that event so builtin afterAppend sees the same
  per-event state shape as the old append loop.

Results after deploying commit `02f526270` to preview slot 2:

`both`, `1000/s`, app-worker publisher, run 1:

- Benchmark: `agent-server-bench-1778209510324-d1be7adc`
- Duplicate invariant: passed
- Duplicate attempts: `14`
- Publish duration: `1115ms`
- Source subscriber wait: `683ms`
- Final subscriber wait: `3ms`
- Processor wait: `176ms`
- Append latency: p50 `34ms`, p90 `101ms`, p99 `136ms`
- Agent subscriber totals:
  - delivered events: `2025`
  - dispatch duration: `1760ms`
  - max dispatch: `325ms`
- Slowest AgentChat derived append batches:
  - `268` appended events: `229ms`
  - `232` appended events: `208ms`
  - `290` appended events: `204ms`

`both`, `1000/s`, app-worker publisher, run 2:

- Benchmark: `agent-server-bench-1778209544769-9cd32f42`
- Duplicate invariant: passed
- Duplicate attempts: `13`
- Publish duration: `1457ms`
- Source subscriber wait: `645ms`
- Final subscriber wait: `10ms`
- Processor wait: `180ms`
- Append latency: p50 `126ms`, p90 `182ms`, p99 `200ms`
- Agent subscriber totals:
  - delivered events: `2025`
  - dispatch duration: `2241ms`
  - max dispatch: `412ms`
- Slowest AgentChat derived append batches:
  - `291` appended events: `398ms`
  - `209` appended events: `254ms`
  - `60` appended events: `247ms`

`agent-only`, `1000/s`, app-worker publisher, two runs:

- Run 1 benchmark: `agent-server-bench-1778209579739-cda23f7d`
  - Duplicate invariant: passed
  - Source subscriber wait: `657ms`
  - Final subscriber wait: `9ms`
  - Processor wait: `18ms`
  - Append latency: p50 `120ms`, p90 `260ms`, p99 `927ms`
  - One tiny `12`-event AgentChat append batch took `988ms`, likely cold/wake or
    platform noise.
- Run 2 benchmark: `agent-server-bench-1778209614824-9fc7724c`
  - Duplicate invariant: passed
  - Source subscriber wait: `764ms`
  - Final subscriber wait: `11ms`
  - Processor wait: `56ms`
  - Append latency: p50 `90ms`, p90 `121ms`, p99 `212ms`

Interpretation:

- True batch commit is a real improvement, especially in the best `both` run:
  append p50/p90/p99 improved from `91/170/198ms` to `34/101/136ms`.
- It did not collapse source subscriber wait to zero. The Stream DO still makes
  around nine Worker RPC dispatches to AgentDurableObject, and Agent still spends
  `~1.7-2.2s` total across those dispatches.
- AgentChat derived append batches are cheaper than before but still not cheap
  enough. A few hundred derived events still cost `~200-400ms` to append back to
  the Stream DO.
- Since append p99 no longer consistently explodes, retest larger callable
  subscriber batches. The earlier `1000` batch result may have been unfairly
  penalized by the old `appendBatch = map(append)` implementation.

### 2026-05-08: retest subscriber batch size 1000 after true batch commit

Hypothesis:

- The earlier `1000` subscriber batch improved final subscriber wait but badly
  regressed append p99.
- Now that processor-derived `appendBatch` uses one Stream DO transaction, a
  larger subscriber delivery batch may reduce Worker RPC dispatch count without
  causing the same append p99 regression.

Results after deploying commit `f81131413` to preview slot 2:

`both`, `1000/s`, app-worker publisher, run 1:

- Benchmark: `agent-server-bench-1778209833746-a7e1a962`
- Duplicate invariant: passed
- Duplicate attempts: `13`
- Publish duration: `1158ms`
- Source subscriber wait: `792ms`
- Final subscriber wait: `3ms`
- Processor wait: `11ms`
- Append latency: p50 `24ms`, p90 `102ms`, p99 `168ms`
- Agent subscriber totals:
  - delivered events: `2025`
  - dispatch duration: `1865ms`
  - attempts: `8`
  - max dispatch: `555ms`

`both`, `1000/s`, app-worker publisher, run 2:

- Benchmark: `agent-server-bench-1778209868317-8fa91e06`
- Duplicate invariant: passed
- Duplicate attempts: `15`
- Publish duration: `1587ms`
- Source subscriber wait: `729ms`
- Final subscriber wait: `4ms`
- Processor wait: `5ms`
- Append latency: p50 `112ms`, p90 `247ms`, p99 `290ms`
- Agent subscriber totals:
  - delivered events: `2025`
  - dispatch duration: `2112ms`
  - attempts: `7`
  - max dispatch: `595ms`

Interpretation:

- Larger batches reduce dispatch count slightly, but each dispatch becomes
  chunkier (`555-595ms` max Agent dispatch).
- Source subscriber wait did not improve over batch `500` after true batch
  commit (`645-683ms` in the two `both` runs).
- Append p99 no longer explodes as badly as old batch `1000`, but run 2 still
  regressed to `290ms`.
- Static `1000` is not obviously better than `500`. The better direction is
  likely alarm scheduling and adaptive batch sizing.

### 2026-05-08: coalesce callable subscriber alarm scheduling

Hypothesis:

- `StreamDurableObject.afterAppend` calls `scheduleCallableSubscriberDelivery`
  for every committed event that has callable subscribers.
- `scheduleCallableSubscriberDelivery` calls `ctx.storage.setAlarm(Date.now())`.
- At `1000/s`, and especially during processor-derived `appendBatch`, this can
  create hundreds or thousands of redundant alarm writes while one pending alarm
  would be enough.
- Coalescing pending alarm scheduling in memory should reduce Stream DO storage
  work and append-side contention without changing ordering or delivery
  semantics.

Results after deploying commit `b738ffed6` to preview slot 2 with batch size
`1000`:

`both`, `1000/s`, app-worker publisher, run 1:

- Benchmark: `agent-server-bench-1778210100657-daca8323`
- Duplicate invariant: passed
- Duplicate attempts: `19`
- Publish duration: `1257ms`
- Source subscriber wait: `1839ms`
- Final subscriber wait: `8ms`
- Processor wait: `25ms`
- Append latency: p50 `103ms`, p90 `144ms`, p99 `145ms`
- Slowest deliveries:
  - Codemode, `7` delivered events from a `12`-event window: `1061ms`
  - Agent, `1000` delivered events: `941ms`
  - Agent, `1000` delivered events: `849ms`
- Alarm runs became very chunky:
  - `1098ms` alarm run delivered `1003` events
  - `904ms` alarm run delivered `1004` events
  - `1061ms` alarm run delivered only `25` events

`both`, `1000/s`, app-worker publisher, run 2:

- Benchmark: `agent-server-bench-1778210140896-228786f2`
- Duplicate invariant: passed
- Duplicate attempts: `19`
- Publish duration: `1411ms`
- Source subscriber wait: `704ms`
- Final subscriber wait: `8ms`
- Processor wait: `7ms`
- Append latency: p50 `107ms`, p90 `215ms`, p99 `225ms`
- Slowest deliveries:
  - Agent, `799` delivered events: `611ms`
  - Agent, `582` delivered events: `512ms`
  - Codemode, `1` delivered event: `329ms`

Interpretation:

- Coalescing alarm scheduling did not produce a clear win.
- Run 1 was substantially worse than the non-coalesced batch-`1000` runs, and
  run 2 was only roughly comparable.
- The change made delivery chunkier and did not reduce Agent dispatch cost.
- Reverted this experiment and restored batch size `500`, which is still the
  best static baseline tested after true batch commit.
