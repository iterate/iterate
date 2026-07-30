---
state: draft
priority: medium
size: medium
dependsOn: []
tags: [home-assistant, integrations, streams, capabilities, kit]
---

# Home Assistant as an always-on stream bridge and live capability

Date: 2026-07-30

Related proposal: [`tasks/kit-esphome-streams-proposal.html`](./kit-esphome-streams-proposal.html)

## Answer first

Build a small TypeScript Home Assistant App that continuously maintains:

1. a local WebSocket connection to Home Assistant Core; and
2. one outbound Cap'n Web WebSocket connection to Iterate.

That app does two deliberately direct things:

- It subscribes to the Home Assistant event bus and appends the raw Home
  Assistant events into one Iterate stream.
- It provides a live capability that forwards normal Home Assistant WebSocket
  commands back into the house.

The canonical connection and stream address should be:

```text
/integrations/home-assistant/main
```

The corresponding capability should be callable as:

```ts
itx.integrations["home-assistant"].get("main").sendMessagePromise({
  type: "get_states",
})
```

This is intentionally **not** a proposal to invent an Iterate-specific smart
home model, normalize every entity, or represent every command as a durable
`action-requested` / `action-started` / `action-settled` sequence. The first
version is a thin, fast bridge over Home Assistant's existing API and event
structures.

## Product intent captured from the discussion

The proposal preserves these requirements:

- Home Assistant is already the natural hub for ESPHome and many other device
  ecosystems, so connecting Home Assistant may make most individual device
  integrations available immediately.
- The Home Assistant App should always strive to maintain an outbound
  WebSocket connection to Iterate's edge. The home must not require an inbound
  port, public Home Assistant URL, VPN, or separately managed reverse tunnel.
- Iterate should be able to receive the whole useful Home Assistant event
  firehose, continuously, into a stream.
- While the socket is alive, Iterate should also be able to call back into
  Home Assistant through a live provided capability.
- The capability should expose approximately the whole authenticated Home
  Assistant Core WebSocket API rather than a small hand-written set of smart
  home operations.
- The bridge should use Home Assistant's own data structures and vocabulary so
  a Home Assistant developer recognizes it immediately.
- TypeScript should be usable on the bridge and on the Iterate side.
- Camera images and security-camera access are desirable, but image/video
  bytes are not ordinary Home Assistant event-bus data and should not be
  smuggled into the event stream.
- Speed matters more than designing a perfect durable action protocol now.
- Per-device paths such as the originally suggested
  `/home-assistant/main/<device>` may be useful later, but should not be the
  canonical ingestion source.

## The complete topology

```text
ESPHome   Zigbee   Matter   Z-Wave   MQTT   cameras   automations   ...
   \         |        |        |       |        |          /
    +---------------- Home Assistant integrations ----------------+
                              |
                              v
                     Home Assistant Core
                    event bus + WebSocket API
                              ^
                              | local authenticated WebSocket
                              v
                  Home Assistant App (TypeScript)
                  - raw event forwarding
                  - live API forwarding
                  - reconnect supervision
                              |
                              | one outbound Cap'n Web WSS
                              | (calls and callbacks multiplexed)
                              v
                    Iterate /api edge ingress
                     /                     \
                    v                       v
   /integrations/home-assistant/main     provided live capability
        durable raw event stream         at the same connection path
                    |                       |
                    v                       v
           processors, agents, UIs     immediate HA API calls
```

The important nodes are:

### Physical devices and vendor integrations

Home Assistant continues to own ESPHome Native API connections, Zigbee,
Matter, MQTT, camera integrations, polling, vendor authentication, entity
construction, and device availability. The bridge does not reconnect to each
physical protocol.

### Home Assistant Core

Home Assistant Core is the local source of truth exposed to the bridge. Its
event bus provides normal events and entity state changes. Its WebSocket API
provides request/response commands such as `get_states`, `call_service`, and
registry queries.

### Home Assistant App

The app is an always-running Node.js/TypeScript container installed alongside
Home Assistant. Home Assistant OS calls these packages "Apps" (formerly
"add-ons").

With `homeassistant_api: true`, an App receives a `SUPERVISOR_TOKEN` and can
connect locally to:

```text
ws://supervisor/core/websocket
http://supervisor/core/api
```

The Supervisor token remains inside the local App. It is never sent to Iterate.

For Home Assistant Container/Core installations that do not run Apps, the same
Node bridge can be packaged as a standalone Docker container and pointed at the
instance's normal `/api/websocket` endpoint with an appropriate Home Assistant
token.

### Iterate edge

The App initiates the only internet-facing connection:

```text
wss://os.iterate.com/api
```

The edge ingress may remain stateless with respect to durable product data.
The actual WebSocket and provided capability are session-bound runtime state;
the stream is durable. If an edge process, deployment, or network connection
goes away, the App reconnects and provides a new live capability.

### Durable connection stream

The whole Home Assistant installation has one canonical stream:

```text
/integrations/home-assistant/main
```

This is the raw, totally ordered firehose for that Home Assistant connection.
It preserves the ordering Home Assistant presented to this subscriber across
all device ecosystems and automations.

### Provided live capability

The same App session mounts a capability at:

```ts
["integrations", "home-assistant", "main"]
```

The integration collection then exposes it as:

```ts
itx.integrations["home-assistant"].get("main")
```

The mount exists only while the App's Cap'n Web session is connected. Its
absence is the correct answer when the house is unreachable.

## One connection stream, not a source stream per device

The original sketch was approximately:

```text
/home-assistant/main/<device>
```

The platform integration convention adds the `/integrations` prefix:

```text
/integrations/home-assistant/main
```

That connection root should be the canonical ingestion stream. It has several
advantages:

- one subscription to Home Assistant maps to one append destination;
- events retain their cross-device order;
- events that concern automations, users, services, areas, or Home Assistant
  itself do not need to be assigned artificially to one device;
- no registry lookup is required on the hot ingestion path; and
- the first bridge remains almost completely schema-agnostic.

If per-device or per-area streams later become useful, they should be
projections derived from the connection stream:

```text
/integrations/home-assistant/main/devices/<ha-device-id>
/integrations/home-assistant/main/areas/<ha-area-id>
```

Those child streams are optional materialized views, not independent
authoritative firehoses. Many Home Assistant events contain an `entity_id`
rather than a `device_id`, so a projection needs the entity and device
registries to resolve that association.

## Direction 1: Home Assistant event firehose into Iterate

### The subscription

Home Assistant's WebSocket API defines:

```json
{
  "id": 1,
  "type": "subscribe_events"
}
```

Omitting `event_type` subscribes to all normal events on the Home Assistant
event bus. The official JavaScript client expresses it as:

```ts
await connection.subscribeEvents<HassEvent>((event) => {
  // Forward the event.
})
```

The library automatically re-establishes event subscriptions after its local
Home Assistant connection reconnects.

### The stream representation

Do not normalize the Home Assistant event in the first version. Apply only the
small wrapper required by the Iterate Stream API:

```ts
await stream.append({
  type: "home-assistant/event",
  payload: event,
})
```

The payload remains the unmodified Home Assistant event:

```ts
type HassEvent = {
  event_type: string
  data: Record<string, any>
  origin: string
  time_fired: string
  context: {
    id: string
    user_id: string | null
    parent_id: string | null
  }
}
```

A normal state change looks like:

```ts
type StateChangedEvent = {
  event_type: "state_changed"
  data: {
    entity_id: string
    new_state: HassEntity | null
    old_state: HassEntity | null
  }
  origin: string
  time_fired: string
  context: Context
}
```

The `new_state` and `old_state` values include the entity's state, attributes,
timestamps, and context. This is the primary way changes from lights, sensors,
locks, climate devices, media players, and many other device-backed entities
appear.

The Stream API accepts multiple events in one append. The simplest code can
append immediately; the first obvious throughput improvement is a tiny
time/size-bounded batch without changing the data model.

### Initial state

The event bus is a live feed, not a snapshot. After establishing the local
subscription without a race, the App should also obtain the current entity
state and append one raw snapshot:

```ts
const states = await connection.sendMessagePromise<HassEntity[]>({
  type: "get_states",
})

await stream.append({
  type: "home-assistant/state-snapshot",
  payload: { states },
})
```

The snapshot makes a new stream immediately useful and lets consumers
re-establish current state after a bridge outage. It does not reconstruct
intermediate events missed during that outage.

### What "all events" means exactly

The wildcard subscription provides:

- all normal events placed on the Home Assistant event bus while the
  subscription is active;
- events across the entire Home Assistant installation, not only ESPHome;
- `state_changed` for loaded entities whose state or attributes change;
- integration-originated events such as physical button presses when that
  integration chooses to fire an event;
- Home Assistant lifecycle, automation, service, registry, and other bus
  events that are visible to this authenticated event subscriber; and
- custom event types fired by custom integrations.

It does **not** promise:

- every raw packet, log line, radio frame, or unchanged measurement received
  by ESPHome, Zigbee, Matter, Z-Wave, MQTT, or a vendor integration;
- events an integration consumes internally without placing them on the Home
  Assistant event bus;
- camera frames, microphone samples, or continuous media;
- recovery of arbitrary events that occurred while the App's local Home
  Assistant subscription was disconnected; or
- wildcard delivery of Home Assistant's special, extremely high-volume
  `state_reported` event.

Home Assistant deliberately excludes `state_reported` from all-event
listeners. That event represents every entity state write, including reports
whose state and attributes did not change, and Home Assistant requires narrow
filtered listeners for it to protect system performance.

Therefore the honest short description is:

> Every normal Home Assistant event from the whole installation while the
> bridge is subscribed—not every physical protocol packet and not continuous
> media.

### Entity, device, and area identity

Home Assistant primarily models entity state by `entity_id`. An entity may
belong to a device, and a device may belong to an area, but `device_id` is not
present in every event.

The live capability can query the entity, device, and area registries. A
consumer can then build mappings such as:

```text
sensor.living_room_temperature
  -> entity registry entry
  -> Home Assistant device 8f…
  -> area "Living Room"
```

This mapping is useful for UI and derived streams, but it does not need to
block or transform raw ingestion.

## Direction 2: a live Home Assistant API capability

### Use Home Assistant's own RPC shape

Home Assistant's WebSocket API is already an RPC protocol:

1. the client sends a JSON object containing a `type` and command-specific
   fields;
2. the connection assigns a numeric request `id`; and
3. Home Assistant returns a correlated success result or error.

The official client exposes this as:

```ts
connection.sendMessagePromise<Result>(message)
```

The capability should deliberately use the same name:

```ts
interface HomeAssistantCapability {
  sendMessagePromise<Result = unknown>(
    message: MessageBase,
  ): Promise<Result>
}

type MessageBase = {
  id?: number
  type: string
  [key: string]: any
}
```

The bridge owns the local Home Assistant connection and request IDs. A remote
caller supplies the normal Home Assistant message without an `id`; the bridge
forwards it with `sendMessagePromise` and returns Home Assistant's result.

### Examples

Read every current entity state:

```ts
const states = await homeAssistant.sendMessagePromise<HassEntity[]>({
  type: "get_states",
})
```

Turn on a light:

```ts
await homeAssistant.sendMessagePromise({
  type: "call_service",
  domain: "light",
  service: "turn_on",
  target: {
    entity_id: "light.kitchen",
  },
  service_data: {
    brightness_pct: 60,
  },
})
```

Read Home Assistant configuration:

```ts
await homeAssistant.sendMessagePromise({
  type: "get_config",
})
```

Use a command registered by a Home Assistant integration:

```ts
await homeAssistant.sendMessagePromise({
  type: "config/device_registry/list",
})
```

No additional Iterate event needs to be appended for those calls. The RPC
promise returns the Home Assistant result directly or rejects with the Home
Assistant/connection error.

### Why this is recognizably Home Assistant

Home Assistant maintains the TypeScript package
[`home-assistant-js-websocket`](https://github.com/home-assistant/home-assistant-js-websocket).
It is the normal JavaScript client for authentication, reconnecting,
subscriptions, entity collections, service calls, and arbitrary WebSocket
commands.

The package exports types including:

- `MessageBase`
- `HassEvent`
- `StateChangedEvent`
- `HassEntity`
- `HassEntities`
- `HassConfig`
- `HassService`
- `HassServices`
- `HassUser`
- `Context`

It also provides typed convenience functions such as `callService`,
`getStates`, `getConfig`, and `getUser`.

The structures are well-known in Home Assistant development, but their
TypeScript strictness has an intentional boundary:

- the command envelope is typed as `type: string` plus arbitrary fields;
- `sendMessagePromise<Result>` lets the caller state the expected result type;
- the generic event envelope has `event_type: string` and
  `data: Record<string, any>`;
- `StateChangedEvent` and common entity/config/service structures are typed;
  and
- there is no exhaustive discriminated union of every possible command or
  event because Core, built-in integrations, and custom integrations can add
  their own types and payloads.

The capability should publish/re-export these recognizable declarations rather
than define an incompatible smart-home schema. Typed convenience methods may
be added later as wrappers:

```ts
interface HomeAssistantCapability {
  sendMessagePromise<Result = unknown>(message: MessageBase): Promise<Result>

  // Possible conveniences, not required in the first implementation:
  callService?(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: HassServiceTarget,
  ): Promise<unknown>
}
```

`sendMessagePromise` remains the escape hatch and the complete initial API.

### Scope of "approximately the whole API"

The raw capability covers the authenticated **Home Assistant Core WebSocket
command namespace**:

- documented Core commands;
- commands registered by installed integrations;
- service calls;
- state, config, service, entity, device, and area queries;
- camera commands whose response is ordinary serializable JSON; and
- future JSON command types without a bridge release.

It does not automatically expose:

- Home Assistant Supervisor/host administration;
- an unrestricted proxy for arbitrary local HTTP URLs;
- WebSocket subscriptions as durable Iterate streams;
- non-serializable local objects;
- raw integration protocol connections; or
- efficient binary/media streaming.

The App should request only the Home Assistant Core API permission needed for
this bridge. Exposing Supervisor machine-management APIs would be a separate,
more privileged product decision.

## Why ordinary subscriptions do not need a reverse capability

The live API technically supports subscription commands, and Cap'n Web can
carry callback capabilities. We could eventually expose something like:

```ts
const subscription = await homeAssistant.subscribe(
  {
    type: "subscribe_trigger",
    trigger: {
      platform: "state",
      entity_id: "binary_sensor.motion_occupancy",
      from: "off",
      to: "on",
    },
  },
  receiver,
)
```

That is not needed for the first version. The all-event subscription already
lands Home Assistant's ordinary event bus in the durable connection stream.
Remote consumers should read or subscribe to that stream instead of creating
many redundant live Home Assistant subscriptions.

Specialized Home Assistant WebSocket subscriptions that are not event-bus
events can be added later when a concrete use case requires them.

## Camera images, video, and other media

Home Assistant events contain camera entity state and metadata, not the
camera's image/video bytes.

Home Assistant exposes:

- still images through `/api/camera_proxy/<entity_id>`;
- MJPEG through `/api/camera_proxy_stream/<entity_id>`; and
- stream commands that can return an HLS URL, plus integration-specific
  WebRTC support.

An HLS or camera-proxy URL returned by Home Assistant commonly points at the
local Home Assistant instance. Returning that URL through
`sendMessagePromise` does not make it reachable from Iterate.

The smallest sensible progression is:

1. ship the raw event stream and `sendMessagePromise`;
2. add an explicit `getCameraSnapshot(entityId)` capability for bounded still
   images if that is enough for the first security-camera use case; and
3. use a separately negotiated, bounded media connection or upload path for
   video, MJPEG, audio, or repeated frames.

Do not append continuous video frames to
`/integrations/home-assistant/main`. The stream should contain camera state,
motion/person events, and possibly references to captured artifacts—not an
unbounded media byte stream.

## Connection lifecycle and reconnect behavior

The App supervises two connections independently:

```text
local leg: Home Assistant App <-> Home Assistant Core
remote leg: Home Assistant App <-> Iterate /api
```

The normal startup/reconnect sequence is:

1. connect and authenticate to Home Assistant Core;
2. subscribe to all normal Home Assistant events;
3. connect and authenticate to the Iterate project;
4. get `/integrations/home-assistant/main`;
5. mount the live capability at
   `["integrations", "home-assistant", "main"]`;
6. append a current `get_states` snapshot;
7. forward each subsequent Home Assistant event; and
8. keep both connections alive and re-establish whichever leg closes.

The ordering of subscription and initial-state collection must avoid a window
where a state changes between the snapshot and the live subscription. The
implementation may subscribe first, buffer briefly, take the snapshot, and
then drain buffered events.

The official Home Assistant JavaScript client already reconnects and
re-establishes subscriptions on the local leg. Iterate's Cap'n Web session
provides the remote calls and capability callback path over one socket.

### Honest prototype guarantees

For the fastest first implementation:

- once a Home Assistant event append succeeds, that event is durable in the
  Iterate stream;
- an event may be lost if the App or local Home Assistant subscription is down
  when Home Assistant fires it;
- an event may also be lost if it is held only in memory when the App process
  crashes or the remote append fails;
- a new state snapshot restores current entity state after reconnect but
  cannot reconstruct all missed transitions;
- the live capability fails immediately and clearly while the App is offline;
  and
- capability calls are not queued for eventual physical execution.

This proposal does not describe the prototype as perfectly lossless. A
persistent local outbox, idempotent append keys, and Recorder/history backfill
are possible hardening work, but they are not required to validate the core
idea.

The minimal observability requirement is that connection loss and append
failure are visible in App logs/status rather than silently swallowed. A
single reconnect/gap diagnostic may be appended after recovery without
turning device actions into event-sourced workflows.

## Authentication and authority

### Fast internal prototype

The current machine lane can authenticate a headless App as the project using
the project's API key. That is enough for an internal vertical slice, but the
key is whole-project authority and must be treated as such.

### Product version

A productized Home Assistant connection should enroll once and receive a
revocable credential scoped to:

```text
project: <project-id>
integration: home-assistant
connection: main
stream: /integrations/home-assistant/main
capability mount: /integrations/home-assistant/main
```

It should not receive arbitrary authority over unrelated project paths.

The Home Assistant `SUPERVISOR_TOKEN` stays local. Iterate calls the provided
capability; the App uses its local credential to execute the corresponding
Home Assistant command and returns only the result.

Because the raw capability is intentionally powerful, any project actor
allowed to invoke it can potentially unlock doors, disable alarms, operate
devices, or inspect presence state to the extent Home Assistant permits.
Project authorization around this integration matters even though the bridge
implementation itself is small.

## The exact first vertical slice

### Build

- One Home Assistant App implemented in Node.js/TypeScript.
- `homeassistant_api: true` and local Supervisor-token authentication.
- `home-assistant-js-websocket` for the local Home Assistant connection.
- One outbound Iterate Cap'n Web connection.
- One canonical stream:
  `/integrations/home-assistant/main`.
- One raw event wrapper:
  `home-assistant/event`.
- One initial state wrapper:
  `home-assistant/state-snapshot`.
- One provided live method:
  `sendMessagePromise(message)`.
- Automatic reconnect and remount/resubscribe.
- Clear logs/status for either connection being unavailable and for append
  failures.

### Demonstrate

1. Install the App and connect it to an Iterate project.
2. Show a raw state snapshot containing entities from multiple integrations.
3. Press a physical ESPHome/Zigbee/Matter button or change a sensor and show
   the corresponding Home Assistant event in the stream.
4. Call `get_states` remotely through the live capability.
5. Call `light.turn_on` remotely and observe both the RPC result and the
   resulting ordinary `state_changed` event in the firehose.
6. Restart the edge connection and show that the App reconnects, remounts the
   capability, resubscribes, and appends a fresh state snapshot.
7. Demonstrate that capability calls fail clearly while the App is offline.

### Explicitly do not build yet

- Per-device source streams.
- A normalized cross-vendor device/entity schema.
- `action-requested`, `action-started`, `action-succeeded`, or
  `action-settled` event workflows.
- Durable command delivery or offline command queues.
- Exactly-once physical effects.
- A persistent local event outbox.
- Recorder/history backfill.
- A full REST or Supervisor proxy.
- Continuous camera/video/audio transport.
- Complete TypeScript unions for every Home Assistant integration command or
  event.

## Relationship to the direct ESPHome proposal

The direct ESPHome proposal gives compatible firmware its own outbound Kit
session, one device stream, and one device capability. The Home Assistant
bridge is a different and highly complementary route:

| Direct ESPHome | Home Assistant bridge |
| --- | --- |
| Requires compatible firmware and usually a reflash | Uses devices already connected to Home Assistant |
| One stream per physical device | One canonical stream per Home Assistant installation |
| Embedded C/C++ transport constraints | Full Node.js/TypeScript runtime |
| Device-specific capability | Approximately the whole Home Assistant Core WebSocket API |
| Direct visibility into the ESPHome adapter's chosen signals | Visibility into what Home Assistant exposes on its event bus/API |
| Must handle sleeping devices itself | Home Assistant absorbs individual device connectivity |
| Separate negotiated media path | Same media boundary remains necessary |

This bridge may be the fastest route to proving the overall product experience:
install one App and immediately expose a heterogeneous existing home, including
its ESPHome devices, to Iterate.

The direct-device work remains valuable for homes without Home Assistant,
lower-latency device-native control, narrower authority, and signals Home
Assistant does not expose.

## Later hardening, only after the vertical slice

Potential follow-up work, ordered by observed need:

1. bounded event batching and throughput measurements on real Home Assistant
   installations;
2. scoped connection enrollment instead of a project API key;
3. a persistent local outbox with idempotent append keys if outage loss is
   unacceptable;
4. entity/device/area registry snapshots and derived device views;
5. retention and redaction controls for sensitive presence/security data;
6. a bounded camera snapshot capability;
7. negotiated media transport;
8. specialized live subscription callbacks for non-event-bus APIs; and
9. typed convenience wrappers for frequently used Home Assistant commands.

None of these should block testing the raw firehose plus raw live capability.

## Source and implementation references

Home Assistant:

- [WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)
- [App communication with Home Assistant](https://developers.home-assistant.io/docs/apps/communication/)
- [REST API](https://developers.home-assistant.io/docs/api/rest/)
- [Camera entity API](https://developers.home-assistant.io/docs/core/entity/camera/)
- [`state_reported` wildcard-listener exception](https://developers.home-assistant.io/blog/2024/03/20/state_reported_timestamp/)
- [`home-assistant-js-websocket`](https://github.com/home-assistant/home-assistant-js-websocket)
- [`home-assistant-js-websocket` exported types](https://github.com/home-assistant/home-assistant-js-websocket/blob/master/lib/types.ts)
- [`home-assistant-js-websocket` connection API](https://github.com/home-assistant/home-assistant-js-websocket/blob/master/lib/connection.ts)

Iterate:

- [`tasks/kit-esphome-streams-proposal.html`](./kit-esphome-streams-proposal.html)
- [`apps/os/docs/integrations.md`](../apps/os/docs/integrations.md)
- [`docs/remote-apps.md`](../docs/remote-apps.md)
- [`docs/adr/0005-typescript-as-canonical-capability-description.md`](../docs/adr/0005-typescript-as-canonical-capability-description.md)
- [`apps/os/src/rpc-targets.ts`](../apps/os/src/rpc-targets.ts)
- [`apps/os/e2e/vitest/integrations-userspace.e2e.test.ts`](../apps/os/e2e/vitest/integrations-userspace.e2e.test.ts)
- [`apps/os/e2e/vitest/live-capability-websocket.e2e.test.ts`](../apps/os/e2e/vitest/live-capability-websocket.e2e.test.ts)

