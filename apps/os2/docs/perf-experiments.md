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
