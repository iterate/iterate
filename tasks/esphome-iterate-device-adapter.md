---
status: deferred
priority: low
size: large
dependsOn: []
tags: [kit, esphome, home-assistant, devices, capnweb, streams]
---

# Build an optional ESPHome-to-Iterate device adapter

**Status summary:** deferred compatibility work. Iterate should first build one
Home Assistant integration/app and use that to expose existing Home Assistant
devices to Iterate. For selected ESP hardware, the lower-level product path is
purpose-built Iterate firmware rather than requiring ESPHome. For example, the
Home Assistant Voice Preview Edition should receive custom Iterate firmware,
not an ESPHome wrapper.

This task remains useful for ESPHome devices whose existing firmware,
components, and OTA workflow are worth preserving. Its desired user experience
is a small YAML addition that compiles an Iterate external component into a
normal ESPHome build. Users should not have to fork firmware or edit C++.

## Strategic position

The intended device stack has three distinct layers:

1. **Home Assistant integration first.** A single Home Assistant
   integration/app connects Home Assistant to Iterate and maps devices,
   entities, state changes, and supported actions into Iterate streams and
   capabilities. This is the broadest path for trying the product model across
   an existing device fleet.
2. **Purpose-built firmware for selected hardware.** Devices that Iterate
   wants to support deeply receive custom firmware using the portable Kit
   runtime and hardware-specific adapters. This avoids inheriting ESPHome's
   abstractions or resource cost when they are not useful. The Home Assistant
   Voice Preview Edition is the leading example.
3. **Optional ESPHome compatibility adapter.** A YAML-loadable external
   component lets an existing ESPHome device connect directly to Iterate when
   preserving its ESPHome configuration, components, Home Assistant
   integration, and OTA lifecycle is valuable.

Do not make the ESPHome adapter a prerequisite for the Home Assistant
integration or for custom Iterate firmware. Revisit this task after the Home
Assistant integration has validated the device-stream and capability model.

## Desired ESPHome experience

Once the external component exists, enabling a supported device should require
only a YAML change and a normal ESPHome build/install:

```yaml
external_components:
  - source:
      type: git
      url: https://github.com/iterate/iterate.git
      ref: <pinned-tag-or-commit>
      path: apps/kit/esphome/components
    components: [iterate_kit]

iterate_kit:
  base_url: https://os.iterate.com
  project_id: !secret iterate_project_id
  project_api_key: !secret iterate_project_api_key
  path: /kit/living-room/ceilsense
```

During local development, `external_components.source.type: local` may point at
the component checkout. A reachable branch may be used while iterating, but
released configurations should pin an immutable tag or commit.

“YAML-enabled” still means ESPHome compiles and installs changed firmware. It
does not mean an already-flashed binary gains Iterate support without an
update. If the current image has working ESPHome OTA and its credentials are
available, the first Iterate-enabled image may be installed over the network;
USB remains the recovery path during development.

## Initial support boundary

- Support ESP32 devices using ESP-IDF first.
- Require sufficient flash, RAM, TLS, and task capacity for a second outbound
  WebSocket client.
- Let ESPHome continue to own Wi-Fi/Ethernet, OTA, NVS, entity setup,
  automations, and its native Home Assistant API.
- Do not initially promise support for ESP8266, RP2040, BK72xx, or every other
  platform ESPHome supports. The portable Kit core may eventually be reusable,
  but each platform needs a transport and resource-budget proof.
- Coexist with the existing ESPHome/Home Assistant connection; using Iterate
  must not require removing Home Assistant.

## Iterate runtime contract

The device is configured with:

- an Iterate deployment base URL, defaulting to
  `https://os.iterate.com`;
- the canonical `prj_...` project ID required by the current
  `project-secret` authentication lane;
- the project's API key; and
- one configurable device path beneath `/kit`, such as
  `/kit/living-room/ceilsense`.

While ESPHome has network connectivity, the adapter should:

1. maintain an outbound WebSocket connection to the deployment's `/api`;
2. authenticate with the existing `project-secret` credential;
3. acquire and retain the full Project capability;
4. acquire exactly one project stream at the configured device path;
5. mount one live device capability at the corresponding capability path;
6. append entity descriptions and observed device events to the device stream;
   and
7. reconnect, reauthenticate, reacquire handles, and remount the capability
   after interruption using bounded exponential backoff with jitter.

The device should endeavour to remain connected, but that must not become a
tight retry loop or an unbounded queue. Connection state, retry state, dropped
events, and queue high-water marks need explicit diagnostics.

The existing Project capability, stream API, `project-secret` authentication,
and live capability mounting should be sufficient for the prototype. Do not
introduce a restricted `KitDeviceSession` server API solely for this task.

## Device stream model

Use one stream per physical device. Entity IDs and entity types are fields in
events rather than child streams.

Prefer bounded, past-tense events such as:

- `kit/device-connected`
- `kit/device-described`
- `kit/entity-described`
- `kit/entity-state-observed`
- `kit/entity-event-observed`

Describe entities individually rather than constructing an unbounded manifest
or a bespoke `entity-manifest-chunk` event. Include stable entity identity,
ESPHome domain, object ID, display name, device class, unit, supported actions
or modes, and current availability where applicable.

Initial discovery should include all usable entities, including diagnostic
entities such as uptime and Wi-Fi signal. Filtering should be an explicit
configuration option introduced only when a real device demonstrates the need.

Reconnects may repeat descriptions. Give descriptions a firmware/configuration
identity or another explicit reconciliation rule so downstream state does not
depend on reconnect count.

## Live capabilities and actions

Durable offline actions are not required. The first adapter may expose a live
generic capability such as:

```text
device.describe()
device.getState()
device.invoke({ entityId, action, arguments })
```

Map `invoke` onto the normal ESPHome entity call paths for the supported
domains, for example:

- switch turn on/off;
- light turn on/off/control;
- button press;
- fan, cover, climate, number, select, and lock calls where their ESPHome APIs
  can be represented safely.

If the device is offline, a live call fails. After a successful call, the
normal ESPHome state callback should append the resulting observed state to the
device stream. Do not add action-requested/action-settled replay, cursors,
deduplication, cancellation, or expiry until a product use case actually
requires offline intent.

Rich media such as continuous audio is outside this adapter's first scope. The
bounded C Cap'n Web peer is suitable for ordinary RPC and event payloads, not a
high-bandwidth media plane. Purpose-built Iterate firmware should own voice and
other hardware experiences that require PCM streaming, strict realtime
budgets, or deep peripheral control.

## External component implementation

Create a normal ESPHome external component, approximately:

```text
apps/kit/esphome/components/iterate_kit/
├── __init__.py
├── iterate_kit.h
└── iterate_kit.cpp
```

The Python module should:

- define and validate the YAML schema;
- default `base_url`;
- require project ID and Project API key;
- validate and normalize the `/kit/...` device path;
- register the generated C++ component; and
- wire required sources, ESP-IDF components, compile definitions, and
  dependencies into ESPHome's build.

The C++ adapter should:

- implement an ESPHome `Component`;
- register as an ESPHome `Controller` or use the equivalent current entity
  callback mechanism;
- enumerate supported entities after setup;
- subscribe to state/event callbacks without blocking ESPHome's main loop;
- translate generic capability actions back into ESPHome entity calls; and
- own the bounded queues and lifetime of the Kit connection.

Reuse the existing Kit work where it fits:

- the portable C connection/retry state machines;
- the vendored bounded Cap'n Web peer;
- WebSocket text framing and bounded mailboxes;
- Project authentication and capability-mount logic; and
- the ESP-IDF TLS/WebSocket transport after removing assumptions that Kit owns
  Wi-Fi startup or a raw configuration partition.

Do not reuse M5-specific entity/capability implementations. Do not let the
adapter read Kit's raw configuration partition or initialize networking:
ESPHome owns both configuration generation and network lifecycle.

The current C implementation has deliberately small buffers and bounded mount
paths. Audit those limits against realistic ESPHome entity descriptions and
paths. Preserve explicit bounds; either increase justified capacities or
stream individual bounded events rather than silently truncating data.

## Prototype authentication

For the first trusted-device prototype, accept the existing Project API key
through ESPHome `!secret`. This gives the device the full Project capability,
which is acceptable for the deliberately limited experiment.

Document the consequences:

- `secrets.yaml` keeps the value out of the checked-in YAML but the credential
  is still present in the compiled device image/NVS;
- physical extraction or firmware compromise exposes broad project authority;
- current revocation may require rotating the project credential for every
  consumer; and
- logs, generated build output, diagnostics, and events must never print the
  key.

Do not block this prototype on OAuth or a device-code flow. Before treating the
adapter as a generally deployable product, design per-device scoped
credentials, revocation, rotation, enrollment, and recovery.

## Work required

- [ ] Use the Home Assistant integration to settle the canonical physical
      device, entity, state, and action representation first.
- [ ] Add the `iterate_kit` external component package and YAML schema.
- [ ] Adapt the current ESP-IDF transport to an ESPHome-owned network
      lifecycle.
- [ ] Retain the authenticated Project capability and implement real stream
      acquisition/appends in the C runtime; current Kit device-event handling
      stops short of durable stream append.
- [ ] Implement bounded device/entity description and observed-state encoding.
- [ ] Implement the generic live device capability and supported entity action
      mappings.
- [ ] Define reconnect reconciliation, event loss counters, queue bounds, and
      observable failure classifications.
- [ ] Verify coexistence with ESPHome's native API and OTA components.
- [ ] Document local-source, branch-source, pinned-release, first-install, OTA,
      credential, and USB-recovery workflows.
- [ ] Decide whether the monorepo remains the long-term external-component
      source or whether releases should be published from a smaller dedicated
      repository.

## Acceptance proof when this task is resumed

On one representative ESP32-S3 ESPHome device:

1. Adding only the documented YAML block produces a firmware build without
   editing the device's C++ or forking its existing configuration.
2. After installation, the device connects outbound, authenticates, opens its
   configured `/kit/...` stream, and mounts its live capability.
3. Sensor and binary-sensor changes appear on the single device stream with
   stable entity identity.
4. A live capability call controls at least one actuator, and its resulting
   observed state appears on the same stream.
5. Existing Home Assistant native API operation and ESPHome OTA remain usable.
6. Network loss and OS restart cause bounded, observable reconnection without
   a retry storm, unbounded memory growth, silent event loss, or divergent
   capability state.
7. No credential material appears in serial logs, Iterate events, build
   diagnostics, or checked-in configuration.
8. USB recovery from a deliberately unusable development build is documented
   and demonstrated before the adapter is tried on an inconveniently installed
   device.

## CeilSense Pro evidence

The physical CeilSense Pro investigated on 2026-07-30 positively identified
itself over its CP2102 serial bridge as:

- ESP32-S3 revision 0.2 with 4 MB flash;
- ESP-IDF 5.5.3;
- ESPHome 2026.3.3;
- `smarthomeshop.ceilsense` firmware version 1.27;
- dual OTA application partitions; and
- an installed SCD4x sensor path.

It did not appear as a reachable ESPHome native API/mDNS device on the host's
Wi-Fi subnet during the observation. No firmware was flashed. This remains
useful evidence that a CeilSense-class ESP32-S3 can host the adapter, but it is
not the active first target.
