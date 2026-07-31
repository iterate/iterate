# Exploration: pluggable hardware APIs (brief requirements 4 + 12)

Status: exploration-round artifact for the v2 plan. Written 2026-07-31 against the
live `c-capabilities` working tree (v1 under active codex development — line
numbers may drift). Companion inputs: `../inputs/brief.md`,
`../../fable-firmware-architecture-review-2026-07-31.md` (R1–R13),
`../inputs/agent-reports/{firmware-core,firmware-audio,xiaozhi,esphome-intercom,espressif-prior-art}.md`.

Requirements under design:

> **4.** clean pluggable APIs for hardware differences to be contained in while
> sharing most code (configurable though so you can add more permissive …)
> **12.** the pluggable device I/O (lights, screen, etc) on-device

Constraint set that shapes everything below: portable allocation-free C core,
bounded-everything, no synthetic capability tree ("a mounted device … can
expose the functions that make sense for that device",
`apps/kit/docs/physical-device-voice-goal.md:90-92`), four boards on the hub
(M5StickS3, StackChan, HA Voice PE, Waveshare S3 AMOLED Touch), ESPHome
devices eventually via an adapter (`tasks/esphome-iterate-device-adapter.md`).

---

## 0. TL;DR

1. **v1's device-I/O seams are already right and survive verbatim** (§2, §4):
   per-peripheral C driver vtables (`leds.h`, `servos.h`, `screen.h`,
   `camera.h`, `metrics.h`), thin RPC capability modules over them, the
   single-task bounded device-event queue, and the flat per-board module table
   in the composition root. Do not redesign these; extend them.
2. **The one genuinely missing hardware seam is a unified audio codec vtable**
   (§1). v1 has three asymmetric audio seams (playback: excellent; capture:
   different idiom, wrong task; route switching: policy smeared across two
   platform files). One `iterate_kit_audio_codec` C vtable — translated from
   xiaozhi's `AudioCodec` properties + ops, but nonblocking/event-drained in
   our style — unifies them, and moves the half-duplex pin fence _inside_ the
   codec implementation where it is a hardware fact, not a controller policy.
3. **Profile-as-data is two-tier** (§3): storage-sizing geometry stays
   compile-time constants (one `profile.h` per board, consumed by both the
   templates and a const struct), while non-sizing policy (freshness windows,
   gain ceiling, warmup frames, intervals, feature flags) becomes a const
   `iterate_kit_device_profile` instance — compile-time defaulted,
   provisioning-overridable for a clamped subset, reported verbatim through
   metrics (review R6).
4. **"More permissive" variants are just more modules in the table** — the
   mechanism already exists (`devices/m5sticks3/m5sticks3.c:158-176`); v2
   makes it cheaper, not different.
5. **The ESPHome adapter costs us only discipline, not code** (§5): keep the
   portable layers task-free/clock-injected (they already are), finish the
   Wi-Fi-bringup extraction (R13) and the core/audio component split (R3) so a
   control-only link set exists.
6. Not-doing (§6): runtime-loadable drivers, C++ inheritance in the portable
   layer, a universal HAL, runtime board detection, ADF/ESPHome framework
   machinery, synthetic capability trees.

---

## 1. (a) The audio codec/IO interface

### 1.1 What v1 actually has (three seams, asymmetric)

| Seam                                                                                                                                                                                                                        | Shape                                                                                        | Quality                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `iterate_kit_audio_hardware` (`components/core/include/iterate/kit/audio.h:35-41`)                                                                                                                                          | 4 synchronous fns: `start_capture`, `stop_capture`, `stop_playback`, `flush_playback`        | Route-lifecycle only. No data plane, no properties, no sample rates. The half-duplex contract lives in a comment ("must make stop_playback() stop DMA immediately and flush_playback() release every speaker buffer before start_capture()", `audio.h:31-34`).                                                                                                     |
| `iterate_kit_audio_capture_driver` (`audio.h:73-79`)                                                                                                                                                                        | one `poll(submit)` fn                                                                        | Pumped from the priority-1 main task (`targets/m5sticks3/main/main.cpp:1196-1217`) via `BoundedCapture<320,16000>` (`platforms/common/include/iterate/kit/platforms/bounded_capture.hpp:36-47`, 2×640 B armed recorder slots) over **M5Unified's legacy-driver recorder** — a different idiom from playback, on the wrong task (review §4.1: the priority orphan). |
| Playback stack: `RealtimePlayback` Driver template + `DirectI2sStereoOutput` + `EspIdfDirectI2sBackend` `I2sOps`/`BoardOps` (`platforms/iterate_m5unified/include/iterate/kit/platforms/m5sticks3_direct_audio.hpp:31-110`) | descriptor-token API, ISR → 4-slot SPSC → owner notify, preload/enable/write, EOF timestamps | The strongest audio asset in the tree: 1,863 LOC policy template + 710 LOC output adapter, host-tested to **descriptor identity** (`tests/realtime_playback_test.cpp` 1,989 LOC, `direct_i2s_stereo_output_test.cpp` 1,104 LOC). Must survive.                                                                                                                     |

Plus the mode enum baked into the _manifest_ (`device.h:11-15` carries
`iterate_kit_audio_mode`, values PTT / FULL_DUPLEX_AEC, `audio.h:15-19`) —
a 2-value policy enum where v2 needs a property vector (see §1.4).

The route fence today: the portable controller sequences
`stop_playback → flush_playback → start_capture` (`audio.h:31-34`,
`components/core/src/audio.c` per the audio deep-read), and the platform maps
those to a **synchronous cross-task destructive fence** — amp off,
`i2s_channel_disable`, `i2s_del_channel` (deletion is the pin-ownership
boundary because mic and speaker share MCLK/BCLK/WS on the Stick), then
`M5.Mic.begin()` — bounded by a 1,000 ms acknowledgement timeout
(`m5sticks3_direct_audio.hpp:173`, `platforms/iterate_m5unified/m5unified.cpp:297-341`).
That fence blocks the main task for up to 1 s (firmware-audio.md smell 3).

### 1.2 What the prior art converges on

xiaozhi's `AudioCodec` is the model the review already endorsed (§5 table,
"xiaozhi's `AudioCodec` with `duplex()`/`input_reference()` properties is the
model"). The property set, verbatim from
`~/src/github.com/78/xiaozhi-esp32/main/audio/audio_codec.h:41-50`:

```cpp
inline bool duplex() const { return duplex_; }
inline bool input_reference() const { return input_reference_; }
inline int input_sample_rate() const { return input_sample_rate_; }
inline int output_sample_rate() const { return output_sample_rate_; }
inline int input_channels() const { return input_channels_; }
inline int output_channels() const { return output_channels_; }
```

with pure-virtual `Read(int16_t*, int)` / `Write(const int16_t*, int)`
(`audio_codec.h:68-69`), `EnableInput/EnableOutput` power gating, and DMA
geometry as constants (`AUDIO_CODEC_DMA_DESC_NUM 6` /
`AUDIO_CODEC_DMA_FRAME_NUM 240`, `audio_codec.h:15-16`). Seven codec
implementations cover every board in ~1,541 LOC total
(`main/audio/codecs/*.cc`: es8311 217, box = ES8311+ES7210 259, es8374 199,
es8388 229, es8389 231, raw-I2S/PDM `no_audio_codec` 386, dummy 20). That is
the economy we want: **a new board's audio cost is a ~200-line codec file**,
not a new pipeline.

Two things xiaozhi's shape gets _wrong for us_:

- Blocking `Read`/`Write` + `std::vector<int16_t>&` + FreeRTOS event groups in
  the base class — not sans-I/O, not allocation-free, not host-testable.
- Properties are instance fields set in constructors; we want them as const
  data in the device profile (§3) so host tests and the OS can read them
  without instantiating hardware.

esphome-audio-stack agrees on cadence but not on surface: no codec class;
one owner task where **blocking DMA owns the loop cadence** ("Do not append a
tick-based delay… vTaskDelay is not a cross-core clock",
`esphome-audio-stack/esphome/components/esp_audio_stack/audio_pipeline.cpp:917-919`),
and hardware variance is compiled out by YAML codegen
(`__init__.py:644-668` emits `MONO_RX`/`STEREO_REF`/`TDM_BUS`… defines).
ADF's lesson is "one task per clock domain, callbacks to fuse stages"
(espressif-prior-art.md §3.2).

### 1.3 Design options

**Option A — straight xiaozhi port: one blocking codec class per board.**
One audio task calls `read()` and `write()` blocking; codec owns I2S channels
and power gating.
_Pro:_ simplest mental model; prior art proven; cadence owned by DMA (review
R5). _Con:_ discards v1's descriptor-identity playback proofs (blocking
`write()` hides which physical descriptor got the frame — our underrun/
freshness policy and its 3,000 LOC of host tests are _built_ on descriptor
identity, `realtime_playback.hpp:47-60`); blocking calls are un-testable
sans-I/O without thread fakes; capture and playback forced into one task even
where profiles want them split. **Rejected as the portable contract** (fine as
an _internal_ idiom inside a platform impl).

**Option B — keep v1's three seams, just fix capture's task.**
Move the pump to the audio owner (R1) but keep `audio_hardware` +
`capture_driver` + Driver templates as separate contracts.
_Pro:_ minimal churn. _Con:_ leaves route policy smeared across
`m5unified.cpp` + `m5sticks3_direct_audio.cpp`; a new board must learn three
seams and their implicit sequencing contract; no properties struct means the
controller keeps deciding duplexness from the 2-value manifest enum; capture
stays a different idiom than playback. **Rejected** — this is exactly the
asymmetry the review graded ◑ (§5 "PCM physical in/out" row).

**Option C (recommended) — one nonblocking, event-drained
`iterate_kit_audio_codec` vtable; blocking allowed _inside_ platform impls.**
The portable contract is sans-I/O: ops never block, completion/capture events
are drained by the owning task from a bounded event view; a platform
implementation may internally run a blocking-DMA loop (esphome shape) or the
v1 ISR→SPSC shape and translate. Playback keeps descriptor tokens so
`RealtimePlayback` policy survives on top unchanged; capture becomes
symmetric (completed-frame events instead of `recorder.isRecording()` count
inference, `bounded_capture.hpp:86-118`).

### 1.4 Recommended header sketch

~150-line portable header, `components/audio/include/iterate/kit/audio_codec.h`
(new `components/audio` per review R3). Allocation-free, libc-only, C99.

```c
/* Static hardware truth. Const per board; lives in the device profile (§3).
 * This replaces the 2-value iterate_kit_audio_mode as the driver of policy:
 * PTT-vs-duplex is DERIVED (half_duplex ⇒ PTT-style routing), not declared. */
struct iterate_kit_audio_codec_properties {
  uint32_t input_sample_rate_hz;    /* native ADC/PDM rate (16000 on Stick) */
  uint32_t output_sample_rate_hz;   /* native DAC rate (48000 on HA VPE)    */
  uint8_t  input_channels;          /* mics + interleaved ref channels      */
  uint8_t  reference_channels;      /* 0 = no hardware AEC reference        */
  uint8_t  output_channels;         /* physical wire channels (Stick: 2)    */
  bool     duplex;                  /* capture+playback simultaneously OK   */
  bool     input_echo_cancelled;    /* upstream DSP (XMOS) already did AEC  */
  uint8_t  playback_descriptors;    /* DMA descriptor count (identity space)*/
  uint16_t frame_samples;           /* samples per frame per channel        */
  int16_t  output_gain_ceiling_centi_db; /* hardware/brownout ceiling       */
};

/* Routes are requests; application is asynchronous and acknowledged by an
 * event. A half-duplex codec refuses CAPTURE|PLAYBACK at init (compile-time
 * profile check) and internally guarantees the v1 fence contract when
 * switching: playback DMA stopped and every speaker buffer released before
 * capture starts (today's audio.h:31-34 contract, moved inside the impl). */
enum iterate_kit_audio_route {
  ITERATE_KIT_AUDIO_ROUTE_IDLE     = 0,
  ITERATE_KIT_AUDIO_ROUTE_CAPTURE  = 1u << 0,
  ITERATE_KIT_AUDIO_ROUTE_PLAYBACK = 1u << 1,
};

enum iterate_kit_audio_codec_event_type {
  /* One completed native-geometry capture frame is readable via read(). */
  ITERATE_KIT_AUDIO_CODEC_CAPTURE_FRAME_READY = 0,
  /* Physical playout of one descriptor finished; eof_us is the DMA EOF
   * timestamp in the codec's monotonic domain (v1's ISR timestamp). */
  ITERATE_KIT_AUDIO_CODEC_DESCRIPTOR_COMPLETED,
  /* A route request finished applying (or failed: status != OK). */
  ITERATE_KIT_AUDIO_CODEC_ROUTE_APPLIED,
  /* Driver-queue overflow / bus fault; generation must be poisoned. */
  ITERATE_KIT_AUDIO_CODEC_FAULT,
};

struct iterate_kit_audio_codec_event {
  uint8_t  type;                    /* iterate_kit_audio_codec_event_type   */
  uint8_t  descriptor;              /* DESCRIPTOR_COMPLETED only            */
  uint8_t  route;                   /* ROUTE_APPLIED only                   */
  int8_t   status;                  /* iterate_kit_status                   */
  uint64_t timestamp_us;            /* EOF / completion time, codec domain  */
};

/* All ops nonblocking; owner-task-only unless a fn documents otherwise.
 * ISR-side production (EOF timestamps, capture completion) is the platform's
 * private business — it surfaces only through next_event(). */
struct iterate_kit_audio_codec {
  void *context;
  const struct iterate_kit_audio_codec_properties *properties;

  /* Lifecycle */
  enum iterate_kit_status (*power)(void *context, bool enabled);
  enum iterate_kit_status (*request_route)(void *context, uint8_t route);

  /* Event drain: owner task pulls; returns UNAVAILABLE when empty. This is
   * the only cross-context surface (backed by a bounded SPSC internally). */
  enum iterate_kit_status (*next_event)(
      void *context, struct iterate_kit_audio_codec_event *event);

  /* Capture: copies exactly one completed frame (native geometry:
   * frame_samples × input_channels S16LE interleaved) into caller storage.
   * UNAVAILABLE when no completed frame. Never blocks. */
  enum iterate_kit_status (*read)(
      void *context, int16_t *samples, size_t capacity_samples,
      uint64_t *captured_at_us);

  /* Playback: descriptor-token writes preserve v1's identity-tested policy.
   * preload() before enable; write() targets the oldest completed
   * descriptor exactly as EspIdfDirectI2sBackend does today. */
  enum iterate_kit_status (*preload)(
      void *context, const int16_t *samples, size_t sample_count);
  enum iterate_kit_status (*write)(
      void *context, const int16_t *samples, size_t sample_count,
      uint8_t descriptor);

  /* Bounded runtime knobs (clamped to profile bounds; see §3). */
  enum iterate_kit_status (*set_output_gain_centi_db)(
      void *context, int16_t gain);
};
```

Notes on deliberate choices:

- **Descriptor tokens stay.** They are the reason v1's playback tests can
  assert "frame N landed in physical descriptor 2 after EOF of descriptor 2"
  instead of counting. `RealtimePlayback<…>` becomes a consumer of this vtable
  (its `Driver` template parameter) instead of the bespoke
  `DirectI2sStereoOutput`; mono→stereo expansion moves inside the codec impl
  where output_channels lives.
- **Capture is copy-out, not borrow.** v1's borrow-with-completion contract
  (`audio.h:43-48`, one frame in flight, `BoundedCapture`'s 4-state ledger)
  exists to avoid one 640-byte copy; it costs a cross-module sequencing
  contract that `bounded_capture.hpp:64-84` has to defend with STATE_ERRORs.
  640 B × 50 Hz = 32 KB/s of memcpy ≈ negligible on a 240 MHz S3; buy the
  simplicity. (Road not taken: zero-copy slot lending — revisit only if a
  profile needs >48 kHz multi-channel capture, where the copy is 6× bigger.)
- **No `send_pcm` in the codec.** v1's `iterate_kit_audio_egress`
  (`audio.h:49-60`) conflates "hardware produced a frame" with "ship it to the
  lane". In v2 the audio owner task reads codec frames, pushes them through
  the `audio_processor` seam (review R2), and submits to the uplink lane —
  egress is the pipeline's business, not the codec's.
- **Events, not callbacks.** Matches v1's ISR→SPSC→owner-notify idiom and
  esphome's "data _and_ lifecycle are events" rule
  (`esp_afe.cpp:1902-1938`); makes the scripted host codec trivial (§1.6).
- **`input_echo_cancelled` is a first-class property** because the HA Voice PE
  makes it real hardware truth (§1.5) — it selects the _null_ processor even
  in full-duplex mode, something neither xiaozhi (`input_reference` only) nor
  v1 (mode enum) can express.

### 1.5 The five implementations

| Board                                   | Capture path                                                                                                                                                                    | Playback path                                                                                                                                                                                                       | properties                                                                                                                                                                                            | Fence?                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M5StickS3**                           | PDM mic on I2S1 (today via M5Unified legacy recorder; v2: `esp_driver_i2s` PDM RX channel per R1 — legacy driver carries a deprecation `#warning`, espressif-prior-art.md §4.1) | ES8311 DAC + amp, I2S0 STD TX, 4×1280 B descriptors (`m5sticks3_direct_audio.hpp:33-37`)                                                                                                                            | 16 k in / 16 k out, 1 in-ch, 0 ref, `duplex=false`                                                                                                                                                    | **Yes** — mic and speaker share MCLK/BCLK/WS on the same controller; PDM RX cannot share a duplex clock with STD TX anyway (esp-idf `i2s.rst:905`). `request_route(CAPTURE)` internally = amp off → `i2s_channel_disable` → `i2s_del_channel` → PDM RX up, then `ROUTE_APPLIED`. AEC structurally impossible → server-side timestamp echo (review §4.6). |
| **StackChan (ES8311-class)**            | ES8311 mono ADC, same I2S controller as TX, shared clocks                                                                                                                       | ES8311 DAC                                                                                                                                                                                                          | 16 k/16 k, 1 in-ch, 0 hardware ref (software TX tap per R11; if board wiring exposes a digital loopback slot, `reference_channels=1` and the tap is deleted), `duplex=true`                           | No fence; `request_route` toggles ADC/DAC power gates only. xiaozhi's `es8311_audio_codec.cc` (217 LOC) is the reference implementation shape.                                                                                                                                                                                                           |
| **HA Voice PE**                         | Dual MEMS mics → **XMOS XU316** (AEC + stationary-noise removal + AGC + beamforming in hardware) → I2S to ESP32-S3; hardware mute switch physically cuts mic power              | I2S out → TI AIC3204 DAC (48 kHz) → speaker / 3.5 mm jack ([home-assistant.io/voice-pe](https://www.home-assistant.io/voice-pe/))                                                                                   | in: 16 k processed (verify at bring-up against `esphome/home-assistant-voice-pe` YAML), out: **48 k** ⇒ output-side resample or 48 k pipeline tail; `duplex=true`, `input_echo_cancelled=true`, 0 ref | No fence. The codec impl must also surface **mute-switch state as a device event** (it is a capture-hardware truth: reads return silence/UNAVAILABLE while muted — fail-closed, never stale audio). Custom Iterate firmware, _not_ an ESPHome wrapper (`tasks/esphome-iterate-device-adapter.md:14-16`).                                                 |
| **Waveshare ESP32-S3-Touch-AMOLED-1.8** | ES8311 codec + onboard analog SMD mic ([waveshare wiki](https://www.waveshare.com/wiki/ESP32-S3-Touch-AMOLED-1.8))                                                              | ES8311 DAC + onboard speaker                                                                                                                                                                                        | ES8311-class ⇒ same impl as StackChan with different pins/gain ceiling — **this is the payoff test for the seam: Waveshare audio should be a profile + pin table, ~0 new codec LOC**                  | No fence                                                                                                                                                                                                                                                                                                                                                 |
| **Host simulator**                      | Scripted: `__test.submitCapture` enqueues a frame → `CAPTURE_FRAME_READY` (today's injection point, `simulator/devices/m5sticks3.cpp:159,241-259`)                              | Scripted descriptor ring on the virtual clock; test controls when `DESCRIPTOR_COMPLETED` fires (today's "withhold completion" egress trick, `simulator/devices/m5sticks3.cpp:53-60`, becomes a codec-level control) | per scenario                                                                                                                                                                                          | Scriptable — lets host tests exercise the fence _state machine_ (route-pending reads rejected, flush-before-capture ordering) which today only runs on the physical device                                                                                                                                                                               |

The simulator entry is the big testability win: v1's simulator deliberately
refuses audio timing ("deliberately does not synthesize sound or imitate
I2S/DMA/FreeRTOS/WebSocket buffering", `simulator/devices/m5sticks3.cpp:10-23`);
a scripted codec keeps that honesty (no acoustics claims) while making
route/fence/descriptor policy host-coverable.

### 1.6 Where the half-duplex fence lives (the precise answer)

Three layers, one owner each:

1. **Policy — portable audio controller** (survives from `audio.c`): decides
   _when_ to switch (PTT pressed ⇒ interrupt playback, request CAPTURE;
   released ⇒ request PLAYBACK). Purely a state machine over codec events;
   host-tested. It no longer knows _how_ switching works — the
   `stop_playback/flush_playback/start_capture` triplet and its ordering
   comment (`audio.h:31-41`) are deleted from the portable surface.
2. **Mechanism — codec implementation**: the Stick codec owns the
   amp-off → channel-delete → mic-up sequence and executes it **on the audio
   owner task** (where the I2S lifecycle already lives, prio 19 core 1,
   `m5sticks3_direct_audio.hpp:171-172`), emitting `ROUTE_APPLIED` when done.
   Because request/apply is asynchronous, the 1 s synchronous main-task fence
   (`m5sticks3_direct_audio.hpp:173` + firmware-audio.md smell 3) disappears:
   button-to-capture latency becomes a measured event interval, not a blocking
   call.
3. **Guarantee — profile data**: `duplex=false` in the properties struct makes
   `request_route(CAPTURE|PLAYBACK)` an init-time rejection, so no caller can
   even ask for the illegal state.

### 1.7 Relationship to the audio_processor seam (R2)

The codec vtable is _below_ the processor seam. Owner-task frame loop:

```
codec.read(native frame) ──▶ processor.process(mic, ref, out) ──▶ uplink lane
                              ▲ ref = hardware channels (reference_channels>0)
                              │       or software TX tap ring (R11)
codec.write(descriptor) ◀── RealtimePlayback policy ◀── downlink lane
        │
        └──▶ TX tap → ref ring (complete frames only, reset on session edges)
```

Processor selection is profile data: Stick/Waveshare/simulator → null
processor; StackChan → `esp_sr` FD_LOW_COST AEC + WebRTC VAD (31 KB internal /
90 KB PSRAM / 19.6 % core, espressif-prior-art.md §2.3); HA VPE → null
processor _because_ `input_echo_cancelled=true`. The fail-closed rule imports
verbatim: configured-but-unavailable processor ⇒ silence, never raw mic
(`esphome-audio-stack/esp_afe.cpp:1612-1615`).

---

## 2. (b) Device I/O modules: producers, consumers, and what survives verbatim

### 2.1 The shape v1 already has (correct — keep it)

Two directions, two idioms, both already in v1:

**Outputs (core → hardware): synchronous driver vtables + thin RPC modules.**
Every output peripheral is a caller-owned C vtable with a borrowed context and
synchronous, allocation-free calls on the owner task; the generic capability
module does _all_ RPC validation before the driver sees anything:

- LEDs: `set(index,r,g,b)` + `fill(r,g,b)`, count-checked at init
  (`components/capabilities/include/iterate/kit/capabilities/leds.h:20-36`);
- Servos: `move(yaw,pitch,speed)` validated against a per-device limits
  snapshot frozen at init — "Limits belong to the device profile rather than
  this library: geometry and safe pulse ranges are hardware facts"
  (`servos.h:18-41`);
- Screen: `render_png(url,len)` over caller-owned URL scratch
  (`screen.h:22-37`);
- Camera: `take_photo()` with an explicit ownership-transferring release hook
  and a profile-chosen `maximum_photo_bytes` (`camera.h:14-51`);
- Metrics: `sample()` driver + subscription scheduler (`metrics.h:284,322`).

The modules over these are 78–127 LOC each (`leds.c` 127, `servos.c` 90,
`camera.c` 92, `screen.c` 78 per firmware-core.md §1c) and shared by every
board. **Survives verbatim.** The only planned change is orthogonal: the
metrics _schema_ single-sourcing (R7) — the driver-vtable mechanism is
untouched.

**Inputs (hardware → core): producers publish events; nobody polls drivers.**
There is deliberately no "button driver vtable". Platforms observe hardware
(today: `M5.BtnA` polled + coalesced,
`platforms/iterate_m5unified/include/iterate/kit/platforms/m5unified.hpp:62-70`)
and _publish_ into the single-task bounded event queue
(`components/core/include/iterate/kit/device_events.h:75-97`: not ISR-safe by
contract, power-of-two capacity, per-poll work budget). Remote RPC edges enter
the _same_ queue via the `push_to_talk` module ("publishes into the shared
`device_events` queue rather than calling audio directly, so remote and
physical edges share one total order", `push_to_talk.c:7-13` per
firmware-core.md), the device handler drives the audio controller, and an
observer mirrors every edge into the Cap'n Web event stream
(`devices/m5sticks3/m5sticks3.c:41-87`). This one-total-order property is the
foundation for requirement 8 (devices as streams). **Survives verbatim.**

### 2.2 What changes: the event vocabulary, not the queue

Today's event space is exactly PTT start/stop with a 2-byte stored
representation (`device_events.h:14-34`). The four boards need more
producers:

| Board     | New producers                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| M5StickS3 | BtnA (exists), BtnB/power events                                                                                                    |
| StackChan | touch, buttons                                                                                                                      |
| HA VPE    | multipurpose button, **rotary dial** (relative ticks), **hardware mute switch** (also a codec-capture truth, §1.5), Grove-port GPIO |
| Waveshare | touch panel, IMU wake/gesture (QMI8658 on board), power button                                                                      |

Design choice, aligned with brief req 8 ("on-device data structure … events
shaped like that with path, type, payload"):

- **Stored representation stays compact** (grow the entry to ~8 bytes:
  `type:u8, source:u8, payload:i16/u16×2, seq implicit`) — the queue's
  bounded, single-task, no-lock properties are worth more than in-queue JSON.
- **One name/schema table maps compact events to stream-shaped events**
  (`{path, type, payload}`) at the _edges_: the Cap'n Web event-stream module,
  the future SD logger (brief req 5), and the /pcm cross-posting all serialize
  from the same table — the same single-sourcing move as metrics R7. The table
  is per-board data referenced from the profile (§3), so a board with a dial
  has `dial-turned` events and a board without one simply has no such row —
  no synthetic union of all possible inputs.
- **Add one ISR-marshalling helper** (platform layer): a tiny ISR-safe SPSC of
  raw edges drained by the owner task into `device_event_publish` — the
  marshalling that `device_events.h:81-85` already demands platforms do,
  provided once instead of reinvented per board. (The dial on HA VPE is the
  first consumer that genuinely needs edge capture faster than a 10 ms poll.)

### 2.3 Renderers consume the renderer-input structure

The goal doc pins this (`physical-device-voice-goal.md:219-236`): one
normalized structure — idle/listening/thinking/speaking state, audio
energy/envelope, viseme output (both StackChan candidate algorithms), future
stage directions, timing/confidence — produced by pluggable analysers,
consumed by pluggable renderers ("sprite renderers now, procedural renderers
later, and non-screen renderers such as the Home Assistant Voice Preview
Edition light ring"). Sketch:

```c
struct iterate_kit_renderer_input {
  uint8_t  agent_state;        /* idle/listening/thinking/speaking */
  uint8_t  viseme;             /* current viseme id, 0 = none      */
  uint8_t  viseme_confidence;  /* 0..255                            */
  uint8_t  stage_direction;    /* 0 = none; future vocabulary       */
  uint16_t energy_q10;         /* envelope, Q10 fixed point         */
  uint16_t transition_ms;      /* hint for coherent animation       */
  uint64_t valid_at_us;        /* timing base, device monotonic     */
};

/* Output-side vtable, same idiom as leds/servos: synchronous, owner-task,
 * allocation-free. One per board; a board may register several. */
struct iterate_kit_renderer_driver {
  void *context;
  enum iterate_kit_status (*render)(
      void *context, const struct iterate_kit_renderer_input *input);
};
```

Instances: StackChan sprite renderer (LCD), Stick status-screen renderer,
HA VPE **LED-ring renderer** (multicolored ring; LED count TBV at bring-up),
Waveshare AMOLED renderer. The _analyser_ side hangs off the audio-processor
seam as a non-realtime second consumer (review §5 "PCM → viseme" row:
"never as an inline stage of the realtime path"); "listening must be visibly
immediate" means `agent_state` transitions are driven by the _local_ device
event queue (PTT/VAD edges), not by server round-trips
(`physical-device-voice-goal.md:547`).

The existing `screen.render_png` capability stays as-is next to this —
renderers are a _local_ consumer loop; `renderOnScreen(url)` is a remote RPC.
Boards with both arbitrate at the composition root (e.g., remote PNG
suppresses avatar until a timeout — policy, per-board).

### 2.4 Capability RPC modules stay thin — the "survives verbatim" list

| Survives byte-for-byte (mechanism)                                 | Why                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leds/servos/screen/camera` driver vtables + modules               | already the right cut; validated-RPC-over-synchronous-vtable is exactly what a new board wants to reuse                                                                                              |
| `callback_budget` (shared in-flight ceiling, `callback_budget.h`)  | cross-module concurrency bound derived from the control-ring proof (`m5sticks3.h:46-50`)                                                                                                             |
| `device_event_queue` + `push_to_talk` module + event-stream module | one total order for physical/remote edges; coalescing overflow policy (`device_event_stream.c:90-108` per firmware-core.md)                                                                          |
| `peer` flat module table + `invokeCapability` envelope unwrap      | "modules themselves publish the desired method paths … building a heap capability tree per device would duplicate routing state" (`m5sticks3.c:166-171`) — this _is_ the no-synthetic-tree mechanism |
| `rpc_internal` status→RPC-error mapping                            | uniform "hardware rejected the arguments" vocabulary                                                                                                                                                 |
| Composition-root pattern (`devices/<board>.c`, 284/131 LOC)        | explicit wiring beats a registration framework; see §3.4                                                                                                                                             |

Changes are all subtractions/single-sourcing, not redesigns: metrics schema
X-macro (R7), event name table (§2.2), argument-strictness normalization
(firmware-core.md smell 8).

---

## 3. (c) Device profile as data

### 3.1 Today's scatter (the problem, precisely)

The same board's "configuration" currently lives in seven places:

| What                                                                                       | Where today                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Playback policy numbers (max frame age 200 ms, prebuffer timeout 200 ms, refill lead 2 ms) | template arguments `RealtimePlayback<320,16000,4,200,200,2000>` (`m5sticks3_direct_audio.hpp:103-110`)                                |
| DMA geometry (4×1280 B), frame duration                                                    | `M5StickS3DirectI2sOps` class constants (`m5sticks3_direct_audio.hpp:33-37`)                                                          |
| Lane capacities (32×648 B / 32×656 B = 640 ms each way)                                    | target literals (`main.cpp:152-159` per firmware-audio.md §1)                                                                         |
| Freshness/network policy (capture age 250 ms, barrier 40 ms, 8-frame unconfirmed)          | platform header with compile-time proofs (`platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_websocket_policy.h:36-63`) |
| Gain ceiling (−18 dB ES8311 brownout fix)                                                  | hardcoded register write in a `.cpp` (`m5sticks3_direct_audio.cpp:37-42`)                                                             |
| Mic warmup discard (1 frame), capture buffers (2)                                          | `m5unified.hpp:111`, `bounded_capture.hpp:47`                                                                                         |
| Module count, events-per-poll, callback budget                                             | device header enums (`m5sticks3.h:22-23`) + options field (`m5sticks3.h:46-50`)                                                       |
| Task cores/priorities/stacks                                                               | scattered class constants (`m5sticks3_direct_audio.hpp:171-174`) + policy header (`esp_idf_websocket_policy.h:36-52`)                 |

Every knob is a recompile (review §4.4); a second board re-derives
relationships (e.g. PCM-prio = control-prio + 1) instead of instantiating
them. Meanwhile the goal doc _requires_ knobs-as-data with defaults, bounds,
and metrics (`physical-device-voice-goal.md:196-199`), and esphome-audio-stack
demonstrates the endpoint: every core/priority/stack/duration/placement is
YAML config (esphome-intercom.md §5).

### 3.2 The two-tier design

The tension: v1's compile-time constants are what make RAM provable
(`sizeof(Runtime)` logged at boot as a regression bridge, `main.cpp:1173-1196`
per firmware-core.md §5) — a runtime struct cannot size a static array. So:
**split by whether the value sizes storage.**

**Tier 1 — geometry (compile-time, one header per board).**
`devices/<board>/include/iterate/kit/devices/<board>_profile.h` holds _all_
storage-sizing constants, consumed by both the C++ templates and the Tier-2
struct initializer:

```c
/* m5sticks3_profile.h — the ONLY place these numbers exist. */
#define M5STICKS3_FRAME_SAMPLES            320u
#define M5STICKS3_SAMPLE_RATE_HZ         16000u
#define M5STICKS3_PLAYBACK_DESCRIPTORS       4u
#define M5STICKS3_CAPTURE_BUFFERS            2u
#define M5STICKS3_UPLINK_RING_FRAMES        32u
#define M5STICKS3_DOWNLINK_RING_FRAMES      32u
#define M5STICKS3_EVENT_QUEUE_CAPACITY       8u
#define M5STICKS3_MODULE_COUNT               5u
#define M5STICKS3_METRIC_SUBSCRIPTIONS       2u
```

**Tier 2 — policy (const struct instance, compile-time defaulted).**

```c
struct iterate_kit_device_profile {
  const char *slug;                 /* "m5sticks3" — replaces manifest    */
  const char *display_name;

  struct iterate_kit_audio_codec_properties codec;   /* §1.4              */

  struct {                          /* freshness / realtime policy        */
    uint16_t max_playback_frame_age_ms;      /* 200                       */
    uint16_t partial_prebuffer_timeout_ms;   /* 200                       */
    uint16_t minimum_refill_lead_us;         /* 2000                      */
    uint16_t max_capture_age_ms;             /* 250                       */
    uint16_t peer_barrier_interval_frames;   /* 4                         */
    uint16_t peer_unconfirmed_ceiling_frames;/* 8                         */
    uint8_t  mic_warmup_discard_frames;      /* 1                         */
  } audio_policy;

  struct {                          /* per-task placement                 */
    struct iterate_kit_task_spec audio;      /* {core 1, prio 19, 8192}   */
    struct iterate_kit_task_spec control_net;/* {core 0, prio  5, 8192}   */
    struct iterate_kit_task_spec pcm_net;    /* {core 0, prio  6, 8192}   */
  } tasks;

  struct {                          /* feature flags — capability truth   */
    bool has_sd;                    /* req 5: SD log sink                 */
    bool has_display;
    bool has_camera;
    bool has_servos;
    bool has_touch;
    bool has_dial;
    bool has_hardware_mute;
    uint8_t led_count;              /* 0 = no LEDs                        */
  } features;

  /* Stream-shaped event name table for this board's producers (§2.2). */
  const struct iterate_kit_device_event_schema *event_schema;
  size_t event_schema_count;

  /* Bounds for the provisioning-overridable subset (§3.3): each override
   * is clamped here; out-of-range provisioning is a classified boot
   * diagnostic, never a silent clamp-to-weird. */
  struct iterate_kit_profile_bounds bounds;
};

extern const struct iterate_kit_device_profile iterate_kit_m5sticks3_profile;
```

Compile-time ordering proofs move with the values: the negative-array-size
assertions in `esp_idf_websocket_policy.h:66-109` become `_Static_assert`s
against the profile initializer in the board's profile.c — same proofs,
board-scoped, and the "portable-policy-in-a-platform-header" wart (review §5
last row) dies.

**Reporting**: the whole Tier-2 struct is serialized once per session through
the metrics capability (R6c) so every physical run records the knob values it
ran with — the schema table from R7 covers it for free.

### 3.3 Provisioning-overridable subset

Extend the `ITERKIT1` TLV image (portable decoder,
`components/core/src/configuration.c` — magic/version/CRC32, all-or-nothing
zeroing per firmware-core.md §5) with optional tags for exactly the knobs that
are safe to vary without re-proving memory: freshness windows, prebuffer
timeout, gain (≤ profile ceiling), mic warmup frames, metrics intervals,
log-to-SD enable. Rules:

- Absent tag ⇒ compiled default (today's behavior byte-for-byte).
- Present tag ⇒ clamped against `profile.bounds`; out-of-bounds ⇒ boot
  diagnostic + default (fail-loud, not fail-weird).
- Never overridable: anything Tier-1 (ring sizes, descriptor counts, task
  stacks), sample rates, wire constants.

Options considered for the override channel: (i) provisioning TLV only
(recommended first — flasher already exists, host-testable decoder);
(ii) + a `setTuning` capability method for live experimentation (defer:
requires the drain-handshake discipline of esphome's reconfig path,
`esp_afe.cpp:1662-1743`, for anything the audio task snapshots — adopt the
snapshot pattern first, then this becomes cheap); (iii) NVS — rejected, second
storage mechanism for the same data.

### 3.4 "Configurable so you can add more permissive" — variants as module tables

The goal doc's model ("expose the functions that make sense … no generated
universal hierarchy", `physical-device-voice-goal.md:90-95`) is already
implemented by v1's composition roots: a board is a fixed array of
`iterate_kit_module` (`m5sticks3.c:158-176`), each module publishing its own
method paths into one flat peer table, plus a hand-written `__describe` JSON
(`m5sticks3.c:18-33`). StackChan proves the reuse: same five generic modules,
different selection (screen/servos/leds/camera/metrics vs
events/metrics/screen/ptt/audio), zero copied logic
(`devices/stackchan/include/iterate/kit/devices/stackchan.h:17-52`).

v2 keeps this and makes three cheap improvements:

1. **Board-specific modules are first-class.** A "more permissive" build =
   append modules to the table: e.g. a `sdcard` module (`listLogs`,
   `readLog(range)`) only on `has_sd` boards; a `dial` event vocabulary only
   on HA VPE; a debug/`__test` module only in bench builds (the simulator
   already models this pattern with its private `__test` namespace,
   `simulator/devices/stackchan.cpp:176-201`). Nothing in core enumerates
   possible modules — the table is open.
2. **Description assembled from module fragments.** Each
   `iterate_kit_module` gains an optional `const char *describe_fragment`;
   the composition root concatenates into caller-owned scratch at init.
   Kills the hand-maintained 15-line JSON string per board; keeps zero
   allocation. (~60 LOC in `peer.c`, one test.)
3. **Composition roots stay hand-written.** Options considered:
   - _(chosen)_ hand-written `devices/<board>.c` (~130–280 LOC each): explicit,
     reviewable, matches "conventions over frameworks"; the duplication is the
     transactional-init ladder (`m5sticks3.c:112-150`), worth a tiny
     `INIT_OR_FAIL(expr)` local macro at most.
   - X-macro board manifest generating options + init: saves ~80 LOC/board,
     costs a mini-DSL every reader must learn — rejected (this is exactly the
     "spec-object" shape the working preferences reject).
   - Runtime builder/registry (`device_add_module()`): invites dynamic
     composition we then have to bound and test; the fixed table already
     fixes dispatch RAM at compile time (`m5sticks3.h:16-24`) — rejected.

### 3.5 What the manifest becomes

`iterate_kit_device_manifest` (slug/display-name/audio_mode, `device.h:11-15`)
dissolves into the profile struct; `device.h` drops its `audio.h` include
(today the type-erased device concept drags the audio mode enum everywhere —
firmware-core.md §2 flags this), which is also what makes the control-only
ESPHome link set clean (§5).

---

## 4. LOC / RAM / effort accounting

Present base (from `wc -l`, this tree): capability modules + headers ≈ 2.6 k
LOC shared across boards; per-board cost today = composition root (284 LOC
Stick / 131 StackChan) + platform audio (Stick: 802 + 368 + 254 + 143 LOC
m5unified/direct-audio) + target main.cpp (1,349). Playback templates 1,863 +
710 + backend; bounded_capture 258.

Estimated v2 deltas for this topic:

| Piece                                                          | New LOC (est)                 | Deleted/moved LOC (est)                                                                                              |
| -------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `audio_codec.h` + controller rework                            | ~150 header + ~250 controller | `audio.h` hardware/egress/capture vtables (~90), `bounded_capture.hpp` ledger (258 → absorbed into Stick codec impl) |
| Stick codec impl (wraps existing I2sOps/BoardOps + new PDM RX) | ~300                          | fence code consolidated out of `m5unified.cpp` (~150)                                                                |
| ES8311 codec impl (StackChan + Waveshare shared)               | ~250 (xiaozhi's is 217)       | —                                                                                                                    |
| HA VPE codec impl                                              | ~200                          | —                                                                                                                    |
| Scripted host codec                                            | ~150                          | simulator egress-withholding hacks (~60)                                                                             |
| Profile structs + per-board profile.c ×4                       | ~120 each                     | scattered constants (net ≈ 0; they move)                                                                             |
| Event schema table + ISR marshaller                            | ~150                          | —                                                                                                                    |
| Renderer input + 2 renderers (Stick status, StackChan sprite)  | ~400                          | —                                                                                                                    |

RAM: unchanged by design — the codec vtable's event ring is the existing
4-slot completion SPSC generalized (+~64 B/board); profile struct ~200 B
const/flash. The AEC future stays budgeted separately (60–90 KB internal +
0.09–0.78 MB PSRAM + ~20 % core when StackChan lands, review §4.5; IRAM is
16,383/16,384 B used — R4 must precede any codec-ISR growth).

---

## 5. (d) ESPHome adapter positioning — what the shared core must not assume

Source: `tasks/esphome-iterate-device-adapter.md` (status **deferred**, low
priority). Strategic order is settled there: HA integration first; selected
hardware (incl. HA VPE) gets purpose-built Iterate firmware; the ESPHome
external component is only for devices whose existing ESPHome
firmware/OTA/entities are worth preserving (`:10-44`). First scope is
control-plane only — "Rich media such as continuous audio is outside this
adapter's first scope … Purpose-built Iterate firmware should own voice"
(`:174-178`).

What that demands of v2's portable core (checked against today's reality):

| Requirement                                                                                                           | Status today                                                                                                                                        | v2 action                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No task ownership in portable layers** — the adapter ticks from ESPHome's `loop()` (~16 ms cadence, must not block) | ✅ already true: tasks exist only in `platforms/` and `targets/`; every portable module is poll-driven with injected `now_ms` (`m5sticks3.h:91-95`) | keep as an architecture test invariant; the codec vtable (§1.4) is likewise nonblocking so a `loop()`-driven host is legal                                                                                           |
| **No Wi-Fi/NVS ownership** — "ESPHome owns both configuration generation and network lifecycle" (`:220-222`)          | ❌ `itx_transport.c` bundles Wi-Fi bring-up/NVS/netif with the scheduler (`itx_transport.c:1010-1164` per firmware-core.md §1e)                     | R13's Wi-Fi-station extraction is a _prerequisite_, not hygiene: transport = socket scheduler; station manager = separate, optional module                                                                           |
| **No config-partition assumption** — YAML/codegen supplies base_url/project/path (`:60-65,220-222`)                   | ◑ decoder is portable and injectable; the _target_ reads the partition                                                                              | keep configuration a caller-supplied struct; partition reading stays in `platforms/iterate_esp_idf/configuration.c`                                                                                                  |
| **Control-only link set** (no PCM lane, no audio)                                                                     | ❌ `components/core` physically contains the PCM lane; `device.h` includes `audio.h`                                                                | R3 split (`core` vs `audio` components) + §3.5 manifest change make "control stack without audio lane" a real build — the review already wants this for Waveshare/HA-VPE bring-up too (§5 "Target component layout") |
| **Bounded buffers audited against ESPHome entity descriptions** (`:224-227`)                                          | 2 KiB control message capacity etc.                                                                                                                 | profile-as-data (§3) makes these per-host numbers instead of Stick-derived constants                                                                                                                                 |
| **Transport injectable** (ESPHome-owned socket, possibly its TLS)                                                     | ◑ sans-I/O `websocket_tx/rx/text` are transport-free; the taskless `websocket_connection.c` presumes `esp_transport`                                | acceptable: the adapter can reuse `websocket_connection` (ESP-IDF is the supported first platform, `:79-80`) or drive tx/rx over ESPHome sockets; no core change needed                                              |

Positioning verdict for the v2 plan: **design for the adapter, don't build
it.** The two structural moves it needs (R3 split, R13 extraction) are already
justified on their own; everything else is "don't regress the sans-I/O
discipline". Revisit after the HA integration validates the device-stream
model (`:41-44`).

---

## 6. (e) The not-doing list

- **No runtime-loadable drivers.** No dlopen-oid, no registry populated at
  runtime, no driver discovery. All vtables are wired at init by the
  composition root from link-time symbols; the module table is fixed-size
  (`m5sticks3.h:16-24` rationale stands). One firmware artifact per board
  (`physical-device-voice-goal.md:82` — reproducible artifact per
  board/version) — therefore also **no runtime board detection / universal
  binary**.
- **No C++ inheritance in the portable layer.** The seams are C structs of
  function pointers with borrowed contexts (exactly v1's idiom). C++ stays in
  `platforms/` as templates/classes implementing those vtables
  (`RealtimePlayback` et al.), never crossing into `components/`. xiaozhi's
  `Board`/`AudioCodec` class hierarchy and `DECLARE_BOARD` singleton macro
  (`board.h:87-90`) are the _pattern source_, not code to port.
- **No universal HAL.** We abstract only what we test through: audio codec,
  output-driver vtables, event publication, clock, transport. No generic
  GPIO/I2C/SPI wrapper — codec and driver impls call ESP-IDF directly.
- **No synthetic capability tree / no universal device schema.** Settled in
  the goal doc (`:90-95`); the flat module table with self-published paths is
  the mechanism.
- **No ADF element framework, no ESPHome codegen in our core, no xiaozhi
  class graph** (review "Explicitly not recommended"). We take seam placement
  and scheduling/backpressure policies; the machinery stays theirs. Their
  compile-out-unused-paths idea survives in spirit as per-board CMake source
  selection, not as a codegen system.
- **No seekaudio blob** (eval-only, esp-sr-pinned, host-untestable —
  espressif-prior-art.md §5); its MIT AECMOS/ERLE harness methodology is the
  only take.
- **No hot-reconfigurable geometry.** Ring sizes, descriptor counts, task
  stacks never change at runtime; only the clamped Tier-2 subset is
  provisioning-overridable. No `setTuning` RPC in v2.0 (§3.3).
- **No zero-copy capture lending** in the codec contract (§1.4 tradeoff) and
  **no per-stage ringbuffer chains** between codec/processor/lane — one
  buffering boundary per direction stays law (`pcm_lane.c:6-17` doctrine).
- **No Opus** (review "not recommended"; wire v1 frozen by the brief).

---

## 7. Open questions to put to Jonas (high-order)

1. **Codec contract blocking-ness**: §1.3 recommends nonblocking+events to
   keep sans-I/O testability and descriptor identity; the cost is that each
   platform impl internally re-creates a blocking loop the esphome way. Is
   host-testability of route/descriptor policy worth that extra platform
   layer on boards (ES8311-class) where a plain blocking loop would be ~100
   LOC simpler? (My answer: yes — the simulator codec and fence tests repay
   it — but it is a real 2×.)
2. **How much becomes provisioning-overridable in v2.0** (§3.3): the minimal
   set (gain, freshness, warmup, intervals, SD enable) or nothing until a
   physical need shows up? Overrides cost a TLV version bump + flasher work.
3. **Renderer arbitration** between `renderOnScreen(url)` and the local
   avatar loop (§2.3) — per-board policy or a shared convention?
4. **Event payload width** (§2.2): 8-byte compact entries cover
   dial-ticks/touch coords; is that enough headroom for stage-direction-like
   events, or should the queue admit a second, wider event class now?
