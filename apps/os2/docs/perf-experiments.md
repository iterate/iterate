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

Restore confirmation after deploying commit `48319d29a`:

- Benchmark: `agent-server-bench-1778210339977-1d17ebfa`
- Duplicate invariant: passed
- Duplicate attempts: `19`
- Publish duration: `1596ms`
- Source subscriber wait: `989ms`
- Final subscriber wait: `10ms`
- Processor wait: `56ms`
- Append latency: p50 `104ms`, p90 `167ms`, p99 `413ms`
- Agent subscriber totals:
  - delivered events: `2025`
  - dispatch duration: `2570ms`
  - max dispatch: `715ms`
- Codemode subscriber totals:
  - delivered events: `9`
  - dispatch duration: `792ms`
  - max dispatch: `426ms`

Interpretation:

- The restored baseline deployment worked and passed duplicate invariants, but
  this confirmation run was slower than the earlier best batch-`500` runs.
- There is significant run-to-run variance, especially in early tiny Codemode
  deliveries and Agent dispatch max latency.
- Current evidence says static batch-size tuning alone is not enough. We need
  deeper instrumentation around receiver dispatch time, cold/wake effects, and
  Stream DO appendBatch internals.

### 2026-05-08: instrument Stream DO appendBatch phases

Hypothesis:

- AgentChat receiver timings show derived `streamApi.appendBatch` still costs
  hundreds of milliseconds for a few hundred events.
- We need to know whether that cost is:
  - input parsing;
  - in-memory idempotency/build/reduce;
  - the SQLite transaction;
  - synchronous `afterAppend` work after commit;
  - or total overhead around the call.

Change under test:

- Add bounded Stream DO diagnostics for recent `appendBatch` calls.
- Each diagnostic records:
  - input event count;
  - committed event count;
  - duplicate/idempotent-return count;
  - parse duration;
  - build/reduce duration;
  - commit duration;
  - `afterAppend` duration;
  - total duration;
  - first/last committed offset;
  - error message if the batch throws.
- The diagnostics are returned from `StreamDurableObject.getDiagnostics()`, so
  they appear in the existing server benchmark JSON under
  `result.streamDiagnostics.appendBatchDiagnostics`.
- First deployed implementation rounded diagnostic phase timings to integer
  milliseconds. On successful 1000-event runs this reported all appendBatch
  phase durations as `0ms`, which is useful as a coarse signal but too lossy for
  reducer/commit profiling. Updated the diagnostic rounding to preserve
  microsecond-scale decimals in milliseconds.

Validation:

- Commit under test: `e70be2410`
- Preview: `https://os2.iterate-preview-2.com`
- Shared typecheck: passed
- OS2 typecheck: passed
- First 1000-event run returned a client-visible oRPC 500, but Cloudflare trace
  `0d185c2496e2d5f989d5c988636e8b68` showed the benchmark request itself as
  `POST OK`, `237` spans, no error events. A rerun succeeded, so this currently
  looks transient rather than a deterministic appendBatch diagnostics failure.
- Small sanity benchmark:
  - Benchmark: `agent-server-bench-1778210863474-66a7b124`
  - Count/rate/concurrency: `10` / `10/s` / `1`
  - Duplicate invariant: passed
  - Logical append attempts: `52`
  - Committed idempotent events: `33`
  - Duplicate attempts: `19`
  - Unexpected duplicate attempts: `0`
  - Source subscriber wait: `125ms`
  - Processor wait: `5ms`
  - Append latency: p50 `17ms`, p90 `55ms`, p99 `63ms`
- 1000-event benchmark:
  - Benchmark: `agent-server-bench-1778210915514-5e6f032e`
  - Count/rate/concurrency: `1000` / `1000/s` / `100`
  - Duplicate invariant: passed
  - Logical append attempts: `1038`
  - Committed idempotent events: `1023`
  - Duplicate attempts: `15`
  - Unexpected duplicate attempts: `0`
  - Publish duration: `1078ms`
  - Source subscriber wait: `1089ms`
  - Final subscriber wait: `331ms`
  - Processor wait: `14ms`
  - Append latency: p50 `21ms`, p90 `60ms`, p99 `107ms`
  - Slowest Agent deliveries:
    - `15` delivered events: `1199ms`
    - `500` delivered events: `449ms`
    - `500` delivered events: `396ms`
    - `500` delivered events: `351ms`
    - `500` delivered events: `316ms`
  - Slowest Codemode deliveries:
    - `5` delivered events: `104ms`
    - `1` delivered event: `74ms`
  - AppendBatch diagnostics captured `496`, `500`, and `6` committed event
    batches, but integer rounding reported all phases as `0ms`.

Interpretation:

- The hidden-idempotency-storm concern is valid and now measurable: compare
  logical append attempts against committed idempotent events, and fail if any
  duplicate key outside the setup allowlist appears.
- This benchmark did not show a 10x hidden application-event append storm. The
  duplicates were setup/lifecycle keys:
  `processor-registered:*`, `events.iterate.com/codemode/session-started`, and
  the Codemode callable subscription key.
- The main latency is still subscriber dispatch, especially the Agent runner.
  The Stream DO appendBatch path appears below integer-millisecond resolution in
  this run, so the next run with decimal timings should confirm whether
  appendBatch is genuinely negligible or merely hidden by rounding.

Decimal timing rerun after deploying commit `966c24881`:

- Benchmark: `agent-server-bench-1778211142191-bb1b667f`
- Duplicate invariant: passed
- Logical append attempts: `1036`
- Committed idempotent events: `1023`
- Duplicate attempts: `13`
- Unexpected duplicate attempts: `0`
- Publish duration: `1157ms`
- Source subscriber wait: `1108ms`
- Final subscriber wait: `3ms`
- Processor wait: `60ms`
- Append latency: p50 `77ms`, p90 `123ms`, p99 `196ms`
- AppendBatch diagnostics still reported `0ms` for parse/build-reduce/commit
  and `afterAppend`, even with decimal millisecond rounding, for batches of
  `408`, `311`, `189`, `72`, and `22` events.
- Slowest deliveries:
  - Agent, `500` delivered events: `476ms`
  - Agent, `408` delivered events: `428ms`
  - Agent, `500` delivered events: `413ms`
  - Agent, `430` delivered events: `372ms`
  - Agent, `17` delivered events: `264ms`
  - Codemode, `5` delivered events: `140ms`
- Cloudflare trace: `f1bdf68f02893f1fc62d8895b380d8f7`
  - Root request: benchmark-stream POST
  - Trace duration: `6098ms`
  - Trace spans: `4370`
  - Errors: none
  - Sampled first `1000` span events:
    - `jsrpc`: `32` spans, `29457ms` summed duration, max `27697ms`
    - `durable_object_subrequest`: `43` spans, `1611ms` summed duration,
      max `128ms`
    - `durable_object_storage_exec`: `548` spans, `0ms` reported duration
    - `durable_object_storage_setAlarm`: `311` spans, `0ms` reported duration
    - `insert into events ...`: `311` sampled calls
    - idempotency lookup query: `154` sampled calls

Updated interpretation:

- `performance.now()` does not appear usable for measuring synchronous work
  inside this Durable Object path. It still works for request-level waits and
  async subscriber dispatch, but synchronous appendBatch phases remain pinned at
  `0ms`. Use Cloudflare spans and structural counters for this part.
- AppendBatch itself is probably not the source of the second-scale lag in this
  benchmark. The trace shows the expensive work around Worker RPC / Durable
  Object subrequests and many alarm scheduling/storage spans.
- The source Stream DO still schedules a very high number of alarms/storage
  operations under high-rate individual appends. This supports the hypothesis
  that we need a single ongoing alarm-originated delivery loop with per-subscriber
  queues, rather than treating alarm scheduling as a cheap per-append action.

### 2026-05-08: suppress callable delivery alarms while a drain is active

Hypothesis:

- The earlier coalescing experiment only skipped duplicate `setAlarm()` calls
  while an alarm had been scheduled but had not fired yet.
- It did not skip `setAlarm()` calls made while an alarm-originated callable
  subscriber drain was already active.
- Under high-rate individual appends, appends can race with an active drain and
  schedule more alarms even though the active drain already has the
  `this.state.eventCount > targetEventCount` reschedule check.
- If this is part of the bottleneck, suppressing schedules while active should
  reduce `durable_object_storage_setAlarm` spans and should not hurt ordering,
  because the drain loop still uses persistent subscriber cursors and reschedules
  if new events are committed after its initial target.

Change under test:

- Add two in-memory Stream DO booleans:
  - `callableSubscriberDeliveryAlarmScheduled`
  - `callableSubscriberDeliveryActive`
- `scheduleCallableSubscriberDelivery()` now:
  - records every scheduling request;
  - coalesces if an alarm is already scheduled;
  - coalesces if a callable delivery drain is already active;
  - otherwise calls `ctx.storage.setAlarm(Date.now())`.
- `alarm()` clears the scheduled flag, marks delivery active around
  `drainCallableSubscriberDelivery()`, then clears the active flag in `finally`.
- `getDiagnostics()` now exposes:
  - `scheduleRequestCount`
  - `setAlarmCount`
  - `setAlarmErrorCount`
  - `coalescedWhileScheduledCount`
  - `coalescedWhileActiveCount`

Validation plan:

- Run the same server benchmark:
  `agent-chat-responses`, `count=1000`, `rate=1000`, `concurrency=100`,
  `subscriber-mode=both`.
- Compare:
  - source subscriber wait;
  - final subscriber wait;
  - append p50/p90/p99;
  - Agent dispatch batches;
  - duplicate invariant;
  - callable alarm diagnostic counters;
  - Cloudflare trace span count and sampled `durable_object_storage_setAlarm`
    count.

Result:

- Commit under test: `61bc3011b`
- Benchmark: `agent-server-bench-1778211589084-06f0fa2d`
- Duplicate invariant: passed
- Publish duration: `2044ms`
- Source subscriber wait: timed out after `30005ms`
  - Target offset: `1626`
  - Codemode cursor: `1223`
  - Agent cursor: `1223`
- Final subscriber wait: timed out after `30022ms`
  - Target offset: `1826`
  - Codemode cursor: `1223`
  - Agent cursor: `1223`
- Processor wait: timed out after `30080ms`
  - Agent / AgentChat / OpenAI processors were all only through offset `1223`
- Append latency: p50 `190ms`, p90 `238ms`, p99 `302ms`
- Alarm diagnostics:
  - `scheduleRequestCount`: `201`
  - `setAlarmCount`: `1`
  - `coalescedWhileActiveCount`: `200`
  - `coalescedWhileScheduledCount`: `0`
  - `setAlarmErrorCount`: `0`

Interpretation:

- This was a correctness failure, not just a slower run.
- Suppressing schedules while a drain is active can lose wakeups. The active
  drain did not reliably observe later committed stream state and therefore did
  not reschedule for the remaining events.
- The persistent subscriber cursors protected ordering and made the stall
  visible, but they did not make active in-memory coalescing safe.
- Reverted the behavioral coalescing immediately. Kept the diagnostic counters
  only, so the next baseline run can measure `setAlarm()` pressure without
  changing delivery behavior.

### 2026-05-08: baseline alarm diagnostics after reverting active coalescing

Change under test:

- Commit `1e5e7e88e` restores the pre-coalescing delivery behavior.
- It keeps only the in-memory diagnostic counters for:
  - schedule requests;
  - successful `setAlarm()` calls;
  - setAlarm errors;
  - coalesced-while-scheduled;
  - coalesced-while-active.

Validation:

- Benchmark: `agent-server-bench-1778212001534-9ff754ff`
- Duplicate invariant: passed
- Logical append attempts: `1036`
- Committed idempotent events: `1023`
- Duplicate attempts: `13`
- Unexpected duplicate attempts: `0`
- Publish duration: `1533ms`
- Source subscriber wait: `1057ms`
- Final subscriber wait: `3ms`
- Processor wait: `62ms`
- Append latency: p50 `131ms`, p90 `172ms`, p99 `285ms`
- Alarm diagnostics:
  - `scheduleRequestCount`: `2029`
  - `setAlarmCount`: `2029`
  - `setAlarmErrorCount`: `0`
  - `coalescedWhileScheduledCount`: `0`
  - `coalescedWhileActiveCount`: `0`
- Delivery runs:
  - target `2027`, delivered `100`, duration `197ms`
  - target `1927`, delivered `602`, duration `569ms`, rescheduled
  - target `1325`, delivered `801`, duration `842ms`, rescheduled
  - target `524`, delivered `402`, duration `503ms`, rescheduled
  - target `122`, delivered `100`, duration `243ms`, rescheduled
- Slowest subscriber deliveries:
  - Agent, `500` delivered events: `561ms`
  - Agent, `402` delivered events: `503ms`
  - Agent, `500` delivered events: `451ms`
  - Agent, `17` delivered events: `373ms`
  - Agent, `301` delivered events: `281ms`
- Cloudflare trace: `6a86605a25103f5eb72cabd32dabf0af`
  - Trace start: `2026-05-08T03:46:41.534Z`
  - Trace duration: `6494ms`
  - Trace spans: `422` in summary, first telemetry page returned `1000`
    events for the trace
  - First `1000` trace events:
    - `durable_object_subrequest`: `435` events, summed duration `123201ms`,
      max `432ms`
    - `durable_object_storage_exec`: `274` events
    - `jsrpc`: `129` events, summed duration `2425ms`, max `124ms`
    - `durable_object_storage_setAlarm`: `102` events in the sampled page

Interpretation:

- The safe baseline does not starve, but it schedules one alarm per callable
  delivery scheduling request. In this benchmark that is `2029` calls to
  `ctx.storage.setAlarm()` for roughly `1000` source events plus derived events.
- The trace again points at Durable Object subrequest pressure, not reducer CPU.
- Naive in-memory coalescing is unsafe. The next viable design needs a durable
  wake/work marker or per-subscriber queued work model that does not rely on an
  active in-memory drain seeing all later commits.

### 2026-05-08: scheduled-only alarm coalescing with diagnostics

Reference notes:

- Cloudflare Durable Object alarms are persisted storage-backed timers and each
  Durable Object instance has only one scheduled alarm slot at a time.
  <https://developers.cloudflare.com/durable-objects/api/alarms/>
- Kenton Varda's Durable Objects correctness writeup explains why input/output
  gates make storage and concurrent event delivery less intuitive than ordinary
  JavaScript async interleaving.
  <https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/>

Hypothesis:

- Active-drain coalescing is unsafe because the active drain may not observe
  later commits and therefore may not reschedule.
- Scheduled-only coalescing should be safer: suppress duplicate `setAlarm()`
  calls only while an alarm is scheduled but has not fired yet.
- Once the alarm starts, clear the scheduled flag immediately, so appends during
  the active drain can still schedule another alarm if needed.
- This was tried earlier with batch size `1000` and unclear/worse results. The
  current retest keeps batch size `500` and adds exact schedule/setAlarm counters.

Change under test:

- Reintroduce only `callableSubscriberDeliveryAlarmScheduled`.
- `scheduleCallableSubscriberDelivery()` now skips `setAlarm()` only when this
  scheduled flag is true.
- `alarm()` clears the scheduled flag before draining.
- No active-drain coalescing.

Validation plan:

- Run the same 1000-event `agent-chat-responses` server benchmark.
- Require source/final/processor waits to complete.
- Compare `scheduleRequestCount` to `setAlarmCount`.
- Compare append latency and subscriber wait against baseline
  `agent-server-bench-1778212001534-9ff754ff`.

Result:

- Benchmark: `agent-server-bench-1778212312773-0ab36bd9`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Subscriber mode: `both`
- Duplicate invariant: passed
  - committed idempotent events: `1023`
  - duplicate attempts: `13`
  - logical append attempts: `1036`
  - unexpected duplicate attempts: `0`
- Publish duration: `1320ms`
- Source subscriber wait: completed in `798ms`
- Final wait: completed in `3ms`
- Processor wait: completed in `6ms`
- Append latency:
  - p50 `102ms`
  - p90 `158ms`
  - p99 `180ms`
  - max `190ms`
- Alarm diagnostics:
  - schedule requests: `2028`
  - `setAlarm()` calls: `10`
  - coalesced while scheduled: `2018`
  - coalesced while active: `0`
  - setAlarm errors: `0`

Comparison with no-coalescing baseline
`agent-server-bench-1778212001534-9ff754ff`:

- `setAlarm()` calls dropped from `2029` to `10`.
- Source subscriber wait improved from `1057ms` to `798ms`.
- Processor wait improved from `62ms` to `6ms`.
- Append p50/p90/p99 improved from `131/172/285ms` to `102/158/180ms`.
- The benchmark did not starve, unlike active-drain coalescing.

Interpretation:

- Scheduled-only alarm coalescing is the first alarm experiment that looks both
  safe and beneficial under the `500` event batch-size baseline.
- The important distinction is that it only suppresses duplicate alarms before
  the alarm has fired. Once the alarm handler starts, new appends can schedule a
  follow-up alarm, so later committed events are not stranded behind stale
  in-memory assumptions.
- This does not get self-delivery lag near zero yet. The slowest deliveries are
  still dominated by callable subscriber dispatch time, with `500` event agent
  batches taking `435-518ms`.

Cloudflare trace check:

- Trace id: `9deeb205408b61e2d689721b4de04d58`
- Worker: `os2-preview-2`
- Timeframe: `2026-05-08T03:51:45Z` to `2026-05-08T03:52:20Z`
- Root request:
  `POST /api/projects/proj__os__01kr2vd1s7e059akbsg9331dmj/agents/benchmark-stream/%2Fagents%2Fserver-bench-1778212307017`
- Trace duration: `33536ms`
- Span count: `4508`
- Error spans: `0`

Unexpected finding:

- The slowest sampled span was not append/reduce/delivery. It was an
  `AgentDurableObject.getRuntimeState` JS RPC span:
  - duration: `27642ms`
  - CPU: `3ms`
  - wall time: `27049ms`
  - method: `getRuntimeState`
- The benchmark endpoint calls `agent.getRuntimeState()` as a warmup before it
  starts measuring publish duration. That means the JSON result can say publish
  and delivery completed quickly while the full request still spent tens of
  seconds waking/starting the Agent Durable Object.

Follow-up instrumentation:

- Add Agent Durable Object startup step timing to runtime state.
- Add `agentWarmupDurationMs` and `initialRuntimeState` to the server benchmark
  response so cold-start/wake cost is visible in every benchmark JSON result.

### 2026-05-08: Agent startup and traffic-shape isolation

Change:

- Deployed Agent Durable Object startup step timing to `os2-preview-2`.
- Server benchmark response now includes:
  - `agentWarmupDurationMs`;
  - `initialRuntimeState.lastStartupTiming`;
  - final `runtimeState.lastStartupTiming`.

Benchmark A: `agent-chat-responses`, both subscribers, RPC subscription

- Benchmark: `agent-server-bench-1778212881051-339e79e2`
- Startup timing:
  - total: `2993ms`
  - `ensure-agent-setup-events`: `1243ms`
  - `ensure-codemode-session`: `1436ms`
  - `catch-up-stream-processors`: `275ms`
  - measured request warmup after startup: `6ms`
- Hot path:
  - publish duration: `1159ms`
  - source subscriber wait: `916ms`
  - final subscriber wait: `4ms`
  - processor wait: `56ms`
  - append p50/p90/p99: `32/112/181ms`
  - duplicate invariant: passed, `15` duplicate attempts, `0` unexpected
- Slowest Agent subscriber dispatches:
  - `500` events: `519ms`
  - `500` events: `460ms`
  - `399` events: `331ms`
- Agent runtime timings show those dispatches are real processor work:
  - `agent-chat` batch append `217` derived events: `248ms`
  - `agent-chat` batch append `100` derived events: `128ms`
  - `agent-chat` batch append `282` derived events: `216ms`
  - `agent-chat` batch append `399` derived events: `310ms`

Benchmark B: same traffic, `codemode-only`

- Benchmark: `agent-server-bench-1778212956718-ff7724e0`
- Startup timing:
  - total: `3119ms`
  - `ensure-agent-setup-events`: `1214ms`
  - `ensure-codemode-session`: `1388ms`
  - `catch-up-stream-processors`: `450ms`
- Hot path:
  - publish duration: `1142ms`
  - source subscriber wait: `17ms`
  - final subscriber wait: `9ms`
  - append p50/p90/p99: `50/95/111ms`
  - duplicate invariant: passed, `19` duplicate attempts, `0` unexpected

Benchmark C: `raw-openai-ws`, both subscribers, RPC subscription

- Benchmark: `agent-server-bench-1778212993274-b9b9ea2a`
- Startup timing:
  - total: `3106ms`
- Hot path:
  - publish duration: `1267ms`
  - source subscriber wait: `71ms`
  - final subscriber wait: `3ms`
  - processor wait: `5ms`
  - append p50/p90/p99: `110/124/168ms`
  - duplicate invariant: passed, `13` duplicate attempts, `0` unexpected

Interpretation:

- Cold Agent startup is a separate, real `~3s` problem. It is mostly setup-event
  reconciliation plus Codemode session creation. The previous benchmark JSON hid
  this because it timed publish after the Agent DO had already started.
- Hot stream fanout is not uniformly bad at `1000/s`: `codemode-only` catches up
  in `17ms`, and `raw-openai-ws` with both subscribers catches up in `71ms`.
- The bad `agent-chat-responses` case is dominated by Agent processor side
  effects. `agent-chat` transcribes visible chat events into
  `agent/input-added` events, and those derived append batches cost hundreds of
  milliseconds.
- Reducing and no-op afterAppend are effectively instant in these runs. The
  remaining hot cost is cross-DO derived appends from processor afterAppend.

### 2026-05-08: already-rendered Agent input traffic

Question:

- How much of the `agent-chat-responses` cost is caused by `agent-chat`
  transcribing chat events into derived `agent/input-added` events, versus the
  Agent processor reducing model-visible input rows?

Change:

- Added a new benchmark traffic shape: `agent-inputs`.
- It appends `events.iterate.com/agent/input-added` directly with
  `triggerLlmRequest: { behaviour: "dont-trigger-request" }`.
- This bypasses `agent-chat` transcription and avoids LLM scheduling, while
  still exercising the Agent processor's history reducer.

Validation:

- One-event smoke benchmark succeeded:
  `agent-server-bench-1778213465946-8531f942`
- First 1000-event attempt returned a 500 immediately after deploy, but the same
  command succeeded on retry. Treat that failed attempt as likely preview edge
  propagation unless it recurs.

Benchmark:

- Benchmark: `agent-server-bench-1778213484278-c993723c`
- Traffic: `1000` `agent/input-added` events at `1000/s`
- Subscriber mode: `both`
- Subscription transport: `rpc`

Result:

- Startup timing:
  - total: `2736ms`
- Hot path:
  - publish duration: `1267ms`
  - source subscriber wait: `350ms`
  - final subscriber wait: `8ms`
  - processor wait: `13ms`
  - append p50/p90/p99: `112/134/166ms`
  - duplicate invariant: passed, `14` duplicate attempts, `0` unexpected
- Alarm diagnostics:
  - schedule requests: `1034`
  - `setAlarm()` calls: `16`
  - coalesced while scheduled: `1018`
- Slowest Agent subscriber dispatches:
  - setup batch `18` events: `273ms`
  - tail batch `28` events: `267ms`
  - `100` input events: `246ms`
  - `40` input events: `125ms`
  - `200` input events: `100ms`

Comparison:

- `raw-openai-ws` both subscribers:
  - source wait `71ms`
  - processor wait `5ms`
  - no meaningful Agent history growth
- `agent-inputs` both subscribers:
  - source wait `350ms`
  - processor wait `13ms`
  - Agent history grows by `1000` model-visible rows
- `agent-chat-responses` both subscribers:
  - source wait `916ms`
  - processor wait `56ms`
  - Agent history grows and `agent-chat` also appends derived
    `agent/input-added` events

Interpretation:

- There are at least two hot costs:
  - reducing/persisting large Agent history state;
  - cross-DO derived append batches from `agent-chat`.
- The `agent-inputs` result suggests the Agent processor's reduced state shape is
  itself expensive under high-volume input streams. The state stores full
  model-visible history, so every persisted processor state write serializes a
  growing history array.
- The `agent-chat-responses` result adds derived append cost on top of that
  state-growth cost.

Next instrumentation:

- Add processor-state save diagnostics: serialized JSON byte length and save
  duration per processor/stream batch.
- The existing processor timing reports `reduceDurationMs: 0` for these cases,
  which is not enough to distinguish cheap reduce from expensive state
  serialization/storage.

### 2026-05-08: processor state-save diagnostics

Change:

- Added per-batch processor state-save diagnostics:
  - `stateSaveCallCount`;
  - `stateSaveDurationMs`;
  - `stateSaveJsonBytes`;
  - `maxStateJsonBytes`.
- Deployed to `os2-preview-2`.

Important caveat:

- `stateSaveDurationMs` still reports `0ms` in these sync Durable Object paths.
  This matches earlier `performance.now()` problems: the runtime does not give
  useful sub-millisecond timing for the synchronous storage/serialization path.
- The byte counts are still useful because they show how much state each batch
  is serializing and writing.

Benchmark A: `agent-inputs`

- Benchmark: `agent-server-bench-1778213749613-406f55f5`
- Traffic: `1000` `agent/input-added` events at `1000/s`
- Result:
  - publish duration: `1108ms`
  - source subscriber wait: `273ms`
  - final subscriber wait: `11ms`
  - processor wait: `6ms`
  - append p50/p90/p99: `51/98/126ms`
  - duplicate invariant: passed, `19` duplicate attempts, `0` unexpected
- Processor state diagnostics:
  - `agent`:
    - batches: `8`
    - save calls: `14`
    - cumulative saved JSON bytes: `845273`
    - max state JSON bytes: `121398`
  - `agent-chat`:
    - cumulative saved JSON bytes: `2260`
    - max state JSON bytes: `248`
  - `openai-ws`:
    - cumulative saved JSON bytes: `2165`
    - max state JSON bytes: `199`
- Slowest Agent subscriber dispatches:
  - `227` events: `352ms`
  - setup `17` events: `323ms`
  - `301` events: `228ms`
  - `286` events: `192ms`

Benchmark B: `agent-chat-responses`

- Benchmark: `agent-server-bench-1778213767408-12548c41`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Result:
  - publish duration: `1409ms`
  - source subscriber wait: `946ms`
  - final subscriber wait: `3ms`
  - processor wait: `5ms`
  - append p50/p90/p99: `89/231/246ms`
  - duplicate invariant: passed, `13` duplicate attempts, `0` unexpected
- Processor state diagnostics:
  - `agent`:
    - batches: `12`
    - save calls: `15`
    - cumulative saved JSON bytes: `1637965`
    - max state JSON bytes: `254567`
  - `agent-chat`:
    - cumulative saved JSON bytes: `3584`
    - max state JSON bytes: `248`
    - afterAppend/append duration total: `1196ms`
  - `openai-ws`:
    - cumulative saved JSON bytes: `1974`
    - max state JSON bytes: `199`
- Slowest Agent subscriber dispatches:
  - `486` events: `470ms`
  - `477` events: `414ms`
  - `500` events: `385ms`
  - `202` events: `385ms`

Interpretation:

- The Agent processor is the only processor with large reduced state. At 1000
  model-visible rows it is already writing `~121KB-255KB` state snapshots.
- The cost of a single Agent subscriber dispatch tracks both:
  - how many events the Agent processor reduces; and
  - how large the Agent history state has become by the save point.
- `agent-chat-responses` is worse than direct `agent-inputs` because it has both
  costs:
  - `agent-chat` appends derived `agent/input-added` rows;
  - `agent` then persists a growing full-history state snapshot.
- This strongly suggests the Agent processor state shape is not suitable for
  very high velocity streams if every input row is retained in one reduced-state
  JSON blob.

Possible next experiments:

- Cap or window Agent reduced-state history and reconstruct full model context
  from stream history only when preparing an LLM request.
- Split Agent model-visible history into append-only events plus a compact
  reducer state containing cursors/counts/current request config.
- Add a benchmark mode with fixed-size Agent state to isolate storage size from
  event count.

### 2026-05-08: WebSocket subscription transport comparison

Hypothesis:

- A WebSocket subscription from Stream DO to Agent DO might be faster than
  Workers RPC callable delivery for high-rate processor streams.

Benchmark:

- Benchmark: `agent-server-bench-1778213057056-078b74fd`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Subscriber mode: `both`
- Subscription transport: `websocket`

Result:

- Publish duration: `1044ms`
- Append p50/p90/p99: `18/40/70ms`
- Callable source wait: `5ms`, but this is not a valid success signal because
  the Agent subscriber is no longer represented by callable subscriber cursors.
- Processor wait: timed out after `30062ms`
- Agent processor state at timeout:
  - `agent` reduced through offset `494`;
  - `agent-chat` reduced through offset `494`;
  - stream had `1000+` benchmark events.
- Agent local delivery delays showed severe backlog:
  - offset `101`: `4880ms`
  - offset `151`: `8022ms`
  - offset `231`: `12695ms`
  - offset `286`: `15767ms`
  - offset `385`: `23230ms`
  - offset `461`: `28530ms`
- Processor timings show tiny batches:
  - repeated `agent-chat` batches with `inputEventCount: 1`;
  - each derived append took roughly `53-84ms`.

Interpretation:

- The current WebSocket subscription path is much worse for processor delivery
  than batched Workers RPC.
- It appears to deliver effectively one event at a time to the Agent DO, which
  destroys batching and turns `agent-chat` derived appends into a serial
  per-event cost.
- The WebSocket benchmark currently also exposes a measurement bug: callable
  cursor waits do not measure WebSocket subscriber catch-up, so `source wait:
5ms` is misleading.
- Do not pursue WebSocket transport as a performance fix until it supports
  batch frames and has a real cursor/progress diagnostic.

### 2026-05-08: Idempotency-key duplicate append suspicion

Question:

- Could a processor bug be hidden because it appends the same logical event many
  times with the same idempotency key, so the stream only commits one event?

Current answer:

- Yes, this is a real failure mode to guard against, but the Stream DO now has a
  direct diagnostic for it.
- Stream storage has an `idempotency_duplicate_attempts` table keyed by
  `idempotency_key`.
- `StreamDurableObject.getDiagnostics()` reports:
  - `idempotencyCommittedEventCount`
  - `idempotencyDuplicateAttemptCount`
  - `idempotencyDuplicateKeyCount`
  - `idempotencyLogicalAppendAttemptCount`
  - `idempotencyDuplicateTopKeys`
- The server benchmark evaluates this invariant and fails when:
  - total duplicate attempts exceed the configured maximum; or
  - duplicate attempts appear for unexpected key prefixes.

Implication:

- If every committed idempotent event had actually been attempted 10 times with
  the same key, the diagnostic should show roughly:
  - `idempotencyDuplicateAttemptCount ~= committedIdempotentEvents * 9`
  - `idempotencyLogicalAppendAttemptCount ~= committedIdempotentEvents * 10`
  - top duplicate keys with `duplicateAttempts: 9`
- The default benchmark threshold is intentionally low
  (`--max-idempotency-duplicate-attempts 25`), so a broad 10x append loop should
  fail even if the key prefix is in the allowed list.

Remaining gap:

- The current duplicate table tells us which idempotency key duplicated, event
  type, stream path, target offset, and first/last duplicate time.
- It does not yet attribute duplicate attempts to a specific append source or
  stack/caller. If this counter starts rising, the next instrumentation should
  add a lightweight append-source label at central append call sites rather than
  logging every event.

### 2026-05-08: Agent status updates isolate small Agent state

Hypothesis:

- If the stream path and subscriber delivery are basically healthy, then traffic
  that is consumed by Agent but does not grow full model-visible history should
  process much faster than `agent-chat` or `agent/input-added` traffic.

Benchmark:

- Benchmark: `agent-server-bench-1778214089673-9ef385d9`
- Traffic: `1000` `agent/status-updated` events at `1000/s`
- Subscriber mode: `both`
- Subscription transport: RPC

Result:

- Publish duration: `1090ms`
- Source subscriber wait: `130ms`
- Final subscriber wait: `11ms`
- Processor wait: `12ms`
- Append p50/p90/p99: `30/72/92ms`
- Duplicate invariant: passed, `15` duplicate attempts, `0` unexpected
- Alarm diagnostics:
  - schedule requests: `1030`
  - `setAlarm()` calls: `11`
  - coalesced while scheduled: `1019`

Processor state diagnostics:

- `agent`:
  - batches: `11`
  - save calls: `16`
  - cumulative saved JSON bytes: `39131`
  - max state JSON bytes: `2506`
  - total afterAppend/append duration: `29ms`
- `agent-chat`:
  - batches: `11`
  - max state JSON bytes: `248`
  - total afterAppend/append duration: `60ms`
- `openai-ws`:
  - batches: `11`
  - max state JSON bytes: `199`
  - total afterAppend/append duration: `18ms`

Interpretation:

- The same stream and subscriber machinery can process 1000 events at 1000/s
  with low processor lag when Agent reduced state stays compact.
- This reinforces the current bottleneck ranking:
  1. Agent full-history reduced state growth.
  2. `agent-chat` derived appends when every visible chat event becomes an
     `agent/input-added` event.
  3. Stream alarm/cursor delivery mechanics.
- The stream delivery path is still not at the desired `~0ms` self-delivery lag,
  but the huge delay cases are now much more strongly tied to processor work and
  state shape than to the scheduled-alarm delivery loop alone.

### 2026-05-08: Compact-state stress above 1000/s

Change:

- Raised the debug-only `project.agents.benchmarkStream` input caps:
  - `count`: `2000` -> `10000`
  - `ratePerSecond`: `2000` -> `10000`
  - `concurrency`: `100` -> `500`

Blocked attempt before cap raise:

- `5000` events at `5000/s`, `concurrency=500` failed request validation because
  the previous debug benchmark caps were too low.

Benchmark A:

- Benchmark: `agent-server-bench-1778214198910-9f099224`
- Traffic: `2000` `agent/status-updated` events at `2000/s`
- Subscriber mode: `both`
- Publisher: app worker

Result:

- Publish duration: `2346ms`
- Source subscriber wait: `142ms`
- Final subscriber wait: `4ms`
- Processor wait: `4ms`
- Append p50/p90/p99: `107/137/239ms`
- Agent state stayed compact:
  - max state JSON bytes: `2509`
  - max input batch: `200`

Benchmark B:

- Benchmark: `agent-server-bench-1778214387794-9581eabc`
- Traffic: `5000` `agent/status-updated` events at `5000/s`
- Subscriber mode: `both`
- Publisher: app worker

Result:

- Publish duration: `5803ms`
- Source subscriber wait: `229ms`
- Final subscriber wait: `9ms`
- Processor wait: `5ms`
- Append p50/p90/p99: `567/636/672ms`
- Agent state stayed compact:
  - max state JSON bytes: `2508`
  - max input batch: `500`
- Slowest Agent subscriber deliveries were large batches:
  - `500` events: `624ms`
  - `500` events: `588ms`
  - `500` events: `538ms`
  - `500` events: `514ms`

Benchmark C:

- Benchmark: `agent-server-bench-1778214430596-ca9726f1`
- Traffic: `5000` `agent/status-updated` events at `5000/s`
- Subscriber mode: `agent-only`
- Publisher: app worker

Result:

- Publish duration: `6141ms`
- Source subscriber wait: `956ms`
- Final subscriber wait: `10ms`
- Processor wait: `5ms`
- Append p50/p90/p99: `589/667/726ms`
- Slowest Agent subscriber deliveries:
  - `500` events: `801ms`
  - `500` events: `785ms`
  - `500` events: `606ms`
  - `500` events: `603ms`

Benchmark D:

- Benchmark: `agent-server-bench-1778214475517-3a83581f`
- Traffic: `5000` `agent/status-updated` events at `5000/s`
- Subscriber mode: `agent-only`
- Publisher: AgentDurableObject

Result:

- Publish duration: `9006ms`
- Source subscriber wait: `9ms`
- Final subscriber wait: `3ms`
- Processor wait: `3ms`
- Append p50/p90/p99: `848/1157/1500ms`
- Slowest Agent subscriber deliveries:
  - `161` events: `1041ms`
  - `448` events: `632ms`
  - `470` events: `560ms`
  - `482` events: `516ms`

Interpretation:

- Compact Agent state can keep processor cursor catch-up fast even at 5000
  events, but publish latency climbs sharply under high concurrency to one
  Stream DO.
- AgentDurableObject publishing makes post-publish source wait almost disappear,
  but publish itself becomes slower. That means the measurement is partly
  "how much work was already processed before the publisher returned."
- For compact-state traffic, the visible bottleneck is now large batch dispatch
  from Stream DO to Agent DO, not Agent state size.
- However, the Agent processor timing currently rounds many batches to `0ms`,
  while Stream DO measures hundreds of ms for the subscriber RPC call. That gap
  needs a no-op subscriber control.

### 2026-05-08: No-op Agent subscriber isolates batch RPC cost

Hypothesis:

- If hundreds of milliseconds per `500` event Agent batch are mostly Workers RPC
  serialization/scheduling, then a no-op Agent subscriber receiving the same
  batch payload should show similar dispatch times.
- If no-op is much faster, the overhead is inside AgentDurableObject
  `afterAppendBatch` / stream processor hosting, even for compact-state traffic.

Harness:

- Added debug subscriber mode: `agent-noop-only`.
- First implementation used RPC method `benchmarkNoopAfterAppendBatch`.
- That was a bad harness because `external-subscriber` only uses the batch fast
  path when `rpcMethod === "afterAppendBatch"`. The first no-op run fell back to
  per-event delivery, timed out waiting for cursors, and was discarded except as
  a harness lesson.
- Fixed by passing `subscriberSlug` in the `afterAppendBatch` payload and making
  AgentDurableObject short-circuit when the subscriber slug starts with
  `agent-noop:`.

Corrected benchmark:

- Benchmark: `agent-server-bench-1778215030303-a9f3787e`
- Traffic: `5000` `agent/status-updated` events at `5000/s`
- Subscriber mode: `agent-noop-only`
- Publisher: app worker

Result:

- Publish duration: `6433ms`
- Source subscriber wait: `37ms`
- Final subscriber wait: `2ms`
- Append p50/p90/p99: `587/678/901ms`
- No-op subscriber deliveries:
  - delivered events: `5028`
  - delivery calls: `14`
  - max no-op batch dispatch: `96ms`
  - total no-op batch dispatch: `447ms`
  - representative `500` event batches: `30-96ms`

Interpretation:

- Pure Stream DO -> Agent DO batched Workers RPC with `500` small events costs
  tens of ms, not hundreds.
- The hundreds-of-ms real Agent subscriber deliveries are therefore not just
  payload transfer. They are in AgentDurableObject `afterAppendBatch` or the
  stream processor host path around it.
- The next instrumentation should split Agent `afterAppendBatch` into:
  - time before method body starts, if measurable from `deliveryStartedAtMs`;
  - `ensureStarted`;
  - filter/consume loop;
  - cursor/state reads and writes;
  - processor state JSON serialization and storage.
- The no-op run also confirms that the alarm/cursor loop can catch up quickly
  when subscriber work is truly tiny: `5000` events delivered with `37ms` source
  wait after publish.

### 2026-05-08: Cloudflare traces and unused batch return values

Trace check:

- Used Cloudflare Workers observability for account
  `cc7f6f461fbe823c199da2b27f9e0ff3`, worker `os2-preview-2`.
- Corrected no-op benchmark timeframe:
  - `2026-05-08T04:36:30Z` to `2026-05-08T04:38:30Z`
  - Benchmark: `agent-server-bench-1778215030303-a9f3787e`
- Trace summary included many alarm traces and one long trace:
  - trace id: `df06c8919fa46b3388c78ab0c8026eaa`
  - duration: `12089ms`
  - spans: `20310`
  - errors: `0`
- A sampled event query on that trace showed:
  - `jsrpc` spans dominated sampled non-storage duration;
  - most durable object storage spans were reported as `0ms`.

Real Agent benchmark trace:

- Timeframe:
  - `2026-05-08T04:26:10Z` to `2026-05-08T04:27:50Z`
  - Benchmarks around `agent-server-bench-1778214387794-9581eabc` and
    `agent-server-bench-1778214430596-ca9726f1`
- Long trace:
  - trace id: `fd1a0f81834a6be943ea90063969ca08`
  - duration: `33817ms`
  - spans: `20589`
  - errors: `0`
- Sampled summary from that trace:
  - `durable_object_subrequest`: `297` sampled spans, total sampled duration
    `215325ms`, max `725ms`
  - `jsrpc`: `38` sampled spans, total sampled duration `25103ms`, max
    `22483ms`
- The longest sampled `jsrpc` span was:
  - entrypoint: `AgentDurableObject`
  - method: `getRuntimeState`
  - duration: `22483ms`
  - wall time: `22234ms`
  - CPU time: `1ms`

Interpretation:

- Long wall-time/low-CPU `getRuntimeState` strongly suggests Durable Object
  queueing/backpressure, not CPU-bound reducer work.
- Several trace-level long spans are benchmark observer calls, not necessarily
  the actual event delivery call. Benchmark diagnostics still need to be read
  together with traces.
- One concrete waste became obvious while comparing no-op and real Agent
  batches: Agent and Codemode batch subscriber methods returned their reduced
  runtime state to Stream DO, but Stream DO ignores subscriber return values.
- Returning full state is especially bad for Agent because the returned object
  can include growing reduced history state.

Change:

- AgentDurableObject `afterAppendBatch` now consumes events and returns nothing.
- CodemodeSession `afterAppendBatch` now consumes events and returns nothing.
- No-op Agent benchmark subscriber also returns nothing.

Validation:

- Typechecks:
  - `pnpm --dir apps/os2 typecheck`
  - `pnpm --dir packages/shared typecheck`
- Deployed to preview slot 2.

Post-change benchmark A:

- Benchmark: `agent-server-bench-1778215568324-b1dae036`
- Traffic: `2000` `agent/status-updated` events at `2000/s`
- Subscriber mode: `both`
- Publisher: app worker
- Result:
  - publish duration: `2103ms`
  - source subscriber wait: `225ms`
  - processor wait: `6ms`
  - final subscriber wait: `4ms`
  - append p50/p90/p99: `99/120/141ms`
  - largest post-startup Agent batches:
    - `177` events: `249ms`
    - `200` events: `196ms`
    - `216` events: `172ms`

Post-change benchmark B:

- Benchmark: `agent-server-bench-1778215604848-2fb44df9`
- Traffic: `5000` `agent/status-updated` events at `5000/s`
- Subscriber mode: `both`
- Publisher: app worker
- Concurrency: `100`
- Result:
  - publish duration: `5468ms`
  - source subscriber wait: `93ms`
  - processor wait: `6ms`
  - final subscriber wait: `3ms`
  - append p50/p90/p99: `106/121/144ms`
  - slowest Agent batches were `100-101` events and `81-109ms`

Post-change benchmark C:

- Benchmark: `agent-server-bench-1778215641364-083115d6`
- Traffic: `5000` `agent/status-updated` events at `5000/s`
- Subscriber mode: `both`
- Publisher: app worker
- Concurrency: `200`
- Result:
  - publish duration: `5077ms`
  - source subscriber wait: `93ms`
  - processor wait: `12ms`
  - final subscriber wait: `4ms`
  - append p50/p90/p99: `193/228/288ms`
  - slowest Agent batches were `200-223` events and `159-298ms`

Post-change benchmark D:

- Benchmark: `agent-server-bench-1778215678575-66387c3f`
- Traffic: `1000` `agent/input-added` events at `1000/s`
- Subscriber mode: `both`
- Publisher: app worker
- Result:
  - publish duration: `1072ms`
  - source subscriber wait: `186ms`
  - processor wait: `6ms`
  - final subscriber wait: `3ms`
  - append p50/p90/p99: `39/90/112ms`
  - Agent max state JSON bytes: `121362`
  - largest post-startup Agent batches:
    - `194` events: `196ms`
    - `259` events: `116ms`
- Compared with the prior direct `agent-inputs` run:
  - source subscriber wait improved `273ms -> 186ms`
  - append p99 improved `126ms -> 112ms`
  - largest post-startup Agent dispatch improved from about `352ms` to `196ms`

Post-change benchmark E:

- Benchmark: `agent-server-bench-1778215708597-3eba6253`
- Traffic: `1000` `agent-chat/assistant-response-added` events at `1000/s`
- Subscriber mode: `both`
- Publisher: app worker
- Result:
  - publish duration: `1558ms`
  - source subscriber wait: `663ms`
  - processor wait: `4ms`
  - final subscriber wait: `4ms`
  - append p50/p90/p99: `120/209/258ms`
  - Agent max state JSON bytes: `254525`
  - `agent-chat` afterAppend/append duration: `1182ms`
- Compared with the prior `agent-chat-responses` run:
  - source subscriber wait improved `946ms -> 663ms`
  - the dominant remaining cost is still derived appends from `agent-chat`
    into `agent/input-added`.

Important failed/unstable run:

- `5000` status events at `5000/s` with `concurrency=500` failed once with a
  generic oRPC `500` after this change.
- Lower concurrency runs succeeded:
  - `concurrency=100`: p99 `144ms`
  - `concurrency=200`: p99 `288ms`
- Current operating hypothesis:
  - high publish concurrency to one Stream DO creates queueing/tail latency and
    can trip generic worker errors;
  - the benchmark should model realistic upstream backpressure rather than
    treating very high client-side concurrency as a free throughput knob.

Current conclusions:

- Removing unused batch return values is a real improvement and should stay.
- For compact-state traffic, 5000/s is achievable with low post-publish source
  wait when publish concurrency is bounded around `100`.
- For full Agent history traffic, returning less helps, but the state shape is
  still too large.
- For `agent-chat`, derived append volume is now the main visible bottleneck.

### 2026-05-08: Cloudflare docs/Kenton reading notes

Sources read:

- Kenton Varda, "We've added JavaScript-native RPC to Cloudflare Workers"
  - https://blog.cloudflare.com/javascript-native-rpc/
- Kenton Varda, "Durable Objects: Easy, Fast, Correct - Choose three"
  - https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/
- Cloudflare Workers RPC docs
  - https://developers.cloudflare.com/workers/runtime-apis/rpc/
- Cloudflare Durable Objects alarms docs
  - https://developers.cloudflare.com/durable-objects/api/alarms/

Relevant notes:

- Workers RPC is designed to make Worker/DO calls feel like local method calls,
  but parameters and return values are still transferred across a remote
  boundary. The docs describe RPC parameters and return values as structured
  clonable values. That reinforces the benchmark lesson: do not return large
  reduced state from fire-and-forget subscriber calls.
- Kenton's Durable Objects writing emphasizes that a DO instance is single
  threaded and owns its state in one place. This matches the observed queueing:
  one hot Stream DO can serialize many concurrent append calls, alarm delivery,
  derived appends, diagnostics, and benchmark reads.
- The Durable Objects alarms docs say each DO can only have one alarm scheduled
  at a time, while alarm handlers are intended for queue/batch-style work and
  execute at least once with retry behavior. This supports the current design
  direction of one alarm-driven delivery loop plus per-subscriber cursors, but
  also means we need explicit coalescing and bounded work per alarm.
- The docs also warn that `setAlarm()` replaces an existing scheduled alarm.
  This supports keeping the scheduled-only coalescing logic: many append calls
  should not blindly fight over alarm timestamps.

Design implications for this stream processor system:

- Keep RPC call payloads and return values intentionally small.
- Treat every hot Stream DO as a single-threaded queue; caller concurrency is
  backpressure, not free throughput.
- Prefer batching at the alarm/subscriber boundary, but bound batch size and
  per-alarm work so diagnostics/read calls are not stuck behind long delivery
  loops.
- Avoid observer methods like `getRuntimeState()` participating in hot traces
  unless necessary; they can queue behind delivery work and then look like
  product latency.

### 2026-05-08: processor append-call timing diagnostic

Change:

- Added `appendCallTimings` to `withStreamProcessor` runtime batch timings.
- Each processor batch timing now records each processor-originated `append` or
  `appendBatch` call with:
  - kind: `append` or `appendBatch`;
  - event count requested by the processor;
  - duration of the call back into the Stream DO.
- Commit: `6613f66ea` (`Trace processor append call timings`).

Reason:

- Prior `agent-chat-responses` runs showed almost all `agent-chat` time under
  `afterAppend`, but that did not separate CPU work from waiting on the Stream
  DO append RPC.
- The new field lets us distinguish:
  - local processor/reducer work;
  - processor-originated append wait;
  - downstream subscription/cursor wait.

RPC subscriber benchmark:

- File: `/tmp/os2-bench-agent-chat-both-1000-append-call-timings.json`
- Benchmark id: `agent-server-bench-1778216282947-0fcae9cb`
- Traffic: `agent-chat-responses`
- Count/rate/concurrency: `1000`, `1000/s`, `100`
- Subscriber mode: `both`
- Subscription transport: `rpc`
- Result:
  - publish duration: `1048ms`
  - source subscriber wait: `791ms`
  - processor wait: `92ms`
  - final subscriber wait: `3ms`
  - append p50/p90/p99: `27/81/110ms`
  - idempotency duplicate invariant: passed
  - duplicate attempts: `15`

Processor timings:

- `agent-chat`:
  - total retained processor time: `978ms`
  - `appendDurationMs`: `978ms`
  - append calls: `6`
  - derived appended events: `1002`
  - largest append calls:
    - `269` events in `274ms`
    - `315` events in `198ms`
    - `102` events in `161ms`
    - `101` events in `159ms`
    - `196` events in `128ms`
- `agent`:
  - retained total: `22ms`
  - one append call: `22ms`
  - max state JSON bytes: `254590`
- `openai-ws`:
  - retained total: `41ms`
  - two append calls: `21ms` and `20ms`

Interpretation:

- For this benchmark, `agent-chat` is not CPU-bound. Its retained
  `afterAppendBatch` time is effectively all time spent awaiting derived
  `appendBatch` calls back into the same hot Stream DO.
- The likely architectural shape is:
  - Stream DO alarm drains original events;
  - Stream DO calls Agent DO `afterAppendBatch`;
  - `agent-chat` inside Agent DO awaits `appendBatch` back into the same Stream
    DO;
  - that Stream DO is also the alarm runner that is waiting for the Agent DO
    call to return.
- Cloudflare DO reentrancy means this does not deadlock, but it creates exactly
  the kind of serialized queueing we are seeing.
- This supports experimenting with one or more of:
  - not awaiting processor-derived appends from subscriber delivery;
  - a same-runner local feed-through path that can continue processing committed
    returned events without waiting for subscription redelivery;
  - separating subscriber dispatch from derived append acknowledgement;
  - a clean WebSocket replacement path that actually batches.

WebSocket subscriber benchmark:

- File: `/tmp/os2-bench-agent-chat-both-websocket-1000-append-call-timings.json`
- Benchmark id: `agent-server-bench-1778216449034-f7cb624d`
- Same traffic/count/rate/concurrency.
- Subscription transport: `websocket`
- Important caveat:
  - this is not a clean replacement benchmark because Agent startup still
    installs the callable `afterAppendBatch` subscription; the WebSocket
    subscription is additive in the current harness.
- Result:
  - publish duration: `1103ms`
  - source subscriber wait: `7ms`
  - processor wait: timed out after `30088ms`
  - last processor cursor: around offset `522`
  - final subscriber wait: `4ms`
  - append p50/p90/p99: `22/65/108ms`
  - idempotency duplicate invariant: passed

WebSocket interpretation:

- Existing WebSocket delivery is much worse for this workload.
- The Agent DO receives/processes WebSocket frames one at a time, so retained
  timings show many single-event processor batches.
- `agent-chat` retained timing window showed `16` one-event `appendBatch` calls,
  around `56-75ms` each, and the run failed to drain within the `30s` processor
  wait.
- WebSocket cannot be judged as a replacement until it has a batched frame
  protocol or a coalescing layer at the subscriber boundary.

Current conclusion:

- Callable RPC `afterAppendBatch` remains the best current transport for
  high-rate agent stream delivery.
- The next performance experiment should target the StreamDO -> AgentDO ->
  StreamDO loop, not raw reducer speed.
- A good next minimal experiment is to make `agent-chat` derived append delivery
  return quickly while preserving error visibility, then compare:
  - processor wait;
  - final subscriber wait;
  - local append delivery delays;
  - missing/skipped event counts.

### 2026-05-08: async agent-chat derived append experiment

Change:

- `agent-chat` now schedules derived `agent/input-added` appends through
  processor `waitUntil` when the runner provides it.
- If the derived append fails, `agent-chat` attempts to append a
  `core/error-occurred` event with idempotency key
  `agent-chat/transcription-error@<sourceOffset>`.
- `withStreamProcessor` now schedules a local feed-through drain after
  processor-originated `append`/`appendBatch` completes. This matters when the
  append completes after the original delivery lane has already returned.
- Commit: `19974a366` (`Schedule agent chat derived appends asynchronously`).

Verification before deploy:

- `pnpm --dir packages/shared typecheck`
- `pnpm --dir apps/os2 typecheck`
- `pnpm --dir packages/shared test -- agent-chat/implementation.test.ts`
  - Note: this package script runs the broader shared test groups before the
    specific stream-processor test filter.
  - Passed.
  - Existing noisy warnings:
    - WebSocket peer disconnected warnings from callable tests;
    - `rrule` sourcemap warnings from durable-object-utils tests.

Preview deploy:

- Deployed to preview slot 2 with:
  - `doppler run --project os2 --config preview_2 -- pnpm --dir apps/os2 alchemy:up`

Benchmark:

- File: `/tmp/os2-bench-agent-chat-both-1000-async-derived.json`
- Benchmark id: `agent-server-bench-1778216847721-cd1e9a6d`
- Traffic: `agent-chat-responses`
- Count/rate/concurrency: `1000`, `1000/s`, `100`
- Subscriber mode: `both`
- Subscription transport: `rpc`

Comparison against the previous RPC run:

| Metric                 | Awaited derived append | Async derived append |
| ---------------------- | ---------------------: | -------------------: |
| publish duration       |               `1048ms` |             `1272ms` |
| source subscriber wait |                `791ms` |              `842ms` |
| processor wait         |                 `92ms` |               `12ms` |
| final subscriber wait  |                  `3ms` |               `11ms` |
| append p50/p90/p99     |          `27/81/110ms` |       `89/124/144ms` |
| duplicate attempts     |                   `15` |                 `13` |
| duplicate invariant    |                 passed |               passed |

Processor timing comparison:

- Awaited run:
  - `agent-chat` retained total: `978ms`
  - `agent-chat.appendDurationMs`: `978ms`
  - derived append calls: `6`
  - derived appended events: `1002`
  - retained local append delivery delay sample: `84ms`
- Async run:
  - `agent-chat` retained total: `0ms`
  - `agent-chat.appendDurationMs`: `1226ms`
  - derived append calls: `6`
  - derived appended events: `1002`
  - retained local append delivery delay sample: `0ms`

Important interpretation:

- This is a mixed result, not a solution.
- Returning from `agent-chat.afterAppendBatch` quickly does reduce processor
  cursor wait and makes same-runner local derived-event delivery effectively
  immediate in the retained samples.
- It does not reduce the underlying Stream DO append work. The derived
  `appendBatch` calls still take about as long in aggregate, now outside the
  awaited `afterAppendBatch` path.
- Publish latency and source subscriber wait got slightly worse. That suggests
  the work was moved out of the critical processor cursor path, not removed
  from the hot Stream DO.
- This may still help user-visible follow-up processing because derived events
  are locally fed through with near-zero delay, but it is not enough for the
  whole stream system target.

Cloudflare trace:

- Account: iterate dev/stg (`cc7f6f461fbe823c199da2b27f9e0ff3`)
- Worker: `os2-preview-2`
- Timeframe queried: `2026-05-08T05:06:30Z` to `2026-05-08T05:09:30Z`
- Main benchmark trace:
  - trace id: `41e063c8f5b5a3908d78f71467f2ec10`
  - root: `POST .../agents/benchmark-stream/%2Fagents%2Fserver-bench-1778216841774`
  - trace duration: `7969ms`
  - sampled spans in trace summary: `2936`
  - errors: none
- Sampled events summary from first `1000` trace events:
  - `durable_object_subrequest`: `418` spans, total sampled duration `73984ms`,
    max `294ms`
  - `jsrpc`: `170` spans, total sampled duration `39435ms`, max `27944ms`
  - storage spans sampled as `0ms` duration

Trace interpretation:

- This continues to point at DO/RPC queueing, not reducer CPU or SQLite.
- The very long `jsrpc` span is likely an observer/benchmark call queued behind
  stream work, consistent with the earlier `getRuntimeState()` trace finding.
- The large count of `durable_object_subrequest` spans around `200-300ms`
  aligns with the processor append-call timings and hot Stream DO queueing.

Current conclusion:

- Async derived appends are useful as a narrow latency tool for local derived
  event feed-through, but not sufficient as the main throughput fix.
- The next architectural experiment should reduce the Stream DO subrequest/RPC
  queue itself:
  - cleanly replace callable delivery with batched WebSocket delivery, not an
    additive single-event WebSocket path;
  - or add first-class event-type routing so processors are not invoked for
    irrelevant event classes;
  - or split processor cursor/state storage so ignored events do not rewrite
    full processor state.

### 2026-05-08: batched WebSocket subscriber delivery

Change:

- Stream WebSocket subscriber delivery can now send one `events` frame carrying
  a batch of committed stream events.
- `AgentDurableObject` accepts both legacy single-event `event` frames and new
  batched `events` frames, then calls the same batch processor path used by
  callable delivery.
- Commit: `807aac78d` (`Batch stream websocket subscriber delivery`).

Benchmark:

- File: `/tmp/os2-bench-agent-chat-both-websocket-batched-1000.json`
- Benchmark id: `agent-server-bench-1778217316807-fc715a55`
- Traffic: `agent-chat-responses`
- Count/rate/concurrency: `1000`, `1000/s`, `100`
- Subscriber mode: `both`
- Subscription transport: `websocket`
- Important caveat:
  - this is still not a clean replacement benchmark because Agent startup also
    installs the normal callable subscription; the WebSocket subscription is
    additive in the current benchmark harness.

Result:

- publish duration: `1617ms`
- source subscriber wait: `5ms`
- processor wait: `2900ms`
- final subscriber wait: `7ms`
- append p50/p90/p99: `137/162/167ms`
- terminal p50/p90/p99: `68/68/68ms`
- duplicate invariant: passed
- committed idempotent events: `241`
- duplicate attempts: `12`
- logical idempotent append attempts: `253`
- duplicate attempt ratio: `0.05`
- alarm diagnostic:
  - schedule requests: `1243`
  - actual `setAlarm()` calls: `23`
  - coalesced while scheduled: `1220`

Comparison:

| Metric              | Unbatched WebSocket | Batched WebSocket |
| ------------------- | ------------------: | ----------------: |
| publish duration    |            `1103ms` |          `1617ms` |
| source wait         |               `7ms` |             `5ms` |
| processor wait      |          `30088ms+` |          `2900ms` |
| append p50/p90/p99  |       `22/65/108ms` |   `137/162/167ms` |
| duplicate attempts  |                `13` |              `12` |
| duplicate invariant |              passed |            passed |

Interpretation:

- Batching WebSocket frames fixes the catastrophic single-frame backlog: the
  previous run failed to drain after `30s`; this run drained in `2.9s`.
- It is still much worse than the best RPC + async-derived run for processor
  wait, and append latency got worse.
- Because the WebSocket subscription is additive, this result does not prove
  WebSocket is worse as a replacement transport. It only proves that batched
  frames are necessary and that the current mixed transport is not sufficient.
- The retained runtime timing window still showed mostly `inputEventCount: 1`
  batches. That may be because the last retained timings are callable/default
  or terminal traffic rather than the WebSocket batch frames. We need either a
  larger timing window or per-transport aggregate counters before drawing a
  stronger conclusion.

Next experiment:

- Add a clean benchmark mode that disables the default callable subscription
  for the agent path and measures WebSocket as a replacement, not an additive
  subscriber.
- Add aggregate subscriber-delivery counters by transport:
  - delivered event count;
  - batch count;
  - max/p50/p90 batch size;
  - delivery duration.

### 2026-05-08: how to detect idempotency masking repeated appends

Concern:

- A processor could append the same logical event repeatedly with the same
  idempotency key.
- The visible stream would look correct because only the first append commits
  an event; later attempts return the existing event.
- This can hide severe bugs and create large hidden load.

How we know today:

- `StreamDurableObject.append()` and `appendBatch()` record a duplicate attempt
  before returning an existing idempotent event.
- The duplicate attempt is durable SQLite state, not just in-memory debug state:
  `idempotency_duplicate_attempts`.
- `StreamDurableObject.getDiagnostics()` reports:
  - `idempotencyCommittedEventCount`
  - `idempotencyDuplicateAttemptCount`
  - `idempotencyDuplicateKeyCount`
  - `idempotencyLogicalAppendAttemptCount`
  - `idempotencyDuplicateTopKeys`
- The server benchmark fails the run when duplicate attempts exceed the budget
  or when duplicate attempts appear outside the allowlisted setup prefixes.

The exact `10x` case:

- Suppose a stream commits `1000` unique idempotent events.
- If every event was actually attempted `10` times with the same key, the
  stream would still show only `1000` committed events.
- Diagnostics should show roughly:
  - committed idempotent events: `1000`
  - duplicate attempts: `9000`
  - logical idempotent append attempts: `10000`
  - duplicate attempt ratio: `9`
- The current default benchmark budget is `25` duplicate attempts, so this
  would fail immediately even if all duplicate keys had an allowed setup prefix.

Current limitation:

- The aggregate duplicate count is authoritative for storm detection.
- The unexpected-prefix check currently examines the top duplicate keys returned
  by diagnostics, limited to `50`. A broad small duplicate class below that
  top-N window could be missed by prefix attribution if the total duplicate
  count stayed under the global budget.
- The diagnostics identify key, event type, stream path, target committed
  offset, and first/last duplicate timestamps. They do not yet identify the
  append caller or processor instance that made the duplicate attempt.

Next instrumentation if this counter rises:

- Add an append-source label at central stream API call sites, for example:
  - app route / benchmark publisher;
  - `withStreamProcessor` processor append;
  - JSONata reactor append;
  - stream topology/internal append;
  - external subscriber error append.
- Store source-label aggregates alongside duplicate attempts so we can answer:
  "which caller repeatedly attempted this idempotency key?"
- Consider returning all duplicate-key rows, or separate prefix aggregate counts,
  for benchmark invariant checks so unexpected low-count duplicate classes are
  not limited by top-N diagnostics.

### 2026-05-08: clean WebSocket replacement benchmark and measurement fixes

Problem found:

- The earlier `subscriptionTransport=websocket` benchmark was not clean enough.
- Agent startup installed the default callable subscriber, then the benchmark
  appended a WebSocket subscriber with the same slug.
- Because subscribers are keyed by slug, the WebSocket event replaces the
  callable once reduced, but warmup/setup ordering could still contaminate
  measurements.
- The benchmark also had two correctness gaps:
  - `processorWait` only targeted terminal events, not the full published
    traffic;
  - `agent-chat` now schedules derived appends asynchronously, so an
    `agent-chat` cursor reaching the source event does not prove the derived
    `agent/input-added` event is committed.

Changes:

- Added `subscriptionTransport=websocket-only`.
- Benchmark agent paths under `/agents/server-bench-*` and `/agents/bench-*`
  now skip AgentDurableObject's default startup subscription.
- The benchmark endpoint explicitly installs the requested Agent subscriber:
  - `rpc` installs a callable Agent subscriber;
  - `websocket` / `websocket-only` install a WebSocket Agent subscriber.
- `processorWait` now targets all published traffic plus terminal events.
- For `agent-chat-responses`, the benchmark now waits for corresponding
  `agent-chat/render-response@<sourceOffset>` derived `agent/input-added`
  events to appear in the stream.

Commits:

- `7e484ff06` - `Add clean websocket stream benchmark mode`
- `a3eaedf72` - `Measure processor wait against benchmark traffic`
- `c80380509` - `Wait for benchmark derived agent chat events`

Verification:

- `pnpm --dir apps/os2-contract typecheck`
- `pnpm --dir apps/os2 typecheck`
- Deployed to preview slot 2 after each benchmark-significant change.

Important measurement caveat:

- In `agent-only` mode the Codemode subscriber still exists with
  `jsonataFilter: false`, so callable cursor waits may report completion for
  that disabled callable subscriber.
- For WebSocket Agent delivery, `sourceSubscriberWait` and `finalSubscriberWait`
  are therefore not Agent-delivery metrics. The meaningful fields are:
  - `processorWait`;
  - `derivedEventWait`;
  - stream diagnostics;
  - duplicate invariant;
  - append latency.

Clean 500-event comparison:

RPC:

- File: `/tmp/os2-bench-agent-chat-agent-only-rpc-clean-target-500-fail2.json`
- Benchmark id: `agent-server-bench-1778218389626-50baa1b2`
- Traffic/count/rate/concurrency: `agent-chat-responses`, `500`, `1000/s`,
  `100`
- Subscriber mode: `agent-only`
- Transport: `rpc`
- Result:
  - publish duration: `805ms`
  - source callable wait: `833ms`
  - processor wait: `4ms`
  - final callable wait: `137ms`
  - append p50/p90/p99: `102/175/175ms`
  - duplicate invariant: passed
  - duplicate attempts: `17`
  - committed idempotent events: `522`

WebSocket-only:

- File:
  `/tmp/os2-bench-agent-chat-agent-only-websocket-only-derived-wait-500.json`
- Benchmark id: `agent-server-bench-1778218880454-903e854d`
- Same traffic/count/rate/concurrency.
- Subscriber mode: `agent-only`
- Transport: `websocket-only`
- Result:
  - publish duration: `1307ms`
  - processor wait: `1416ms`
  - derived event wait: `3076ms` for `500/500` derived events
  - append p50/p90/p99: `223/274/274ms`
  - duplicate invariant: passed
  - duplicate attempts: `13`
  - committed idempotent events: `522`

Clean 1000-event comparison:

RPC:

- File: `/tmp/os2-bench-agent-chat-agent-only-rpc-derived-wait-1000.json`
- Benchmark id: `agent-server-bench-1778218828095-12a04fa5`
- Traffic/count/rate/concurrency: `agent-chat-responses`, `1000`, `1000/s`,
  `100`
- Subscriber mode: `agent-only`
- Transport: `rpc`
- Result:
  - publish duration: `1749ms`
  - source callable wait: `697ms`
  - processor wait: `5ms`
  - derived event wait: `55ms` for `1000/1000` derived events
  - final callable wait: `10ms`
  - append p50/p90/p99: `141/173/181ms`
  - duplicate invariant: passed
  - duplicate attempts: `17`
  - committed idempotent events: `1022`
  - local delivery sample: derived offsets showed about `131ms` delay in the
    retained sample.

WebSocket-only:

- File:
  `/tmp/os2-bench-agent-chat-agent-only-websocket-only-derived-wait-1000-retry.json`
- Benchmark id: `agent-server-bench-1778218915813-89b4dccd`
- Same traffic/count/rate/concurrency.
- Subscriber mode: `agent-only`
- Transport: `websocket-only`
- Result:
  - publish duration: `1590ms`
  - processor wait: `2890ms`
  - derived event wait: `10323ms` for `1000/1000` derived events
  - append p50/p90/p99: `120/166/174ms`
  - duplicate invariant: passed
  - duplicate attempts: `17`
  - committed idempotent events: `1022`
  - local delivery sample: derived offsets showed about `33ms` delay in the
    retained sample.

Interpretation:

- Clean WebSocket replacement is better than the old unbatched WebSocket path,
  but still much worse than callable RPC for this agent workload.
- The bottleneck is not simply source-event delivery. WebSocket can get source
  frames into the Agent DO, but derived `agent/input-added` commits lag badly.
- The important comparison is:
  - RPC at `1000/s`: derived event wait `55ms`;
  - WebSocket-only at `1000/s`: derived event wait `10323ms`.
- The local retained delay sample can be misleading because it only records the
  last bounded window. The derived-event wait is the stronger metric.
- There was one transient WebSocket-only 1000 run that returned a generic 500
  before result serialization. A retry completed. Treat this as another reason
  to add explicit error logging around benchmark waits and WebSocket delivery.

Current conclusion:

- Do not replace callable RPC subscriber delivery with the current WebSocket
  subscriber implementation for Agent processors.
- The next useful WebSocket experiment would need:
  - aggregate WebSocket delivery counters in `AgentDurableObject`;
  - frame batch-size timings;
  - explicit error logs from `fetch("/stream-subscription")` processing;
  - a way to distinguish source delivery from processor-derived append
    completion.
- The next broader performance experiment should focus on the StreamDO/AgentDO
  derived append path and/or keeping callable RPC while reducing Stream DO
  queue pressure.

## Idempotency Duplicate Attempt Detection

Hypothesis:

- We may have bugs where processors repeatedly append the same logical event
  with the same idempotency key.
- The stream hides the duplicate commit, so the visible event log can look
  correct even if the runtime attempted the append many times.
- Example failure shape: every visible committed event has actually been
  attempted 10 times, but nine attempts per key returned the existing committed
  event.

Current detection:

- `StreamDurableObject.append()` and `appendBatch()` call
  `recordIdempotencyDuplicate()` whenever an input has an `idempotencyKey` that
  already exists.
- The duplicate path records into the DO-local SQLite table
  `idempotency_duplicate_attempts` before returning the existing event.
- `getDiagnostics()` exposes:
  - `idempotencyCommittedEventCount`;
  - `idempotencyDuplicateAttemptCount`;
  - `idempotencyDuplicateKeyCount`;
  - `idempotencyLogicalAppendAttemptCount`;
  - `idempotencyDuplicateTopKeys`;
  - `idempotencyDuplicateTopSources`;
  - recent in-memory `idempotencyDuplicates`.
- The server benchmark script evaluates a duplicate invariant from those
  diagnostics. If 1000 committed idempotent events were each attempted 10 times,
  we should see roughly 9000 duplicate attempts and a duplicate attempt ratio of
  about `9.0`.

What this already answers:

- A same-key append storm should not be invisible.
- It should appear as a high
  `idempotencyDuplicateAttemptCount / idempotencyCommittedEventCount` ratio.
- The top-key diagnostics should show specific idempotency keys with high
  `duplicateAttempts`.
- The source diagnostics should show metadata-derived culprit labels such as
  `processor:agent-chat`, `processor:agent`, `benchmark-publisher`, or
  `metadata.source`.

Remaining diagnostic gaps:

- The table does not currently record whether the duplicate attempt had the same
  payload/metadata as the committed event. A same-key/different-payload bug
  would be counted but not made loud enough.
- `idempotencyDuplicateTopKeys` is bounded, so it is good for benchmark
  invariant checks and recent debugging, but not a full forensic ledger.

Next instrumentation to add:

- Do not add new event fields or append API diagnostics for this.
- Use only the existing event `metadata` object to identify append origin.
- Read source labels from `metadata.provenance.processor.slug`,
  `metadata.benchmark`, or `metadata.source`.
- Store a compact attempted payload/metadata hash and record
  `mismatchedDuplicateAttempts`.
- Fail benchmark invariants when duplicate attempt ratio exceeds a small
  expected allowance, and separately fail on any same-key/different-payload
  duplicate.

Preview smoke after adding metadata-derived source counters:

- Deployed commit: `51e9343d2`
- Command:

```sh
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- \
pnpm --dir apps/os2 benchmark:agent-stream:server -- \
  --traffic agent-chat-responses \
  --count 30 \
  --rate 30 \
  --concurrency 5 \
  --subscriber-mode agent-only \
  --subscription-transport rpc
```

- File: `/tmp/os2-bench-duplicate-sources-smoke.json`
- Benchmark id: `agent-server-bench-1778219955174-3b02aa6d`
- Result:
  - duplicate invariant: passed
  - committed idempotent events: `52`
  - duplicate attempts: `12`
  - logical append attempts: `64`
  - duplicate attempt ratio: `0.23`
  - unexpected duplicate attempts: `0`
- Top metadata-derived duplicate sources:
  - `processor:agent`: `6` attempts for
    `processor-registered:agent:0.1.0`
  - `processor:openai-ws`: `3` attempts for
    `processor-registered:openai-ws:0.1.0`
  - `processor:codemode`: `2` attempts for
    `events.iterate.com/codemode/session-started`

Interpretation:

- This answers the hidden-idempotency concern for same-key duplicate storms:
  they now show up in stream diagnostics by total attempt count, key, and
  metadata-derived source.
- The smoke run already shows some expected idempotent setup churn. That is not
  invisible anymore, but it is still worth tightening once the larger
  performance bottleneck is clearer.

## 2026-05-08: high-rate RPC after duplicate-source diagnostics

All runs below used preview slot 2 after deploying `51e9343d2`.

### Agent-chat source events, app-worker publisher

`1000` events requested at `1000/s`, concurrency `100`:

- File: `/tmp/os2-bench-agent-chat-rpc-source-diagnostics-1000.json`
- Benchmark id: `agent-server-bench-1778220042615-2975e4f3`
- Publish duration: `1557ms`
- Append latency p50/p90/p99: `134/174/179ms`
- Source subscriber wait: `1017ms`
- Processor wait: `17ms`
- Derived `agent/input-added` wait: `46ms` for `1000/1000`
- Final subscriber wait: `45ms`
- Duplicate attempts: `17` over `1022` idempotent commits, ratio `0.02`
- Unexpected duplicate attempts: `0`

`3000` events requested at `1500/s`, concurrency `150`:

- File: `/tmp/os2-bench-agent-chat-rpc-source-diagnostics-3000-rate1500.json`
- Benchmark id: `agent-server-bench-1778220277702-68abda7a`
- Publish duration: `5189ms`
- Append latency p50/p90/p99: `237/336/354ms`
- Source subscriber wait: `3019ms`
- Processor wait: `103ms`
- Derived wait: `73ms` for `3000/3000`
- Final subscriber wait: `5ms`
- Duplicate attempts: `17` over `3022` idempotent commits, ratio `0.01`

`5000` events requested at `1000/s`, concurrency `100`:

- File: `/tmp/os2-bench-agent-chat-rpc-source-diagnostics-5000-rate1000.json`
- Benchmark id: `agent-server-bench-1778220316330-0fbb79f2`
- Publish duration: `9491ms`
- Append latency p50/p90/p99: `169/292/448ms`
- Source subscriber wait: `1398ms`
- Processor wait: `546ms`
- Derived wait: `372ms` for `5000/5000`
- Final subscriber wait: `12ms`
- Duplicate attempts: `17` over `5022` idempotent commits

`5000` events requested at `2000/s`, concurrency `200`:

- First attempt failed with a generic oRPC `500`.
- Cloudflare telemetry query for `2026-05-08T06:01:20Z` to
  `2026-05-08T06:02:40Z` found no `$metadata.level = error` rows and no
  `http.response.status_code >= 500` rows for `os2-preview-2`; several
  `span-not-ended` durable-object subrequest spans existed but did not explain
  the app-level failure.
- Retry file:
  `/tmp/os2-bench-agent-chat-rpc-source-diagnostics-5000-rate2000-retry.json`
- Retry benchmark id: `agent-server-bench-1778220458016-4a337a38`
- Retry publish duration: `8084ms`
- Append latency p50/p90/p99: `295/432/456ms`
- Source subscriber wait: `2310ms`
- Processor wait: `15ms`
- Derived wait: `170ms` for `5000/5000`
- Final subscriber wait: `562ms`
- Duplicate attempts: `12` over `5022` idempotent commits

Interpretation:

- The current RPC processor path is no longer showing the old multi-second
  derived-event delay once source publishing finishes.
- The weak point is append throughput into the Stream DO from the benchmark
  publisher. Requested `1000-2000/s` rates are not actually achieved; observed
  publish throughput is roughly `500-650/s` in these app-worker publisher runs.
- Duplicate idempotency attempts are not the explanation for the current
  throughput ceiling. They remain low and are dominated by setup events.

### Agent Durable Object publisher

`3000` agent-chat events requested at `1500/s`, concurrency `150`,
publisher `agent-durable-object`:

- File: `/tmp/os2-bench-agent-chat-agent-publisher-rpc-3000-rate1500.json`
- Benchmark id: `agent-server-bench-1778220362264-e53860c5`
- Publish duration: `10001ms`
- Append latency p50/p90/p99: `447/614/871ms`
- Source subscriber wait: `57ms`
- Processor wait: `11ms`
- Derived wait: `110ms` for `3000/3000`

Interpretation:

- Publishing from the Agent DO was slower than the app-worker publisher for
  this workload.
- That suggests the Agent DO should not become the high-throughput event
  publisher path unless it batches appends or otherwise decouples producer work
  from processor work.

### Raw OpenAI websocket-like source events

`5000` raw OpenAI websocket events requested at `2000/s`, concurrency `200`:

- File: `/tmp/os2-bench-raw-openai-rpc-5000-rate2000.json`
- Benchmark id: `agent-server-bench-1778220405853-0a6c7158`
- Publish duration: `8623ms`
- Append latency p50/p90/p99: `339/398/441ms`
- Source subscriber wait: `46ms`
- Processor wait: `17ms`
- Final subscriber wait: `10ms`

Interpretation:

- Removing `agent-chat` derived appends does not materially improve source
  append throughput; publishing still lands around `580/s`.
- Processor delivery is not the bottleneck for raw non-consuming-ish traffic.

Next experiment:

- Add an append-batch benchmark option and compare single-event append with
  `appendBatch` sizes such as `10`, `50`, and `100`.
- This matches Cloudflare's guidance that batching `10-100` logical messages
  per transport/frame can reduce per-message context-switch overhead.

## 2026-05-08: append batching and subscriber delivery experiments

Constraint reminder from the investigation:

- Do not modify the core event data schema for benchmark/perf diagnostics.
- Event-origin hints must come from the existing `event.metadata` object.
- Durable diagnostics tables are acceptable for runtime counters, but visible
  stream events must stay compatible with the existing event envelope.

### Batched benchmark publisher

Implemented and deployed:

- Commit `d61eb503c`: added `--append-batch-size` to the server benchmark and
  routed benchmark publishing through `stream.appendBatch({ events })`.
- This changes benchmark traffic generation only; raw stream events are still
  written individually in the stream history.

Best batch result with the then-current `500` event callable subscriber alarm
window:

```sh
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- \
pnpm --dir apps/os2 benchmark:agent-stream:server -- \
  --traffic agent-chat-responses \
  --count 5000 \
  --rate 2000 \
  --concurrency 5 \
  --append-batch-size 50 \
  --subscriber-mode agent-only \
  --subscription-transport rpc
```

- File: `/tmp/os2-bench-agent-chat-rpc-batch50-5000-rate2000-concurrency5.json`
- Benchmark id: `agent-server-bench-1778220854604-fe4cc8ac`.
- Publish duration: `2630ms`, roughly `1900/s` effective source publishing.
- Append latency p50/p90/p99: `46/169/265ms`.
- Source subscriber wait: `2341ms`.
- Processor wait: `354ms`.
- Derived `agent/input-added` wait: `125ms` for `5000/5000`.
- Final subscriber wait: `876ms`.

Batch-size comparison for `5000` events at requested `2000/s`, concurrency `5`:

- `appendBatchSize=25`: publish `2690ms`, source wait `3526ms`, derived wait
  `120ms`, final wait `1216ms`.
- `appendBatchSize=50`: publish `2630ms`, source wait `2341ms`, derived wait
  `125ms`, final wait `876ms`.
- `appendBatchSize=100`: publish `2524ms`, source wait `3027ms`, derived wait
  `225ms`, final wait `2100ms`.

Interpretation:

- Batched append is the first major improvement. It moves 5000 source events
  from `~8-9.5s` single-event publishing down to `~2.5-2.7s`.
- Batch size `50` is the best point observed so far. `100` improves publisher
  duration slightly but worsens subscriber/final lag.
- This strongly suggests the source append bottleneck is per-call/transport
  overhead, not event serialization alone.

### Callable subscriber alarm window

Experiments:

- Commit `29e915a78`: increased
  `CALLABLE_SUBSCRIBER_ALARM_BATCH_SIZE` from `500` to `1000`.
- Commit `aa9553617`: decreased it from `1000` to `250`.
- Commit `164923d94`: restored it to `500` while adding websocket alarm
  delivery.

Comparable `5000` event, requested `2000/s`, `appendBatchSize=50`,
concurrency `5`, RPC subscriber runs:

- Window `500`: publish `2630ms`, source wait `2341ms`, derived wait `125ms`,
  final wait `876ms`.
- Window `1000`: publish `3641ms`, source wait `3335ms`, derived wait `381ms`,
  final wait `2363ms`.
- Window `250`: publish `2578ms`, source wait `3927ms`, derived wait `143ms`,
  final wait `2761ms`.
- Restored/current window `500` after websocket batching:
  - File:
    `/tmp/os2-bench-agent-chat-rpc-batch50-5000-rate2000-concurrency5-current500.json`
  - Benchmark id: `agent-server-bench-1778222096695-b632f48c`
  - Publish duration: `2539ms`
  - Append latency p50/p90/p99: `50/165/215ms`
  - Source subscriber wait: `2612ms`
  - Processor wait: `7ms`
  - Derived wait: `134ms`
  - Final subscriber wait: `968ms`

Interpretation:

- Bigger subscriber delivery batches are not automatically better. At `1000`,
  individual Agent RPC dispatches took up to `~1.4s`, and total lag worsened.
- Smaller `250` event batches reduce the size of each RPC dispatch but create
  too many drain iterations/cursor writes; total lag also worsened.
- `500` remains the least bad tested alarm window for the RPC path.

### Noop subscriber isolation

Command shape:

```sh
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- \
pnpm --dir apps/os2 benchmark:agent-stream:server -- \
  --traffic agent-chat-responses \
  --count 5000 \
  --rate 2000 \
  --concurrency 5 \
  --append-batch-size 50 \
  --subscriber-mode agent-noop-only \
  --subscription-transport rpc
```

Result:

- File:
  `/tmp/os2-bench-agent-chat-rpc-batch50-5000-rate2000-concurrency5-noop-callable250.json`
- Benchmark id: `agent-server-bench-1778221471605-99b165d9`
- Publish duration: `2532ms`.
- Append latency p50/p90/p99: `24/43/96ms`.
- Source subscriber wait: `38ms`.
- Final subscriber wait: `6ms`.
- No derived `agent/input-added` events were expected because Agent processors
  were disabled; the benchmark timed out its derived-event wait as designed.
- Noop dispatch averaged `14ms` per batch, max `21ms`.

Interpretation:

- Stream DO delivery to a subscriber is not inherently multi-second at this
  volume.
- The seconds of lag are introduced by real Agent processor work/state handling
  and by derived appends, not by the alarm loop alone.

### Raw OpenAI-like traffic isolation

With batch publisher and `250` event alarm window:

- File:
  `/tmp/os2-bench-raw-openai-rpc-batch50-5000-rate2000-concurrency5-callable250.json`
- Benchmark id: `agent-server-bench-1778221424137-bfbb4cb0`
- Publish duration: `2537ms`.
- Append latency p50/p90/p99: `27/52/104ms`.
- Source subscriber wait: `121ms`.
- Processor wait: `5ms`.
- Final subscriber wait: `4ms`.
- Agent dispatch averaged `28ms`, max `53ms`.

Interpretation:

- High-volume raw `openai-ws/websocket-message-received` events are fine when
  they do not create a large Agent history or a second wave of derived appends.
- The problem workload is specifically `agent-chat` -> `agent/input-added` ->
  Agent history growth / subscriber replay.

### WebSocket subscriber transport

Initial websocket result before batching websocket delivery:

- `1000` agent-chat events at `1000/s`, `appendBatchSize=50`.
- File:
  `/tmp/os2-bench-agent-chat-websocket-batch50-1000-rate1000-concurrency5-callable250-retry.json`
- Benchmark id: `agent-server-bench-1778221569565-c9b7ea33`
- Source subscriber wait: `6ms`, but processor wait `3649ms` and derived wait
  `18257ms`.
- Runtime samples showed websocket processing as many one-event batches.

Root cause found:

- Websocket subscribers were still delivered by Stream DO immediate
  `afterAppend`, one committed event at a time.
- The alarm/cursor batch delivery path only selected `callable` subscribers,
  even though `publishExternalSubscriberBatch()` already had a websocket batch
  branch.

Fix:

- Commit `164923d94`: moved websocket subscribers onto the same alarm/cursor
  delivery path as callable subscribers, leaving webhooks as immediate
  subscribers.
- This did not change event schema or payloads.

Post-fix websocket results:

`1000` events at `1000/s`:

- File:
  `/tmp/os2-bench-agent-chat-websocket-batch50-1000-rate1000-concurrency5-alarmwebsocket.json`
- Benchmark id: `agent-server-bench-1778221886864-ce55f4f0`
- Publish duration: `1249ms`.
- Source subscriber wait: `52ms`.
- Processor wait: `571ms`.
- Derived wait: `632ms`.
- Final subscriber wait: `11ms`.
- Runtime samples now show websocket batches of `~200-301` events instead of
  one-event frames.

`5000` events at `2000/s`:

- First attempt hit a generic oRPC `500`; Cloudflare traces around the window
  showed `Durable Object reset because its code was updated` during long
  `StreamDurableObject.history` RPCs. This is a deploy confounder from
  repeatedly updating preview while benchmarks were active.
- Retry file:
  `/tmp/os2-bench-agent-chat-websocket-batch50-5000-rate2000-concurrency5-alarmwebsocket-retry.json`
- Benchmark id: `agent-server-bench-1778222046678-c18858f7`
- Publish duration: `2562ms`.
- Append latency p50/p90/p99: `48/95/162ms`.
- Source subscriber wait: `34ms`.
- Processor wait: `966ms`.
- Derived wait: `2121ms`.
- Final subscriber wait: `4ms`.

Interpretation:

- Websocket alarm batching fixed the catastrophic `18s` derived wait.
- Websocket source delivery is now effectively immediate from the Stream DO's
  perspective because `socket.send()` does not await Agent processing.
- That makes websocket delivery look excellent for source cursor lag, but it is
  not equivalent to RPC delivery. The Stream DO advances the subscriber cursor
  after sending frames, not after the Agent DO has durably reduced the events.
- For correctness-sensitive processors, RPC remains the stricter transport
  unless we add websocket acknowledgements.
- A future websocket transport should include explicit ack frames carrying the
  reduced-through offset before the Stream DO advances the subscriber cursor.

### Processor fast-forward for unconsumed batches

Hypothesis:

- `withStreamProcessor` loops every delivered event through every registered
  processor, even when the processor contract cannot consume any event in the
  batch.
- For an `agent-chat` source batch, `agent` and `openai-ws` do unnecessary
  event-type checks just to advance cursors.

Fix under test:

- Commit `07482468c`: if a delivered batch is contiguous and contains no event
  type consumed by a processor, fast-forward that processor's
  `reducedThroughOffset` and `afterAppendCompletedThroughOffset` with one state
  save.

Result:

- File:
  `/tmp/os2-bench-agent-chat-rpc-batch50-5000-rate2000-concurrency5-fastforward.json`
- Benchmark id: `agent-server-bench-1778222454135-9ffe41c2`
- Publish duration: `2911ms`.
- Append latency p50/p90/p99: `71/258/279ms`.
- Source subscriber wait: `3363ms`.
- Processor wait: `16ms`.
- Derived wait: `168ms`.
- Final subscriber wait: `1657ms`.

Interpretation:

- This did not improve the main benchmark; the run was worse than the prior
  current-500 RPC run.
- The dominant path is not unconsumed event looping. It is likely:
  - RPC delivery waiting for Agent processor work;
  - Agent state/history growth (`stateSaveJsonBytes` reaches `~2.5MB` by the
    end of 5000 chat events);
  - second-wave derived appends from `agent-chat` back into the same stream.
- The fast-forward remains conceptually correct for cursor advancement, but it
  is not the main performance unlock.

## Current Working Model

What seems solid now:

- Source publishing needs batching. Single-event public append calls top out at
  roughly `500-650/s`; batched append can get close to `1900/s` for this test.
- Hidden idempotency storms are not explaining the current lag. Duplicate
  attempts are visible and low in these runs.
- Stream delivery without real processors is fast: noop catch-up was `38ms`.
- Raw event traffic without derived Agent history is fast: raw OpenAI-like
  catch-up was `121ms`.
- RPC delivery gives stronger cursor correctness because the Stream DO waits
  for `afterAppendBatch` to return before writing the subscriber cursor.
- Websocket delivery can make source cursor lag nearly zero, but without an ack
  protocol it only proves frames were sent, not that the Agent processor reduced
  them.

Main remaining bottlenecks/hypotheses:

- Agent state shape is too large for high-velocity streams. Full model-visible
  history in reduced state reaches multi-megabyte JSON quickly.
- `agent-chat` derived appends create a second event wave. Source event delivery
  can complete while derived `agent/input-added` events still need to be
  appended, delivered, and reduced by `agent`.
- The Stream DO alarm delivery loop is still serial per subscriber window: read
  history, dispatch subscriber, write cursor, repeat. At high volume, a few
  hundred milliseconds per Agent RPC window compounds into seconds.
- Current timing diagnostics round most processor internals to `0ms`, which is
  too coarse. We need sub-millisecond or aggregate CPU/serialization counters
  to separate JSON serialization, storage put, zod parsing, and processor
  reducer cost.

Next experiments:

- Add websocket ack frames and only advance websocket subscriber cursors after
  Agent confirms `reducedThroughOffset`.
- Add an Agent-state compaction experiment: store only bounded history in
  reduced state or store history in a separate append-only/queryable projection.
- Add finer processor timing diagnostics with fractional milliseconds and
  cumulative `JSON.stringify` cost.
- Test an `agent-chat` processor variant that appends derived events in larger
  batches and/or yields faster while making the derived append lifecycle
  explicit in diagnostics.
- Evaluate whether Agent history needs to be a processor state at all for
  high-velocity streams, or whether the LLM request renderer should query the
  stream when a request is actually needed.

## 2026-05-08: traffic isolation and timing precision

### Direct Agent traffic vs agent-chat derived traffic

Current-build RPC runs with `appendBatchSize=50`, `5000` events requested at
`2000/s`, concurrency `5`:

`agent-inputs`:

- File: `/tmp/os2-bench-agent-inputs-rpc-batch50-5000-rate2000-current.json`
- Benchmark id: `agent-server-bench-1778222685477-ec54ff3d`
- Publish duration: `2540ms`
- Append latency p50/p90/p99: `25/44/128ms`
- Source subscriber wait: `1033ms`
- Processor wait: `81ms`
- Final subscriber wait: `5ms`
- Agent dispatch: `17` batches, `5024` delivered events, max `466ms`, mean
  `196ms`
- Agent state bytes reached `~1.2MB` of JSON save accounting by the end of the
  run.

`agent-status-updates`:

- File: `/tmp/os2-bench-agent-status-rpc-batch50-5000-rate2000-current.json`
- Benchmark id: `agent-server-bench-1778222684987-53493d45`
- Publish duration: `2550ms`
- Append latency p50/p90/p99: `26/49/129ms`
- Source subscriber wait: `1518ms`
- Processor wait: `18ms`
- Final subscriber wait: `5ms`
- Agent dispatch: `14` batches, `5024` delivered events, max `545ms`, mean
  `276ms`
- Agent state stayed tiny: roughly `5KB` of JSON save accounting.

Comparison to `agent-chat-responses`:

- Current-500 RPC file:
  `/tmp/os2-bench-agent-chat-rpc-batch50-5000-rate2000-concurrency5-current500.json`
- Source subscriber wait: `2612ms`
- Derived wait: `134ms`
- Final subscriber wait: `968ms`
- Agent dispatch: max `474ms`, mean `252ms`, but over `10025` delivered events
  because source chat events create a second wave of `agent/input-added` events.

Interpretation:

- Direct Agent input traffic is faster than `agent-chat` because it avoids the
  derived-event second wave.
- Tiny-state `agent/status-updated` traffic still has second-scale source wait
  at 5000 events, so Agent state size is not the only issue.
- The delivery window/RPC scheduling cost itself is material.

### More precise processor timing

Fix:

- Commit `90db31fc4`: changed processor and Agent runtime diagnostics from
  whole-millisecond rounding to fractional millisecond rounding, and changed
  state-save timing to use `performance.now()`.
- This is diagnostics-only. It does not change event schema.

Deploy confounder:

- The first post-deploy precision run hit a generic oRPC `500`.
- Cloudflare traces showed the familiar `Durable Object reset because its code
was updated` during `StreamDurableObject.history`, so the failed attempt was
  treated as deploy noise rather than an instrumentation bug.

Precision sample, `agent-inputs`, `1000` events at `1000/s`:

- File:
  `/tmp/os2-bench-agent-inputs-rpc-batch50-1000-rate1000-precision-retry.json`
- Benchmark id: `agent-server-bench-1778223036893-c8253d02`
- Publish duration: `1118ms`
- Append latency p50/p90/p99: `36/213/299ms`
- Source subscriber wait: `984ms`
- Processor wait: `7ms`
- Final subscriber wait: `12ms`
- Stream DO Agent dispatch: `4` batches, `1024` delivered events, max
  `1413ms`, mean `509ms`
- Agent-side `afterAppendBatch` timings:
  - first batch: `69` events, `totalDurationMs=30`, `deliveryLagMs=1531`
  - next batch: `500` events, `totalDurationMs=0`, `deliveryLagMs=163`
  - next batch: `453` events, `totalDurationMs=0`, `deliveryLagMs=0`
- Processor timings still show many large batches as `0ms` inside Agent, even
  when Stream DO observed hundreds of milliseconds of RPC dispatch.

Precision sample, `agent-status-updates`, `1000` events at `1000/s`:

- File:
  `/tmp/os2-bench-agent-status-rpc-batch50-1000-rate1000-precision.json`
- Benchmark id: `agent-server-bench-1778223084844-7c00b46a`
- Publish duration: `1014ms`
- Source subscriber wait: `106ms`
- Processor wait: `15ms`
- Final subscriber wait: `4ms`
- Stream DO Agent dispatch: `14` batches, `1024` delivered events, max `119ms`,
  mean `53ms`
- Agent-side batch timings remained `0ms` for consume/afterAppend/state saves.

Interpretation:

- For no-op/tiny-state Agent traffic, reducer and `afterAppend` work is
  effectively instant inside the Agent DO.
- Stream DO still waits tens to hundreds of milliseconds per Agent RPC dispatch,
  and occasionally over a second for direct Agent input traffic.
- This points at cross-DO RPC dispatch/scheduling/input-gate queueing as a
  current bottleneck, more than reducer CPU.
- Websocket delivery avoids this wait only because `socket.send()` does not wait
  for the Agent DO to reduce the events; that is why websocket needs explicit
  acknowledgements before it can replace RPC for processor correctness.

Next refined experiments:

- Add `deliveryStartedAtMs`, Agent handler start time, and handler completion
  time to Agent diagnostics so we can split RPC latency into queue-before-JS vs
  handler-runtime vs response-return latency.
- Build a websocket-ack subscriber mode and compare it with RPC:
  source cursor should advance only after acked `reducedThroughOffset`, making
  the comparison correctness-equivalent.
- Try reducing concurrent publisher pressure while keeping append batches to
  see whether Stream DO alarm/RPC dispatch contention improves when publishing
  has finished before delivery drains.
