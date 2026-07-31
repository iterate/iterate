# Candidate C — the minimal-delta architecture

Status: exploration-round candidate architecture (one of three independent
attempts), 2026-07-31. Inputs: `../inputs/brief.md` (12 requirements + late
addendum), `../../fable-firmware-architecture-review-2026-07-31.md` (R1–R13),
all seven recon files in this folder, and the v1 deep-reads under
`../inputs/agent-reports/`. All file:line references are into the live
`c-capabilities` worktree unless prefixed; LOC figures were re-verified with
`wc -l` on 2026-07-31 (`metrics.c` 1,510, `main.cpp` 1,349, root
`CMakeLists.txt` 1,008, `realtime_playback.hpp` 1,863, `bounded_playback.hpp`
389, `device_events.c` 198, `device_event_stream.c` 549,
`runtime_diagnostics.c` 505, `itx_transport.c` 1,624, `pcm_transport.c` 1,181).

---

## 0. The bet

**v1's bones are already good, and the review says so in writing** — we beat
every studied prior-art project on off-device testability, bounded-everything
telemetry, freshness policy, generation fencing, and heap discipline (review
§3, table). The prior art beats us on five specific, _bounded_ defects
(§4.1–§4.5), and the twelve v2 requirements are mostly _additive_ features
(SD sink, events-as-streams groundwork, session economics, timestamp echo),
not restructurings.

So this candidate's thesis: **the winning move is the smallest set of changes
that (a) fixes the five review defects via R1–R13 as surgical patches, and
(b) lands every new requirement as a new module BESIDE the existing ones —
while a codex agent is actively finishing v1 in the same tree.** No grand
reorganization. Concretely:

- **metrics stays a sampler.** The scheduler/sampler split survives; only the
  _schema_ is single-sourced (R7).
- **`runtime_diagnostics` stays.** Its console pump keeps running; it is not
  absorbed into an event spine.
- **`device_events` GROWS into the requirement-8 event shape** (wider entry,
  interned type table, more observers) rather than being replaced by a new
  lapped-ring event core.
- **`device_event_stream`'s five-boolean delivery machine survives verbatim**
  and is generalized from PTT-only to all event types.
- **`realtime_playback.hpp` (1,863 LOC) and the whole descriptor-identity
  playback stack are not touched at all.**
- **`device-e2e.ts` is not decomposed.** New rig scenarios land as separate
  scripts sharing newly-extracted helpers; the physically-proven monolith
  keeps passing unchanged.
- **The two-proxy split is blessed, not merged**: `DevicePcmProxy` stays the
  lab harness; the deployed `KitVoiceWorker` bridge gets the
  session-economics state machine (it is the thing requirement 11 names).

The deltas this bet forgoes are quantified honestly in §9 (what the big-bang
candidates delete that this one keeps forever), and §9.3 gives each kept wart
an explicit **trigger condition** that flips it into a v2.1 redesign — the
minimal-delta answer to calcification is to _instrument_ the warts, not
pretend they are gone.

Headline numbers up front (details §7):

|                                  |         v1 | Candidate C v2 |                   Δ |
| -------------------------------- | ---------: | -------------: | ------------------: |
| Firmware production              |     31,228 |       ≈ 29,850 |          **−4.4 %** |
| Firmware tests                   |     20,727 |       ≈ 20,400 |              −1.6 % |
| Build system                     |      1,640 |          ≈ 930 |               −43 % |
| Host production                  |     18,607 |       ≈ 19,050 | **+2.4 %** (grows!) |
| Host tests                       |     13,108 |       ≈ 13,500 |                +3 % |
| **Total**                        | **85,310** |   **≈ 83,730** |        **≈ −1.9 %** |
| Files added / deleted / modified |          — |  ≈ 26 / 6 / 30 |                   — |

Yes: this candidate barely reduces LOC. Its claim on brief requirement 1 is
that it reduces _complexity concentration_ (places-a-counter-is-spelled goes
≈7 → 1 via R7; scattered per-board constants go 7 places → 1 profile; the
capture path stops being a priority orphan) while spending its entire risk
budget on **never breaking the physical proof ladder**. If Jonas wants a
−10 %+ LOC headline, this is the wrong candidate — see §9.1.

---

## 1. What "minimal" means, precisely

Rules this candidate imposes on itself:

1. **A change is either a review item (R1–R13), a requirement (1–12), or a
   verified-dead deletion. Nothing else.** No opportunistic rewrites, no
   "while we're in here". The audit's structural event-spine collapse
   (code-reduction-audit §2c, net −1,130, risk HIGH) is _not_ a review item
   and is explicitly not taken.
2. **Deletions must be zero-behavior-change**: `bounded_playback.hpp` (389
   LOC, referenced only by its own test — audit §2b1), `websocket_text`
   egress/ingress adapters (production uses only outbox/inbox; the ingress
   control-frame branch at `websocket_text.c:174-189` is unreachable because
   `itx_transport.c:570-573` drops control frames first — audit §2b2),
   capnweb `responder.c` + `call_path` (zero production callers — audit
   §2b4), managed-client dead fields (`esp_idf_itx_transport.h:144-158`).
   Camera stays (it is a 160-LOC leaf; deleting it is churn, not reduction).
3. **Additions are new files wherever possible**, so codex's in-flight v1
   work (see the live git status: codex is currently modifying `metrics.c`,
   `metrics.h`, `main.cpp`, `itx_mount.c`, `peer.c`, `itx_transport.c`, both
   pcm transports, `m5sticks3.c`, and six test files) collides with as few
   hunks as possible.
4. **Every wave ends with the tone proof green** (`prove-production-
m5sticks3-tone.ts` path) before the next wave starts. The proof ladder is
   the invariant, not a milestone.
5. **Adopted prior-art patterns arrive as bounded patches with provenance**,
   never as frameworks: xiaozhi's preroll ring and BinaryProtocol2 header,
   esphome's fail-closed silence rule and DMA-owned cadence, ADF's
   one-task-per-clock-domain — each is ≤ ~100 LOC at a named seam.

---

## 2. Component/module layout (deliverable 1)

The tree below is v1's tree with moves marked `◄ moved`, additions marked
`+ NEW`, and deletions marked `✕`. Everything unmarked is byte-identical in
role (and mostly in content) to v1.

```
vendor/capnweb                bounded C99 Cap'n Web peer (~3.3k after prune)
  ✕ src/responder.c           deferred-reply setters, zero production callers
  ✕ call_path + argless call  firmware uses call_expressions only

components/core               portable control plane ONLY (sans-I/O)
  itx_mount / itx_connection  authenticate → projects.get → provideCapability
  peer                        flat module table, invokeCapability unwrap
  websocket_tx/rx/frame_writer, websocket_text (outbox/inbox halves only ✕ egress/ingress)
  spsc_ring, retry_gate, atomic.h (R8: + named acquire/release helpers)
  configuration               ITERKIT1 TLV (+ deviceId tag, + clamped knob tags)
  device_events               ◄ GROWS: 16-B entries, interned type table, 3 observer slots
  + device_event_types.def    + NEW X-macro: C enum + URI string + TS union, one row/type
  runtime_diagnostics         console snapshot pump — UNCHANGED (kept wart, §9.3)
  + event_sd_log.{h,c}        + NEW portable SD sink core: framing, pump FSM, gap records
  + device_profile.h          + NEW R6 tier-2 policy struct (per-board instance in devices/)
  status/, cpu_usage

components/audio              + NEW component = R3 split (mechanical moves)
  pcm_websocket, pcm_lane     ◄ moved from core, content unchanged
  pcm_uplink_conductor/sender ◄ moved
  pcm_peer_delivery_guard     ◄ moved
  audio (controller)          ◄ moved; audio.h drops peer.h — own status enum (R3)
  + audio_processor.h         + NEW R2 seam: frame_spec/process/fail-closed
  + audio_processor_null.c    + NEW passthrough impl (Stick, HA VPE, simulator)
  + audio_codec.h             + NEW capture+route half of the codec contract (§3.2)

components/capabilities       unchanged mechanism; metrics schema regenerated
  metrics_schema.def          + NEW R7 X-macro (one row per counter, 4 surfaces)
  metrics.c → metrics_sample.c + metrics_subscriptions.c   (R7 file split; same behavior)
  device_event_stream         ◄ generalized: any event type, same delivery machine
  push_to_talk, leds, servos, screen, camera, callback_budget, rpc_internal  (verbatim)

devices/
  m5sticks3/  + m5sticks3_profile.{h,c}     tier-1 geometry + tier-2 policy instance
  stackchan/  + stackchan_profile.{h,c}
  (future: waveshare/, ha_vpe/, eink boards — profile + module table each)

platforms/iterate_esp_idf
  itx_transport               ✕ Wi-Fi bring-up extracted (R13)
  + wifi_station.{h,c}        + NEW station manager on retry_gate (+ fleet jitter)
  pcm_transport               patched: gate-reset-on-confirmed-delivery, socket wakeup (R5)
  websocket_connection        + first host test (fakes compile it — closes documented hole)
  + m5sticks3_codec.c         + NEW Stick impl of audio_codec.h: esp_driver_i2s PDM RX
                                capture + route fence moved inside, on audio owner task (R1)
  + sd_block_store.c          + NEW SDMMC/SDSPI adapter for event_sd_log (lands w/ Waveshare)

platforms/iterate_m5unified   board init only; recorder pump path deleted with R1
platforms/common              RealtimePlayback / DirectI2sStereoOutput — UNTOUCHED
  ✕ bounded_playback.hpp      dead
  ✕ bounded_capture.hpp       absorbed by m5sticks3_codec.c (R1)

targets/m5sticks3/main        main.cpp ≈ 700 after R7 kills sampleRuntimeMetrics
                              (:455-924) and R6 moves the constant farm to profile
simulator/                    + scripted codec (capture/route events on virtual clock)

host (apps/kit/src, scripts)
  src/voice/device-pcm-proxy.ts        R9 defect fixes + device-clocked default; else frozen (lab)
  src/userspace/config-worker/
    + upstream-session.ts              + NEW req-11 state machine (§5 row 11)
    + stream-outbox.ts                 + NEW bounded drop-oldest cross-post (req 8)
    worker.ts / pcm-proxy.ts           rewired to attach/detach; v2 subprotocol negotiation
  src/device/wire-constants.generated.ts   + NEW from one table (R10)
  + src/voice/deterministic-pcm-uplink-recorder-provider.ts  (~80 LOC, layer-2 uplink proof)
  + scripts/kit-checkride.ts           + NEW layer-3 human checkride (~200 LOC)
  + scripts/sd-ingest.ts               + NEW SD block decoder CLI (~250 LOC, decoder table generated)
  scripts/device-e2e.ts                UNCHANGED except additive flags (kept wart, §9.3)
```

The late addendum (audio-less devices) is satisfied structurally by exactly
one move: the R3 split plus dropping `device.h`'s `audio.h` include
(`device.h:4` today; the manifest's `audio_mode` field dissolves into the
profile). After that, an e-ink/buttons board links
`core + capabilities + platform control half` with **no** PCM lane, no audio
controller, no processor seam, no codec — and a negative link test pins it
(§5 row "addendum").

---

## 3. The load-bearing new interfaces (deliverable 2)

Five headers carry the whole delta. House style throughout: caller-owned
storage, options structs, vtables with borrowed `void *context`, status
enums, no allocation after init, reasoning comments.

### 3.1 `components/audio/include/iterate/kit/audio_processor.h` (R2)

The seam both AEC and viseme analysis land on. Shape follows
esphome-audio-stack's `AudioProcessor` (`audio_core_processor.h:66-118`) with
its fail-closed rule (`esp_afe.cpp:1612-1615`) and xiaozhi's
mutate-by-owning-task discipline (`afe_audio_engine.cc:317-368`).

```c
#ifndef ITERATE_KIT_AUDIO_PROCESSOR_H
#define ITERATE_KIT_AUDIO_PROCESSOR_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/status.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The speech-pipeline seam (review R2). Sits between the codec's capture
 * output and the uplink lane; a second, non-realtime consumer (viseme/energy
 * analysis) taps the same processed frames. All calls execute on the audio
 * owner task; implementations never block, never allocate, and never take a
 * lock the hot path can contend on (reconfiguration uses a dirty-flag +
 * drain handshake applied BY the owner between frames — the esphome
 * esp_afe.h:92-105 discipline).
 */

struct iterate_kit_audio_frame_spec {
  uint32_t sample_rate_hz;    /* 16000 on every current board            */
  uint16_t samples_per_frame; /* 320 = 20 ms                             */
  uint8_t channels;           /* processed output is always mono for v2  */
};

struct iterate_kit_audio_processor_result {
  /* VAD edge state when the implementation supports it; callers must treat
   * unsupported (always-false) identically to quiet. */
  bool voice_active;
  /* FAIL-CLOSED MARKER. When the configured processor cannot run (model
   * missing, PSRAM exhausted, mid-reconfigure), out[] is silence and this
   * is true. Raw mic never passes through a broken processor — the rule
   * that keeps a failed AEC from broadcasting the far end back upstream. */
  bool output_is_silence;
};

struct iterate_kit_audio_processor_ops {
  struct iterate_kit_audio_frame_spec (*frame_spec)(void *context);
  /* Bumps whenever frame_spec would answer differently; the audio
   * controller restarts the capture session on a bump rather than
   * splicing incompatible frames into one uplink epoch. */
  uint32_t (*frame_spec_revision)(void *context);
  /*
   * mic: one completed capture frame (spec geometry).
   * reference: same-geometry playback reference, NULL when nothing is
   *   audible. Complete frames only — partial/padded reference frames
   *   decorrelate adaptive filters (esphome audio_pipeline.cpp:1728-1737);
   *   the codec/tap layer enforces that before this call.
   * out: caller storage, spec geometry, always fully written.
   */
  enum iterate_kit_status (*process)(
      void *context,
      const int16_t *mic,
      const int16_t *reference,
      int16_t *out,
      struct iterate_kit_audio_processor_result *result);
};

struct iterate_kit_audio_processor {
  const struct iterate_kit_audio_processor_ops *ops;
  void *context;
};

/* Passthrough implementation: copies mic→out, voice_active unsupported.
 * Selected by profile for M5StickS3 (no device AEC possible), HA Voice PE
 * (input_echo_cancelled — the XMOS already did the DSP), and the simulator. */
struct iterate_kit_audio_processor iterate_kit_audio_processor_null(void);

#ifdef __cplusplus
}
#endif
#endif
```

Implementations in this candidate: `null` (ships now, host-tested), `fake`
(test-only: scriptable failures, spec-revision bumps — lives in
`tests/fakes/`), and the `esp_sr` FD_LOW_COST adapter **later, with StackChan
bring-up** (review R11; ~31 KB internal + 90 KB PSRAM + 19.6 % of one core,
review §4.5 table — gated on the R4 IRAM/PSRAM chores).

### 3.2 `components/audio/include/iterate/kit/audio_codec.h` — the _half_ codec

This is where minimal-delta deliberately diverges from the full
`iterate_kit_audio_codec` of the hardware-plugability recon (§1.4 there). R1
forces capture to move (new owner task, new driver); route switching must
move with it (the fence is a capture/playback hand-off). **Playback does
not have to move**, and its 3.6 k-LOC descriptor-identity stack
(`realtime_playback.hpp` 1,863 + `direct_i2s_stereo_output.hpp` 710 +
backend 689 + 3,093 LOC of tests) is the best-proven code in the tree. So
v2.0 ships the codec contract with **capture + route + properties only**;
playback keeps its existing template stack and is folded under the codec
vtable at the first genuinely-new board bring-up (Waveshare), when a second
implementation exists to justify the abstraction.

```c
#ifndef ITERATE_KIT_AUDIO_CODEC_H
#define ITERATE_KIT_AUDIO_CODEC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/status.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * v2.0 scope note: this contract covers the capture and route halves that
 * review R1 forces to move. Playback continues to ride the proven
 * RealtimePlayback/DirectI2sStereoOutput stack (descriptor identity,
 * host-tested); descriptor-token write ops join this vtable when the second
 * board (Waveshare ES8311) lands and the abstraction has two customers.
 */

struct iterate_kit_audio_codec_properties {
  uint32_t input_sample_rate_hz;   /* 16000 on Stick                        */
  uint32_t output_sample_rate_hz;  /* 48000 on HA VPE                       */
  uint8_t input_channels;
  uint8_t reference_channels;      /* 0 = no hardware AEC reference         */
  bool duplex;                     /* capture+playback simultaneously legal */
  bool input_echo_cancelled;       /* upstream DSP (XMOS) already did AEC   */
  int16_t output_gain_ceiling_centi_db; /* −1800 = the ES8311 brownout fix  */
};

enum iterate_kit_audio_route {
  ITERATE_KIT_AUDIO_ROUTE_IDLE = 0,
  ITERATE_KIT_AUDIO_ROUTE_CAPTURE = 1u << 0,
  ITERATE_KIT_AUDIO_ROUTE_PLAYBACK = 1u << 1,
};

enum iterate_kit_audio_codec_event_type {
  /* One completed native-geometry frame is readable via read().           */
  ITERATE_KIT_AUDIO_CODEC_CAPTURE_FRAME_READY = 0,
  /* A route request finished applying; status carries failure.            */
  ITERATE_KIT_AUDIO_CODEC_ROUTE_APPLIED,
  /* Driver/bus fault: the owner must poison the capture generation.       */
  ITERATE_KIT_AUDIO_CODEC_FAULT,
};

struct iterate_kit_audio_codec_event {
  uint8_t type;
  uint8_t route;                   /* ROUTE_APPLIED only                    */
  int8_t status;
  uint64_t timestamp_us;           /* codec monotonic domain                */
};

/*
 * All ops nonblocking; owner-task-only. On the M5StickS3 the implementation
 * owns the half-duplex fence INTERNALLY (amp off → i2s_channel_disable →
 * i2s_del_channel → PDM RX up — mic and speaker share MCLK/BCLK/WS and PDM
 * RX cannot share a duplex clock, esp-idf i2s.rst:905), executing it on the
 * audio owner task and emitting ROUTE_APPLIED when done. This deletes the
 * 1 s synchronous cross-task fence (m5sticks3_direct_audio.hpp:173): the
 * button-to-capture interval becomes a measured event gap, not a block.
 */
struct iterate_kit_audio_codec_ops {
  enum iterate_kit_status (*request_route)(void *context, uint8_t route);
  /* Owner drains; UNAVAILABLE when empty. Backed by a bounded SPSC
   * internally (the existing 4-slot completion ring idiom, generalized). */
  enum iterate_kit_status (*next_event)(
      void *context, struct iterate_kit_audio_codec_event *event);
  /* Copy-out capture: one completed frame into caller storage, or
   * UNAVAILABLE. Copy-out (640 B × 50 Hz = 32 KB/s memcpy, negligible at
   * 240 MHz) deletes BoundedCapture's 258-LOC borrow ledger and its
   * cross-module sequencing contract (bounded_capture.hpp:64-84). */
  enum iterate_kit_status (*read)(
      void *context, int16_t *samples, size_t capacity_samples,
      uint64_t *captured_at_us);
};

struct iterate_kit_audio_codec {
  const struct iterate_kit_audio_codec_ops *ops;
  const struct iterate_kit_audio_codec_properties *properties;
  void *context;
};

#ifdef __cplusplus
}
#endif
#endif
```

With this, `audio.h` loses `iterate_kit_audio_capture_driver` and the
`stop_playback/flush_playback/start_capture` ordering comment (`audio.h:31-41`)
— the portable controller becomes a state machine over codec events, and
`duplex=false` in properties makes the illegal simultaneous route an
init-time rejection.

### 3.3 `device_events.h` growth + `device_event_types.def` (requirement 8)

The queue mechanics (`device_events.h:54-120`: power-of-two capacity,
single-task, publish/poll never wait, full metrics struct) survive verbatim.
What changes is the entry and the vocabulary:

```c
/* components/core/include/iterate/kit/device_event_types.def
 * ONE row per event type: C enum name, full apps/os-shaped URI. The macro
 * is the cross-language single source: it expands to (1) the C enum,
 * (2) the URI string table every sink serializer uses, (3) via a small
 * generator, the TS union for the userspace worker — the same move R7
 * makes for metrics, so type drift between firmware, SD card, and stream
 * is impossible by construction. */
#define ITERATE_KIT_DEVICE_EVENT_TYPES(X) \
  X(BOOTED,             "events.iterate.com/kit-device/booted") \
  X(PTT_STARTED,        "events.iterate.com/kit-device/ptt-started") \
  X(PTT_STOPPED,        "events.iterate.com/kit-device/ptt-stopped") \
  X(WIFI_CONNECTED,     "events.iterate.com/kit-device/wifi-connected") \
  X(WIFI_LOST,          "events.iterate.com/kit-device/wifi-lost") \
  X(CONTROL_MOUNTED,    "events.iterate.com/kit-device/control-mounted") \
  X(CONTROL_LOST,       "events.iterate.com/kit-device/control-lost") \
  X(PCM_CONNECTED,      "events.iterate.com/kit-device/pcm-connected") \
  X(PCM_LOST,           "events.iterate.com/kit-device/pcm-lost") \
  X(ROUTE_APPLIED,      "events.iterate.com/kit-device/audio-route-applied") \
  X(INCIDENT_RECORDED,  "events.iterate.com/kit-device/incident-recorded") \
  X(EVENT_GAP_OBSERVED, "events.iterate.com/kit-device/event-gap-observed")
```

```c
/* device_events.h — the widened entry (was 2 bytes, device_events.h:27-34) */
struct iterate_kit_device_event {
  uint16_t type;        /* index into the interned URI table                */
  uint8_t source;       /* PHYSICAL / REMOTE / SYSTEM (unchanged semantics) */
  uint8_t flags;
  uint32_t sequence;    /* boot-local, assigned at publish — was implicit   */
  uint64_t uptime_ms;
  uint8_t payload[8];   /* per-type packed struct (wifi reason+rssi, gap
                         * expected/actual, incident kind+value). 8 bytes
                         * covers every current producer; a wider payload
                         * class is a §10 question, not a v2.0 need. */
};                      /* 24 bytes/slot; 32-slot queue = 768 B (was 64 B) */
```

Fan-out stays the v1 idiom, not a new ring-with-cursors: the queue keeps its
one handler (drives the audio controller) and grows from one observer slot to
a **fixed table of 3** (capnweb event stream, SD sink feeder, console). Each
observer is a nonblocking callback that copies into its own bounded queue and
counts its own losses — exactly what `device_event_stream`'s coalescing queue
(`device_event_stream.c:90-108`) and the SD sink's SPSC ring already do.
"Every sink records explicit sequence gaps and drop/overflow counts"
(`physical-device-voice-goal.md:309`) is satisfied per-sink because every
entry now carries `sequence`: a sink that dropped can emit
`EVENT_GAP_OBSERVED {expected, actual}` as data.

Serialization to the apps/os shape (`{type: "events.iterate.com/…", payload,
metadata.device: {bootEpoch, sequence, uptimeMs}}`, per the os-streams recon
§14) happens **at sinks only**, via one table-driven serializer (~120 LOC,
bounded snprintf, ~2 µs/event at sink-drain time, never on the hot path).
Idempotency key on the wire: `kit-device:<deviceId>:<bootEpoch>:<sequence>` —
which is why `configuration.c` gains a `deviceId` TLV tag and NVS gains a
boot-epoch counter (prerequisite: today the firmware mounts a fixed
`kit.m5sticks3` path via caller-supplied `options.path`
(`itx_mount.c:118-157`) and two Sticks on one project would collide).

### 3.4 `components/core/include/iterate/kit/event_sd_log.h` (requirement 5)

Straight from the sd-event-logging recon (§4–§6 there), unchanged in shape —
it was already designed in v1 house style. Compressed sketch:

```c
#ifndef ITERATE_KIT_EVENT_SD_LOG_H
#define ITERATE_KIT_EVENT_SD_LOG_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/status.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * SD event/log sink (brief req 5). Portable core: producers publish into a
 * caller-owned SPSC ring (drop-new + saturating counters — audio tasks
 * never learn the sink exists); a background pump batches 4 KiB CRC32C
 * blocks into preallocated contiguous segment files through the block-store
 * vtable. A stalled or absent card degrades to counted loss, never to
 * queueing on any producer (physical-device-voice-goal.md:307-309).
 * Boards without a slot (M5StickS3, HA Voice PE) simply never construct
 * the module.
 */

struct iterate_kit_block_store {
  void *context;
  /* Nonblocking probe: is a writable medium present? Drives the
   * retry_gate-paced re-probe (1 s → 30 s) that replaces the card-detect
   * line neither SD board wires. */
  enum iterate_kit_status (*probe)(void *context);
  /* Blocking allowed — only the sink pump task ever calls these. */
  enum iterate_kit_status (*open_segment)(
      void *context, uint32_t segment_index, uint64_t preallocate_bytes);
  enum iterate_kit_status (*write)(
      void *context, const uint8_t *block, size_t block_bytes);
  enum iterate_kit_status (*sync)(void *context);
  enum iterate_kit_status (*close_segment)(void *context);
};

enum iterate_kit_event_sd_log_state {
  ITERATE_KIT_EVENT_SD_LOG_UNMOUNTED = 0,
  ITERATE_KIT_EVENT_SD_LOG_PROBING,
  ITERATE_KIT_EVENT_SD_LOG_STREAMING,
  ITERATE_KIT_EVENT_SD_LOG_SYNCING,
  ITERATE_KIT_EVENT_SD_LOG_ROTATING,
  ITERATE_KIT_EVENT_SD_LOG_DEGRADED,
};

struct iterate_kit_event_sd_log_options {
  struct iterate_kit_block_store store;      /* borrowed                   */
  uint8_t *ring_storage;                     /* caller-owned, PSRAM OK     */
  size_t ring_capacity_bytes;                /* 64 KiB default: >30 s of
                                              * total card stall at the
                                              * ≤2 KB/s steady rate        */
  uint8_t *batch_storage;                    /* internal DMA-capable RAM   */
  size_t batch_capacity_bytes;               /* 8 KiB                      */
  uint32_t sync_interval_bytes;              /* 32 KiB                     */
  uint32_t sync_interval_ms;                 /* 5000 — bounded loss window */
  uint64_t segment_bytes;                    /* 4 MiB contiguous prealloc  */
};

struct iterate_kit_event_sd_log_metrics {
  uint32_t records_written;
  uint32_t records_dropped;                  /* ring-full, producer side   */
  uint32_t gap_records_written;              /* synthetic gap facts        */
  uint32_t write_errors;
  uint32_t reprobe_attempts;
  uint64_t max_write_stall_us;               /* the SdFat-class GC spikes  */
  uint8_t state;
};

/* Producer side: nonblocking, any-task-safe via the SPSC contract. */
enum iterate_kit_status iterate_kit_event_sd_log_publish(
    struct iterate_kit_event_sd_log *log,
    const struct iterate_kit_device_event *event);

/* Pump: called from the sink task loop (prio 2, core 0); one bounded batch
 * per call. Blocking happens only inside store ops. */
enum iterate_kit_status iterate_kit_event_sd_log_pump(
    struct iterate_kit_event_sd_log *log, uint64_t now_ms);

#ifdef __cplusplus
}
#endif
#endif
```

Landing vehicle: portable core + `tests/fakes/fake_block_store.c`
(virtual-clock stall/yank/corrupt scripting) + simulator wiring ship in wave
3 and are fully host-proven; the ESP-IDF `sd_block_store.c` (SDMMC 1-bit,
CLK=2/CMD=1/D0=3 per waveshareteam's `pin_config.h`) lands with the Waveshare
bring-up — the only zero-conflict SD board. CoreS3's shared-LCD-bus SPI
variant waits for StackChan and the esp_lcd-vs-M5GFX bus-ownership decision
(sd recon §1.2, open question). Read-back is a `has_sd`-gated capability
module (`readSdEvents({bootEpoch, afterSequence, limit})`) — lazy pull, never
auto-replay on reconnect (os-streams recon §12.5).

### 3.5 `components/core/include/iterate/kit/device_profile.h` (R6)

Two-tier exactly as the hardware recon §3.2 designed (geometry stays
compile-time in `devices/<board>/<board>_profile.h`; policy becomes one const
struct), trimmed to the knobs that exist today:

```c
struct iterate_kit_device_profile {
  const char *slug;                      /* replaces manifest slug         */
  const char *display_name;
  struct iterate_kit_audio_codec_properties codec;  /* absent ⇒ zeroed +
                                                     * has_audio=false     */
  struct {
    uint16_t max_playback_frame_age_ms;      /* 200                        */
    uint16_t partial_prebuffer_timeout_ms;   /* 200                        */
    uint16_t max_capture_age_ms;             /* 250                        */
    uint16_t peer_barrier_interval_frames;   /* 4                          */
    uint16_t peer_unconfirmed_ceiling_frames;/* 8                          */
    uint8_t mic_warmup_discard_frames;       /* 1                          */
  } audio_policy;
  struct {
    struct iterate_kit_task_spec audio;      /* {core 1, prio 19, stack}   */
    struct iterate_kit_task_spec control_net;/* {core 0, prio 5}           */
    struct iterate_kit_task_spec pcm_net;    /* {core 0, prio 6}           */
    struct iterate_kit_task_spec sd_sink;    /* {core 0, prio 2}, has_sd   */
  } tasks;
  struct {
    bool has_audio;                          /* late addendum: per-device  */
    bool has_sd;
    bool has_display;
    bool has_camera;
    bool has_servos;
    bool has_hardware_mute;
    uint8_t led_count;
  } features;
  struct iterate_kit_profile_bounds bounds;  /* clamps for the TLV subset  */
};
```

Provisioning overrides (TLV tags, all-or-nothing CRC image as today,
`configuration.c`): freshness windows, prebuffer timeout, gain ≤ ceiling,
warmup frames, metrics intervals, SD enable. Absent tag = compiled default
byte-for-byte; out-of-bounds = classified boot diagnostic + default. The
whole tier-2 struct is serialized once per session through the metrics
capability (a generated row family in `metrics_schema.def`), so every
physical run records the knob values it ran with — R6(c) discharged.

The compile-time ordering proofs in `esp_idf_websocket_policy.h:66-109`
become `_Static_assert`s against the profile initializer in each board's
`profile.c` — same proofs, board-scoped, and the portable-policy-in-a-
platform-header wart (review §5, last row) dies.

### 3.6 PCM v2 wire header (R11 tail / requirement 9) — for completeness

Not a C header file of ours so much as a wire struct; copied from xiaozhi
`protocol.h:17-24` with two deliberate deviations (little-endian; negotiated
as WS subprotocol `iterate.kit.pcm.v2` offered alongside `v1`):

```c
struct iterate_kit_pcm_v2_header {   /* 16 bytes, little-endian */
  uint16_t version;                  /* 2 */
  uint16_t type;                     /* 0=PCM, 2=EOS/commit (zero payload) */
  uint32_t reserved;
  uint32_t timestamp_ms;             /* uplink: worker-assigned downlink
                                      * timestamp of the frame whose DMA EOF
                                      * most recently completed; 0 = nothing
                                      * audible. Downlink: assigned playout
                                      * timeline. */
  uint32_t payload_bytes;            /* 640 or 0 */
};
```

Device cost ≈ 60 LOC (both timestamp domains already exist:
`realtime_playback.hpp:83-99` publishes `eofAtUs` + frame metadata; add 4 B
wire timestamp to the metadata + one atomic published by the audio owner),
worker cost ≈ 40 LOC (2 s reference ring indexed by assigned timestamp). The
`type=2` uplink frame doubles as the **in-band commit marker** that makes PTT
turns survive control-lane loss (proxy recon §2.2). v1 peers are unaffected:
subprotocol negotiation means bare-640-B framing whenever either end only
speaks v1.

---

## 4. Task model per board class (deliverable 3)

Board classes per the late addendum: half-duplex voice, duplex voice, duplex
voice with upstream hardware DSP, and audio-less control.

### 4.1 Half-duplex voice (M5StickS3) — v1's model with two changes

| Task                 | Core | Prio | Owns                                                                                                                                                              | Cadence source                                                                                                            |
| -------------------- | ---- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `app_main` main loop | 0    | 1    | buttons/display, Cap'n Web dispatch, transport polls, metrics sampling. **No mic pump anymore** (R1).                                                             | 10 ms tick (fine: nothing realtime left on it)                                                                            |
| control net          | 0    | 5    | control socket, mount, reconnect generations                                                                                                                      | socket + retry_gate                                                                                                       |
| PCM net              | 0    | 6    | PCM socket, uplink conductor, downlink receive                                                                                                                    | **socket-driven wakeup** (R5 — kills the 1-tick receive poll flagged at `pcm_transport.c:598-611`)                        |
| audio owner          | 1    | 19   | playback policy + I2S lifecycle (unchanged) **+ capture read + processor + route fence** (R1: codec impl runs the amp-off→channel-delete→PDM-RX-up sequence here) | DMA completion events via codec `next_event` — blocking-DMA-owns-cadence, the esphome rule (`audio_pipeline.cpp:917-919`) |
| I2S TX ISR (IRAM)    | 1    | —    | EOF timestamp → SPSC → owner notify (unchanged; **no new IRAM_ATTR anywhere** — 1 byte free, review §4.5)                                                         | hardware                                                                                                                  |

Changes vs v1: mic capture leaves the priority-1 orphan slot (review §4.1 —
the single structural realtime defect); the 1 s synchronous metrics/route
rendezvous stops being a capture hazard because the main loop no longer has
audio duties; both R5 tick-polls die. Everything else is byte-identical.

### 4.2 Duplex voice (StackChan, Waveshare) — same skeleton + AEC budget

Same five tasks. Additions: the audio owner's frame loop calls the `esp_sr`
FD_LOW_COST processor synchronously per 20 ms frame (~19.6 % of core 1 —
inside budget next to playback policy), fed by the software TX-tap reference
ring (R11: complete frames only, reset on capture-session edges, 0–10 ms
mic-lags-ref verified once via interleaved debug dump). StackChan's CoreS3
additionally has the **hardware** reference option the stackchan autopsy
found (ES7210 TDM slot 1 = MIC3 wired across the speaker output,
`audio_pipeline.c:446-482` there) — if bring-up confirms it,
`reference_channels=1` and the software tap is deleted. SD sink task (0/2)
present on both boards (`has_sd`), pump absorbs the 100–400 ms cheap-card GC
stalls via the 64 KiB ring.

### 4.3 Duplex voice, hardware DSP upstream (HA Voice PE)

Same skeleton; `input_echo_cancelled=true` selects the **null** processor
even in full duplex (the XMOS XU316 already did AEC/NS/AGC); output side runs
at 48 kHz (codec property) with the resample decision confined to the codec
impl. Hardware mute switch surfaces as a device event AND a capture-hardware
truth (reads return UNAVAILABLE while muted — fail-closed). No SD task.

### 4.4 Audio-less control (e-ink/buttons class — late addendum)

| Task                  | Core | Prio | Owns                                       | Cadence               |
| --------------------- | ---- | ---- | ------------------------------------------ | --------------------- |
| `app_main`            | 0    | 1    | buttons/e-ink, Cap'n Web dispatch, metrics | 10 ms tick            |
| control net           | 0    | 5    | control socket                             | socket + retry_gate   |
| SD sink (if `has_sd`) | 0    | 2    | event log pump                             | own loop, blocking OK |

No PCM net, no audio owner, no ISR. Link set = `core + capabilities +
platform control half` — buildable and negative-link-tested after R3.
Single-core parts are legal here by construction (nothing pins core 1).

---

## 5. Requirements 1–12 → mechanisms (deliverable 4)

| #   | Requirement                            | Candidate C mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Delta class                                                              |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Less code/complexity                   | R7 X-macro schema (−2,260 combined, biggest single win); R8 atomics (−220); R13 CMake helper (−710 build); verified-dead deletions (−1,900). Honest: total LOC ≈ −1.9 % because the audit's high-risk structural collapses are refused (§9.1). Complexity metrics that DO move: counter-spelling sites ≈7→1; per-board constant homes 7→1; bespoke delivery machines 4→4 (unchanged — the kept wart).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | deletions + 2 new `.def` files                                           |
| 2   | Easier to test/reason                  | R3 makes core-without-audio a link-time truth (negative link test); processor + codec seams get null/fake/scripted impls so route-fence and fail-closed policy are host-covered for the first time; pthread-fakes rule becomes a merge gate and closes the two documented holes (`websocket_connection.c` errno classifier/URL parser, `peer.c` unwrap — firmware-core §6); event goldens (JSONL diff) become the cheapest behavior spec. Budget: ≤5 s native / ≤30 s vitest warm (testing recon §2.4).                                                                                                                                                                                                                                                                                                                                                                                                                         | new tests, no rewires                                                    |
| 3   | Prior-art best practices               | Each imported as a bounded patch with provenance: capture priority ladder (xiaozhi `audio_service.cc:131-135`), DMA-owned cadence (esphome `audio_pipeline.cpp:917-919`), fail-closed silence (`esp_afe.cpp:1612-1615`), drain-before-mic-open + warmup (R12, xiaozhi `application.cc:937-945`), timestamp echo (xiaozhi protocol v2), preroll ring (xiaozhi `wake_word_audio_cache.cc:26-27`), reference discipline (esphome `audio_pipeline.cpp:1728-1737`). Refused: ADF elements, seekaudio blob, any framework machinery (review "explicitly not recommended").                                                                                                                                                                                                                                                                                                                                                            | ≤100 LOC patches                                                         |
| 4   | Pluggable hardware APIs                | v1's driver vtables + thin RPC modules + flat module table survive verbatim (hardware recon §2 — they are already right); + codec capture/route contract (§3.2); + two-tier profile (§3.5); "more permissive" = append board modules to the open table (mechanism exists, `m5sticks3.c:158-176`). New ES8311-class board audio ≈ profile + pins + ~250-LOC codec impl.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 2 new headers, moves                                                     |
| 5   | SD logs (if present)                   | `event_sd_log` portable core + block_store vtable + fake + simulator now; hardware adapter at Waveshare bring-up (only zero-conflict slot: SDMMC 1-bit CLK2/CMD1/D0 3); FATFS + preallocated contiguous 4 MiB segments + CRC32C 4 KiB blocks; producers publish nonblocking, ≤5 s loss window, per-sink gap records; `readSdEvents` pull capability; `sd-ingest.ts` decoder from the same generated table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | all-new module                                                           |
| 6   | Keep the best                          | §6.1 verbatim list — review §3's preserve table is the floor; this candidate's entire premise. The audio path (41 % of firmware production, best-tested code) is untouched except the capture half R1 forces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —                                                                        |
| 7   | Three testing layers                   | L1: seam tests + goldens + fuzz targets (websocket_rx, TLV) + golden-replay corpus of real rig PCM. L2: `device-e2e.ts` frozen; four ADDITIVE scenarios as sibling scripts over shared helpers — PTT uplink echo loop (~80-LOC uplink-recorder provider + PRBS31 from the Mac speaker; the physical regression test for the §4.1 orphan), AEC three-phase proof (ERLE ≥10 dB / near-end damage <3 dB, goal doc :317-321), barge-in stopwatch, timestamp-echo alignment (PRBS correlation as ±0.5 ms ground truth); plus one **no-acoustics rig scenario** for the audio-less class (mount, events, SD ledger only). L3: `kit-checkride.ts` — <5 min, ~8 frozen prompted steps asserted against the device event stream, incl. AP-kill drill (req 10) and SD-vs-host evidence diff. One frozen per-device acceptance module imported by all three layers (today the six acoustic numbers live in ≥3 files — testing recon §1.3). | additive                                                                 |
| 8   | Devices as streams                     | `device_events` grows into the shape (§3.3): interned URI table, sequence/bootEpoch/uptime coordinates, sink-side serialization to verbatim `StreamEventInput`; deviceId TLV + NVS bootEpoch; worker replaces its two `wouldPostToStream:true` seams (`worker.ts:245-253`, `:269`) with idempotency-keyed appends via a bounded drop-oldest `stream-outbox.ts`; stream path `/kit/devices/<id>`; userspace-hosted `KitDeviceProcessor` (guestbook shape, zero apps/os changes); transcription deltas `ephemeral:true`; PCM never on the stream.                                                                                                                                                                                                                                                                                                                                                                                 | additive (firmware entry widening is the only touch to existing code)    |
| 9   | Server-side AEC                        | "Allow for" fully discharged by the v2 subprotocol header + timestamp echo (§3.6, ~100 LOC both ends, v1 peers unaffected). Ladder: rig-side speexdsp first (evidence: stamp accuracy vs PRBS ground truth), worker speak-state gating (~30 LOC, no DSP) as the shipping duplex-ish mode for the Stick, worker WASM speex (~0.2–0.6 ms/20 ms frame, ~$0.0014/session-hour) only on proven need; xAI has no reference input today (watch item).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | additive                                                                 |
| 10  | Degrade/recover, both sockets always   | Four surgical firmware fixes: PCM gate reset on first confirmed delivery not socket connect (`pcm_transport.c:617` vs control's READY gating `itx_transport.c:738-748`, ~10 LOC); fleet jitter in the platform wrapper (retry_gate.c:6-12 says it belongs there, ~15 LOC); retry-gated `pcm_transport_start` (today attempted exactly once, `main.cpp:1273`); Wi-Fi backoff unified onto retry_gate (R13). New last rung: no control READY for 15 min OR fatal latch → SD-log → reboot (ESPHome posture). Degraded-mode matrix with per-state LED policy + press-time failure surfacing via existing leds/screen modules; in-band commit marker removes the PCM-up/control-down dead mode.                                                                                                                                                                                                                                      | patches                                                                  |
| 11  | No always-on Grok                      | `upstream-session.ts` in the worker: NO_UPSTREAM→DIALING→ACTIVE→DRAINING→COOLDOWN per device lane; DO `storage.setAlarm` idle timer (eviction-proof); 2 s/64 KB preroll ring so `max(0, dial − press) ≈ 0` added latency; pre-minted 300 s secret pool; await `session.updated` (today fire-and-forget, `providers.ts:145-166`); policy V-B: 90 s idle window + drain-at-turn-boundary + rotation at ~25 min (30-min xAI cap) + transcript replay via `conversation.item.create` ⇒ ≈$4.16/day vs $115/day always-on at $0.08/min. Provider death sends device EOS (clean frame-boundary stop) instead of today's 1011 cascade (`pcm-proxy.ts:104-110`); deletes the `#suppressDownlink` defect class structurally.                                                                                                                                                                                                              | new module + rewire of `pcm-proxy.ts` (the one non-additive host change) |
| 12  | Pluggable device I/O                   | Driver vtables/modules verbatim; event vocabulary grows per board (dial, touch, mute) via the `.def` table referenced from the profile; one shared ISR-marshalling SPSC helper; `renderer_driver` + renderer-input struct added when the first avatar board lands (StackChan) — steal the stackchan 40-B `face_render_key_t` IR (`face_keyframe.h:62-129`, `_Static_assert==40`, already designed and tested) rather than inventing one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | additive                                                                 |
| —   | **Late addendum** (audio-less devices) | R3 split + `device.h` drops `audio.h` (include at `device.h:4` today) + `features.has_audio` ⇒ control-only link set, negative link test in CI, no-acoustics rig scenario, task model §4.4. Where audio IS present nothing changes — the realtime discipline is untouched by the generality because audio never became the organizing principle in the first place.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | moves                                                                    |

---

## 6. Survival ledger (deliverable 5) — verbatim / adapted / deleted

### 6.1 Survives VERBATIM (requirement 6; review §3 is the floor)

| Module                                                                                                                                                                     | Why                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `realtime_playback.hpp` (1,863) + `direct_i2s_stereo_output.hpp` (710) + `esp_idf_direct_i2s_backend.hpp` (689) + their 3,093 LOC of descriptor-identity tests             | the physically-proven crown jewel; every line bought with an incident (brownout, silence-recovery, generation poison) |
| `pcm_lane`, `pcm_uplink_conductor`, `pcm_uplink_sender`, `pcm_peer_delivery_guard`, `pcm_websocket`                                                                        | "the strongest part" (review §5); moved to `components/audio` byte-identical                                          |
| `spsc_ring`, `retry_gate`, `websocket_tx/rx/frame_writer`, `itx_mount`, `itx_connection`, `configuration` decoder core                                                     | clean sans-I/O plumbing                                                                                               |
| vendor capnweb minus responder/call_path; the TS interop suite + known-failure ledger                                                                                      | all six wire message types load-bearing                                                                               |
| `device_events` queue mechanics (publish/poll, bounded, single-task, metrics)                                                                                              | only the entry widens                                                                                                 |
| `device_event_stream` delivery machine (single subscriber, call_in_flight, callback budget, release_pending, coalesce-and-count, post-subscribe snapshot)                  | correctness core, pinned by `m5sticks3_events_test.c`; generalized input, identical machinery                         |
| `runtime_diagnostics` (505c+250h)                                                                                                                                          | untouched — the kept-wart decision, §9.3                                                                              |
| leds/servos/screen/camera driver vtables + capability modules, `callback_budget`, `push_to_talk`, `rpc_internal`, flat peer module table, composition-root pattern         | already the right cut (hardware recon §2)                                                                             |
| `tests/fakes/` pthread-fake platform, virtual-clock fault harness, simulator control-plane honesty                                                                         | the distinctive v1 property, promoted to a merge rule                                                                 |
| Host: acoustic oracles (tone + PRBS31 analyzers, both implementations), SoX-only capture doctrine, endurance family + frozen thresholds, `device-e2e.ts`, prove-\* scripts | the physical proof ladder — frozen by design in this candidate                                                        |
| Wire v1: 640 B/20 ms/16 kHz S16LE, dual sockets, zero-length EOS                                                                                                           | brief hard constraint; v2 header is negotiated _alongside_                                                            |

### 6.2 Adapted (existing files, bounded edits)

| Module                                               | Edit                                                                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audio.h`/`audio.c` (368)                            | drop `peer.h` (own status enum, capability layer maps — R3); capture vtable + route triplet replaced by codec-event state machine; controller logic otherwise intact                                           |
| `device_events.{h,c}`                                | 24-B entry, sequence at publish, 3 observer slots, `.def` table                                                                                                                                                |
| `device_event_stream.{h,c}`                          | notification carries `{type, payload, sequence}` for any event type (schema bump); delivery machine untouched                                                                                                  |
| `metrics.{h,c}`                                      | schema regenerated from `metrics_schema.def`; file split (sampler vs subscriptions); dead managed-client rows deleted; 1536-B expression-capacity proof regenerated and kept                                   |
| `main.cpp` (1,349 → ≈700)                            | `sampleRuntimeMetrics` (:455-924) dies with R7 (platform sampler writes the canonical struct directly); constant farm + static_asserts move to the profile; boot order + main loop intact                      |
| `itx_transport.c` (1,624 → ≈1,300)                   | Wi-Fi station extraction (R13) into `wifi_station.c`; READY gating untouched                                                                                                                                   |
| `pcm_transport.c`                                    | gate-reset-on-confirmed-delivery; socket-driven wakeup (R5)                                                                                                                                                    |
| `m5unified` platform                                 | shrinks to board init; recorder pump path deleted with R1                                                                                                                                                      |
| Worker (`worker.ts`, `pcm-proxy.ts`, `providers.ts`) | attach/detach rewire, v2 subprotocol, await `session.updated`, outbox posts at the two logged seams                                                                                                            |
| `device-pcm-proxy.ts`                                | R9 defect fixes only (`#suppressDownlink` at :429, oversized-provider-message admission) + device-clocked default; then frozen as the lab harness                                                              |
| `firmware-architecture.test.ts`                      | fix the two vacuous-pass `slice(indexOf(...))` hazards (:663-677); convert include-boundary greps to link-truth once R3 lands (keep one release as belt-and-braces); the register/priority/IRAM tripwires stay |

### 6.3 Deleted (verified-dead only)

| Deletion                                                |  LOC | Verification                                                                                                                |
| ------------------------------------------------------- | ---: | --------------------------------------------------------------------------------------------------------------------------- |
| `bounded_playback.hpp` + test                           | −772 | only referent is its own test (audit b1)                                                                                    |
| `websocket_text` egress/ingress + test halves           | −480 | production uses outbox/inbox only; ingress control branch unreachable (`itx_transport.c:570-573`)                           |
| capnweb `responder.c` + `call_path` + native-test trims | −350 | zero production callers; interop ledger updated same commit                                                                 |
| managed-client dead fields (6 surfaces)                 | −100 | header admits they "remain zero" (`esp_idf_itx_transport.h:144-158`)                                                        |
| `bounded_capture.hpp` (258) + M5Unified recorder pump   | −458 | superseded by codec capture (R1) — the one deletion tied to a behavior change, guarded by the uplink echo-loop rig scenario |
| atomics copies ×8 → `atomic.h` named variants           | −220 | mechanical (R8); every touched file has a host test                                                                         |
| host `withTimeout`×3 / `waitForOpen`×2                  |  −40 | trivial                                                                                                                     |

---

## 7. The delta, quantified (deliverable 6)

### 7.1 Files

| Class        |               Count | Names (firmware)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Names (host)                                                                                                                                                                |
| ------------ | ------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Added**    |                 ≈26 | `device_event_types.def`, `metrics_schema.def`, `audio_processor.h`, `audio_processor_null.c`, `audio_codec.h`, `event_sd_log.{h,c}`, `device_profile.h`, `m5sticks3_profile.{h,c}`, `stackchan_profile.{h,c}`, `wifi_station.{h,c}`, `m5sticks3_codec.c`, `sd_block_store.c` (later), `fake_block_store.c`, tests: `audio_processor_test.c`, `audio_codec_route_test.c`, `event_sd_log_test.c`, `device_events_golden_test.c`, `websocket_connection_test.c`, `peer_test.c` | `upstream-session.ts`, `stream-outbox.ts`, `deterministic-pcm-uplink-recorder-provider.ts`, `kit-checkride.ts`, `sd-ingest.ts`, `wire-constants.generated.ts` (+ generator) |
| **Deleted**  | 6 whole + 2 partial | `bounded_playback.hpp`, `bounded_playback_test.cpp`, `bounded_capture.hpp`, `responder.c`, `call.c` partial, `websocket_text.c` partial                                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                           |
| **Modified** |                 ≈30 | `device.h`, `audio.{h,c}`, `device_events.{h,c}`, `device_event_stream.{h,c}`, `metrics.{h,c}`(split), `configuration.{h,c}`, `main.cpp`, `itx_transport.c`, `pcm_transport.c`, `m5unified.{hpp,cpp}`, `m5sticks3_direct_audio.{hpp,cpp}`, `m5sticks3.{h,c}`, root + component CMakeLists, ~8 test files                                                                                                                                                                     | `worker.ts`, `pcm-proxy.ts`, `providers.ts`, `device-events.ts`, `device-pcm-proxy.ts`, `firmware-architecture.test.ts`, `device-e2e.ts` (flags only)                       |

### 7.2 LOC ledger

Deletions taken (production): R7 schema −1,700 device / −560 host; R8 −220;
R13 Wi-Fi net −150; dead code −772 −230 −250 −100; capture path −458; host
misc −40. **Σ ≈ −4,480.**

Additions: processor seam +350; codec header + Stick impl + controller
rework +640 (net +182 after the −458 above); SD portable core + fake +650;
profile structs +240 (mostly moves); event widening + serializer +270; wire
generator +150 C-side; ladder fixes +50; ts-echo +80 device. Host: upstream
session +300; outbox +80; ts-echo ring +150; uplink recorder +80; checkride
+200; sd-ingest +250; generated schema/constants +250. **Σ ≈ +3,740 prod.**

|                     |         v1 |      v2 (C) |          Δ | vs the audit's full program                                                                                               |
| ------------------- | ---------: | ----------: | ---------: | ------------------------------------------------------------------------------------------------------------------------- |
| Firmware production |     31,228 |     ≈29,850 |     −4.4 % | audit projects −11 % (its extra −2.1 k is the event-spine collapse + camera/profile/analyzer cuts this candidate refuses) |
| Firmware tests      |     20,727 |     ≈20,400 |     −1.6 % | new seam/golden/SD tests ≈ +650 vs −1,000 dead/dup                                                                        |
| Build               |      1,640 |        ≈930 |      −43 % | same (R13)                                                                                                                |
| Host production     |     18,607 |     ≈19,050 | **+2.4 %** | audit projects −7 %; this candidate adds five host modules and consolidates almost nothing host-side                      |
| Host tests          |     13,108 |     ≈13,500 |       +3 % |                                                                                                                           |
| **Total**           | **85,310** | **≈83,730** | **−1.9 %** | audit: −8 %                                                                                                               |

RAM delta: event queue 64 B → 768 B; SD sink ~80 KiB PSRAM + ~20 KiB
internal on `has_sd` boards only (audio path still uses zero PSRAM); ts-echo
+128 B metadata; profile ~200 B flash. IRAM delta: **zero by rule** (R4's
clawback is scheduled before any AEC work; nothing in this candidate adds
`IRAM_ATTR`).

---

## 8. Migration/sequencing with codex mid-flight (deliverable 7)

The live git status shows codex currently editing: `metrics.{c,h}`,
`main.cpp`, `itx_mount.c`, `peer.c`, `itx_transport.c`, both PCM/ITX
transport headers, `m5sticks3.{c,h}`, `m5sticks3_direct_audio.cpp`,
simulator files, `CMakeLists.txt`, and six test files. Sequencing is built
around that: **wave 0 touches none of those files; the schema wave (R7) is
explicitly gated on codex's current checkpoint merging.**

| Wave                                                | Contents                                                                                                                                                                                                                                           | Codex-conflict risk                                                                                            | Proof-ladder gate                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **0 — free wins** (can start today)                 | delete `bounded_playback` pair; prune `websocket_text` egress/ingress + merge its two test files; capnweb responder/call_path prune + interop ledger; `withTimeout` dedupe; R9 host defect fixes + device-clocked default; vacuous-pass grep fixes | LOW — none of these files are in codex's modified set except root CMakeLists (coordinate the two-line removal) | none needed (zero behavior change); run native suite + proxy tests                                                       |
| **1 — structure** (after codex's checkpoint merges) | R3 split (file moves + `audio.h`/`peer.h` break + `device.h` include drop); R13 Wi-Fi extraction; R8 atomics; CMake `add_iterate_kit_test()` + shared source lists; negative link test for the control-only set                                    | MEDIUM — mechanical but wide; do as one review-able PR of moves + one of edits                                 | tone proof re-run; native 38/38                                                                                          |
| **2 — R1/R5 realtime**                              | Stick codec impl (esp_driver_i2s PDM RX + internal fence) on the audio owner; capture leaves the main loop; socket-driven PCM wakeup; R12 drain-edge event; PCM gate-reset + retryable start + jitter                                              | HIGH sensitivity (this is the audio path) — but the change is confined to capture/route; playback untouched    | tone proof + **new uplink echo-loop scenario** (the regression test this wave creates for itself) + 1-min endurance rung |
| **3 — schema & knobs**                              | R7 X-macro + metrics file split + dead-field rows; R6 profile + TLV tags + deviceId/bootEpoch; R10 wire-constant generation; `main.cpp` sampler death                                                                                              | MEDIUM — touches codex's hottest files; MUST wait for their metrics work to land, then regenerate              | endurance rung (metrics continuity is what it checks); host parsers regenerated same PR                                  |
| **4 — features**                                    | event widening + generalized event stream + goldens; SD portable core + fake + simulator + `readSdEvents`; worker upstream-session + preroll + outbox + `KitDeviceProcessor`; v2 subprotocol + ts-echo; checkride CLI                              | LOW firmware / MEDIUM worker (rewires `pcm-proxy.ts`)                                                          | tone proof through the NEW worker path before flipping prod; AP-kill drill in checkride                                  |
| **5 — boards** (out of v2.0 scope, enabled by it)   | Waveshare bring-up (ES8311 codec impl + playback folds under codec vtable + SD hardware adapter); StackChan (AEC behind R2 seam per R11, renderer IR from stackchan); HA VPE                                                                       | —                                                                                                              | AEC three-phase proof; per-board checkride                                                                               |

R4's chores (IRAM audit, PSRAM enable+smoke, placement-audit logging) ride
waves 1–2 as scheduled tasks, before anything in wave 5 needs them.

Every wave is independently landable and independently revertable; no wave
holds two copies of anything for longer than one PR (the R7 wave deletes the
hand schemas in the same change that generates them).

---

## 9. Honest cons and failure modes (deliverable 8)

### 9.1 What this candidate does NOT deliver

- **Requirement 1's LOC reading.** −1.9 % total. The audit shows the honest
  maximum without cutting proven audio/test code is ≈ −8 %; the gap (≈ −6.4 k
  LOC) is exactly the risk this candidate refuses: event-spine collapse
  (−1,130 prod −700 test, risk HIGH), device-e2e phase-runner (−600),
  analyzer merge (−450), camera/profile/misc (−700), host parser
  consolidation beyond R7. If "reduce the amount of code" is scored
  literally, candidate C loses that row on purpose.
- **Host code grows.** Five new host modules and no host consolidation:
  +2.4 %. The worker gains its most complex logic ever (the upstream state
  machine) without the surrounding cleanup a redesign would bring.
- **One delivery machine too many, forever** (or until a trigger fires):
  the capnweb event sink, the metrics subscription scheduler, the
  runtime_diagnostics pump, and now the SD sink pump are four separately
  maintained "bounded background delivery" machines; two of them
  (`device_event_stream`, metrics scheduler) share structurally identical
  five-boolean bookkeeping (`metrics.h:312-320` vs
  `device_event_stream.h:64-78`) that stays written twice.

### 9.2 Failure modes specific to this architecture

1. **The stackchan failure shape.** Stackchan died by accretion: a decent
   4.5 k-LOC audio core buried under 60 k LOC of additive, never-pruned
   renderer variants (stackchan autopsy §1). Candidate C's "add beside,
   never rewire" rule is _the same gesture_. The mitigations are the wave
   gates (nothing lands without a deletion or a test) and the §9.3 trigger
   ledger — but the risk is real and structural, and a reviewer should weigh
   it as this candidate's biggest long-term hazard.
2. **Two proxies drift.** Every `/pcm` protocol change now lands twice
   (worker + `DevicePcmProxy`) or the lab harness silently stops modelling
   prod. The v2 subprotocol is the first test: if the lab proxy doesn't
   learn it in the same wave, layer-2 scenarios can't exercise ts-echo
   against deterministic providers. Freezing `DevicePcmProxy` "except
   defects" is a policy, not an enforcement.
3. **Half-adopted codec contract = a third asymmetry era.** From wave 2
   until Waveshare bring-up, capture speaks `audio_codec.h` while playback
   speaks `RealtimePlayback` templates. That is _better_ than v1's three
   asymmetric seams (the fence is finally owned by one task) but it is a new
   inconsistency a newcomer must learn, and if Waveshare slips, it calcifies.
4. **Generalized event stream keeps coalesce-newest semantics.** No
   resume-from-cursor protocol (os-streams recon §12.2): a subscriber that
   missed events gets a gap fact and a snapshot, never a replay from the
   device's RAM. For the PTT-controlling consumer that is today's designed
   policy (gap ⇒ close generation, `worker.ts:279-287`); for the stream
   cross-post it means short control-plane outages produce durable gap
   events where the big-bang design would have replayed 64 slots. SD backfill
   covers the long-outage case; the 2-to-64-event window is accepted loss.
5. **R7 regeneration race with codex.** The schema wave rewrites the exact
   files codex is editing today. Landing it early corrupts their work;
   landing it late means new counters keep being threaded through ~7 places
   in the meantime. The sequencing gate (wave 3 waits for their checkpoint)
   is the answer but it makes the biggest complexity win the _latest_ one.

### 9.3 The wart ledger — kept warts with explicit redesign triggers

The minimal-delta contract: every wart this candidate keeps is named, and
each carries the condition under which incremental cost has provably
exceeded redesign cost. This table is intended to survive into the final
plan as a standing review item.

| Kept wart                                                                                   | Carried cost                                                | Trigger that flips it into redesign                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four bounded-delivery machines (event stream, metrics scheduler, diagnostics pump, SD pump) | ~1,900 LOC of parallel machinery; five-boolean logic ×2     | the **third** time a delivery bug/feature (budget change, subscriber lifecycle fix) must be fixed in more than one machine ⇒ do the audit's event-spine collapse (§2c, Option B: sampler stays outside, incidents become events) as v2.1's single milestone |
| `runtime_diagnostics` as a separate console path beside the event log                       | 755 LOC; two console vocabularies                           | when the SD sink + event goldens prove the event serializer covers ≥90 % of what the console lines carry (measure by diffing a physical run's console log against its event JSONL) ⇒ fold console into an event sink                                        |
| `device-e2e.ts` monolith (1,752) + prove-\* orchestration duplication                       | new scenarios re-implement phase sequencing (~150 LOC each) | when the **fourth** additive scenario lands (uplink echo, AEC proof, barge-in, ts-echo alignment = exactly four) ⇒ extract the phase-runner then, with a green physical run to diff against                                                                 |
| Two proxies                                                                                 | dual maintenance of `/pcm` semantics                        | first release where a `/pcm` change ships in one proxy and not the other (detectable: the shared conformance fixture set from R10 fails on one side) ⇒ merge to one bridge core with host adapters                                                          |
| Dual acoustic analyzers (in-memory + streaming, 1,307 LOC file)                             | equivalence maintained by fixtures                          | first analyzer feature that must be written twice ⇒ merge (streaming subsumes in-memory; −450)                                                                                                                                                              |
| `main.cpp` ≈700-LOC composition monolith                                                    | reviewability                                               | second target board's main.cpp exceeding ~400 shared-shape LOC ⇒ extract the boot ladder                                                                                                                                                                    |
| Playback outside the codec vtable                                                           | contract asymmetry                                          | Waveshare bring-up (already scheduled) — this one has a date, not a condition                                                                                                                                                                               |
| host-paced proxy mode                                                                       | ~150 LOC + a second delivery model                          | after StackChan ships on device-clocked, delete if unused for one release                                                                                                                                                                                   |

### 9.4 Where "minimal" is genuinely the wrong frame

If Jonas's actual intent for v2 is _organizational_ — one event spine as the
device's nervous system, streams-first from boot, a single codec abstraction
as the porting story — then this candidate under-delivers by design: it
produces v1.5, an excellent v1.5, but the conceptual count of mechanisms
goes UP (codec contract + old playback contract; event queue + four sinks;
two proxies; two diagnostics paths) before triggers bring it down. The
big-bang candidates pay risk now for a smaller _concept_ count; this one
pays concept count for near-zero risk to a proof ladder that took weeks of
physical debugging to build. That trade is the whole decision.

---

## 10. Decisions assumed here that belong to Jonas (deliverable 9)

1. **Refusing the event-spine collapse.** I assumed keeping four delivery
   machines + the trigger ledger beats a HIGH-risk rewrite of the control
   plane's correctness core mid-v1. If Jonas weighs "one mechanism" over
   "zero disturbance", this is the single fork that most separates candidate
   C from A/B — and it is reversible later at roughly the same cost as now.
2. **Blessing the two-proxy split** (worker = product, `DevicePcmProxy` =
   frozen lab harness) instead of merging to one bridge core with host
   adapters. Cheaper now, standing drift risk forever (§9.2.2).
3. **Codec contract scope**: capture+route now, playback folded in at
   Waveshare. The alternative (full codec vtable day one, hardware recon
   §1.4) costs ~250 extra LOC of rewiring against the crown-jewel playback
   stack during codex's active window. I chose the asymmetry; Jonas may
   prefer paying once.
4. **Session policy V-B defaults**: 90 s idle window, transcript replay
   across hangups (conversation memory vs cost vs privacy of retaining
   transcripts in the DO), rotation at 25 min — and the assumption that xAI
   bills per connected minute (unverified; a deliberately-idle-session
   measurement must precede freezing `T_idle`, proxy recon §0.4).
5. **Event identity choices**: deviceId as an efuse-MAC-derived TLV field;
   stream path `/kit/devices/<id>`; device coordinates in `metadata.device`
   (not `payload`); two type namespaces (`kit-device/*` + `kit-voice/*`) on
   one stream. All copied from the os-streams recon's recommendations; all
   cheap to decide now and annoying to migrate later.

---

## 11. Roads not taken _within_ this candidate

- **Event-spine collapse now** — see §10.1; the behavioral suites
  (`metrics_subscription_test.c` 1,169, `m5sticks3_events_test.c` 537) would
  need porting under an active codex tree.
- **Full codec vtable including playback** — §10.3.
- **Merging the ESP transports** — their scheduling/discard policies differ
  deliberately (`esp_idf_websocket_policy.h:36-52` pins the priority
  relationship); the audit reached the same verdict.
- **Deleting camera / deferring StackChan capabilities** — churn without
  risk reduction; leds/servos are on the hub roadmap.
- **SD on internal NOR for the Stick** — cache-suspension stalls are the
  exact hazard class `CONFIG_I2S_ISR_IRAM_SAFE` exists for
  (`sdkconfig.defaults:18-19` per the SD recon), and IRAM has one byte free.
  The Stick's resilience story is the RTC-noinit last-gasp buffer, later.
- **Opus, QEMU emulation, C test frameworks, runtime-loadable drivers,
  synthetic capability trees, ADF/ESPHome/xiaozhi machinery** — all refused
  for the same reasons the review and recon docs already established;
  nothing in the minimal-delta frame changes those verdicts.
