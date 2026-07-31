# Candidate A — THE EVENT-SPINE ARCHITECTURE (Kit v2)

Status: candidate-architecture artifact, exploration round, 2026-07-31. One of
three independent design attempts. All file:line references are into the live
`c-capabilities` worktree unless marked otherwise; prior-art paths are under
`~/src/github.com/`. Companion evidence: the seven exploration files in this
folder (cited as `os-streams`, `stackchan-autopsy`, `sd-event-logging`,
`proxy-session-economics`, `hardware-plugability`, `testing-three-layers`,
`code-reduction-audit`) and the architecture review
(`../../fable-firmware-architecture-review-2026-07-31.md`, R1–R13).

---

## 0. The bet

**The device's core data structure is a bounded event — interned type,
packed payload, boot-local sequence, boot epoch, monotonic timestamp — from
the first instruction after static init.** Buttons, PTT edges, remote command
requests, lifecycle, Wi-Fi transitions, socket generations, diagnostics
incidents, playback incidents, route changes: all admitted into ONE
single-writer lapped ring (the spine) with per-sink read cursors. Sinks are
pluggable and independently bounded: the Cap'n Web subscription, the SD card,
the serial console, retained-latest views — and, one hop up, the userspace
worker's cross-post into an apps/os stream at `/kit/devices/<deviceId>`. The
realtime PCM lane stays a separate non-event fast path (latency law), but it
_emits_ spine events at every ownership boundary. Capabilities become thin
translations: state-mutating RPC → command-shaped event in; `subscribe*` →
event feed out.

Three facts make this more than aesthetics:

1. **v1 already built four separate "something happened, someone must hear
   it" machines** — `device_events` (329 LOC), `device_event_stream` (653),
   the metrics subscription scheduler (~500 of `metrics.c`'s 1,510), and
   `runtime_diagnostics` (~755) — and two of them contain the _same_ five
   delivery booleans written twice
   (`device_event_stream.h:74-77` vs `metrics.h:314-318`:
   `occupied/call_in_flight/callback_budget_reserved/release_pending`).
   The spine is not a new idea; it is the admission that these four are one
   thing (code-reduction-audit §2c).
2. **The platform side is already event-sourced.** Every device connect
   appends a durable `capability-host/capability-provided` event to the
   project root stream (`components/core/src/itx_mount.c:5-27`;
   os-streams §6), and the goal doc mandates the direction: "Holding and
   releasing its physical button produce the same bounded application events
   that can also be invoked remotely. This is the basis for later stream
   cross-posting" (`apps/kit/docs/physical-device-voice-goal.md:142-144`).
   The seam is literally marked `wouldPostToStream: true` in the worker
   (`apps/kit/src/userspace/config-worker/worker.ts:245-253`).
3. **The late addendum (audio-less devices) is this candidate's home turf.**
   An e-ink + buttons device under this architecture is _just the spine_:
   event core + control plane + sinks + renderers, with zero audio code in
   the link set. "Has audio" becomes "the audio component publishes into the
   spine and consumes from it" — a plugin, not the organizing principle. The
   minimal device IS the spine.

And the honesty clause, up front: the spine does **not** eat metrics sampling
(gauges stay a sampler; the spine carries a _reference_, §1.5), does **not**
eat PCM (never, not even ephemeral), does **not** fix the capture priority
orphan (R1 is orthogonal), and its total order is _admission_ order, not
physical-simultaneity order (§10.2). Where it fights physics, it yields —
loudly, in one place each.

---

## 1. The spine itself

### 1.1 The record

Three candidate representations were laid out in os-streams §9 (interned
64-byte envelope / 24-byte tagged union / 256-byte preformatted JSON). This
candidate adopts **the interned envelope** and tunes it:

```c
struct iterate_kit_event {           /* off sz                                */
  uint16_t type_id;                  /*  0  2  interned index; 0 = invalid    */
  uint8_t  source;                   /*  2  1  physical / remote / system     */
  uint8_t  flags;                    /*  3  1  bit0 payload_truncated,
                                               bit1 sideslot_reference        */
  uint32_t sequence;                 /*  4  4  spine admission order,
                                               boot-local, monotonic          */
  uint64_t origin_uptime_us;         /*  8  8  stamped at ORIGIN (ISR/task),
                                               not at admission               */
  uint32_t boot_epoch;               /* 16  4  NVS counter; every slot is
                                               self-describing (SD forensics) */
  uint16_t payload_length;           /* 20  2                                 */
  int16_t  handler_status;           /* 22  2  iterate_kit_status of the
                                               acting consumer (§1.3)         */
  uint8_t  payload[40];              /* 24 40  per-type packed struct         */
};                                   /* 64 bytes, no padding                  */
_Static_assert(sizeof(struct iterate_kit_event) == 64u, "spine slot budget");
```

Deliberate choices, each a divergence someone must sign off on:

- **No `path` in the slot.** One device = one stream; `path`/`offset`/
  `createdAt` are assigned by the platform stream at commit and do not even
  exist in `StreamEventInput`
  (`packages/iterate/src/processors/schemas.ts:87-92`). Storing a path
  per-slot would be ~20 bytes of the same constant 64 times over. The
  X-macro row _can_ grow a path-suffix column the day sub-streams
  (`/kit/devices/<id>/voice`) exist; the slot never changes. This is the one
  place this candidate softens the maximalist "path in every record" reading
  — flagged for Jonas (§12 Q1).
- **`type_id` is a u16 intern index; the URI string lives in the X-macro
  table** (§3.1). Nothing off-device ever sees the index: every sink
  serializer emits the full `events.iterate.com/kit-device/...` string.
  41-byte URIs × 64 slots would triple the ring for zero information
  (os-streams §14 ⚠1).
- **Two time-ish fields, two jobs.** `origin_uptime_us` is stamped where the
  edge physically happened (ISR, foreign task); `sequence` is stamped at
  spine admission on the owner task. Under tributary marshalling (§1.2) these
  can disagree by one drain latency (≤ one 10 ms tick). Total order = the
  sequence; physical timing = the timestamp. Both are honest; neither
  pretends to be the other.
- **`handler_status` records what the acting consumer did** — preserving
  today's contract that observers see the handler result
  (`device_event_stream.h:31` `int32_t result`;
  `devices/m5sticks3/m5sticks3.c:64-77` "Audio state has already changed when
  this observer runs") without doubling every event into a
  request/result pair.
- **40-byte payload ceiling, packed per-type structs.** `wifi-lost` carries
  `{u8 reason; i8 rssi}`; `event-gap-observed` carries
  `{u32 expected; u32 actual; u32 lost}`. Anything bigger sets
  `payload_truncated` or uses a `sideslot_reference` (§1.5). Variable-length
  prose does not belong on a 64-byte spine; it belongs in retained buffers
  the payload can point at.

Rejected alternatives, with reasons (full trade table in os-streams §9):
the 24-byte tagged union recreates the schema-triplication disease R7 exists
to kill (every new type edits union + N switches + TS mirror); the 256-byte
preformatted-JSON slot spends 16 KiB of RAM and moves `snprintf` onto the
publisher's hot task for aesthetics.

### 1.2 One log; tributaries; the total order

The spine is **one single-writer lapped ring** owned by the main task, fed by
bounded **tributaries** from every other context:

```
button GPIO ISR ──► tributary (ISR-safe, 8 slots) ─┐
Wi-Fi event cb ──► tributary (ctrl-net task, 8)  ──┤            ┌──────────────────────────┐
PCM net task   ──► tributary (8)                 ──┼─ admission ─►  SPINE  64 × 64 B ring  │
audio owner    ──► tributary (8, core 1)         ──┤  (main task,└───┬─────┬─────┬─────┬───┘
RPC dispatch   ──► publish directly (same task)  ──┘   assigns      │     │     │     │
                                                       sequence,    ▼     ▼     ▼     ▼
                                                       runs handler capnweb  SD  console retained
                                                       chain, stamps sink   sink  sink   -latest
                                                       handler_status)
```

Why this topology and not the alternatives:

| Option                                                             | Shape                                                                                                                                 | Verdict                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A (chosen): single-writer spine + per-context SPSC tributaries** | foreign contexts `try_publish` into a private SPSC; owner drains tributaries into the spine each tick; sequence assigned at admission | Preserves v1's "one deterministic total order for physical and remote edges" (`device_events.h:80-85`, the property `push_to_talk.c` exists for) and generalizes the marshalling contract v1 already demands of platforms. The tributary is the existing ISR→4-slot-SPSC audio idiom (`m5sticks3_direct_audio.hpp` EOF path) made a first-class module. |
| B: one log per clock domain, sinks merge by timestamp              | per-task rings, merge at read                                                                                                         | Rejected: timestamp merging across cores re-imports the cross-socket ordering problem in miniature; the total order is the asset (a lost PTT ordering can invert microphone meaning — `worker.ts:279-287`).                                                                                                                                             |
| C: lock-free MPMC spine                                            | atomics everywhere                                                                                                                    | Rejected: hand-rolled memory-order code is exactly what R8 wants _less_ of; eight copy-pasted atomics helpers was the disease (code-reduction-audit a1).                                                                                                                                                                                                |

Admission rules (all inherited from proven v1 designs):

1. **Publish never blocks, never fails.** The spine overwrites the oldest
   slot unconditionally; tributaries drop-new with saturating counters
   (identical policy to every v1 queue, `spsc_ring.h` contract).
2. **A lapped cursor IS the gap** (§1.4). No coalescing state machine; no
   "keep newest" special case. The current coalesce-and-count design
   (`device_event_stream.h:58-63`) becomes a uniform per-sink rule, and the
   goal doc's "every sink records explicit sequence gaps and drop/overflow
   counts" (`physical-device-voice-goal.md:309`) holds _by construction_.
3. **Handler chain at admission, sinks after.** Acting consumers (the audio
   controller for PTT, the knob-applier for gain requests) run synchronously
   in table order on the owner task, exactly like today's
   `iterate_kit_device_event_handler` (`device_events.h:36-47`); their status
   is stamped into the slot before any sink can observe it. Handler failure
   consumes the event once — no implicit retry (`device_events.h:75-79`
   contract survives verbatim).
4. **Bounded work per tick.** Admission drains ≤ N tributary entries and
   sinks drain ≤ M slots per poll, under the existing callback-budget
   discipline (`capabilities/callback_budget.h`) for the Cap'n Web sink and a
   byte budget for the console sink — the goal doc's "bounded background
   work" tier (`physical-device-voice-goal.md:182-185`).

RAM cost, exactly: spine 64 × 64 B = 4,096 B; four tributaries 8 × 64 B =
2,048 B; side-slot (§1.5) 2 × ~640 B = 1,280 B. **≈ 7.4 KiB internal RAM**,
against which the deleted structures return ~0.6 KiB (8×2 B event queue,
4×24 B stream queue, diagnostics staging). Net ≈ +6.8 KiB internal — real,
affordable (the audio path uses zero PSRAM and the control ring already
budgets KBs), and stated here so nobody discovers it in `sizeof(Runtime)`.

### 1.3 Command events in: RPC → spine

v1 already has the pattern in miniature: remote `pushToTalk.start/stop`
publishes into the _same_ queue as the physical button so "remote and
physical edges share one total order" (`push_to_talk.c:7-13` per
firmware-core; wired at `m5sticks3.c:41-57`). v2 makes it the rule, with a
sharp boundary:

**Through the spine** (state-machine inputs — anything two sources could
race on):

- `ptt-started` / `ptt-stopped` (physical, remote, system — exists today)
- `gain-change-requested {centi_db}` (remote knob; handler = audio owner
  snapshot-applier; `handler_status` = clamped/accepted/rejected)
- `route-change-requested` (future duplex/mute toggles)
- provisioning-tunable updates (the R6 clamped TLV subset, if a live
  `setTuning` ever ships)

**Direct calls, optional fact after** (imperative side effects with no
racing state machine):

- `screen.renderPng(url)`, `camera.takePhoto()`, `servos.move()` — execute
  synchronously as today (`screen.h:22-37`, `servos.h:18-41` vtables
  unchanged); each module _may_ publish a compact outcome fact
  (`screen-render-settled {status}`) if the device history wants it.
  Per-module choice in the composition root, not a framework rule.

**Never through the spine** (reads): `getDiagnostics`, `sample()`,
`subscribeTo*`, `__describe`. Reads are reads.

This is "capabilities become RPC → command events in, subscription → event
feed out, where sensible" — with "where sensible" defined operationally:
_if two sources can race on the state, the spine's total order arbitrates;
otherwise don't pay the amplification._

### 1.4 Sinks, cursors, and gap facts

Every consumer holds a cursor `{next_sequence, gap_events, gap_incidents}`.
Reading past a lap returns a **GAP result carrying
`{expected_sequence, actual_sequence}` before the next event** — the sink
converts it into its own gap fact:

- capnweb sink → a gap notification in the batch (v1's
  `coalesced_notifications` field, generalized);
- SD sink → a `GAP` record in the block stream (sd-event-logging §5.2);
- worker cross-post → a durable `kit-device/event-gap-observed` event —
  exactly the diagnostic shape userspace already defines
  (`device-events.ts:24-32` per os-streams §12).

Two consumers, two gap _policies_, one gap _fact_: the PTT-controlling
subscriber keeps its stricter rule (gap ⇒ close the PCM generation and
resync via snapshot — `worker.ts:279-287`, "Guessing after a lost PTT edge
can commit the wrong microphone turn"), while dashboards render "14 events
lost between 10:41:02 and 10:41:19" instead of silently smooth history.

**Retained-state views: derived vs beside — both, split by kind.** The brief
asks to explore both; the answer falls out of a facts-vs-gauges split:

- _Derived from events_: **retained-latest per event class** — the newest
  `incident-recorded`, the newest connectivity transition, current PTT
  state. ~100 LOC view over the spine (newest slot per class), and it is
  what `getDiagnostics`' incident half serializes. The post-subscribe
  snapshot (a v1 crown jewel — reconnect while the button is held restores
  state without inventing an edge, `device_event_stream.h:22-26`)
  generalizes to "retained-latest of every class + the cursor you start
  from".
- _Beside the spine_: **counters and periodic samples**. Producers keep
  bumping owner-local atomics; samplers keep pulling (`metrics.h:284-293`
  driver survives). Fully deriving counters from events would mean an event
  per increment — write amplification at exactly the rates the spine must
  refuse (§1.6). The review already graded this mechanism cleanly separable
  (review §5, metrics row); keep it.
- _Full on-device reduction_ ("device state = reduce(all events)", the
  apps/os processor pattern pushed into firmware) — **explored and
  rejected**: it duplicates the host-side `KitDeviceProcessor`'s job (§8.2)
  on a chip with 40-byte payloads, and every consumer that needs reduced
  state (dashboard, worker) lives off-device anyway. The device keeps
  _retained-latest_, not _reduced-anything_.

`getDiagnostics` in v2 = serialize(retained-latest incidents) +
serialize(latest sample) through the generated emitter, keeping the
1536-byte capacity proof (`metrics.h:357-364`) and the one-in-flight
deferred-reply latch unchanged.

### 1.5 Metrics: the side-slot (the maximalist move, priced honestly)

The naive maximalist reading — every 1 Hz metrics sample becomes a full
snapshot event — dies on arithmetic: a ~600 B sample either balloons every
64 B slot 10–20× (4 KiB ring → 40 KiB) or forces variable-size slots and
kills the fixed-slot single-writer proof (code-reduction-audit §2c Option A,
"Do not do this"). But stopping at "sampler stays fully separate" (Option B)
leaves TWO delivery machines. This candidate takes **Option C, promoted to
the design**: the sampler stays outside the spine, and every sample admits a
16-byte-payload event:

```c
/* payload of kit-device/metrics-sampled */
struct iterate_kit_event_payload_metrics_sampled {
  uint32_t sample_generation;   /* which side-slot write this refers to      */
  uint8_t  slot_index;          /* double buffer: 0/1                        */
  uint8_t  reserved[3];
  uint64_t sampled_at_us;
};
```

The sample itself lives in a **double-buffered side-slot** guarded by a
seqlock — stolen from stackchan's face publisher (odd/even
`published_sequence` bumped around every mutation, writer never blocks,
reader retries on torn read; `firmware-ws/main/face_viseme.c:116-126`,
stackchan-autopsy §2.1). Sinks that care (SD: persist the 1 Hz snapshot for
"we weren't listening" forensics, sd-event-logging §4.3; capnweb: a
metrics-view subscriber) dereference the side-slot at drain time; if the
generation has moved on, that is a _sample-missed_ fact, not corruption.
Sinks that don't care (console) skip the class.

What this buys: **exactly one delivery machine on the device.**
`subscribeToEvents` and `subscribeToMetrics` become two parameterizations of
the same `event_subscription` module (§3.4) — different class filters,
different serializers, same slot bookkeeping, same budget admission, same
release-pending ownership. The duplicated five-boolean machinery
(`device_event_stream.h:74-77` = `metrics.h:314-318`) is written once. What
it costs: the side-slot is a standing admission that gauges are not events —
the spine carries the _fact that a sample exists_, never the sample. That
line is the design.

Per-subscriber interval pacing (today's `subscribeToMetrics` intervals)
becomes sink policy: a metrics-view subscription skips `metrics-sampled`
events until its interval elapses — pacing by _dropping references_ is free;
pacing by queueing samples was the old design's cost.

### 1.6 Boot moment zero, and the admission-rate law

The spine initializes before Wi-Fi, before transports, before audio — right
after static storage and the config partition read. The first admitted
events of every boot, in order:

```
1  kit-device/booted            {reset_reason, firmware_sha_prefix, boot_epoch}
2  kit-device/config-loaded     {config_crc, base_url_hash, has_device_id}
3  kit-device/wifi-connecting   {}
4  kit-device/wifi-connected    {rssi, channel}
5  kit-device/control-mounted   {generation}
6  kit-device/pcm-connected     {generation}
```

The console sink works from slot 1 (serial exists at boot); the SD sink
attaches when the card mounts; the capnweb sink attaches when a session
subscribes. Boot forensics stop being printf archaeology: the 17–19 s
station-outage class (memory ledger: churn replies carried a Wi-Fi reason
the host _discarded_) becomes durable `wifi-lost {reason, rssi}` facts that
survive on SD even when nobody was listening — requirement 5's exact
scenario.

**The admission-rate law** (what keeps the maximalism honest): the spine
admits _state transitions and incidents_, never periodic work. Budget: the
64-slot ring at a sustained 2 events/s gives every sink a 32 s catch-up
window; a pathological 20 events/s still gives 3.2 s. Debug builds assert a
per-producer sustained-rate ceiling; tributary drop counters catch
violations in release. Concretely banned from the spine forever: per-frame
PCM telemetry (50 Hz), per-descriptor completions, per-tick anything, raw
PCM in any form (req 8: "Just not the latency-sensitive PCM"), transcription
deltas (those are worker-side `ephemeral: true` rows — os-streams §11).

### 1.7 The PCM lane: not events, but event-emitting

The audio path keeps every property the stackchan autopsy proved v1 right
about (SPSC frame rings + epoch purge vs drop-newest StreamBuffers; 20 ms
frames vs 100 ms quanta; generation fencing to DMA teardown vs none —
stackchan-autopsy §5.6). The spine touches it only at ownership boundaries,
via the audio owner's tributary:

| Boundary                            | Event                                 | Payload                        | Rate          |
| ----------------------------------- | ------------------------------------- | ------------------------------ | ------------- |
| PCM socket generation up/down       | `pcm-connected` / `pcm-lost`          | `{generation, close_class}`    | per reconnect |
| capture session edges               | `capture-started` / `capture-stopped` | `{route}`                      | per PTT press |
| playback drain edge (R12!)          | `playback-drained`                    | `{generation, frames_played}`  | per turn      |
| generation poison / driver overflow | `incident-recorded`                   | `{kind, detail, value, total}` | per incident  |
| peer-guard trip / uplink purge      | `incident-recorded`                   | same                           | per incident  |
| route applied (codec fence done)    | `route-applied`                       | `{route, elapsed_us}`          | per switch    |

The R12 "defer mic-open until playback fully drains" polish stops being a
bespoke edge callback: the audio controller consumes `playback-drained` from
the spine like any other input, on the same total order as the PTT edge that
raced it. The half-duplex fence's asynchronous `ROUTE_APPLIED` acknowledgment
(hardware-plugability §1.6, killing the 1 s synchronous main-task fence at
`m5sticks3_direct_audio.hpp:173`) surfaces as `route-applied` with a
measured `elapsed_us` — button-to-capture latency becomes a first-class
recorded interval instead of a blocking call nobody times.

---

## 2. Component/module layout (deliverable 1)

```
vendor/capnweb                  bounded C99 Cap'n Web peer (unchanged; responder.c
                                + call_path pruned per audit b4)
components/spine                THE NEW CORE. Zero deps beyond status/atomic/clock:
  event.h / event_types.def       64-B record + X-macro type table (single source
                                  for C enum, URI strings, payload packers, TS types,
                                  SD dictionary — the R7 generator generalized)
  log.{h,c}                       single-writer lapped ring, admission, handler
                                  chain, per-sink cursors, gap results
  tributary.{h,c}                 bounded cross-context publisher (task + ISR-safe
                                  variants); the marshalling rule of
                                  device_events.h:80-85 made a module
  serialize.{h,c}                 bounded JSON emitter → StreamEventInput-shaped
                                  text; binary record packer (shared with SD)
  retained.{h,c}                  retained-latest per class; snapshot support
  sideslot.{h,c}                  seqlock double-buffered sample slot (§1.5)
  console_sink.{h,c}              byte-budgeted serial sink; adopts the
                                  runtime_diagnostics write_fn contract VERBATIM
                                  (runtime_diagnostics.h:133-147)
components/core                 protocol/plumbing only (R3 realized): itx_mount,
                                itx_connection, websocket tx/rx/text (outbox/inbox
                                only), spsc_ring, retry_gate, configuration,
                                wifi_station (NEW: R13 extraction from
                                itx_transport.c:1010-1164), status/atomic
components/audio                pcm_websocket, pcm_lane, uplink conductor/sender,
                                peer_delivery_guard, audio controller,
                                audio_processor seam + null processor (R2),
                                audio_codec vtable (hardware-plugability §1.4).
                                Depends on spine (publishes/consumes); spine NEVER
                                depends on audio — the audio-less link set is a
                                link-time truth (late addendum discharged here)
components/capabilities         thin RPC modules over drivers + spine:
  event_subscription.{h,c}        THE ONE delivery machine (§3.4): capnweb sink;
                                  subscribeToEvents + subscribeToMetrics are
                                  parameterizations
  metrics.{h,c}                   sampler + getDiagnostics only (~400 LOC, down
                                  from 1,901 incl. header); schema generated
  push_to_talk / leds / servos / screen / camera-as-needed: unchanged mechanism
  callback_budget.h               unchanged
components/sdlog                SD sink (req 5): block framer (CRC32C 4 KiB
                                blocks of verbatim 64-B spine slots + DICTIONARY/
                                TIME_ANCHOR/GAP/SNAPSHOT records), pump state
                                machine, block_store vtable (sd-event-logging §6)
components/analysis   (later)   viseme/renderer-input analysers harvested from
                                stackchan (face_spectral.c 112-B integer driver
                                first; stackchan-autopsy §7)
devices/<board>/                composition roots: profile.h (Tier-1 geometry) +
                                profile.c (Tier-2 const policy struct incl. the
                                per-board event-class table) + module table wiring
platforms/iterate_esp_idf       itx_transport (thinner: Wi-Fi extracted, publishes
                                spine events via tributary), pcm_transport (gate
                                fix, boundary events), websocket_connection,
                                sd_block_store (Waveshare SDMMC / CoreS3 SDSPI),
                                isr tributary glue
platforms/common                RealtimePlayback, DirectI2sStereoOutput — untouched
                                crown jewels (realtime_playback.hpp 1,863 LOC)
targets/<board>/main            boot order, static Runtime, task creation
```

Dependency law, enforced at link time (converting
`firmware-architecture.test.ts` greps into linker truths, review §5): `spine`
depends on nothing but `status/atomic/clock`; `core` and `audio` depend on
`spine`; `capabilities` depends on `spine + core (+ audio only for
push_to_talk/audio modules)`; an e-ink board links
`spine + core + capabilities(subset) + sdlog?` and **nothing under
`components/audio` exists in its image**.

---

## 3. C header sketches (deliverable 2)

House style throughout: caller-owned storage, options structs, vtables,
`enum iterate_kit_status`, reasoning comments.

### 3.1 `iterate/kit/spine/event.h` — the record and the single-source table

```c
#ifndef ITERATE_KIT_SPINE_EVENT_H
#define ITERATE_KIT_SPINE_EVENT_H

#include "iterate/kit/status.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * One X-macro row per event type: numeric id (stable forever, append-only),
 * C name, wire type URI, event class, payload struct tag. The same .def file
 * is consumed by (1) this header's enum, (2) the URI string table in
 * serialize.c, (3) the payload packers, (4) a ~150-LOC TS generator emitting
 * the zod union + SD-ingest decoder table + wire-constant equality fixtures.
 * This is review R7/R10 generalized: adding an event type is ONE row plus one
 * payload struct; forgetting a serializer case is a compile error, not a
 * runtime mystery.  Ids are wire-stable: rows are never renumbered or reused.
 */
#define ITERATE_KIT_EVENT_TYPES(X)                                            \
  /* id  NAME                URI (events.iterate.com/…)        class      payload */ \
  X( 1, BOOTED,              "kit-device/booted",              LIFECYCLE, boot)     \
  X( 2, CONFIG_LOADED,       "kit-device/config-loaded",       LIFECYCLE, config)   \
  X( 3, WIFI_CONNECTING,     "kit-device/wifi-connecting",     CONNECT,   none)     \
  X( 4, WIFI_CONNECTED,      "kit-device/wifi-connected",      CONNECT,   wifi)     \
  X( 5, WIFI_LOST,           "kit-device/wifi-lost",           CONNECT,   wifi)     \
  X( 6, CONTROL_MOUNTED,     "kit-device/control-mounted",     CONNECT,   generation) \
  X( 7, CONTROL_LOST,        "kit-device/control-lost",        CONNECT,   generation) \
  X( 8, PCM_CONNECTED,       "kit-device/pcm-connected",       CONNECT,   generation) \
  X( 9, PCM_LOST,            "kit-device/pcm-lost",            CONNECT,   generation) \
  X(10, PTT_STARTED,         "kit-device/ptt-started",         INPUT,     none)     \
  X(11, PTT_STOPPED,         "kit-device/ptt-stopped",         INPUT,     none)     \
  X(12, BUTTON_PRESSED,      "kit-device/button-pressed",      INPUT,     button)   \
  X(13, DIAL_TURNED,         "kit-device/dial-turned",         INPUT,     dial)     \
  X(14, MUTE_SWITCHED,       "kit-device/mute-switched",       INPUT,     toggle)   \
  X(15, CAPTURE_STARTED,     "kit-device/capture-started",     AUDIO,     route)    \
  X(16, CAPTURE_STOPPED,     "kit-device/capture-stopped",     AUDIO,     route)    \
  X(17, PLAYBACK_DRAINED,    "kit-device/playback-drained",    AUDIO,     playback) \
  X(18, ROUTE_APPLIED,       "kit-device/route-applied",       AUDIO,     route_applied) \
  X(19, GAIN_CHANGE_REQUESTED,"kit-device/gain-change-requested",COMMAND, gain)     \
  X(20, INCIDENT_RECORDED,   "kit-device/incident-recorded",   INCIDENT,  incident) \
  X(21, EVENT_GAP_OBSERVED,  "kit-device/event-gap-observed",  INCIDENT,  gap)      \
  X(22, METRICS_SAMPLED,     "kit-device/metrics-sampled",     METRICS,   sideslot) \
  X(23, SD_STATE_CHANGED,    "kit-device/sd-state-changed",    LIFECYCLE, sd_state) \
  X(24, REBOOT_SCHEDULED,    "kit-device/reboot-scheduled",    LIFECYCLE, reboot)
  /* Boards contribute rows through their profile's class table, not by
   * editing core rows; the table is open-ended and append-only. */

enum iterate_kit_event_type_id {
#define ITERATE_KIT_EVENT_TYPE_ENUM(id, name, uri, cls, payload)              \
  ITERATE_KIT_EVENT_##name = (id),
  ITERATE_KIT_EVENT_TYPES(ITERATE_KIT_EVENT_TYPE_ENUM)
#undef ITERATE_KIT_EVENT_TYPE_ENUM
};

enum iterate_kit_event_class {
  ITERATE_KIT_EVENT_CLASS_LIFECYCLE = 1u << 0,
  ITERATE_KIT_EVENT_CLASS_CONNECT   = 1u << 1,
  ITERATE_KIT_EVENT_CLASS_INPUT     = 1u << 2,
  ITERATE_KIT_EVENT_CLASS_AUDIO     = 1u << 3,
  ITERATE_KIT_EVENT_CLASS_COMMAND   = 1u << 4,
  ITERATE_KIT_EVENT_CLASS_INCIDENT  = 1u << 5,
  ITERATE_KIT_EVENT_CLASS_METRICS   = 1u << 6,
};

enum iterate_kit_event_source {
  ITERATE_KIT_EVENT_SOURCE_PHYSICAL = 0,
  ITERATE_KIT_EVENT_SOURCE_REMOTE,
  ITERATE_KIT_EVENT_SOURCE_SYSTEM,
};

enum iterate_kit_event_flags {
  ITERATE_KIT_EVENT_FLAG_PAYLOAD_TRUNCATED = 1u << 0,
  ITERATE_KIT_EVENT_FLAG_SIDESLOT_REFERENCE = 1u << 1,
};

/** The spine slot. 64 bytes, layout proven by static assert; see §1.1. */
struct iterate_kit_event {
  uint16_t type_id;
  uint8_t source;
  uint8_t flags;
  uint32_t sequence;
  uint64_t origin_uptime_us;
  uint32_t boot_epoch;
  uint16_t payload_length;
  int16_t handler_status;
  uint8_t payload[40];
};

/* Per-type packed payloads (representative; one struct per table tag). */
struct iterate_kit_event_payload_wifi { uint8_t reason; int8_t rssi; uint8_t channel; };
struct iterate_kit_event_payload_generation { uint32_t generation; uint16_t close_class; };
struct iterate_kit_event_payload_gap { uint32_t expected_sequence; uint32_t actual_sequence; uint32_t lost_events; };
struct iterate_kit_event_payload_incident { uint16_t kind; uint16_t detail; uint32_t value; uint32_t total_count; };
struct iterate_kit_event_payload_route_applied { uint8_t route; uint8_t status; uint32_t elapsed_us; };

const char *iterate_kit_event_type_uri(uint16_t type_id);       /* NULL if unknown */
uint32_t iterate_kit_event_type_class(uint16_t type_id);        /* 0 if unknown    */

#ifdef __cplusplus
}
#endif
#endif
```

### 3.2 `iterate/kit/spine/log.h` — admission, handlers, cursors

```c
#ifndef ITERATE_KIT_SPINE_LOG_H
#define ITERATE_KIT_SPINE_LOG_H

#include "iterate/kit/spine/event.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum iterate_kit_status (*iterate_kit_event_handler_fn)(
    void *context, const struct iterate_kit_event *event);

/**
 * Acting consumer, run synchronously at admission on the owner task, in
 * table order, BEFORE any sink can observe the slot. The first handler whose
 * class mask matches acts; its status is stamped into handler_status. This
 * preserves the v1 handler/observer split (device_events.h:36-52,
 * m5sticks3.c:41-87): sinks always see what the device actually did.
 */
struct iterate_kit_event_handler {
  void *context;
  uint32_t class_mask;                 /* which classes this handler consumes */
  iterate_kit_event_handler_fn handle;
};

struct iterate_kit_event_log_options {
  /*
   * All storage borrowed for the log lifetime, v1 idiom. Capacity must be a
   * power of two: slot = sequence & (capacity - 1), no division anywhere.
   * The handler table is fixed at init; composition roots wire it exactly
   * like today's module table (m5sticks3.c:158-176).
   */
  struct iterate_kit_event *slots;
  size_t capacity;
  uint32_t boot_epoch;
  const struct iterate_kit_event_handler *handlers;
  size_t handler_count;
};

struct iterate_kit_event_log_metrics {
  uint32_t events_admitted;
  uint32_t handler_failures;
  uint32_t tributary_drained;
  uint32_t high_water_lag;             /* worst cursor lag ever observed */
};

struct iterate_kit_event_log {
  struct iterate_kit_event_log_options options;
  uint32_t next_sequence;              /* single writer: owner task only */
  struct iterate_kit_event_log_metrics metrics;
  bool initialized;
};

enum iterate_kit_status iterate_kit_event_log_init(
    struct iterate_kit_event_log *log,
    const struct iterate_kit_event_log_options *options);

/**
 * Owner-task publish: stamps sequence + boot_epoch, runs the handler chain,
 * commits the slot. Never blocks, never fails for capacity (oldest slot is
 * overwritten; lagging cursors observe the lap as a gap). origin_uptime_us
 * and source/payload come from the caller so tributary-relayed events keep
 * their physical timestamps.
 */
enum iterate_kit_status iterate_kit_event_log_publish(
    struct iterate_kit_event_log *log,
    uint16_t type_id, uint8_t source, uint64_t origin_uptime_us,
    const void *payload, size_t payload_length);

/* ---- cursors ---- */

enum iterate_kit_event_read_result {
  ITERATE_KIT_EVENT_READ_EMPTY = 0,
  ITERATE_KIT_EVENT_READ_EVENT,
  /** The cursor was lapped; gap details are filled in and surfaced ONCE,
   *  BEFORE the next readable event. A lapped cursor IS the gap fact. */
  ITERATE_KIT_EVENT_READ_GAP,
};

struct iterate_kit_event_cursor {
  const struct iterate_kit_event_log *log;
  uint32_t next_sequence;
  uint32_t class_mask;                 /* sinks subscribe by class */
  uint32_t gap_events_total;
  uint32_t gap_incidents;
};

enum iterate_kit_status iterate_kit_event_cursor_open(
    struct iterate_kit_event_cursor *cursor,
    const struct iterate_kit_event_log *log,
    uint32_t class_mask);

enum iterate_kit_event_read_result iterate_kit_event_cursor_next(
    struct iterate_kit_event_cursor *cursor,
    struct iterate_kit_event *out_event,
    struct iterate_kit_event_payload_gap *out_gap);

#ifdef __cplusplus
}
#endif
#endif
```

### 3.3 `iterate/kit/spine/tributary.h` — cross-context publishing

```c
#ifndef ITERATE_KIT_SPINE_TRIBUTARY_H
#define ITERATE_KIT_SPINE_TRIBUTARY_H

#include "iterate/kit/spine/event.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Bounded single-producer/single-consumer relay from a foreign context
 * (another task, or an ISR when constructed with the isr flag) onto the
 * spine owner. This is the marshalling rule device_events.h:80-85 already
 * imposed on platforms ("platforms must first marshal ISR/cross-core edges
 * onto the owner task"), provided once instead of reinvented per board.
 *
 * try_publish never waits: a full tributary drops the NEW candidate and
 * saturates dropped_candidates — the spine's freshness doctrine is
 * drop-oldest, but a tributary is a relay, not a log; keeping its oldest
 * preserves the earliest un-relayed edge, which is the one whose loss would
 * invert state machines (a PTT press must not vanish in favor of its own
 * release; the release becomes the gap instead).
 *
 * The candidate's sequence field is ignored; admission assigns it. The
 * candidate's origin_uptime_us is preserved verbatim.
 */
struct iterate_kit_event_tributary_options {
  struct iterate_kit_event *slots;     /* caller-owned, power-of-two count */
  size_t capacity;
  bool isr_producer;                   /* selects the memory-order pairing */
};

struct iterate_kit_event_tributary_metrics {
  uint32_t candidates_published;
  uint32_t candidates_relayed;
  uint32_t dropped_candidates;
  uint32_t high_water;
};

struct iterate_kit_event_tributary;    /* storage-visible struct in .h body */

enum iterate_kit_status iterate_kit_event_tributary_init(
    struct iterate_kit_event_tributary *tributary,
    const struct iterate_kit_event_tributary_options *options);

/** Producer side; safe from the configured foreign context only. */
enum iterate_kit_status iterate_kit_event_tributary_try_publish(
    struct iterate_kit_event_tributary *tributary,
    uint16_t type_id, uint8_t source, uint64_t origin_uptime_us,
    const void *payload, size_t payload_length);

/**
 * Owner side: relay up to max_events candidates into the log. Called from
 * the spine owner's tick; bounded work per turn, same discipline as
 * device_event_poll (device_events.h:109-116).
 */
size_t iterate_kit_event_tributary_drain(
    struct iterate_kit_event_tributary *tributary,
    struct iterate_kit_event_log *log,
    size_t max_events);

#ifdef __cplusplus
}
#endif
#endif
```

### 3.4 `iterate/kit/capabilities/event_subscription.h` — the ONE delivery machine

```c
#ifndef ITERATE_KIT_CAPABILITIES_EVENT_SUBSCRIPTION_H
#define ITERATE_KIT_CAPABILITIES_EVENT_SUBSCRIPTION_H

#include "iterate/kit/capabilities/callback_budget.h"
#include "iterate/kit/spine/log.h"
#include "iterate/kit/spine/sideslot.h"
#include "iterate/kit/peer.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * The single Cap'n Web callback delivery machine. subscribeToEvents and
 * subscribeToMetrics are parameterizations of this module (class_mask +
 * serializer choice); the five delivery invariants currently pinned twice —
 * by metrics_subscription_test.c and m5sticks3_events_test.c — are
 * implemented ONCE and preserved verbatim:
 *
 *   1. deliveries never overlap (call_in_flight),
 *   2. budget admission before every call (callback_budget_reserved),
 *   3. release_pending preserves remote-capability ownership until the
 *      session can emit the release,
 *   4. loss is visible, never silent (the cursor's gap fact rides in-band),
 *   5. every accepted owner gets a post-subscribe snapshot (retained-latest
 *      per subscribed class + the starting cursor).
 *
 * One subscriber per slot; a new callback replaces an IDLE callback on the
 * same session (worker generations turn over without reconnecting —
 * device_event_stream.h:49-63 rationale, kept).
 */
struct iterate_kit_event_subscription_slot {
  struct capnweb_remote_capability callback;
  struct iterate_kit_event_cursor cursor;
  uint32_t interval_ms;                /* 0 = every batch (event feed);
                                          >0 = paced (metrics view)          */
  uint64_t next_due_ms;
  uint8_t max_events_per_call;         /* bounded by the 1536-B expression
                                          capacity proof (metrics.h:357-364):
                                          ~180 B/event JSON ⇒ default 4      */
  bool occupied;
  bool call_in_flight;
  bool callback_budget_reserved;
  bool release_pending;
};

struct iterate_kit_event_subscription_options {
  struct capnweb_session *session;
  struct iterate_kit_event_log *log;
  struct iterate_kit_sideslot *metrics_sideslot;   /* NULL on metrics-less builds */
  struct iterate_kit_event_subscription_slot *slots;   /* caller-owned */
  size_t slot_count;
  struct iterate_kit_callback_budget *callback_budget;
  char *scratch;                       /* serialization workspace, caller-owned */
  size_t scratch_capacity;             /* ≥ 1536, proven at init */
};

struct iterate_kit_event_subscription {
  struct iterate_kit_event_subscription_options options;
  bool initialized;
};

enum iterate_kit_status iterate_kit_event_subscription_init(
    struct iterate_kit_event_subscription *subscription,
    const struct iterate_kit_event_subscription_options *options);

/** One bounded poll turn: at most one callback call across all slots. */
enum iterate_kit_status iterate_kit_event_subscription_poll(
    struct iterate_kit_event_subscription *subscription, uint64_t now_ms);

/** Module for the peer table; publishes subscribeToEvents/subscribeToMetrics. */
struct iterate_kit_module iterate_kit_event_subscription_module(
    struct iterate_kit_event_subscription *subscription);

#ifdef __cplusplus
}
#endif
#endif
```

### 3.5 Serializer (compact) — the shape on every wire

```c
/* iterate/kit/spine/serialize.h — bounded, allocation-free. */

/** Emits one StreamEventInput-shaped JSON object into caller storage:
 *  {"type":"events.iterate.com/kit-device/ptt-started",
 *   "payload":{...},
 *   "metadata":{"device":{"bootEpoch":417,"sequence":1042,
 *               "uptimeMs":183220,"handlerStatus":0}}}
 *  Field names verbatim from packages/iterate/src/processors/schemas.ts:11-92;
 *  `source` is NEVER emitted at top level — it is platform-reserved
 *  provenance (schemas.ts:17-22); device coordinates ride metadata.device
 *  (os-streams §14 ⚠2, pending Jonas). Returns bytes written, 0 on overflow
 *  (caller records a serialization-failure metric; never truncated JSON). */
size_t iterate_kit_event_serialize_json(
    const struct iterate_kit_event *event, char *out, size_t capacity);

/** Packs the verbatim 64-B slot for the SD block framer. The on-card record
 *  IS the in-RAM slot — one representation, zero translation, torn-tail
 *  exactness from the block CRC (sd-event-logging §5.2). */
size_t iterate_kit_event_serialize_binary(
    const struct iterate_kit_event *event, uint8_t *out, size_t capacity);
```

The SD sink itself reuses the sd-event-logging module design wholesale
(`block_store` vtable, UNMOUNTED→PROBING→STREAMING→SYNCING→ROTATING→DEGRADED
pump on `retry_gate`, preallocated contiguous 4 MiB segments via
`esp_vfs_fat_create_contiguous_file`, `esp_vfs_fat.h:420`) — with one
candidate-A simplification: **the record format is the spine slot**, so the
framer is a memcpy of slots plus DICTIONARY records emitted from the same
X-macro (type_id → URI), TIME_ANCHOR records, GAP records from the cursor,
and SNAPSHOT records dereferencing the metrics side-slot.

---

## 4. Task model per board class (deliverable 3)

Cadence law (R5 applied): DMA completion clocks audio; socket readiness
clocks network; the main tick clocks only the spine drain and budgeted
background sinks; the SD pump blocks on its own card.

**Class 1 — half-duplex voice, no SD (M5StickS3):**

| Task                     | Core | Prio | Owns                                                                                                                               | Cadence                                                            |
| ------------------------ | ---- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `app_main` (spine owner) | 0    | 1    | buttons, RPC dispatch, **spine admission + handler chain**, capnweb sink poll, console sink pump, sampler 1 Hz → side-slot         | 10 ms tick                                                         |
| control net              | 0    | 5    | control socket, mount generations; publishes CONNECT-class events via tributary                                                    | socket-driven wakeup                                               |
| PCM net                  | 0    | 6    | PCM socket, conductor, downlink receive; publishes PCM boundary events via tributary                                               | socket-driven (R5 kills the 10 ms poll, `pcm_transport.c:598-611`) |
| audio owner              | 1    | 19   | playback policy, codec route fence, capture pump (R1 moves it here), processor seam; publishes AUDIO/INCIDENT events via tributary | blocking DMA / completion events                                   |
| I2S ISR (IRAM)           | 1    | —    | EOF timestamps → codec event SPSC                                                                                                  | hardware                                                           |

Changes vs v1's table (review §2.2): capture leaves the main task (R1 —
mic pump on the audio owner, `esp_driver_i2s` RX); the main task's audio duty
drops to zero, so display SPI and the metrics rendezvous stop being capture
hazards; spine admission replaces the `device_event_poll` slot 1:1 (same
task, same tick, same bounded work — button latency unchanged).

**Class 2 — duplex voice + SD (StackChan, Waveshare):** Class 1 plus:

| Task               | Core | Prio                                                                                                                                                          | Owns                                                                                         | Cadence                       |
| ------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------- |
| SD sink            | 0    | 2                                                                                                                                                             | spine cursor → batcher → block framer → block_store; blocking `fwrite/fsync` legal HERE ONLY | ring doorbell, 50 ms fallback |
| AEC/processor work | 1    | (inside audio owner, or a dedicated prio-8 fetch task if esp-sr's feed/fetch split demands it — stackchan ran `aec_task` prio 8 core 1, `app_config.h:59-63`) | FD_LOW_COST AEC behind the R2 seam                                                           | AEC chunk size                |
| renderer tick      | 0    | 1 (main)                                                                                                                                                      | face/renderer_input consumption, 30 fps budget                                               | display timer                 |

SD stall tolerance: 64 KiB PSRAM tributary-to-sink ring absorbs >30 s of
card stall at the ≤2 KB/s steady rate (sd-event-logging §4.2 numbers:
SD spec allows 250 ms write-busy; cheap-card GC stalls run 100–400 ms,
worst ≈1 s).

**Class 3 — duplex voice, hardware AEC, no SD (HA Voice PE):** Class 1
shape, `input_echo_cancelled=true` selects the null processor
(hardware-plugability §1.5); dial ISR gets the ISR-variant tributary
(edge capture faster than a 10 ms poll); mute switch publishes
`mute-switched` INPUT events and forces fail-closed capture silence.

**Class 4 — audio-less (e-ink + buttons; the addendum class):**

| Task                     | Core | Prio | Owns                                                                     | Cadence       |
| ------------------------ | ---- | ---- | ------------------------------------------------------------------------ | ------------- |
| `app_main` (spine owner) | 0    | 1    | buttons, RPC dispatch, spine, capnweb sink, console sink, e-ink renderer | 10 ms tick    |
| control net              | 0    | 5    | control socket                                                           | socket-driven |
| SD sink (if slot)        | 0    | 2    | as Class 2                                                               | doorbell      |

Two tasks plus an optional third. No PCM task, no audio owner, no core-1
work at all. **This row is the architecture's proof of the late addendum:**
the full control plane, event history, SD logging, resilience ladder, and
stream cross-posting exist with zero audio code linked.

**Class 5 — host/simulator:** single-threaded, virtual clock; the spine and
every sink run in-process; the scripted codec (hardware-plugability §1.5)
feeds AUDIO-class events for boards that have audio. Golden-log tests (§5
row 2) drive the whole spine deterministically.

---

## 5. All 12 requirements → concrete mechanisms (deliverable 4)

| #   | Requirement (brief)                                                                | Mechanism in this candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | reduce code/complexity                                                             | Four delivery machines → one (`event_subscription`); six device-side schema copies + three host parsers → one X-macro/.def generator (audit a2: −2,260); device_events + device_event_stream + metrics scheduler + runtime_diagnostics → spine + sinks (audit §2c: −1,130 net); plus audit's mechanical wins (dead code −772, CMake −710, websocket_text −480, capnweb prune −350, atomics −220). Numbers in §7.                                                                                                                                                                                                                                                            |
| 2   | easier to test & reason                                                            | **The spine is the assertion surface of all three layers**: L1 golden event-log diffs (drive a scenario, serialize, diff canonical JSONL — testing-three-layers §2.1.3); L2 rig subscribes to the event feed as its ordering witness (replacing bespoke metric predicates); L3 checkride asserts prompted steps against the same stream and diffs the SD ledger against host evidence (§4.3 there). One vocabulary, three layers.                                                                                                                                                                                                                                           |
| 3   | best practices from prior art                                                      | Adopted with provenance: fail-closed processor silence (`esp_afe.cpp:1612-1615`), DMA-owned cadence (`audio_pipeline.cpp:917-919`), mutation-by-owner + drain handshake (xiaozhi `afe_audio_engine.cc:317-368`), seqlock side-slot (stackchan `face_viseme.c:116-126`), timestamp-echo AEC header (xiaozhi `protocol.h:17-24`), preroll ring (xiaozhi `wake_word_audio_cache.cc:26-27`), 64·fs AW88298 fix + TDM hardware reference (stackchan `audio_pipeline.c:174-208,446-482`). Refused: ADF elements, ESPHome codegen, StreamBuffers, esp_websocket_client, seekaudio blob.                                                                                            |
| 4   | pluggable hardware APIs                                                            | Driver vtables survive verbatim (leds/servos/screen); ONE new `iterate_kit_audio_codec` vtable (hardware-plugability §1.4) unifies the three asymmetric audio seams; two-tier profile (compile-time geometry header + const policy struct incl. **the per-board event-class table** — a board with a dial has `dial-turned` rows, a board without has none); "more permissive" = more modules in the open table (`m5sticks3.c:158-176` mechanism, kept).                                                                                                                                                                                                                    |
| 5   | SD logs (if present)                                                               | `components/sdlog` = a spine cursor + CRC-block framer + `block_store` vtable. On-card record = the 64-B slot verbatim + DICTIONARY/TIME_ANCHOR/GAP/SNAPSHOT records; segments preallocated contiguous; never blocks producers (SPSC decoupling, prio-2 task); absent card = module not constructed (Stick/VPE link none of it). Ingest CLI decodes via the generated table. Boot-moment-zero events mean the card answers "what happened while we weren't listening" from slot 1 of every boot.                                                                                                                                                                            |
| 6   | keep the best things                                                               | §6 disposition table; the review §3 preserve list is the floor and every row survives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 7   | three testing layers                                                               | L1: spine golden logs + null/fake processor contract tests + pthread-faked adapters (rule: no merge without host-compiled sources) + golden-replay corpus; L2: decomposed scenario rig with the event feed as witness + four new acoustic scenarios (uplink echo loop, AEC proof, barge-in stopwatch, timestamp-echo alignment); L3: <5-min checkride asserted against the event stream incl. AP-kill drill + SD-vs-host ledger diff. One acceptance/threshold module per device (testing-three-layers §5).                                                                                                                                                                 |
| 8   | devices as streams; on-device events shaped like apps/os from the earliest moments | **The whole candidate.** Device: spine from boot slot 1, StreamEventInput-shaped at every serialization edge. Host: worker replaces `wouldPostToStream:true` (`worker.ts:245-253,269`) with real appends to `/kit/devices/<deviceId>`, idempotency key `kit-device:<id>:<bootEpoch>:<sequence>` (exactly-once over at-least-once, `writing-stream-processors.md:265-281`); `kit-voice/*` worker-origin events (session/turn/speak/transcription — deltas `ephemeral:true`); userspace-hosted `KitDeviceProcessor` (guestbook shape, zero apps/os changes — os-streams §5/§13); reboot = epoch boundary; SD = lazy pull-only backfill via `readSdEvents`, never auto-replay. |
| 9   | allow server-side AEC                                                              | Stays on the PCM fast path, NOT the spine: `iterate.kit.pcm.v2` subprotocol with the 16-byte little-endian header (xiaozhi BinaryProtocol2 layout, `protocol.h:17-24`; ~60 LOC firmware + ~40 worker; v1 peers unaffected — proxy-session-economics §3.2). The device computes alignment in its own playout timeline (network jitter irrelevant). The spine's role: `speak-started/ended`, `provider-suspended/resumed` session facts, and the rig's timestamp-vs-PRBS31 alignment scenario (±0.5 ms ground truth).                                                                                                                                                         |
| 10  | degrade/recover; both sockets always                                               | retry_gate ladder polish (PCM gate reset on first _confirmed delivery_ not socket connect — `pcm_transport.c:616-618` vs `itx_transport.c:738-748`; fleet jitter in the platform wrapper; retryable `pcm_transport_start` — today once-ever, `main.cpp:1262-1284`; Wi-Fi backoff unified on retry_gate). Every rung transition is a spine event, so the degraded-mode matrix (proxy-session-economics §2.2) is _observable by construction_: LED/earcon policy consumes CONNECT-class events locally. Last rung: no control READY for 15 min OR fatal latch → `reboot-scheduled` event → SD fsync → reboot (~2–3 s, the cheapest full reset an allocation-free image owns). |
| 11  | no always-on Grok; worker hangs up, PCM keeps flowing                              | Worker-side DeviceLane split: device lane lives with the device socket; upstream NO_UPSTREAM→DIALING→ACTIVE→DRAINING→COOLDOWN with DO alarms; 2 s preroll ring masks the ~300–850 ms dial; 90 s idle window ≈ $4/day vs $115/day always-on at $0.08/min; transcript replay makes hangup a pause, not amnesia (proxy-session-economics §1). The spine/stream contribution: `provider-suspended/resumed {reason:"inactivity"}` durable events give the dashboard and the device (via a control-lane push) an honest "asleep, will wake on press" state instead of dead air.                                                                                                   |
| 12  | pluggable device I/O                                                               | Outputs: driver vtables + thin RPC modules, unchanged. Inputs: every producer is a tributary publisher; the per-board event schema table IS the input plugability surface (dial/touch/mute/IMU rows appear only on boards that have them). Renderers: `renderer_input` struct consumed by a `renderer_driver` vtable (sprite/status-screen/LED-ring/e-ink instances); `agent_state` transitions driven by the LOCAL spine (INPUT/AUDIO classes), never a server round-trip (`physical-device-voice-goal.md:547` doctrine). The 40-B `face_render_key_t` + stage cues adopt verbatim from stackchan (`face_keyframe.h:62-129`, `face_stage.h:72-98`).                        |
| —   | LATE ADDENDUM: audio-less devices first-class                                      | The Class-4 build (§4) links `spine + core + capabilities` with zero audio objects; negative link test in CI (an executable linking core-only with no-undefined semantics — testing-three-layers §2.1.1). Where audio IS present, nothing about the spine touches the PCM lane's realtime discipline: the lane's only spine duty is boundary-event publication through a tributary (a nonblocking SPSC push, ~100 ns).                                                                                                                                                                                                                                                      |

---

## 6. v1 disposition: verbatim / adapted / deleted (deliverable 5)

The review §3 preserve list is the floor; every row below it survives.

**VERBATIM (byte-for-byte or move-only):**

| Module                                                                                                                                                                        | Why untouchable                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `realtime_playback.hpp` (1,863) + `direct_i2s_stereo_output.hpp` (710) + descriptor-identity tests (3,093 LOC)                                                                | physically-proven crown jewel; every line bought with an incident (brownout, silence-recovery, generation poison) |
| `pcm_lane`, `pcm_uplink_conductor`, `pcm_uplink_sender`, `pcm_peer_delivery_guard`                                                                                            | the strongest part of the tree (review §5); freshness/fencing policy the stackchan autopsy validates empirically  |
| `spsc_ring`, `retry_gate`, `configuration` (TLV), `frame_writer`, `websocket_tx/rx` + outbox/inbox                                                                            | sans-I/O, host-tested plumbing                                                                                    |
| `vendor/capnweb` core (all six wire message types)                                                                                                                            | exercised end-to-end; only dead surface pruned                                                                    |
| `itx_mount`, `itx_connection`, `peer` flat module table + `invokeCapability` unwrap                                                                                           | the no-synthetic-tree mechanism (`m5sticks3.c:166-171`)                                                           |
| leds/servos/screen driver vtables + modules, `callback_budget`, `rpc_internal`                                                                                                | already the right cut (hardware-plugability §2.4)                                                                 |
| `runtime_diagnostics` **write_fn sink contract** (`runtime_diagnostics.h:133-147`)                                                                                            | adopted verbatim as the console sink's platform seam                                                              |
| composition-root pattern (`devices/<board>.c` hand-written)                                                                                                                   | conventions over frameworks                                                                                       |
| host: acoustic analyzers (streaming pipeline), PRBS31 challenge, SoX capture + provenance doctrine, endurance ladder core + frozen acceptance policy, deterministic providers | the physical-evidence machinery                                                                                   |
| tests: pthread fakes, virtual-clock fault harness, capnweb fuzzer + TS interop ledger                                                                                         | the review §3 table row 1 asset                                                                                   |

**ADAPTED (mechanism survives, home or shape changes):**

| v1                                                                                                                   | v2                                                                                                                  | What survives                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `device_events` (329)                                                                                                | spine log + handler chain                                                                                           | single-task total order, bounded poll, handler-consumes-once, publish-never-waits — the _contract_ is the spine's admission contract |
| `device_event_stream` (653)                                                                                          | `event_subscription` slot                                                                                           | all five delivery invariants + replace-idle-callback + post-subscribe snapshot, ported behind the same wire method                   |
| `metrics.c` scheduler half (~500)                                                                                    | same `event_subscription` machine                                                                                   | interval pacing becomes cursor pacing; drop-dead-subscriber kept                                                                     |
| `metrics.c` builder (838) + snprintf (206) + `metrics.h` structs + `main.cpp:455-924` sampler (470) + 3 host parsers | one `.def` table + generated emitters                                                                               | the 1536-B capacity proof and maximum-width regression test carry over against generated output                                      |
| `runtime_diagnostics` (755)                                                                                          | console sink (150) + retained-latest (100)                                                                          | byte-budget pump discipline, stall metrics                                                                                           |
| `itx_transport.c` (1,624)                                                                                            | thinner shell + `wifi_station` module (R13) + CONNECT-event tributary                                               | generation handshake untouched (982-LOC host test ports)                                                                             |
| `pcm_transport.c`                                                                                                    | gate-reset-on-confirmed-delivery fix + boundary events                                                              | everything else                                                                                                                      |
| `push_to_talk` module (83)                                                                                           | publishes `ptt-*` into the spine                                                                                    | nearly verbatim — it already did this against the old queue                                                                          |
| audio controller (`audio.c`)                                                                                         | consumes spine INPUT/AUDIO classes; drives codec vtable; `capnweb_status` return leak fixed (R3, `audio.c:138-141`) | PTT/duplex state machine                                                                                                             |
| `bounded_capture.hpp` (258)                                                                                          | absorbed into the Stick codec impl (copy-out capture)                                                               | warmup-discard policy                                                                                                                |
| `m5unified` capture + fence (~500)                                                                                   | Stick codec impl (~300) executing the fence on the audio owner                                                      | amp-off → channel-delete → mic-up sequence, now async + measured                                                                     |
| `device-e2e.ts` (1,752)                                                                                              | ~10 scenario objects over `src/rig/*` modules                                                                       | probe, markers, transport, provisioning — moved verbatim                                                                             |
| worker `wouldPostToStream` logs                                                                                      | real `stream.append` with idempotency keys                                                                          | the seam placement                                                                                                                   |

**DELETED (with the audit's verification):**

| What                                                               | LOC                 | Evidence                                                                                           |
| ------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------- |
| `bounded_playback.hpp` + test                                      | −772                | only self-references (audit b1)                                                                    |
| `websocket_text` egress/ingress + unreachable control-frame branch | −480                | production uses outbox/inbox only; `itx_transport.c:570-573` drops control frames first (audit b2) |
| capnweb `responder.c` + `call_path` + wrapper                      | −350                | zero production callers (audit b4)                                                                 |
| managed-client dead diagnostic fields                              | −100                | admitted "remain zero" (`esp_idf_itx_transport.h:144-158`)                                         |
| atomics copies ×8 → named `atomic.h` variants                      | −220                | audit a1                                                                                           |
| CMake stanza copy-paste                                            | −710                | audit a5                                                                                           |
| in-memory acoustic analyzer (streaming subsumes)                   | −450                | audit a4                                                                                           |
| camera capability (defer until a target needs it)                  | −160                | audit e                                                                                            |
| `sampleRuntimeMetrics` + expression builder + formatter            | (inside the −2,260) | audit a2                                                                                           |
| prove-\* orchestration duplication → phase runner                  | −600                | audit f                                                                                            |

---

## 7. LOC estimate vs v1 (deliverable 6)

Base: v1 measured at **85,310** first-party LOC (firmware 31,228 prod +
20,727 tests + 1,640 build; host 18,607 + 13,108 — code-reduction-audit §1).

Candidate-A deltas on top of the audit's shared items:

| Item                                                    |                                       Δ prod | Notes                                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------: | ----------------------------------------------------------------------------------------------------------------------- |
| audit's mechanical deletions (a1,a3–a6,b1–b4,e,f)       |                      −3,900 fw / −1,500 host | unchanged from audit                                                                                                    |
| schema → `.def` generator (a2), extended to event types |                              −2,260 combined | one generator serves metrics AND events AND SD dictionary AND TS                                                        |
| spine collapse (audit §2c, Option-C variant)            | −2,082 deleted / **+1,250 added** = **−830** | +300 over the audit's +950: tributaries as a real module, side-slot + seqlock, boot-event vocabulary, binary serializer |
| SD sink (req 5)                                         |     +400 core, +350 platform, +250 TS ingest | slot-verbatim record format saves ~100 vs the sd recon's framer                                                         |
| codec vtable + Stick impl + scripted codec (req 4)      |                                      net +50 | deletes bounded_capture + fence duplication (hardware recon §4)                                                         |
| processor seam + null (R2)                              |                                         +350 | AEC adapter (+1,000) is a later line item                                                                               |
| profile structs ×2 boards                               |                                         +240 | mostly moves                                                                                                            |
| timestamp-echo v2 header                                |                        +80 device, +150 host | req 9                                                                                                                   |
| worker DeviceLane + cross-post + KitDeviceProcessor     |                                    +550 host | req 8/11; funded by proxy-defect deletion (suppressDownlink class dies structurally)                                    |

|                     |         v1 | v2 (candidate A) |          Δ |
| ------------------- | ---------: | ---------------: | ---------: |
| Firmware production |     31,228 |     **≈ 27,600** |  **−12 %** |
| Firmware tests      |     20,727 |         ≈ 19,700 |       −5 % |
| Build               |      1,640 |            ≈ 930 |      −43 % |
| Host production     |     18,607 |         ≈ 17,600 |       −5 % |
| Host tests          |     13,108 |         ≈ 13,000 |       −1 % |
| **Total**           | **85,310** |     **≈ 78,800** | **≈ −8 %** |

The honest headline is not the −8 %. It is: **places-a-counter-is-spelled
7 → 1; places-an-event-type-is-spelled ∞ → 1; bespoke delivery machines
4 → 1; "something happened" queue disciplines 4 → 1; and the on-device, SD,
wire, and stream representations of history become one representation.**
A −30 % LOC headline would require cutting proven audio policy or test
coverage — requirement 6 forbids both (audit §4 verdict, endorsed).

---

## 8. The host/userspace half (compact)

### 8.1 Cross-posting (the worker side of req 8)

The worker replaces its two `wouldPostToStream:true` seams
(`worker.ts:245-253` device events, `:266-271` provider events) with real
appends in the guestbook idiom (`starter-apps/guestbook/worker.ts:66-74`):

```ts
// Device-origin: coordinates already stamped on-device, so the key is fully
// deterministic — at-least-once anywhere composes to exactly-once on-stream.
await project.streams.get(`/kit/devices/${deviceId}`).append({
  type: e.typeUri, // full events.iterate.com/kit-device/…
  payload: e.payload,
  metadata: {
    device: {
      bootEpoch: e.bootEpoch,
      sequence: e.sequence,
      uptimeMs: e.uptimeMs,
      handlerStatus: e.handlerStatus,
    },
  },
  idempotencyKey: `kit-device:${deviceId}:${e.bootEpoch}:${e.sequence}`,
});
```

Posting never gates the PCM lane: a bounded 64-slot drop-oldest outbox
flushed via `waitUntil`, loss counted, PCM excluded
(proxy-session-economics §4.3). Worker-origin `kit-voice/*` events
(session-opened/closed, turn-committed, speak-started/ended,
transcription-updated **ephemeral:true** / -completed durable,
provider-suspended/resumed) keyed `kit-voice:<sessionId>:<kind>:<turn>`.

### 8.2 `KitDeviceProcessor` and the dashboard

A userspace-hosted processor (`createProcessorHost`, zero apps/os changes —
os-streams §5) reduces the device stream into
`{birthCertificate, lastBoot, pttHeld, activeSession, counters,
recentIncidents(≤32)}`; the dashboard is `useLiveState` over it. Promotion to
a first-class apps/os `kit-devices` domain later is a file move because the
contract already speaks apps/os shapes (os-streams §13).

### 8.3 Resume, replay, epochs

The capnweb subscription grows
`subscribeToEvents(callback, {afterSequence?: {bootEpoch, sequence}})` —
replay from the RAM ring when the cursor is still inside it (≤64 events),
else snapshot + gap, mirroring `openConnection({replayAfterOffset,
maxReplayOffsetGap})` (`itx-api.generated.ts:1289-1303`) at 64-slot scale.
Reboot = epoch boundary, deliberately not stitched (first event of every
boot is `booted`; cross-epoch order is stream-offset order). SD backlog is
**pull-only** (`readSdEvents({bootEpoch, afterSequence, limit})`) — auto-
replaying hours of history through a budgeted control lane would HOL-block
live PTT edges; idempotency keys make lazy backfill converge regardless
(os-streams §12).

---

## 9. Migration & sequencing with a codex agent mid-flight on v1 (deliverable 7)

Ordering principle: **new-files-first** (zero merge collisions with the
codex agent, which is actively editing `metrics.c/h`, `itx_mount.c`,
`main.cpp`, transports — per git status), **behavioral-suite-gated** for
every rewire, and the physical proof ladder (tone → PRBS → endurance rung 1)
re-run green at every milestone boundary.

| M      | Lands                                                                                                                                                                                                                                                                                                          | Collision risk with v1 work                           | Ladder impact                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| **M0** | `components/spine` complete with golden-log tests, host-only; `.def` table + TS generator; nothing consumes it yet                                                                                                                                                                                             | **zero** — all new files                              | none                                                     |
| **M1** | deviceId provisioning (efuse-MAC-derived, TLV tag + flasher) — prerequisite for mount path + idempotency keys; two Sticks on one project collide today (`itx_mount.c:123-157`, no id in `configuration.h`)                                                                                                     | low (config decoder + flasher)                        | none                                                     |
| **M2** | spine wired IN PARALLEL: composition root publishes every existing edge into the spine _alongside_ `device_events`; console sink runs next to `runtime_diagnostics`; rig diffs the two ledgers for a full ladder run                                                                                           | low (additive wiring in `devices/`)                   | proof: two ledgers must agree before anything is deleted |
| **M3** | cutover 1: `device_events` + `device_event_stream` → spine + `event_subscription`, behind the SAME `subscribeToEvents` wire method (v1 flat shape emitted from the new machine first); ported behavioral suites (`m5sticks3_events_test`, coalescing/gap invariants) must pass on both before the old files go | **medium — coordinate a quiet window**                | tone + PTT scenarios re-run                              |
| **M4** | cutover 2: schema `.def` for metrics (audit #1) + `metrics.c` scheduler onto `event_subscription`; `getDiagnostics` from retained + side-slot; 1536-B capacity regression regenerated                                                                                                                          | **high-touch on codex's files — after v1 stabilizes** | endurance rung 1                                         |
| **M5** | wire-shape v2: `subscribeToEvents` emits StreamEventInput-shaped batches; worker consumes new shape + real appends + `KitDeviceProcessor` (host-side, independent of firmware timing)                                                                                                                          | firmware/worker lockstep deploy (pre-1.0 clean break) | rig event-witness swaps over                             |
| **M6** | `runtime_diagnostics` → console sink + retained (delete pump/formatter); PCM boundary events + degraded-matrix LED policy; retry-ladder fixes (gate reset, jitter, retryable start, reboot rung)                                                                                                               | medium                                                | AP-kill checkride drill                                  |
| **M7** | `components/sdlog` portable core + fake block store + simulator; hardware adapter WITH the Waveshare bring-up (the only zero-conflict SD board — sd-event-logging §1.4)                                                                                                                                        | zero until bring-up                                   | SD-vs-host ledger diff joins the checkride               |
| **M8** | worker DeviceLane split (req 11) + pcm.v2 timestamp echo (req 9) — orthogonal to the spine, can run parallel to M4–M7                                                                                                                                                                                          | worker + ~60 LOC firmware                             | timestamp-alignment rig scenario                         |

What can land incrementally without breaking anything: M0–M2 are purely
additive; M3/M4 are the two real rewires and each carries its ported
behavioral suite as the gate; M5 is the one deliberate wire break (flagged
to Jonas, §12 Q2); M7–M8 are leaf features.

---

## 10. Honest cons and failure modes of THIS architecture (deliverable 8)

1. **It is the highest-risk single move of any candidate.** The spine
   rewires the control plane's correctness core — the audit rates the
   collapse HIGH-risk for a reason. The five delivery invariants are
   currently _proven by two independent implementations agreeing_; after the
   collapse there is one implementation, and a bug in it is a bug
   everywhere. Mitigation (ported suites, M2's parallel-ledger diff) reduces
   but does not eliminate this. If the team wants v2 fast and boring, this
   is the candidate to argue _against_.
2. **Total order is admission order, not physical order.** A button ISR edge
   and a Wi-Fi callback in the same 10 ms tick serialize in drain order;
   `origin_uptime_us` can disagree with sequence order across producers by
   up to one tick. Any consumer that treats sequence as physical
   simultaneity will be subtly wrong. (Documented, but documentation is not
   a guardrail.)
3. **The spine owner is the main task; spine liveness = main-loop health.**
   A wedged main task freezes admission and every sink (tributaries buffer
   8 events each, then drop). v1's four independent machines degraded
   independently. Mitigation: the audio path never depends on the spine
   (publish is fire-and-forget into a tributary), and the R1 capture move
   means a wedged main task no longer gaps the mic — but event _history_
   during a main-task stall is thinner than today's console lines.
4. **Write-amplification pressure is permanent.** Every future feature will
   want its moment on the spine; at 64 slots, chatty producers eat history.
   The admission-rate law (§1.6) is a discipline, not a mechanism — the
   mechanism is only drop counters and review. Expect one incident where a
   misjudged event rate laps the ring and blinds a sink at the worst moment.
5. **40-byte payloads are a real ceiling.** Incident detail beyond
   `{kind, detail, value, count}` needs side buffers or truncation flags;
   anything prose-shaped (URLs, reasons-as-text) does not fit. The escape
   hatches (`payload_truncated`, `sideslot_reference`) are exactly the kind
   of edge that accumulates ugliness.
6. **The metrics side-slot is a compromise wearing a design's clothes.**
   Generation races (sample overwritten mid-serialize) are handled by
   seqlock-retry + a sample-missed fact, but the mental model "the spine
   carries a reference, not the sample" is one more thing every reader must
   learn. Option B (two data sources, one delivery machine) is simpler to
   explain; I chose the side-slot for the single-machine property and accept
   the teaching cost.
7. **One deliberate wire break** (M5): the v2 event batch shape breaks the
   flat `DeviceEvent` consumer (`device-events.ts:1-9`). Pre-1.0 and
   in-monorepo, but it forces a firmware/worker lockstep deploy across the
   fleet exactly once.
8. **The X-macro single-source is monorepo-friendly and third-party-hostile.**
   Every type addition recompiles firmware and regenerates TS; an external
   integrator cannot extend the vocabulary without our build. Acceptable
   today; wrong if Kit ever opens the device SDK.
9. **The spine does not fix audio.** R1 (capture priority orphan), R4 (IRAM
   at 16,383/16,384 bytes — one byte free), AEC budgets: all orthogonal work
   this candidate schedules but takes no credit for. A reviewer seduced by
   the spine's coherence should notice that the single biggest realtime
   defect in v1 is untouched by it.
10. **SD binary format needs the ingest tool forever.** Slot-verbatim
    records are crash-exact and cheap, but a human with a card and a laptop
    reads nothing without `sd-ingest`. The counter-argument (JSONL on card)
    was rejected for torn-tail exactness and 3–5× size — but req 5's
    "in case we are not listening" spirit leans human-readable, and Jonas
    may overrule (§12 Q4).

---

## 11. Roads not taken

- **Metrics as full snapshot events** — 20× slot inflation or variable-size
  slots; kills the fixed-slot single-writer proof (audit §2c Option A).
- **Per-clock-domain logs merged by timestamp** — re-imports cross-socket
  ordering ambiguity; the total order is the product (§1.2 option B).
- **Lock-free MPMC spine** — more hand-rolled atomics in the codebase that
  needed fewer (§1.2 option C).
- **Full on-device state reduction** (device as its own stream processor) —
  duplicates the host `KitDeviceProcessor` on a 40-byte-payload chip (§1.4).
- **Device appends directly to the apps/os stream** over its own session —
  doubles the firmware JSON surface, breaks single-writer discipline, saves
  one non-latency-sensitive hop (os-streams §15).
- **PCM frames or per-frame telemetry as events, even ephemeral** — the
  metrics capability and the wire exist precisely so streams don't become
  telemetry pipes (`writing-stream-processors.md:315-323`).
- **Auto-replaying SD backlog on reconnect** — HOL-blocks live PTT behind
  stale history on a budgeted lane; lazy pull + idempotent backfill wins
  (os-streams §12.5).
- **JSONL as the on-card format** — kept as the _ingest output_; on-card it
  costs 3–5× bytes, publisher-side snprintf, and line-based torn-tail
  ambiguity vs block CRC exactness (sd-event-logging §5.1) — flagged as a
  Jonas call because the readability argument is legitimate (§12 Q4).
- **An "EventBus"/"Journal"/"Telemetry Fabric" framework noun** — it is a
  ring, tributaries, cursors, and sinks; naming per
  `feedback_no_invented_concept_names`.
- **Extending the mobile Device domain now** (`itx-api.generated.ts:
1433-1450`) — its birth certificate is Expo-specific; userspace path
  first, promote by file move later (os-streams §7).

---

## 12. Decisions that belong to Jonas (deliverable 9)

1. **Path in the record, and the stream path family.** I dropped per-event
   `path` from the slot (one device = one stream; §1.1) and recommend
   `/kit/devices/<deviceId>` for the userspace phase. The maximalist reading
   of requirement 8 ("path, type, payload … from the earliest moments")
   could insist on an interned path field per slot (+2 B, mostly constant).
   Cheap either way now, annoying to migrate later.
2. **The wire break at M5.** v2's `subscribeToEvents` emits
   StreamEventInput-shaped batches and retires the flat `DeviceEvent` shape
   (`device-events.ts:1-9`) in one lockstep deploy — clean break per the
   no-backcompat rule, but it lands while the codex v1 worker is the
   production consumer. Timing and appetite are Jonas's call.
3. **How far commands go through the spine.** I drew the line at
   "state-machine inputs yes, imperative side effects optional, reads never"
   (§1.3). The stricter alternative (every mutating RPC is an event, always)
   buys perfectly uniform history at real amplification cost; the looser one
   (only PTT, as today) forfeits the total-order guarantee for future racy
   knobs. Where the line sits changes every capability module's shape.
4. **SD on-card format: binary slot-verbatim (my pick) vs JSONL.**
   Crash-exactness + 3–5× density vs pull-the-card-into-a-laptop
   readability. Also entangled: does the 1 Hz snapshot go to card verbatim
   (my yes — it bounds invisible-gap analysis between adjacent snapshots)?
5. **Metrics side-slot (one delivery machine) vs Option B (sampler separate,
   machine shared).** §1.5 vs the audit's recommendation. Side-slot is the
   purer spine and −1 mechanism; Option B is simpler to teach and one fewer
   seqlock. This is the decision that most defines how "maximalist" v2's
   event story actually is — and it is reversible later at moderate cost,
   so it can also be decided by building Option C and watching it.

---

_Cross-checked against `inputs/brief.md` (all 12 requirements + late
addendum), the architecture review R1–R13 and its §3 preserve list, and all
seven exploration files. The spine's LOC and RAM numbers derive from
code-reduction-audit measurements; SD numbers from sd-event-logging; proxy
economics from proxy-session-economics; prior-art provenance from
stackchan-autopsy and the review's §7 disposition table._
