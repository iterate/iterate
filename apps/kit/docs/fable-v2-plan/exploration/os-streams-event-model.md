# How apps/os streams work — and how Kit devices become streams (requirement 8)

Exploration-round artifact, 2026-07-31. Read-only survey of the real apps/os
stream machinery plus a wide design space for the device side. All file:line
references are into the `c-capabilities` worktree
(`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`) unless
marked otherwise. TS types quoted "verbatim" are copied byte-for-byte from the
cited files.

Contents:

1. [The canonical event shape](#1-the-canonical-event-shape-verbatim)
2. [The Stream surface](#2-the-stream-surface-what-a-stream-can-do)
3. [How processors consume events](#3-how-stream-processors-consume-events)
4. [itx.live / useLiveState](#4-itxlive--uselivestate)
5. [How a userspace worker.ts posts events](#5-how-a-userspace-workerts-posts-and-receives-events)
6. [provideCapability type:"live" and streams](#6-providecapability-typelive-and-how-mounting-relates-to-streams)
7. [The existing Device domain — the closest prior art](#7-the-existing-device-domain--the-closest-prior-art)
8. [What Kit has today (the seam is half-built)](#8-what-kit-has-today-the-seam-is-half-built)
9. [(a) On-device C event representations — three candidates](#9-a-on-device-c-event-representations--three-candidates)
10. [(b) Device event flow: producers → queues → sinks](#10-b-device-event-flow-producers--bounded-queues--sinks)
11. [(c) What the /pcm worker cross-posts + worker.ts sketch](#11-c-what-the-pcm-worker-cross-posts--workerts-sketch)
12. [(d) Offline buffering and replay semantics](#12-d-offline-buffering-and-replay-semantics)
13. [(e) A device as a stream in apps/os](#13-e-a-device-as-a-stream-in-appsos)
14. [Verbatim vs divergence — the loud table](#14-verbatim-vs-divergence--the-loud-table)
15. [Roads not taken](#15-roads-not-taken)
16. [Open questions for Jonas](#16-open-questions-for-jonas)

---

## 1. The canonical event shape (verbatim)

The single source of truth is a zod schema in the published `iterate` package —
`packages/iterate/src/processors/schemas.ts:11-92`. The public itx contract
(`apps/os/src/itx-api.generated.ts`) is _generated from_ it (the old
handwritten `types.ts` the itx README still mentions has been replaced by
`itx-api.generated.ts`; the README at `apps/os/src/README.md:9-12` is slightly
stale on this point). Verbatim, the append input:

```ts
// packages/iterate/src/processors/schemas.ts:10-82
/** Append input before the stream assigns offset and timestamp. */
export const StreamEventInput = z.strictObject({
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  source: z
    .strictObject({
      // Stamped by the StreamProcessor append methods: which processor appended
      // this event, and — for per-event side effects — while processing which
      // event. ...
      processor: z
        .strictObject({
          slug: z.string(),
          version: z.string(),
          stream: z.strictObject({
            path: z.string().trim().min(1),
            projectId: z.string().trim().min(1).nullable(),
            /** Exact lifetime of the processor's home stream. */
            streamId: z.uuid(),
          }),
          whileProcessing: z
            .strictObject({
              offset: z.number().int().nonnegative(),
              type: z.string().trim().min(1),
            })
            .optional(),
        })
        .optional(),
      copiedFrom: z
        .array(
          z.strictObject({
            /** The source stream's subscription that copied this event. */
            subscriptionKey: z.string().trim().min(1),
            streamId: z.uuid(),
            streamCreatedAt: z.string().trim().min(1),
            cursorChangedAtSourceOffset: z.number().int().positive(),
            createdAt: z.string(),
            offset: z.number().int().nonnegative(),
            path: z.string().trim().min(1),
            projectId: z.string().trim().min(1).nullable(),
            type: z.string().trim().min(1),
          }),
        )
        .min(1)
        .max(MAX_COPIED_FROM_HOPS) // 32, schemas.ts:8
        .optional(),
    })
    .optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  ephemeral: z.literal(true).optional(),
});
```

And the committed event — the input plus what the stream assigns at commit:

```ts
// packages/iterate/src/processors/schemas.ts:87-92
/** Durable stream event after commit. */
export const StreamEvent = StreamEventInput.extend({
  offset: z.number().int().nonnegative(),
  createdAt: z.string(),
  path: z.string().trim().min(1),
});
```

The generated public-contract mirror (what every client programs against) is at
`apps/os/src/itx-api.generated.ts:2547-2581` (`StreamEvent`) and
`:3297-3328` (`StreamEventInput`) — structurally identical.

Load-bearing observations for the device design:

- **`type` is a full URI string** — `events.iterate.com/{app}/{entity}/{past-tense-verb}`
  (`docs/events.md`, "Events are facts, not commands"). Example on the wire:
  `"events.iterate.com/device/notification-requested"`. ~35–55 bytes each.
- **`payload` and `metadata` are free-form JSON records.** `payload` is the
  domain fact; `metadata` is an unreserved side channel (nothing in the
  reducer machinery reads it).
- **`source` is RESERVED.** `source.processor` / `source.copiedFrom` are the
  provenance stamps written by the processor append lanes and by
  stream-to-stream copies. A device must never write into `source` — it is a
  claim slot for platform machinery, "same trust model as idempotency keys"
  (schemas.ts:17-22 comment). Device provenance goes in `payload` or
  `metadata` (decision point, §14).
- **`offset`, `createdAt`, `path` DO NOT EXIST until commit.** The producer
  never invents them. This is the crucial alignment with the device: a device
  produces `StreamEventInput`s; the platform's stream assigns coordinates.
  Device-local `sequence`/`bootEpoch` are _extra provenance_, not offsets.
- **`ephemeral: true` is a second-class-row marker** (schemas.ts:65-81):
  committed and offset-ordered, but excluded from range reads unless asked,
  **never delivered to durable subscriptions or processors**
  (`docs/writing-stream-processors.md:315-323`), and evictable. Existing use:
  LLM streaming chunks. This is exactly the right lane for transcription
  deltas and high-rate telemetry (§11).
- **`idempotencyKey` gives exactly-once-on-stream over at-least-once
  transports.** Same key + identical body = dedupe; same key + different body
  = loud append-time rejection (`docs/domain-objects-and-stream-processors.md:127-133`).
  Bodies under a key must be deterministic — "a `now()`, random id, or freshly
  signed URL in the body turns at-least-once redelivery into a
  same-key-different-body conflict that wedges the frame forever"
  (`docs/writing-stream-processors.md:265-269`). This one rule is what makes
  device replay after an outage safe (§12).

The delivery envelope processors and live connections receive:

```ts
// apps/os/src/itx-api.generated.ts:4176-4194
/**
 * Batch delivered to stream processors and live connections.
 */
export type StreamEventBatch = {
  projectId: string | null;
  path: string;
  /** Random identity of this event log; changes when the stream is recreated. */
  streamId: string;
  events: StreamEvent[];
  /** Exclusive raw-log cursor from which this delivery scan began. */
  scannedAfterOffset: number;
  /** Inclusive raw-log cursor through which this delivery scan completed. */
  scannedThroughOffset: number;
  streamMaxOffset: number;
  state: unknown;
};
```

Note `streamId`: a random identity that changes when a stream is destructively
recreated — the platform's own "epoch" concept. The device's `bootEpoch` (§9)
is the same idea one level down.

## 2. The Stream surface (what a stream can do)

`apps/os/src/itx-api.generated.ts:1213-1383`, the `Stream` interface. The
methods relevant to the device story:

```ts
// apps/os/src/itx-api.generated.ts:1213-1245 (excerpt, verbatim signatures)
export interface Stream {
  __describe(): Promise<Description>;
  /** Commit events; resolves with the same events carrying offsets and timestamps. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  /** Commit only if this path still names the supplied stream lifetime. */
  appendIfStreamId(args: { streamId: string; events: StreamEventInput[] }): Promise<StreamEvent[]>;
  /** The stream at a sub-path, resolved relative to this stream's path. */
  at(path: string): Stream;
  getEvent(args: { offset: number } | { idempotencyKey: string }): Promise<StreamEvent | undefined>;
  getEvents(args?: StreamEventReadInput): Promise<StreamEvent[]>;
  getEventPage(args?: StreamEventReadInput): Promise<StreamEventPage>;
  readEvents(args?: StreamEventReadInput): StreamEventPager;
  waitForEvent(args: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent>;
  // ... processor runtime state, liveState, kill ...
  openConnection(args: {
    connectionKey?: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    expectedStreamId?: string | null;
    maxReplayOffsetGap?: number;
    eventTypes?: readonly string[];
    filter?: EventFilter;
    // ...
  }): Promise<StreamConnectionHandle>;
  subscribeToEventsFrom(args: { sourceStreamPath: string; filter?; jsonataTransform?; start?; ... }):
    Promise<{ subscriptionKey: string; subscriptionConfiguredEvent: ... }>;
  // ...
}
```

(Full definitions with doc comments: `itx-api.generated.ts:1213-1383`;
`StreamEventReadInput` `:3331-3346`; `StreamEventPage` `:3354-3360`.)

Three lanes out of a stream, with different guarantees:

| Lane                                                                    | Cursor owner                 | Guarantee                                       | Ephemeral?                                                             |
| ----------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `openConnection` (session callback)                                     | caller (`replayAfterOffset`) | live push while the session lives; dies with it | delivered only if appended after the connection opened, never replayed |
| durable subscription (`subscribeToEventsFrom`, processor subscriptions) | source stream stores cursor  | at-least-once, ordered, survives everything     | never                                                                  |
| polling reads (`getEvents`/`readEvents`/`waitForEvent`)                 | caller                       | pull                                            | opt-in `includeEphemeral`                                              |

`waitForEvent` matters for requirement 7 (testing): a physical device test can
assert "the button press produced a durable
`kit-device/ptt-started` on the stream within 2 s" as one call — the stream
becomes the assertion surface for hardware-in-the-loop tests, exactly as the
processor-testing doctrine says "the stream is the assertion surface"
(`docs/writing-stream-processors.md:426-428`).

Also worth stealing conceptually: `subscribeToEventsFrom` supports a
`jsonataTransform` and copies carry `source.copiedFrom` provenance chains
(bounded to 32 hops, schemas.ts:8). Cross-posting device events to other
streams (a per-fleet rollup, an agent's stream) is configuration, not code,
once the device stream exists.

## 3. How stream processors consume events

The whole authoring surface is two hooks (`docs/writing-stream-processors.md:7-9`).
Verbatim from `packages/iterate/src/processors/stream-processor.ts`:

```ts
// packages/iterate/src/processors/stream-processor.ts:58-67
export type StreamProcessorContract = {
  slug: string;
  version: string;
  stateSchema: z.ZodType;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
  emits: readonly string[];
  parseEvent(event: StreamEvent): StreamEvent;
};

// :108-112
/** What `reduce` receives: one consumed event and the state to fold it into. */
export type ReduceArgs<Contract> = {
  event: ConsumedEvent<Contract>;
  state: ProcessorState<Contract>;
};

// :153-181
/** What `processEvent` receives: one reduction result plus delivery context and helpers. */
export type ProcessEventArgs<Contract> = Omit<ReducedEvent<Contract>, "event"> &
  SideEffectHelpers & {
    event: ReducedEvent<Contract>["event"] | null;
    append: (...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
    appendTo: (path: string, ...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
    delivery: DeliveryContext;
  };
```

with the two side-effect primitives (`:138-151`): `blockProcessorWhile`
(at-least-once, holds the cursor) and `runInBackground` (droppable attempt).
Key doctrine points a Kit device processor must obey like everyone else:

- One monolithic `reduce`; birth certificate (`*/created`) is the first domain
  event and gates `processEvent` (`docs/domain-objects-and-stream-processors.md:50-139`).
- Batches are transport, never semantics — partition invariance is pinned by
  the runner tests (`docs/writing-stream-processors.md:137-147`).
- Obligations are `…-requested` → optional `…-started` → one `…-settled`
  terminal with a result union (`:149-189`).
- Replay safety: every vendor side effect is an idempotency-keyed append, an
  at-head state comparison, or a freshness-gated ack (`:271-292`).

A minimal complete processor is 96 LOC — the guestbook
(`packages/iterate/src/starter-apps/guestbook/processor.ts:8-96`): a
`defineProcessorContract({slug, version, stateSchema, events, consumes, emits})`
call plus a class with one `reduce` switch. That is the exact template for a
`KitDeviceProcessor` (§13).

## 4. itx.live / useLiveState

Live state is _not_ a stream lane — it is a push-diff view of any serializable
value, usually a processor's reduced state. Three verbatim pieces:

```ts
// packages/iterate/src/sdk/capnweb/live-state/types.ts:9-13
/** Read-only live value exposed across a Cap'n Web capability boundary. */
export interface LiveStateRpc<State = unknown> {
  get(): Promise<State>;
  subscribe(onUpdate: (update: LiveUpdate<State>) => unknown): Promise<LiveStateSubscriptionHandle>;
}

// packages/iterate/src/sdk/capnweb/live-state/protocol.ts:21-37
export type LiveStatePatch =
  | { set: unknown }
  | { fields?: Record<string, LiveStatePatch>; drop?: string[] };

export type LiveUpdate<State = unknown> =
  | { type: "snapshot"; revision: number; state: State }
  | { type: "patch"; from: number; to: number; patch: LiveStatePatch };
```

Subscription always delivers one `snapshot` first, then minimal structural
diffs; a revision gap means resubscribe (protocol.ts:26-34). The React hook:

```ts
// packages/iterate/src/sdk/itx/react.ts:558-568 (signature verbatim)
export function useLiveState<State, Selected = State>(
  live: (itx: ProjectStub) => LiveStateRpc<State>,
  selector: (state: State) => Selected,
  deps: unknown[] = [],
  opts?: { slug?: string; enabled?: boolean },
): {
  value: Selected | undefined;
  status: ItxConnectionStatus;
  error?: string;
  refresh: () => void;
};
```

Every domain handle exposes `liveState`: `itx.liveState`
(`ProjectLiveState`, itx-api.generated.ts:144, 1945-1952), `Stream.liveState`
(`StreamRuntimeDebugState`, `:1276`), `Device.liveState`
(`DeviceDescription`, `:1449`), sandbox/repo/secret similarly. In userspace, a
`LiveStateRpcTarget` wraps a processor registry directly
(guestbook `worker.ts:130-140`).

**Why this matters for Kit:** the dashboard page "show me this device now —
connected? holding PTT? last incident?" is `useLiveState` over a
`KitDeviceProcessor`'s reduced state, zero polling, and the firmware's own
`snapshot`-then-sequence semantics (device_event_stream.h:22-26) is the same
protocol shape one layer down. The two snapshot/diff designs rhyme; they do
not share code and should not.

## 5. How a userspace worker.ts posts (and receives) events

The reference is the config-repo template + guestbook starter app. Posting is
just the typed append door on the project's stream capability:

```ts
// packages/iterate/src/starter-apps/guestbook/worker.ts:66-74 (verbatim)
const registry = await this.#ensureInitialized();
using project = await this.env.ITX.get();
await project.streams.get(guestbookStreamPath).append({
  type: "events.iterate.com/guestbook/entry-signed",
  payload: { message: trimmedMessage, name: trimmedName },
  idempotencyKey: `guestbook/entry:${crypto.randomUUID()}`,
});
await registry.catchUp("guestbook");
registry.refreshLive();
```

Receiving: the project worker extends `IterateWorkerEntrypoint`, and the
platform delivers **every committed durable event on every stream in the
project** to it:

```ts
// packages/iterate/src/sdk.ts:406-415 (verbatim)
/** Platform entry point for event delivery ... */
async processEventBatch(batch: StreamDeliveryBatch): Promise<void> {
  for (const event of batch.events) await this.processEvent(event);
}

/** Called once per delivered event, in per-stream order, at-least-once.
 * Override to react; the default ignores everything. */
protected async processEvent(_event: StreamEvent): Promise<void> {}
```

with the contract spelled in the class docstring (sdk.ts:370-381): per-stream
order, at-least-once, ephemeral events never arrive, throwing holds the
checkpoint and redelivers the batch. The seeded template routes this into apps
(`apps/os/config-repo-template/worker.ts:33-36`) and its header states the
philosophy: _"the essence of an iterate project can be expressed as two
functions: { fetch, processEvent }"_ (worker.ts:6-14).

A userspace DO can also _host_ a real processor over a stream —
`createProcessorHost` + `catchUp` (guestbook worker.ts:16-21, 36-43) — with
durable alarms routed through the platform (`IterateDurableObject`,
sdk.ts:434-441). So the full apps/os processor discipline (reduce, replay,
keepalive) is available to Kit's userspace worker **without any apps/os
change**. That is the single most important fact in this document for
requirement 8: _device-as-stream needs zero platform PRs to start._

## 6. provideCapability type:"live" and how mounting relates to streams

```ts
// apps/os/src/itx-api.generated.ts:1971-1995 (verbatim)
export type ProvideCapabilityInput =
  | {
      capability: unknown;
      flattenNestedPaths?: false;
      instructions?: string;
      path: string[];
      type: "live";
      types?: string;
    }
  | {
      capability: FlattenedCapabilityTarget;
      flattenNestedPaths: true;
      instructions?: string;
      path: string[];
      type: "live";
      types?: string;
    }
  | {
      expression: ItxExpression;
      flattenNestedPaths?: boolean;
      instructions?: string;
      path: string[];
      type: "itx-call";
      types?: string;
    };
```

The relationship to streams: **a mount IS a stream event.** The capability
host's durable table is the reduction of
`events.iterate.com/capability-host/capability-provided` /
`capability-revoked` events on the scope's stream
(`apps/os/src/domains/capability-host/capability-host-processor-contract.ts:206,289`;
`apps/os/src/README.md:245-247` "backed by `capability-provided` events on the
scope's stream"). For a `live` mount, the _mount record_ is durable but
_calls_ travel back over the provider's session and die with it
(README.md:252-256).

The firmware already lives this: its control connection is
`authenticate → projects.get → provideCapability(type=live, local capability)`
(`apps/kit/firmware/components/core/src/itx_mount.c:5-27`), mounting
`kit.m5sticks3` on the project root host with `flattenNestedPaths`
(itx_mount.c:123-157). So today, **every device (re)connect already appends a
durable `capability-host/capability-provided` event to the project root
stream** — the device's presence is _already_ event-sourced; what's missing is
everything else about the device.

Consequence for the design: connectivity ("is the device mounted right now")
should NOT be re-modelled as hand-rolled device events on the device stream —
the platform already journals mounts. What the device stream adds is the
_device's own_ facts (edges, lifecycle, incidents) plus voice-session facts
from the /pcm worker.

## 7. The existing Device domain — the closest prior art

apps/os already has a `Device` domain — **mobile push installations** (Expo).
It is the closest thing to "a physical thing as a stream" and the shape to
mirror where it fits:

```ts
// apps/os/src/itx-api.generated.ts:1433-1450 (verbatim)
/** One enrolled installation. Push credentials enter only through enroll(). */
export interface Device {
  __describe(): Promise<Description & DeviceDescription>;
  enroll(input: DeviceEnrollInput): Promise<DeviceDescription>;
  append(...events: DeviceAppendInput[]): Promise<StreamEvent[]>;
  /** Idempotently disable push; null means this installation was never enrolled. */
  revoke(reason: "disabled" | "permission-denied" | "sign-out"): Promise<StreamEvent | null>;
  kill(): Promise<void>;
  processor: StreamProcessorRpc<DeviceDescription>;
  liveState: LiveStateRpc<DeviceDescription>;
}
```

Its stream path is `/devices/<deviceId>`; the birth batch is a deterministic
builder (`apps/os/src/domains/devices/device-defaults.ts:12-33`):
`device/created` (idempotency key `device/created:${projectId}:${deviceId}`)
plus one hosted-processor subscription event, appended atomically. Its
contract (`device-processor-contract.ts:24-393`) is a model citizen: obligation
pattern for push notifications (`notification-requested` →
`notification-attempt-started` → `notification-ticket-observed` → ONE
`notification-settled` with a six-kind result union), credentials kept off the
stream in a write-only Secret, offsets as obligation identity ("no synthetic
ids anywhere", contract:154-159).

**But it is not our Device.** The birth certificate hard-codes
`platform: ios|android`, Expo push-token secret coordinates, and
notifications-permission facts (contract:412-458). Options for Kit:

- **7-A. Extend the mobile Device domain** to a platform union
  (`ios|android|esp32-kit`). Rejected for now: it couples Kit's iteration
  speed to an apps/os domain owned by the mobile app, and nothing in the push
  machinery applies to an ESP32.
- **7-B. New first-class `kit-devices` domain in apps/os.** Right eventually
  (hosted processor, catalog copy to `/`, `itx.kitDevices.get(id)`), but it is
  an apps/os PR and requirement 8 says "start laying the groundwork".
- **7-C. Userspace-owned stream + userspace-hosted processor (guestbook
  shape), path chosen to not collide** — zero platform changes, full
  processor discipline, promotable to 7-B later by re-homing the contract.
  **Recommended for v2.** The contract file can be written so that promoting
  it into apps/os is a file move.

## 8. What Kit has today (the seam is half-built)

The goal doc already mandates the direction: _"Holding and releasing its
physical button produce the same bounded application events that can also be
invoked remotely. This is the basis for later stream cross-posting"_
(`apps/kit/docs/physical-device-voice-goal.md:142-144`); _"Provider JSON and
other non-PCM events never enter the binary PCM lane. For the first proof, log
the events that would later be posted to a stream"_ (:157-158); _"every sink
records explicit sequence gaps and drop/overflow counts"_ (:309).

What exists, layer by layer:

**Firmware — the on-device event.** 2 bytes:

```c
// apps/kit/firmware/components/core/include/iterate/kit/device_events.h:27-34 (verbatim)
/**
 * Compact queue entry. Public publishers take typed enums and validate them;
 * the stored representation deliberately costs two bytes per pending event.
 */
struct iterate_kit_device_event {
  uint8_t type;    /* ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED / _STOPPED */
  uint8_t source;  /* PHYSICAL / REMOTE / SYSTEM */
};
```

fed through a single-task, allocation-free bounded queue (198 LOC impl / 131
test, `device_events.h:54-120`): power-of-two capacity, publish/poll never
wait, deliberately not ISR-safe ("platforms must first marshal ISR/cross-core
edges onto the owner task", `device_events.h:80-85`), full metrics struct
(published/processed/backpressure/failures/high-water, `:66-73`). The
M5StickS3 composition root wires one handler (drives the audio controller) and
one observer (mirrors into the capnweb event stream)
(`devices/m5sticks3/m5sticks3.c:41-88`) — source never changes audio
semantics, it exists "for observers/diagnostics" (m5sticks3.c:49-53).

**Firmware — the capnweb subscription.** `device_event_stream` (529 LOC / 100
test): single-subscriber `subscribeToEvents(callback)`, boot-local `int64
sequence`, coalescing bounded queue that keeps the newest state and counts the
loss, post-subscribe snapshot notification:

```c
// apps/kit/firmware/components/capabilities/include/iterate/kit/capabilities/device_event_stream.h:27-34 (verbatim)
struct iterate_kit_device_event_notification {
  int64_t sequence;
  uint32_t coalesced_notifications;
  int32_t result;
  uint8_t type;
  uint8_t source;
  bool snapshot;
};  /* 24 bytes after padding */
```

**Userspace — the consumer.** The wire shape today is flat and ad-hoc, _not_
apps/os-shaped:

```ts
// apps/kit/src/userspace/config-worker/device-events.ts:1-9 (verbatim)
export interface DeviceEvent {
  result: number;
  schemaVersion: number;
  sequence: number;
  snapshot?: boolean;
  source: "physical" | "remote" | "system" | string;
  type: "pushToTalk.started" | "pushToTalk.stopped" | string;
  [key: string]: unknown;
}
```

with sequence-gap policy already first-class: a gap desynchronizes the
subscription and closes the PCM generation rather than guessing
(`device-events.ts:126-135`, `worker.ts:279-287` — "Guessing after a lost PTT
edge can commit the wrong microphone turn"). And the stream seam is literally
marked in the code:

```ts
// apps/kit/src/userspace/config-worker/worker.ts:245-253 (verbatim)
/*
 * This is the explicit MVP stream seam. The event is logged as
 * something that WOULD be cross-posted, while no durable stream
 * semantics are implied before that design is agreed.
 */
this.#log("device-event", "info", { event, sessionId, wouldPostToStream: true });
```

(and `wouldPostToStream: diagnostic.code === "provider-event"` for provider
JSON, worker.ts:269; same pattern in the e2e harness,
`inputs/agent-reports/host-pipeline.md:29`).

So requirement 8's design task is precisely: replace `wouldPostToStream:
true` log lines with real `stream.append(...)`, and make the on-device shape
converge toward `StreamEventInput` instead of the ad-hoc flat record.

## 9. (a) On-device C event representations — three candidates

Requirement 8 verbatim: "Ideally the on-device data structure would also be
expressed in terms of events shaped like that with path, type, payload etc
from the earliest moments — these could be logged on SD card etc."

First, a framing decision that all three candidates share: **the device does
not store `path`.** On the wire, `path` is assigned by the stream at commit
(schemas.ts:87-92 — it's not even in `StreamEventInput`), and the device _is_
its stream — everything it emits lands at one path. Storing a path per event
on-device would be 20+ bytes of the same constant. What the device stores is
`type` + `payload` + local coordinates (`sequence`, `bootEpoch`, timestamp).

### Candidate A — interned envelope (bounded header + bounded payload bytes)

```c
/* SKETCH — not in tree. All storage static, power-of-two ring slots. */

/* Compile-time interned event-type table. The X-macro is the single source:
 * it generates (1) this enum, (2) the full-URI string table the serializers
 * use, (3) the TS union for the userspace worker (via a small generator),
 * exactly the R7/R10 "single-source the schema" recommendation from the
 * architecture review. */
#define ITERATE_KIT_EVENT_TYPES(X) \
  X(BOOTED,            "events.iterate.com/kit-device/booted") \
  X(PTT_STARTED,       "events.iterate.com/kit-device/ptt-started") \
  X(PTT_STOPPED,       "events.iterate.com/kit-device/ptt-stopped") \
  X(WIFI_CONNECTED,    "events.iterate.com/kit-device/wifi-connected") \
  X(WIFI_LOST,         "events.iterate.com/kit-device/wifi-lost") \
  X(CONTROL_MOUNTED,   "events.iterate.com/kit-device/control-mounted") \
  X(CONTROL_LOST,      "events.iterate.com/kit-device/control-lost") \
  X(PCM_CONNECTED,     "events.iterate.com/kit-device/pcm-connected") \
  X(PCM_LOST,          "events.iterate.com/kit-device/pcm-lost") \
  X(INCIDENT_RECORDED, "events.iterate.com/kit-device/incident-recorded") \
  X(EVENT_GAP_OBSERVED,"events.iterate.com/kit-device/event-gap-observed")

struct iterate_kit_event {          /* offset  size */
  uint16_t type_id;                 /*  0      2   index into interned table */
  uint8_t  source;                  /*  2      1   physical/remote/system   */
  uint8_t  flags;                   /*  3      1   bit0 payload_truncated   */
  uint32_t sequence;                /*  4      4   boot-local, monotonic    */
  uint32_t boot_epoch;              /*  8      4   NVS boot counter         */
  uint64_t uptime_ms;               /* 16      8   monotonic since boot     */
  uint16_t payload_len;             /* 24      2                            */
  uint8_t  payload[38];             /* 26     38   per-type packed struct   */
};                                  /* total 64 bytes, no padding waste     */
_Static_assert(sizeof(struct iterate_kit_event) == 64, "slot budget");
```

Payload bytes are a per-type packed struct (e.g. `wifi-lost` carries
`{uint8 reason; int8 rssi;}`), decoded by the same X-macro-driven table that
knows the JSON field names. Ring of 64 slots = **4,096 B**; 32 slots = 2 KiB.

- Pros: fixed 64 B slot; one generic ring/serializer for _all_ event kinds
  forever; the interned table is the schema single-source (C enum + URI string
  - TS type from one macro — kills the metrics-style triplication the review
    flagged in R7); payload stays opaque to the queue, so adding an event type
    touches one X-macro line + one payload struct + one serializer case.
- Cons: payload is bytes, so host-side decode needs the table (but the table
  is generated, and the capnweb/SD serializers run _on the device_, emitting
  full JSON — the host never actually sees the packed form unless we ship raw
  rings for forensics).
- Cost of the serializer: bounded `snprintf` per event at sink-drain time,
  ~1–2 µs/event on the S3 at 240 MHz, off the audio path by construction.

### Candidate B — tagged union (fully typed, smallest)

```c
/* SKETCH — the natural evolution of today's 2-byte event. */
struct iterate_kit_event {
  uint8_t  type;          /* enum, max 255 types  */
  uint8_t  source;
  uint16_t flags;
  uint32_t sequence;
  uint32_t uptime_ms;     /* wraps at 49.7 days — acceptable w/ epoch */
  union {
    struct { uint8_t reason; int8_t rssi; } wifi;
    struct { uint16_t expected_lo, actual_lo; uint32_t coalesced; } gap;
    struct { uint8_t kind; uint16_t detail; uint32_t value; } incident;
    uint8_t raw[12];
  } payload;              /* 12 */
};                        /* total 24 bytes */
```

(`boot_epoch` stored once in the ring header, not per event.) 64 slots =
**1,536 B**.

- Pros: smallest; zero parsing anywhere on device; compiler-checked payloads.
- Cons: every new event type edits the union AND every serializer switch AND
  the TS mirror — the exact "new counter must be threaded through five files"
  failure mode the review condemns in the metrics capability (R7,
  review §5). The union also caps payload at the largest member forever, and
  a variable-length payload (a short incident message) has nowhere to live.

### Candidate C — preformatted JSON slots (device stores wire truth)

Each publish formats the full `StreamEventInput` JSON immediately into a fixed
256-byte slot:

```c
struct iterate_kit_event_json {
  uint32_t sequence;
  uint32_t boot_epoch;
  uint16_t length;
  char     json[246];  /* {"type":"events.iterate.com/kit-device/...","payload":{...},"metadata":{...}} */
};                     /* 256 bytes/slot; 64 slots = 16 KiB */
```

- Pros: sinks become trivial (`SD write = fwrite(slot)`, capnweb = pass
  string through); what's on the SD card is _literally_ the apps/os shape —
  requirement 8's "from the earliest moments" in its most literal reading.
- Cons: 4× RAM of A (16 KiB vs 4 KiB for 64 slots); `snprintf` cost moves
  onto the _publisher's_ task (button ISR-adjacent path) instead of sink
  drain; 246 bytes caps payload sizes invisibly; on a board where the review
  found **IRAM at 1 byte free** and all storage static in the target
  `Runtime` struct, 12 KiB of extra static RAM for aesthetics is the wrong
  trade.

### Verdict and sizes side by side

|                                        | A: interned envelope                              | B: tagged union                | C: JSON slots        |
| -------------------------------------- | ------------------------------------------------- | ------------------------------ | -------------------- |
| bytes/slot                             | 64                                                | 24                             | 256                  |
| 64-slot ring                           | 4,096 B                                           | 1,536 B                        | 16,384 B             |
| new-event-type cost                    | 1 macro line + payload struct + 1 serializer case | union + N switches + TS mirror | 1 format callsite    |
| publish-time CPU                       | ~0 (memcpy)                                       | ~0                             | snprintf on hot task |
| forward-compat (unknown types at sink) | yes (opaque payload)                              | no                             | yes                  |
| apps/os-shape fidelity at rest         | via serializer                                    | via serializer                 | literal              |

**Recommend A.** It keeps publish O(1) on the owner task, keeps RAM within a
PCM-frame-sized budget (64 slots = 6.4 PCM frames' worth of RAM), and the
X-macro intern table doubles as the cross-language schema single-source the
review already wants for metrics (R7) and wire constants (R10). B is what we
have today grown up, and it recreates the schema-triplication disease. C is
worth keeping in mind _only_ as the SD sink's output format (which A's
serializer produces anyway).

## 10. (b) Device event flow: producers → bounded queue(s) → sinks

Producers (all already exist as code paths or incidents in the tree):

- **Button/PTT edges** — GPIO edges marshalled onto the owner task
  (device_events.h:80-85 rule), plus remote `pushToTalk.start/stop` RPC
  (`push_to_talk.c:7-13` publishes into the same queue — one total order).
- **Lifecycle** — boot (reset reason, firmware version, boot_epoch),
  mount/unmount of the control connection (today only visible as
  itx_transport generation counters, `itx_transport.c:608-620` area), PCM
  socket connect/lost.
- **Connectivity** — Wi-Fi station events; the ESP-IDF callbacks already
  publish atomic flags to the network task (`itx_transport.c:385-428`); the
  17–19 s station-outage research showed churn replies carry a Wi-Fi reason
  the host currently discards — as events these become durable facts.
- **Diagnostics incidents** — ring overflow/underrun, peer-delivery-guard
  trips, driver-queue poison, brownout recovery: today counters in the
  metrics snapshot; the _edge_ ("it happened, at uptime T, with value V")
  becomes an `incident-recorded` event while the counter stays a metric.
- **Audio turn milestones** (optional, later) — capture-started,
  playback-drained (the R12 drain-edge event has an obvious event
  representation).

Topology — one ring, many cursors:

```
                    owner task (single producer domain)
button ISR ─┐
Wi-Fi cb ───┼─ marshal ─→ publish(event)            ┌────────────────────────────┐
RPC dispatch┘                    │                   │  iterate_kit_event ring    │
                                 └──────────────────→│  64 × 64 B, seq-addressed  │
                                                     └──────┬──────┬──────┬──────┘
                                       per-sink read cursors │      │      │
                                                             ▼      ▼      ▼
                                                      capnweb    SD JSONL  console
                                                      subscr.    sink      (runtime_
                                                      (exists)   (new,     diagnostics,
                                                         │        req 5)    exists)
                                                         ▼
                                              userspace worker → stream.append
```

Design rules, all inherited from what's already proven in the tree:

1. **Single-writer ring, sequence-addressed slots** (slot = `sequence &
(capacity-1)`, the existing device_events idiom, device_events.h:56-58).
   Publishing overwrites the oldest slot unconditionally — the _writer never
   blocks and never fails_.
2. **Sinks own read cursors; a lapped cursor IS the gap.** When a sink's
   cursor falls more than `capacity` behind the writer sequence, the sink
   advances to `writer_seq - capacity` and records
   `gap = {expected, actual}`. This replaces the current
   coalesce-newest-and-count design (device_event_stream.c:90-108) with a
   uniform per-sink rule and satisfies the goal doc's "every sink records
   explicit sequence gaps and drop/overflow counts" (:309) by construction.
3. **Sinks are bounded background work** (goal doc :182-185): capnweb sink
   drains ≤N events per poll under the existing callback budget
   (`callback_budget.h`); SD sink drains on a low-priority task with a byte
   budget per wake — an SD write stall (SPI SD can block 10–250 ms) then
   shows up as that sink's growing cursor lag and eventually its own gap,
   never as audio jitter. This is the same "a stalled or absent sink never
   blocks audio and never creates an unbounded device queue" contract (goal
   doc :307-308).
4. **The capnweb sink generalizes `device_event_stream`** from
   PTT-notifications-only to all event types, keeping its two good ideas
   verbatim: single subscriber replaceable when idle
   (device_event_stream.h:49-63) and the post-subscribe snapshot — but the
   snapshot generalizes from "current PTT state" to "current reduced device
   state + the cursor you are starting from" (§12).
5. **SD sink format = JSONL of `StreamEventInput` + local coordinates**, one
   line per event, produced by candidate A's serializer:

```json
{
  "type": "events.iterate.com/kit-device/ptt-started",
  "payload": { "source": "physical" },
  "metadata": { "device": { "bootEpoch": 417, "sequence": 1042, "uptimeMs": 183220 } }
}
```

~150–220 B/line. At a pathological 20 events/s that is 4.2 KB/s —
0.36 GB/day worst case, and realistically (button edges + lifecycle,
<0.1/s) a 1 GiB card holds _years_. File-per-boot
(`/sd/events/<bootEpoch>.jsonl`) makes epoch boundaries a filesystem fact
and makes "pull the log for boot N" a bounded read. Requirement 5 ("write
logs to SD in case we are not listening") falls out of the same sink with
a second lane for log lines; whether log lines are events is §16 Q4.

Numbers recap: ring 4 KiB RAM; capnweb sink ≤1 in-flight call (existing
budget); SD sink one 512 B–4 KiB write buffer + FatFS state (~2–6 KiB task
stack); serializer ~2 µs/event; nothing on core 1, nothing at audio priority.

## 11. (c) What the /pcm worker cross-posts + worker.ts sketch

The /pcm userspace worker (`KitVoiceWorker`,
`apps/kit/src/userspace/config-worker/worker.ts:43`) sees three event sources
today, all currently ending in `#log(...)`:

1. **Device events** over the capnweb callback (worker.ts:227-264).
2. **Provider JSON** from Grok realtime: `response.created`, `response.done`
   (`pcm-proxy.ts:262-268`; richer set in the e2e-lane proxy:
   `conversation.item.input_audio_transcription.updated` with model
   `grok-transcribe`, `grok-realtime-voice.ts:147-160`,
   `device-pcm-proxy.test.ts:259-269`), plus the control messages it _sends_:
   `input_audio_buffer.commit`, `response.create`, `response.cancel`,
   `conversation.item.create`.
3. **Its own lifecycle**: PCM socket generations, provider connect failures,
   backlog closes, sequence-gap closes (worker.ts:266-287), and — per
   requirement 11 — the future inactivity hang-up of the Grok session while
   PCM keeps flowing.

Proposed durable vocabulary (worker-origin events, distinct entity segment
from device-origin `kit-device/*` so provenance is readable in the type):

| type (`events.iterate.com/…`)               | payload sketch                                         | durability          |
| ------------------------------------------- | ------------------------------------------------------ | ------------------- |
| `kit-voice/session-opened`                  | `{sessionId, mode: "tone"\|"grok", providerModel?}`    | durable             |
| `kit-voice/session-closed`                  | `{sessionId, origin, code, reason, wasClean}`          | durable             |
| `kit-voice/turn-committed`                  | `{sessionId, turnIndex}` (PTT release → commit+create) | durable             |
| `kit-voice/speak-started`                   | `{sessionId, turnIndex}` (on `response.created`)       | durable             |
| `kit-voice/speak-ended`                     | `{sessionId, turnIndex}` (on `response.done`)          | durable             |
| `kit-voice/transcription-updated`           | `{sessionId, turnIndex, text}`                         | **ephemeral: true** |
| `kit-voice/transcription-completed`         | `{sessionId, turnIndex, text}`                         | durable             |
| `kit-voice/provider-suspended` / `-resumed` | `{sessionId, reason: "inactivity"}`                    | durable (req 11)    |
| `kit-device/event-gap-observed`             | `{expectedSequence, actualSequence}`                   | durable             |

Transcription deltas ride `ephemeral: true` for exactly the reason LLM
streaming chunks do (schemas.ts:65-81): dashboards watching via
`openConnection` see them live, processors and range reads only ever see the
durable final transcript. Raw PCM posts nothing (see §13 "what stays out").

Sketch — the diff against today's `KitVoiceWorker`, in the guestbook idiom:

```ts
// SKETCH for apps/kit/src/userspace/config-worker/worker.ts — not in tree.
// Device stream path: one stream per physical device (see §13 for naming).
const deviceStreamPath = (deviceId: string) => `/kit/devices/${deviceId}`;

export class KitVoiceWorker extends IterateDurableObject {
  // ... existing fields ...

  /** Deterministic birth batch, safe to re-append on every contact —
   * the Telegram-router convention: keys derive from (projectId, path) only
   * (docs/domain-objects-and-stream-processors.md:160-166). */
  async #ensureDeviceStream(project: Project, deviceId: string) {
    await project.streams.get(deviceStreamPath(deviceId)).append({
      type: "events.iterate.com/kit-device/created",
      idempotencyKey: `kit-device/created:${deviceId}`,
      payload: { config: { deviceId, model: "m5sticks3" } },
    });
  }

  /** Device-origin events: the device already stamped bootEpoch+sequence, so
   * the idempotency key is fully deterministic — an at-least-once redelivery
   * or a post-outage replay dedupes to nothing. */
  async #postDeviceEvent(project: Project, deviceId: string, e: DeviceEvent) {
    await project.streams.get(deviceStreamPath(deviceId)).append({
      type: e.type, // already "events.iterate.com/kit-device/..." in v2 wire shape
      payload: e.payload,
      metadata: { device: { bootEpoch: e.bootEpoch, sequence: e.sequence, uptimeMs: e.uptimeMs } },
      idempotencyKey: `kit-device:${deviceId}:${e.bootEpoch}:${e.sequence}`,
    });
  }

  /** Worker-origin voice-session events: sessionId is minted once per PCM
   * generation (worker.ts:128 today), so (sessionId, kind, turnIndex) is a
   * stable identity for dedupe. */
  async #postVoiceEvent(
    project: Project,
    deviceId: string,
    sessionId: string,
    kind: string,
    payload: Record<string, unknown>,
    ephemeral?: true,
  ) {
    await project.streams.get(deviceStreamPath(deviceId)).append({
      type: `events.iterate.com/kit-voice/${kind}`,
      payload: { sessionId, ...payload },
      ...(ephemeral
        ? { ephemeral: true as const }
        : { idempotencyKey: `kit-voice:${sessionId}:${kind}:${payload.turnIndex ?? 0}` }),
    });
  }

  // wiring: in #subscribeToDeviceEvents, replace the wouldPostToStream log
  // (worker.ts:245-253) with #postDeviceEvent; in #onPcmDiagnostic, map
  // provider-event diagnostics (pcm-proxy.ts:262-268) onto #postVoiceEvent.
}
```

Two operational notes:

- **Append latency must not gate the voice path.** `stream.append` from a
  userspace DO is an RPC hop; the PCM bridge never awaits it inline —
  fire-and-forget with `ctx.waitUntil` and idempotency keys carrying the
  retry burden (this is a `runInBackground`-shaped attempt whose recovery is
  the next event or the device's own replay, per the
  `docs/writing-stream-processors.md:127-135` question).
- **Batching:** button-rate events don't need it; if we later cross-post
  per-turn timing summaries, `append(...events)` is already variadic and one
  atomic batch (itx-api.generated.ts:1216).

## 12. (d) Offline buffering and replay semantics

The outage matrix (all observed in the field per the memory ledger — 17–19 s
Wi-Fi station outages with the firmware's own double-defer ladder; control
non-recovery as a separate defect):

| Failure                              | What keeps working                         | What buffers                              | What replays                                                               |
| ------------------------------------ | ------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------- |
| Wi-Fi outage (s–min)                 | ring keeps filling; SD sink keeps draining | RAM ring (64 events) + SD (unbounded-ish) | capnweb sink resumes from its cursor if not lapped                         |
| control socket lost, Wi-Fi fine      | same                                       | same                                      | same, one generation later                                                 |
| userspace worker generation turnover | device unaware                             | device ring                               | new subscriber passes its cursor                                           |
| device reboot                        | nothing                                    | SD only (RAM ring gone)                   | **no automatic replay** — new bootEpoch, `booted` event, gap is structural |
| mothership down for hours            | SD                                         | SD                                        | lazy/manual backfill only                                                  |

Semantics, in the order they matter:

1. **Sequence gaps are first-class data, not failures.** The device-side rule
   (§10 rule 2) makes a lapped cursor produce a
   `kit-device/event-gap-observed` fact with `{expectedSequence,
actualSequence}` — the exact shape the userspace diagnostic already has
   (`device-events.ts:24-32`). On the stream, the gap event is durable
   evidence; a dashboard renders "we lost 14 events between 10:41:02 and
   10:41:19" instead of silently smooth history. The _PTT-controlling_
   subscriber keeps its existing stricter policy (gap ⇒ close generation and
   resync via snapshot, worker.ts:279-287) because for PTT a gap can invert
   microphone meaning — two consumers, two gap policies, one gap fact.
2. **Resume protocol replaces snapshot-only.** Today's capnweb subscribe
   delivers a state snapshot then increments (device_event_stream.h:22-26).
   Generalized: `subscribeToEvents(callback, { afterSequence?: {bootEpoch,
sequence} })` — the device replays from its RAM ring when the requested
   cursor is still inside it (≤64 events behind), else it delivers
   `{snapshot, gap: {expected, actual}}` and continues from now. This mirrors
   `openConnection({ replayAfterOffset, maxReplayOffsetGap })` on the platform
   (itx-api.generated.ts:1289-1303) — same contract, 64-slot scale.
3. **Idempotency keys make replay boring.** Because every device event's key
   is `kit-device:<id>:<bootEpoch>:<sequence>` and bodies are deterministic
   functions of the device event (§11 sketch), the userspace worker can
   re-post any suffix of history after any partial failure and the stream
   dedupes; at-least-once anywhere in the chain composes to exactly-once on
   the stream. This is not our invention — it is the platform's whole retry
   doctrine (`docs/writing-stream-processors.md:271-281`).
4. **Reboot = epoch boundary, deliberately not stitched in RAM.** `bootEpoch`
   is an NVS-backed counter; sequence restarts at 0; the first event of every
   boot is `kit-device/booted {resetReason, firmwareVersion}`. The stream
   shows the boot as a fact; per-epoch ordering is total, cross-epoch
   ordering is by stream offset. (Platform precedent: `streamId` changes on
   stream recreation and `appendIfStreamId`/`expectedStreamId` fence it,
   itx-api.generated.ts:1218, 1294-1298.)
5. **SD is the deep archive and the "we were not listening" answer (req 5),
   not an automatic replay lane.** Auto-replaying hours of SD backlog through
   the control socket on reconnect would (a) head-of-line-block live PTT
   events behind stale history on a budgeted callback lane, (b) burn the
   callback budget exactly when the session is trying to re-establish, and
   (c) duplicate what the ring already covers for short outages. Instead:
   `kit.<device>.readSdEvents({bootEpoch, afterSequence, limit})` as an
   ordinary bounded capability — pull, not push — which an operator, an
   agent, or a backfill script invokes lazily; backfilled appends use the
   same idempotency keys so late backfill converges with whatever the live
   path managed to post. (An automated "backfill gaps I saw" processor is a
   later nicety; the keys make it safe whenever it comes.)

## 13. (e) A device as a stream in apps/os

**Path naming options:**

| Option                  | Example                   | Verdict                                                                                                                                                                                                |
| ----------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/devices/<id>`         | `/devices/stick-a1b2`     | collides with the mobile Device domain's namespace (`device-defaults.ts:18` uses exactly this family); different processors on one family confuses the catalog even though "a path is only an address" |
| `/kit/devices/<id>`     | `/kit/devices/stick-a1b2` | **recommended for the userspace phase**: clearly project-app-owned, containers need no synthetic domain objects (doctrine §"stream path is an address"), promotable later                              |
| `/kit/<id>`             | `/kit/stick-a1b2`         | shorter but mixes devices with the `/kit/` app scope the install plan already uses for the worker's own capability host (worker.ts:236-239 mentions the app's `/kit/` scoped host)                     |
| per-device *sub*streams | `/kit/devices/<id>/voice` | over-structuring now; one stream per device, `at()` exists if we ever split                                                                                                                            |

**Device identity:** does not exist yet — the firmware mounts a fixed
`["kit","m5sticks3"]` path (itx_mount.c:123-157) and `configuration.h` has no
device id. v2 needs a durable `deviceId` (efuse MAC-derived, e.g.
`stick-<6 hex>`), provisioned into config, carried in the mount path
(`kit.devices.<id>`) and in every event's idempotency key. This is a
prerequisite for more than streams (two Sticks on one project today would
fight over one mount path).

**Who owns the stream:** the userspace `KitVoiceWorker` (the device's "sole
lifecycle owner", device_event_stream.h:52-54) — it appends the deterministic
birth batch on first contact (§11 sketch) exactly like a transport router
births a routed agent's stream on first contact
(`docs/domain-objects-and-stream-processors.md:186-190`). The device itself
never appends to the stream directly: it holds a _project-scoped_ session
whose only durable write is its capability mount. Keeping the worker as the
single stream writer preserves the single-writer sequence discipline and
keeps stream authority out of firmware entirely.

**Processor:** a `KitDeviceProcessor` hosted BY THE USERSPACE WORKER
(guestbook shape, `createProcessorHost`, §5) — pure projection first, no side
effects:

```ts
// SKETCH — kit userspace, mirrors guestbook/processor.ts:8-96 structurally.
export const KitDeviceProcessorContract = defineProcessorContract({
  slug: "kit-device",
  version: "0.1.0",
  description: "One physical Kit device: presence, PTT state, sessions, incidents.",
  stateSchema: z.object({
    birthCertificate: z
      .object({ config: z.object({ deviceId: z.string(), model: z.string() }) })
      .nullable()
      .default(null),
    lastBoot: z
      .object({ bootEpoch: z.number().int(), resetReason: z.string(), firmwareVersion: z.string() })
      .nullable()
      .default(null),
    pttHeld: z.boolean().default(false),
    activeSession: z
      .object({ sessionId: z.string(), mode: z.enum(["tone", "grok"]) })
      .nullable()
      .default(null),
    counters: z
      .object({
        turns: z.number().int().default(0),
        gaps: z.number().int().default(0),
        incidents: z.number().int().default(0),
      })
      .prefault({}),
    recentIncidents: z
      .array(z.object({ kind: z.string(), uptimeMs: z.number(), bootEpoch: z.number() }))
      .max(32)
      .default([]), // bounded, newest-last
  }),
  events: {
    /* kit-device/* + kit-voice/* schemas from §11's table */
  },
  consumes: [
    /* the durable types from §11; never the ephemeral ones */
  ],
  emits: [],
});
```

Dashboard = `useLiveState` over this state via a `LiveStateRpcTarget` in the
worker's Cap'n Web API (guestbook worker.ts:128-145 pattern, §4).

**What stays OUT of the stream (hard lines):**

- **Raw PCM, both directions** — explicitly out of scope in requirement 8
  ("Just not the latency-sensitive PCM (for now)"), and structurally wrong
  for a DO-SQLite journal (256 kbps = 1.6 MB/min; the PCM lane's freshness
  doctrine is the opposite of an append-only log). Not even ephemeral rows:
  ephemeral events still transit the stream DO.
- **Per-frame/per-tick telemetry (≥Hz rates)** — stays on the existing
  metrics capability (capnweb subscription, `capabilities/metrics.h`); at
  most a low-rate durable `kit-device/metrics-sampled` rollup (≤1/min) if
  history proves useful, else `Stream.liveState`-style live-only.
- **Transcription deltas** — ephemeral rows only (§11).
- **Secrets/credentials** — never; the Device domain's write-only-Secret
  pattern is the reference if the device ever needs per-device credentials
  (`device-processor-contract.ts:13-17`).
- **Images/photos** — file storage + a URL-bearing event, never payload bytes
  (matches `AgentFileAttachment` precedent, itx-api.generated.ts:2595-2598).

**Promotion path to a first-class apps/os domain (later):** move the contract
into `apps/os/src/domains/kit-devices/`, add a `kitDevices.get(id)` handle
with `append` typed as `ConsumedInput<KitDeviceProcessorContract>` +
`processor` + `liveState` (the `Device` interface at
itx-api.generated.ts:1434-1450 is the template), keep the same stream path or
migrate under the empty-state-cutover rule
(`docs/domain-objects-and-stream-processors.md:291-299` — no compat readers,
pre-1.0). Because the userspace phase already speaks contract-shaped events
with deterministic keys, promotion is a re-homing, not a migration.

## 14. Verbatim vs divergence — the loud table

Jonas's standing rule: copy apps/os API shapes VERBATIM (memory:
`feedback_mirror_appsos_api_shapes.md`). Where the device forces divergence,
it is flagged here and nowhere silently.

**Copied verbatim (no deviation):**

| Shape                                                                                                                                                       | Source of truth                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Event object: `{type, payload?, metadata?, idempotencyKey?, ephemeral?}` — exact field names, `type` as full `events.iterate.com/...` URI, past-tense facts | `schemas.ts:11-82`, `docs/events.md`            |
| Committed coordinates (`offset`, `createdAt`, `path`) assigned only by the stream — the device never fabricates them                                        | `schemas.ts:87-92`                              |
| `ephemeral: true` (literal true, never `false`) for transcription deltas / transient signals                                                                | `schemas.ts:65-81`                              |
| Idempotency-key dedupe as the replay mechanism; deterministic bodies                                                                                        | `docs/writing-stream-processors.md:265-281`     |
| Processor contract authoring (`defineProcessorContract`, zod state, monolithic reduce, birth certificate, `consumes`/`emits`)                               | guestbook `processor.ts:8-96`, doctrine doc     |
| Birth batch: deterministic builder keyed on `(projectId, path)`, re-appendable on every contact                                                             | `device-defaults.ts:12-33`, doctrine `:160-166` |
| Obligation naming `…-requested`/`…-started`/one `…-settled` if the device stream ever carries obligations (e.g. commanded firmware update)                  | `device-processor-contract.ts:236-345`          |
| `LiveStateRpc` / `useLiveState` for dashboards                                                                                                              | `live-state/types.ts:9-13`, `react.ts:558`      |
| `subscribeToEvents` resume args mirror `openConnection`'s `replayAfterOffset`/`maxReplayOffsetGap` contract                                                 | itx-api.generated.ts:1289-1303                  |

**Divergences (⚠ each needs Jonas's eyes):**

1. ⚠ **On-device `type` is a `uint16` intern index, not a string.** The
   X-macro table maps indices 1:1 to full URI strings; every sink serializer
   emits the full string, so nothing off-device ever sees the index. Reason:
   41-byte strings × 64 slots would triple the ring for zero information.
   The _table_ is the contract; drift is impossible because TS types are
   generated from the same macro output.
2. ⚠ **Device coordinates (`bootEpoch`, `sequence`, `uptimeMs`) ride in
   `metadata.device`, not in `payload` and not in `source`.** `source` is
   platform-reserved provenance (schemas.ts:17-22) — overloading it would be
   the worst kind of fake-verbatim. `metadata` is the documented free side
   channel. Counter-argument for `payload`: processors that _reduce over_
   gaps need the sequence, and doctrine keeps domain facts in `payload`.
   Either is defensible; pick one and never both (§16 Q2).
3. ⚠ **No wall-clock `createdAt` from the device.** The device has monotonic
   uptime only (no RTC/NTP yet); `createdAt` is commit time at the stream, so
   an event buffered offline for 40 s has `createdAt` 40 s after the physical
   edge. `metadata.device.uptimeMs` + the `booted` event allow exact
   reconstruction; if that proves too weak, the fix is device NTP, not fake
   timestamps.
4. ⚠ **Device-side "stream" is a 64-slot lapped ring, not an append-only
   log.** Overwrite-oldest with per-sink gap facts is the RAM-honest analog
   of ephemeral eviction; the SD sink is the closest thing to the durable
   journal. We deliberately do NOT claim device-side durability semantics.
5. ⚠ **Two event _type namespaces_ on one stream** (`kit-device/*` from the
   device, `kit-voice/*` from the worker) rather than one. Precedent: agent
   streams carry `agent/*` + `capability-host/*` + facet events on one shared
   stream (doctrine survey table), so this is arguably verbatim-adjacent —
   but it is a naming decision worth confirming (§16 Q3).

## 15. Roads not taken

- **Device appends directly to the stream over its own capnweb session**
  (mount a `Stream.append`-shaped capability into the device). Rejected for
  now: doubles the firmware's JSON surface, puts stream authority in
  firmware, breaks single-writer sequence discipline, and saves one hop that
  is not latency-sensitive. Reconsider only if the userspace worker proves an
  availability bottleneck — and note it would still be shape-verbatim
  (`append(StreamEventInput)`) if it ever happens.
- **Reusing/extending the mobile Device domain now** (§7-A) — coupling
  without shared behavior.
- **A new apps/os `kit-devices` domain first** (§7-B) — right destination,
  wrong first step; userspace gets us the same contract with zero platform
  risk while v1 is still being implemented next door.
- **Automatic SD backlog replay on reconnect** (§12.5) — head-of-line risk on
  the budgeted control lane; lazy pull with idempotent backfill wins.
- **Candidate C (JSON-at-rest on device) as the ring format** — 4× RAM and
  hot-path snprintf for aesthetics; kept only as the SD/wire _output_ format.
- **Candidate B (tagged union) as the queue format** — recreates the
  metrics-schema triplication disease the review's R7 exists to kill.
- **Per-event wrapper methods on any new handle** (`markSpoken()`,
  `recordIncident()`…) — the doctrine's typed-append-door rule forbids it
  (`docs/domain-objects-and-stream-processors.md:196-246`).
- **Durable per-frame audio telemetry events** — the metrics capability and
  ephemeral lanes exist precisely so streams don't become telemetry pipes;
  "processors never see ephemeral events" is a guarantee, not a suggestion
  (`docs/writing-stream-processors.md:315-323`).
- **Inventing a device-side framework noun** ("EventBus", "Journal",
  "Telemetry Fabric") — it is a ring, sinks, and a serializer; naming rules
  per `feedback_no_invented_concept_names.md`.

## 16. Open questions for Jonas

1. **Path family:** `/kit/devices/<id>` (recommended) vs `/devices/<id>`
   shared with mobile vs something else? Affects only the userspace phase's
   birth builder; cheap to decide, annoying to migrate.
2. **Device coordinates in `metadata.device` or `payload`?** (§14 ⚠2.)
   Recommendation: `metadata.device`, keeping payloads pure domain facts.
3. **One entity segment or two?** `kit-device/*` + `kit-voice/*` (recommended,
   provenance-in-type) vs a single `kit-device/*` vocabulary where the worker's
   events are just more facts about the device.
4. **Are SD _log lines_ events?** Req 5 says "write logs to SD". Options: (a)
   two SD lanes — events.jsonl (this design) + plain log text; (b) wrap log
   lines as `kit-device/log-recorded` events (uniform but noisy — and
   event-volume-is-fine may apply on SD while durable-stream noise still
   matters). Recommendation: (a) now, revisit after seeing volumes.
5. **How much of this lands in v2 vs later?** Minimum coherent slice:
   deviceId + X-macro event table + generalized ring/sinks in firmware,
   apps/os-shaped wire events over the existing subscription, worker
   cross-posting with idempotency keys, userspace-hosted `KitDeviceProcessor`.
   SD sink and resume-from-cursor can trail by one milestone without changing
   any shape.
