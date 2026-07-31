# Candidate B — the audio-pipeline-purist architecture

Status: exploration-round candidate design, 2026-07-31. One of three independent
v2 candidates. All file:line references are from the current `c-capabilities`
working tree unless prefixed with a prior-art path under `~/src/github.com/`.
Companion inputs: `../inputs/brief.md`,
`../../fable-firmware-architecture-review-2026-07-31.md` (R1–R13), the seven
exploration artifacts in this folder, and the six deep-reads in
`../inputs/agent-reports/`.

## 0. The bet, stated plainly

**The product is voice. The architecture should look like the product.**

v1 is organized around _transport_ (a portable control core that happens to
contain a PCM lane); the prior art that actually ships full-duplex voice under
load — xiaozhi, esphome-audio-stack, ADF — is unanimously organized around the
_audio dataflow_: one codec seam at the bottom, one processor seam in the
middle, one owning task per clock domain whose cadence is the DMA itself, and
every listening shape (PTT, auto-stop, continuous duplex, future wake) as a
_mode of one pipeline_, never a second design. Candidate B commits to that
organization:

1. **Center**: `components/audio` is the first-class component. It contains a
   C translation of xiaozhi's `AudioCodec`
   (`~/src/github.com/78/xiaozhi-esp32/main/audio/audio_codec.h:41-69`) as the
   hardware seam, a C translation of esphome-audio-stack's `AudioProcessor`
   (`~/src/github.com/n-IA-hane/esphome-audio-stack/esphome/components/esp_audio_stack/audio_core_processor.h:66-118`)
   as the DSP seam, and ONE pipeline state machine whose modes are xiaozhi's
   three listening modes translated verbatim
   (`~/src/github.com/78/xiaozhi-esp32/main/protocols/protocol.h:35-39`:
   `kListeningModeAutoStop`, `kListeningModeManualStop`,
   `kListeningModeRealtime`).
2. **Cadence is owned by DMA, everywhere.** No tick polls survive. The one
   deliberate impurity: the codec contract has a _blocking beat call_ executed
   only on the audio owner task — because "RX/TX cadence is owned by the
   blocking codec/I2S DMA operations… vTaskDelay is not a cross-core clock"
   (`esphome-audio-stack/…/audio_pipeline.cpp:917-919`) is the one lesson every
   studied project paid for independently.
3. **Analysers (viseme/energy/renderer input) are second consumers of the
   processed tap**, fed from completed playout/capture frames inside the audio
   task exactly as stackchan proved
   (`~/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec/firmware-ws/main/audio_pipeline.c:710-716`),
   published through a seqlock, never on the render task's clock.
4. **Events (req 8) are a normal bounded module** — a 64-slot interned-envelope
   ring with per-sink cursors feeding capnweb/SD/console sinks. It is
   deliberately NOT the organizing principle: no dispatch rides it, no module
   communicates through it, metrics samplers stay samplers. It is periphery,
   and this document is honest below (§9) about what that costs.
5. **Steal aggressively and verbatim.** Every load-bearing pattern below has a
   named prior-art source with file:line provenance, and several files port
   with only renames (stackchan's analyser vtable, pose, 40-byte render key,
   spectral driver; xiaozhi's BinaryProtocol2 header layout).

### 0.1 Squaring the bet with the late addendum

Jonas's addendum (brief `inputs/brief.md:9-34`) makes audio-less devices
(e-ink + buttons, mic-only, speaker-only) first-class and explicitly names
candidate B's organization as a risk. Candidate B's answer is _containment,
not retreat_:

- The audio pipeline is the organizing principle **of `components/audio`**,
  not of the firmware. `components/core` (Cap'n Web, itx mount, websocket
  framing, configuration, intent queue), `components/events`, and
  `components/capabilities` form a complete, linkable, testable device with
  zero audio symbols. The R3 split (`review §6 R3`) is a prerequisite land
  here, and the negative link test ("core-only executable links with no audio
  object files") is CI from day one.
- An e-ink+buttons board is: `core` + `events` + `capabilities` + a
  composition root + a platform transport. Its build never mentions
  `iterate_kit_audio_*`. Its rig scenario has no acoustics.
- What candidate B does NOT do is redesign the periphery to be as elegant as
  the pipeline. The control plane keeps v1's shapes nearly verbatim (they are
  good), and the honest consequence — the periphery gets less new design
  attention than the center — is catalogued in §9.1.

Where audio IS present, the addendum's second half ("it MUST be realtime,
resilient, not delayed, good AEC") is exactly what this candidate maximizes.

---

## 1. Component/module layout

```
vendor/capnweb                     bounded C99 Cap'n Web peer — UNCHANGED (minus dead responder/call_path)
components/core                    control plumbing only: itx_mount, itx_connection, websocket_tx/rx/text,
                                   frame_writer, spsc_ring, retry_gate, configuration (TLV), atomic.h,
                                   intent_queue (v1 device_events renamed to what it is: bounded control
                                   intents with one total order for physical+remote edges), cpu_usage
components/events                  PERIPHERY: 64×64 B interned-envelope observability ring, per-sink
                                   cursors (lapped cursor = explicit gap fact), X-macro type table;
                                   sinks: capnweb subscriber, console, SD JSONL, retained-latest
components/audio                   THE CENTER (linkable only on audio boards):
  audio_codec.h                      hardware seam: properties + routes + blocking beat + descriptor writes
  audio_processor.h                  DSP seam: frame_spec/process(mic,ref,out)/fail-closed-silence
  audio_pipeline.{h,c}               ONE mode machine (manual_stop/auto_stop/realtime): turn edges,
                                     drained-edge mic-open, warmup discard, ref-ring discipline, taps
  processors/null.c                  copy mic→out (Stick today, HA VPE, simulator)
  processors/timestamp_echo.c        copy mic→out + stamp result with playout-ms (server-AEC variant)
  speech_leveler.{h,c}               Q16 gain + soft-knee limiter (stackchan port, verbatim)
  pcm_lane / uplink_conductor /      v1's transmission stack — SURVIVES VERBATIM (moved files)
  uplink_sender / peer_delivery_guard/ pcm_websocket
components/analysis                analysers behind one vtable (stackchan port): pose, 40-byte render key,
                                   stage cues, envelope (60 B) + spectral (112 B) drivers; MFCC driver is
                                   host/userspace-build only
components/capabilities            thin RPC modules — SURVIVE VERBATIM: leds, servos, screen, push_to_talk,
                                   rpc_internal, callback_budget; metrics rebuilt on the R7 X-macro;
                                   event subscription becomes the events capnweb sink parameterization
devices/<board>/                   composition root (hand-written module table, m5sticks3.c:158-176 idiom)
                                   + profile.{h,c} (tier-1 geometry constants + tier-2 const policy struct)
platforms/iterate_esp_idf          itx_transport (minus Wi-Fi), pcm_transport (socket-wakeup, no tick),
                                   wifi_station.c (extracted, retry_gate-backed), websocket_connection,
                                   configuration partition reader
platforms/esp_codecs               per-board codec impls: m5sticks3.c (PDM RX + fence-inside-codec),
                                   es8311.c (StackChan + Waveshare, ~250 LOC shared),
                                   ha_vpe.c (XMOS-processed in, 48 k out domain hidden inside),
                                   esp_sr_processor.c (FD AEC behind the processor seam — StackChan phase)
platforms/common                   RealtimePlayback + DirectI2sStereoOutput templates — SURVIVE, now
                                   consumed by codec impls instead of the target
targets/<board>/main               boot order + task creation + nothing else (main.cpp shrinks to ~600)
simulator/                         control-plane model + NEW scripted codec (route/fence/descriptor policy
                                   host-coverable for the first time)
```

Dataflow on a duplex board (the picture the whole candidate is organized
around):

```
             ┌──────────────────── audio task (core 1, prio 19, cadence = codec DMA) ────────────────────┐
             │                                                                                            │
 mic DMA ───▶│ codec.next_beat() ─▶ leveler ─▶ processor.process(mic, ref, out) ─▶ uplink pcm_lane ──────▶│──▶ PCM net task
             │        ▲                            ▲                │                                     │    (core 0, prio 6,
             │        │                            │                └─▶ result.voice_active → intent      │     socket-wakeup)
             │        │                     ref ring: COMPLETE frames only,                               │
             │        │                     drop-oldest, reset on session edges                           │
             │        │                            ▲                                                      │
 spk DMA ◀───│ codec.write(descriptor) ◀── RealtimePlayback policy ◀── downlink pcm_lane ◀───────────────│◀── PCM net task
             │        │                                                                                   │
             │        └─ descriptor EOF beat ─▶ analyser.push_pcm(completed frame)  [seqlock publish]     │
             └────────────────────────────────────────────────────────────────────────────────────────────┘
                                                        │
                              display/background task (core 0, prio 1): analyser.snapshot() → render key
                              → sprite/LED/servo renderer; events ring sinks pump; metrics sampler
```

PTT on the Stick is the same picture with `mode = MANUAL_STOP`,
`processor = null`, and the codec's half-duplex route fence hiding the
mic/speaker pin swap (§4).

---

## 2. The load-bearing new interfaces (C header sketches)

House style throughout: caller-owned storage, options structs, vtables with
borrowed contexts, `iterate_kit_status` returns, reasoning comments. All
portable, libc-only, allocation-free after init.

### 2.1 `iterate/kit/audio_codec.h` — the hardware seam (xiaozhi `AudioCodec`, translated and de-C++'d)

The deliberate difference from a pure sans-I/O contract: **`next_beat()` may
block**. This is the candidate's signature move — the codec owns the clock, the
pipeline dances to it, and no tick poll exists anywhere in the audio path. The
prior art is unanimous (esphome `audio_pipeline.cpp:917-919`; xiaozhi's
`audio_input` task blocking-reads 10 ms chunks at prio 8/core 0,
`main/audio/audio_service.cc:131-136`; ADF i2s_stream tasks at prio 23,
review §4.1). Host testability survives because the pthread fakes already model
blocking primitives (`tests/fakes/fake_esp_idf_platform.c` implements FreeRTOS
tasks over pthreads) and the scripted simulator codec returns beats under test
control.

```c
#ifndef ITERATE_KIT_AUDIO_CODEC_H
#define ITERATE_KIT_AUDIO_CODEC_H

#include "iterate/kit/status.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Static hardware truth, const per board, referenced from the device profile.
 * Replaces v1's 2-value iterate_kit_audio_mode (audio.h:15-19) as the driver
 * of policy: duplexness/reference/echo-cancelled are FACTS the pipeline reads,
 * never declarations a controller asserts. input_echo_cancelled exists because
 * the HA Voice PE's XMOS XU316 does AEC/NS/AGC upstream of the ESP32 — a truth
 * neither xiaozhi's input_reference() nor v1's enum can express.
 */
struct iterate_kit_audio_codec_properties {
  uint32_t sample_rate_hz;           /* presented rate: 16000 everywhere; the
                                        HA VPE impl hides its 48 k DAC domain
                                        behind an internal resample so the
                                        pipeline sees ONE clock domain */
  uint16_t frame_samples;            /* 320 = 20 ms, matches wire v1 */
  uint8_t  mic_channels;             /* interleaved mic channels in a beat */
  uint8_t  reference_channels;       /* 0 = no hardware AEC reference;
                                        1 on CoreS3 (ES7210 TDM slot 1 MIC3,
                                        stackchan audio_pipeline.c:446-482) */
  uint8_t  playback_descriptors;     /* DMA descriptor identity space (4)   */
  bool     duplex;                   /* capture+playback simultaneously OK  */
  bool     input_echo_cancelled;     /* upstream DSP already did AEC (VPE)  */
  int16_t  output_gain_ceiling_centi_db; /* −1800 on the Stick: brownout fix */
};

enum iterate_kit_audio_route {
  ITERATE_KIT_AUDIO_ROUTE_IDLE     = 0u,
  ITERATE_KIT_AUDIO_ROUTE_CAPTURE  = 1u << 0,
  ITERATE_KIT_AUDIO_ROUTE_PLAYBACK = 1u << 1,
  /* CAPTURE|PLAYBACK is rejected at init when properties.duplex is false;
   * illegal states are unrequestable, not runtime-checked. */
};

enum iterate_kit_audio_beat_kind {
  ITERATE_KIT_AUDIO_BEAT_CAPTURE_FRAME        = 1u << 0,
  ITERATE_KIT_AUDIO_BEAT_DESCRIPTOR_COMPLETED = 1u << 1,
  ITERATE_KIT_AUDIO_BEAT_ROUTE_APPLIED        = 1u << 2,
  ITERATE_KIT_AUDIO_BEAT_FAULT                = 1u << 3,
};

/*
 * One beat = one hardware cadence edge. On a duplex codec capture and EOF
 * beats interleave on the shared clock; on the half-duplex Stick the active
 * route decides which kind arrives. Beats carry copies/identities, never
 * borrowed driver memory: capture data is copied out (640 B × 50 Hz = 32 KB/s
 * of memcpy — we buy the simplicity and delete BoundedCapture's 258-LOC
 * 4-state borrow ledger, bounded_capture.hpp:64-118), and playout completion
 * carries the DESCRIPTOR IDENTITY + EOF timestamp exactly as the v1 ISR does
 * today (4-slot SPSC → owner notify, m5sticks3_direct_audio.hpp:33-37), so
 * RealtimePlayback's descriptor-identity proofs survive unchanged.
 */
struct iterate_kit_audio_beat {
  uint32_t kinds;                    /* bitmask of iterate_kit_audio_beat_kind */
  uint16_t captured_samples;         /* CAPTURE_FRAME: count copied to storage */
  uint64_t captured_at_us;           /* CAPTURE_FRAME: DMA completion time     */
  uint8_t  completed_descriptor;     /* DESCRIPTOR_COMPLETED: identity 0..N-1  */
  uint64_t descriptor_eof_us;        /* DESCRIPTOR_COMPLETED: ISR EOF stamp    */
  uint8_t  applied_route;            /* ROUTE_APPLIED                          */
  enum iterate_kit_status route_status;   /* ROUTE_APPLIED: OK or the failure  */
  enum iterate_kit_status fault;          /* FAULT: classified driver fault    */
};

struct iterate_kit_audio_codec_ops {
  enum iterate_kit_status (*power)(void *context, bool enabled);

  /*
   * Route application is asynchronous and acknowledged by a ROUTE_APPLIED
   * beat. The half-duplex fence — amp off, i2s_channel_disable, i2s_del_channel
   * (deletion is the pin-ownership boundary: mic and speaker share
   * MCLK/BCLK/WS and PDM RX cannot share a duplex clock, esp-idf i2s.rst:905),
   * PDM RX up — executes INSIDE the Stick codec impl on the audio owner task.
   * This deletes the 1 s synchronous cross-task fence the main task pays today
   * (m5sticks3_direct_audio.hpp:173, m5unified.cpp:297-341): press-to-capture
   * becomes a measured beat interval, not a blocking call.
   */
  enum iterate_kit_status (*request_route)(void *context, uint8_t route);

  /*
   * Blocks the calling task until the next cadence edge, a route/fault
   * completion, or timeout. OWNER-TASK ONLY; this call IS the pipeline clock.
   * capture_storage receives one frame (frame_samples × mic_channels, plus
   * reference_channels interleaved when the hardware provides them — the
   * CoreS3 codec deinterleaves near/ref from TDM by ISR sequence pairing,
   * stackchan audio_pipeline.c:486-608, and presents them as separate spans).
   */
  enum iterate_kit_status (*next_beat)(
      void *context, struct iterate_kit_audio_beat *beat,
      int16_t *capture_storage, size_t capture_capacity_samples,
      int16_t *reference_storage, size_t reference_capacity_samples,
      uint32_t timeout_ms);

  /* Playback keeps v1's descriptor-token idiom (preload before enable; write
   * targets the oldest completed descriptor) so the 3,000-LOC identity test
   * suite (realtime_playback_test.cpp, direct_i2s_stereo_output_test.cpp)
   * keeps proving the same physical claims. */
  enum iterate_kit_status (*preload)(
      void *context, const int16_t *samples, size_t sample_count);
  enum iterate_kit_status (*write_descriptor)(
      void *context, uint8_t descriptor,
      const int16_t *samples, size_t sample_count);

  enum iterate_kit_status (*set_output_gain_centi_db)(
      void *context, int16_t gain_centi_db);
};

struct iterate_kit_audio_codec {
  const struct iterate_kit_audio_codec_ops *ops;
  const struct iterate_kit_audio_codec_properties *properties;
  void *context;
};

#endif
```

Economy target, from xiaozhi: seven codec implementations cover every board in
1,541 LOC total (`main/audio/codecs/*.cc` — es8311 217, box ES8311+ES7210 259,
no_audio_codec 386, dummy 20). A new board's audio cost must be a ~200–300 LOC
codec file plus a profile, or the seam has failed.

### 2.2 `iterate/kit/audio_processor.h` — the DSP seam (esphome `AudioProcessor`, translated)

Direct C translation of `audio_core_processor.h:66-118` with the fail-closed
rule imported verbatim from `esp_afe.cpp:1612-1615` ("when the configured
processor can't run, emit silence — never raw mic") and one candidate-B
extension: the result carries the playout timestamp so **server-side AEC is
literally a processor variant** (§5).

```c
#ifndef ITERATE_KIT_AUDIO_PROCESSOR_H
#define ITERATE_KIT_AUDIO_PROCESSOR_H

#include "iterate/kit/status.h"
#include <stdbool.h>
#include <stdint.h>

struct iterate_kit_audio_frame_spec {
  uint32_t sample_rate_hz;      /* 16000 */
  uint16_t samples_per_frame;   /* AEC engines dictate their chunk: the seam
                                   honors aec_get_chunksize (stackchan
                                   audio_pipeline.c:826), so this may be 512
                                   (32 ms) for FD AEC while the wire stays
                                   320/20 ms — the pipeline re-frames. */
  uint8_t  mic_channels;
  uint8_t  reference_channels;  /* 0 or 1 at this seam */
};

struct iterate_kit_audio_processor_result {
  bool     voice_active;        /* VAD state when the impl supports it       */
  bool     output_is_silence;   /* fail-closed marker: out[] was zeroed      */
  /* Timestamp-echo variant: the wire timestamp (worker downlink timeline,
   * ms) of the frame most recently completed at the DAC when this mic frame
   * was captured; 0 = nothing audible. The uplink conductor copies this into
   * the pcm v2 frame header (§5.2). Device-AEC variants leave it 0. */
  uint32_t reference_playout_ms;
};

struct iterate_kit_audio_processor_ops {
  struct iterate_kit_audio_frame_spec (*frame_spec)(const void *context);

  /* Monotonic revision; a change means storage geometry changed and the
   * pipeline must restart the capture session (esphome frame_spec_revision
   * contract, audio_core_processor.h:103-107). */
  uint32_t (*frame_spec_revision)(const void *context);

  /*
   * mic and out are same-spec frames; reference may be NULL (no playback
   * active — the pipeline passes NULL rather than a zero frame so the impl
   * can skip filter adaptation; esphome instead feeds zeros to keep surface
   * consistency, esp_afe.cpp — we prefer the explicit NULL and document it).
   * CONTRACT: on any internal failure, fill out with silence, set
   * output_is_silence, return OK. Returning an error is reserved for
   * unrecoverable states that must poison the capture generation.
   * Mutations (NLP level, mode toggles) are dirty-flagged by setters and
   * applied HERE by the owning task — the xiaozhi/stackchan discipline
   * (afe_audio_engine.cc:317-368; stackchan audio_pipeline.c:723-730).
   */
  enum iterate_kit_status (*process)(
      void *context,
      const int16_t *mic, const int16_t *reference, int16_t *out,
      struct iterate_kit_audio_processor_result *result);
};

struct iterate_kit_audio_processor {
  const struct iterate_kit_audio_processor_ops *ops;
  void *context;
};

#endif
```

Shipped implementations, in landing order: `null` (Stick, simulator, HA VPE —
the VPE selects null _because_ `input_echo_cancelled=true`), `timestamp_echo`
(Stick full-duplex experiments; §5), `fake` (test-only: scriptable failures,
spec-revision bumps), `esp_sr_fd_aec` (StackChan phase: standalone
`aec_create_from_config` FD mode, filter*length 4, state in PSRAM, linear+NLP
split with per-stage µs timing — configuration stolen verbatim from stackchan
`audio_pipeline.c:803-826, 731-736`). Reconfiguration uses esphome's drain
handshake verbatim: `process_busy*`/`drain*request*` seq_cst pair, zero-timeout
try-lock with silence fallback, rebuilds on a low-prio task with a depth-1
latest-wins queue (`esp_afe.h:92-105`, `esp_aec.cpp:168-187`).

### 2.3 `iterate/kit/audio_pipeline.h` — one pipeline, three modes

The piece v1 does not have at all. It subsumes v1's
`iterate_kit_audio_controller` (audio.c/audio.h — the PTT-vs-duplex lifecycle
policy) and adds the turn machinery every studied project converged on. It is
portable, allocation-free, and runs entirely on the audio owner task; its unit
tests drive it with the scripted codec + fake processor on a virtual clock.

```c
#ifndef ITERATE_KIT_AUDIO_PIPELINE_H
#define ITERATE_KIT_AUDIO_PIPELINE_H

#include "iterate/kit/audio_codec.h"
#include "iterate/kit/audio_processor.h"
#include "iterate/kit/status.h"

/*
 * xiaozhi's ListeningMode, translated (protocol.h:35-39). PTT and duplex are
 * NOT two designs: they are one pipeline with different mic-open/commit rules.
 *   MANUAL_STOP : mic open press→release (Stick PTT). Commit at release.
 *   AUTO_STOP   : mic opens after playback drains; commit on VAD-stop or
 *                 explicit stop; mic closes at commit. (Wake-word flows land
 *                 here later with zero new pipeline states.)
 *   REALTIME    : mic always open; requires processor-grade echo handling
 *                 (device AEC, upstream-hardware AEC, or timestamp-echo with
 *                 the cancellation running server-side).
 */
enum iterate_kit_listening_mode {
  ITERATE_KIT_LISTENING_MANUAL_STOP = 0,
  ITERATE_KIT_LISTENING_AUTO_STOP,
  ITERATE_KIT_LISTENING_REALTIME,
};

/* Control intents drained from the core intent queue (v1 device_events —
 * physical and remote PTT edges share one total order, push_to_talk.c:7-13). */
enum iterate_kit_pipeline_intent {
  ITERATE_KIT_PIPELINE_INTENT_PRESS = 0,   /* PTT down / wake trigger  */
  ITERATE_KIT_PIPELINE_INTENT_RELEASE,     /* PTT up                   */
  ITERATE_KIT_PIPELINE_INTENT_INTERRUPT,   /* barge-in: purge playback */
  ITERATE_KIT_PIPELINE_INTENT_SET_MODE,    /* payload: listening mode  */
};

/* Uplink handoff: exactly one buffering boundary per direction stays law
 * (pcm_lane.c doctrine). submit copies one processed frame + its stamp into
 * the uplink lane; commit is the in-band turn boundary (zero-length uplink
 * frame, symmetric with downlink EOS — proxy-session doc §2.2). */
struct iterate_kit_pipeline_uplink {
  void *context;
  enum iterate_kit_status (*submit)(
      void *context, const int16_t *samples, size_t sample_count,
      uint32_t reference_playout_ms, uint64_t captured_at_us);
  enum iterate_kit_status (*commit)(void *context);
  enum iterate_kit_status (*abandon)(void *context);  /* clear, not commit */
};

/* Analyser tap: non-realtime second consumer of the pipeline's frames.
 * push() must be O(frame) with no locks/heap/log (stackchan concurrency rule
 * set, docs/architecture.md); the analyser publishes via seqlock and the
 * render task snapshots at its own 30 Hz. */
struct iterate_kit_pipeline_tap {
  void *context;
  void (*push_playout)(void *context, const int16_t *samples,
                       size_t sample_count, uint64_t eof_us);
  void (*push_capture)(void *context, const int16_t *samples,
                       size_t sample_count, uint64_t captured_at_us);
};

struct iterate_kit_pipeline_policy {
  uint8_t  mic_warmup_discard_frames;   /* 1 today; xiaozhi uses ~120 ms     */
  uint8_t  drained_edge_defer;          /* AUTO_STOP: defer mic-open until
                                           playback fully drained (xiaozhi
                                           application.cc:937-945) — the R12
                                           drain-edge, now a mode rule        */
  uint16_t reference_ring_ms;           /* ~80 ms drop-oldest (review R11)   */
  uint16_t reference_predelay_ms;       /* ADF 0–10 ms mic-lags-ref trim     */
  bool     leveler_enabled;
};

struct iterate_kit_audio_pipeline_options {
  enum iterate_kit_listening_mode initial_mode;
  struct iterate_kit_audio_codec codec;            /* borrowed */
  struct iterate_kit_audio_processor processor;    /* borrowed */
  struct iterate_kit_pipeline_uplink uplink;
  struct iterate_kit_pipeline_tap tap;             /* ops may be NULL */
  struct iterate_kit_pipeline_policy policy;
  /* downlink side: RealtimePlayback policy object, borrowed — the pipeline
   * routes DESCRIPTOR_COMPLETED beats into it and its refill decisions into
   * codec.write_descriptor; the 1,863-LOC template is consumed, not rewritten */
  void *playback_policy;
};

struct iterate_kit_audio_pipeline;   /* caller-owned, storage in the struct */

enum iterate_kit_status iterate_kit_audio_pipeline_init(
    struct iterate_kit_audio_pipeline *pipeline,
    const struct iterate_kit_audio_pipeline_options *options);

/*
 * The owner task's whole loop body:
 *   drain intents → codec.next_beat(block) → route beat:
 *     CAPTURE_FRAME → warmup gate → leveler → snapshot knobs (esphome
 *       snapshot pattern, audio_pipeline.cpp:790-816: read every per-frame-
 *       mutable atomic ONCE into a plain ctx struct) → processor.process
 *       (ref = hardware channel if reference_channels>0, else the TX-tap
 *       ring slice, else NULL) → uplink.submit → tap.push_capture
 *     DESCRIPTOR_COMPLETED → playback policy (refill/underrun/EOS) →
 *       ref-ring append (COMPLETE frames only — padding pollutes the
 *       adaptive filter, esphome audio_pipeline.cpp:1728-1737) →
 *       tap.push_playout → drained-edge detection → publish audible stamp
 *     ROUTE_APPLIED / FAULT → mode machine / generation poison
 * Returns after one beat so the owner task can also pump bounded non-audio
 * work (metrics rendezvous) between beats without a second clock.
 */
enum iterate_kit_status iterate_kit_audio_pipeline_run_once(
    struct iterate_kit_audio_pipeline *pipeline, uint32_t timeout_ms);

#endif
```

### 2.4 `iterate/kit/analyser.h` — stackchan's `face_algorithm_t`, renamed

Ported nearly verbatim from
`stackchan/experiments/02-minimal-realtime-aec/firmware-ws/main/face_driver.h:33-52`,
with the pose (`face_pose.h:39-56`), the 12-byte keyframe prefix + 40-byte
render key (`face_keyframe.h:16-129`, `_Static_assert(sizeof == 40)` kept), and
the 32-byte sample-clock stage cues (`face_stage.h:72-98`). The stackchan
autopsy's verdict stands: this IS the goal doc's renderer-input structure
(`physical-device-voice-goal.md:219-236`), field for field — adopt, don't
redesign.

```c
struct iterate_kit_analyser_ops {
  const char *name;
  size_t state_size;
  size_t state_alignment;
  bool (*init)(void *state, uint32_t sample_rate_hz,
               const void *config, size_t config_size);
  void (*push_pcm)(void *state, const int16_t *samples, size_t sample_count);
  /* Provider-side milestones (transcript, response start/end) enter with a
   * playout-clock dispatch marker so text releases in sync with the SPEAKER,
   * not network arrival (face_driver.h:19-31 pattern — received_audio_samples
   * → dispatch_playout_samples). */
  void (*push_event)(void *state, const struct iterate_kit_analyser_event *e);
  void (*snapshot)(const void *state, struct iterate_kit_pose *pose);
};

struct iterate_kit_analyser {         /* non-owning dispatch handle */
  const struct iterate_kit_analyser_ops *ops;
  void *state;                        /* caller-owned, ops->state_size bytes */
};
```

Three drivers port with provenance headers: envelope (60 B state, integer,
zero-crossing width — `face_animator.c`, the one the CoreS3 firmware shipped),
spectral (112 B state, integer-only 7-band Q14 Goertzel, ~7 MAC/sample, <1 % of
a core — `face_spectral.c:6-363`; **the on-device default**), MFCC/prototype
viseme (6,472 B state + 14,352 B MIT HeadAudio model, float —
`face_viseme.c`; **host/userspace builds only**). All publish through the
identical seqlock (`face_viseme.c:116-126, 729-748`): audio writer never
blocks, display reader retries torn reads. Renderers (sprite player, Stick
status screen, HA VPE LED ring, StackChan servos via
`head_yaw/pitch/roll` in the render key) are output-vtable consumers in the
leds/servos idiom — a servo renderer is just another consumer.

Two properties are imported as _requirements_, with the stackchan tests that
enforce them: packet-boundary invariance (same pose for same PCM regardless of
WS chunking — hash-equality across two packetisations,
`docs/pcm-face-rig.md:163-165`) and playout-clocking (PCM fed from completed TX
DMA so 16 s of network buffer can never make the mouth lead the speaker,
`audio_pipeline.c:710-716`).

### 2.5 `iterate/kit/event_ring.h` — the periphery, kept deliberately small

The os-streams exploration's Candidate-A envelope, adopted as-is
(`os-streams-event-model.md` §9: 64-byte interned envelope — u16 type id into
an X-macro URI table, u32 sequence, u32 boot_epoch, u64 uptime_ms, 38-byte
packed payload; 64 slots = 4 KiB; single-writer, per-sink cursors, a lapped
cursor IS the `event-gap-observed` fact). Sinks: capnweb subscriber (the
`device_event_stream` delivery machinery generalized — its five booleans are
already duplicated in the metrics scheduler, `device_event_stream.h:64-78` vs
`metrics.h:312-320`, and get written once), console (runtime_diagnostics'
byte-budgeted pump), SD JSONL (req 5, per the sd-event-logging design:
producers publish to a PSRAM ring; a prio-2 core-0 task batches 8 KiB writes
into preallocated contiguous FAT segments with CRC32C blocks), retained-latest
(feeds `getDiagnostics`).

What candidate B refuses: making this the spine. The metrics sampler stays a
sampler (periodic ~600 B wide samples do not belong in 64-byte slots —
code-reduction audit §2c Option B); the pipeline's mode machine is driven by
the intent queue directly, never by consuming its own observability ring; no
module-to-module communication rides events. The audio pipeline _publishes_
turn milestones (capture-started, drained, turn-committed, generation-poisoned)
into the ring from the owner task — O(memcpy), fire-and-forget.

---

## 3. Task model per board class

Priorities follow the prior-art ladder the review found unanimous (§4.1):
capture/audio at the top of app priorities, network below, UI at the bottom.
The v1 defect this fixes: mic capture pumped from the priority-1 main task
below both net tasks with 40 ms of hardware buffer
(`bounded_capture.hpp:47`, `main.cpp:1196-1217`, review §4.1) — any main-task
stall >40 ms silently gaps the mic, including the 1 s metrics rendezvous
(`m5sticks3_direct_audio.hpp:173`).

### Class 1 — half-duplex PTT (M5StickS3)

| Task                                          | Core | Prio | Cadence source                                                                                                            | Owns                                                                                                                                               |
| --------------------------------------------- | ---- | ---- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iterate-audio`                               | 1    | 19   | **blocking `codec.next_beat`** (PDM RX DMA while capturing; TX EOF ISR→SPSC while playing; route completions)             | pipeline: capture→leveler→processor(null)→uplink lane; RealtimePlayback refills; half-duplex fence execution; analyser push; audible-stamp publish |
| `iterate-pcm-net`                             | 0    | 6    | socket-readiness wakeup + lane-notify (**tick poll deleted** — the code already self-flags it, `pcm_transport.c:600-606`) | uplink conductor/sender drain, downlink receive→lane, peer-delivery guard                                                                          |
| `iterate-net` (control)                       | 0    | 5    | socket wakeup + retry_gate deadlines                                                                                      | Cap'n Web socket, mount, reconnect generations                                                                                                     |
| `sd-sink` (only if `profile.features.has_sd`) | 0    | 2    | event-ring cursor notify + 5 s fsync deadline                                                                             | SD segment writer (absent on the Stick — no slot)                                                                                                  |
| main/background                               | 0    | 1    | 10 ms tick (UI only — audio no longer cares)                                                                              | buttons→intent queue, display, metrics sampler, event-ring capnweb/console sink pumps, analyser snapshot→renderer                                  |

The main loop's audio duty is exactly zero; the 10 ms tick survives only for
human-scale I/O. Button-to-capture latency becomes an event interval (intent
publish → ROUTE_APPLIED beat), measured by the rig, replacing the 1 s
synchronous fence bound.

### Class 2 — full-duplex device AEC (StackChan/CoreS3)

| Task              | Core | Prio | Cadence source                                                                                                                                        | Owns                                                                                                                                                                                                                             |
| ----------------- | ---- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iterate-audio`   | 1    | 19   | blocking `next_beat` on the shared-clock duplex codec (ES7210 TDM RX + AW88298 TX; ISR sequence-paired mic/ref, stackchan `audio_pipeline.c:486-608`) | pipeline with `processor = esp_sr_fd_aec` **inline** (FD AEC ≈ 20 % of a core, espressif budgets review §4.5 — fits in the beat budget; measured per-stage µs telemetry from stackchan `audio_pipeline.c:220-274` comes with it) |
| `dsp-rebuild`     | 1    | 3    | depth-1 latest-wins queue                                                                                                                             | processor rebuilds behind the drain handshake (esphome `esp_aec.cpp:168-187`) — never the hot path                                                                                                                               |
| `iterate-pcm-net` | 0    | 6    | socket wakeup                                                                                                                                         | as class 1                                                                                                                                                                                                                       |
| `iterate-net`     | 0    | 5    | socket wakeup                                                                                                                                         | as class 1                                                                                                                                                                                                                       |
| `sd-sink`         | 0    | 2    | cursor notify                                                                                                                                         | SPI-mode SD on the shared LCD bus, per-chunk bus acquire                                                                                                                                                                         |
| main/background   | 0    | 1    | 10 ms tick                                                                                                                                            | touch/buttons, face renderer at 30 Hz off the seqlock, sinks, sampler                                                                                                                                                            |

One clock domain (shared BCLK) ⇒ one audio task; this is deliberately tighter
than stackchan's aec_task(8)+audio_task(12) pair — their split existed because
`esp_codec_dev` calls block independently; our codec presents one beat stream.
If full AFE (feed/fetch worker) is ever needed, the fetch worker lands as a
second core-1 task at prio 18 clocked by the feed semaphore
(esphome `esp_afe.cpp:1902-1938` shape) — a codec-impl detail behind the same
seam.

### Class 3 — duplex with upstream hardware AEC (HA Voice PE)

Class 2's table with `processor = null` (because `input_echo_cancelled=true`),
no `dsp-rebuild` task, and the codec impl privately owning the 48 kHz DAC
domain (internal upsample; the pipeline sees 16 k). The hardware mute switch is
a codec truth: reads return silence while muted (fail-closed), and the edge is
published as an intent + event. Dial ticks arrive via the platform ISR
marshaller into the intent queue.

### Class 4 — audio-less (e-ink + buttons; mic-only; speaker-only)

| Task                   | Core | Prio | Cadence source | Owns                                            |
| ---------------------- | ---- | ---- | -------------- | ----------------------------------------------- |
| `iterate-net`          | 0    | 5    | socket wakeup  | control plane                                   |
| `sd-sink` (if present) | 0    | 2    | cursor notify  | SD sink                                         |
| main/background        | 0    | 1    | tick           | buttons→intents, e-ink renderer, sinks, sampler |

No audio task, no PCM net task, no `components/audio` object files in the
link. Mic-only and speaker-only boards link `components/audio` with a codec
whose properties zero out the missing direction; the pipeline degenerates
gracefully (a route with no PLAYBACK bit never touches descriptors; a codec
with `mic_channels=0` never emits capture beats). This is the addendum's
"capability, not assumption" requirement expressed as properties + link sets.

---

## 4. One pipeline, three shapes — the proof of the central claim

The prompt's demand: show precisely how StackChan AEC and M5StickS3 PTT are
the same pipeline. The table is the architecture:

| Axis                         | M5StickS3 PTT                                                          | StackChan duplex AEC                                                                                                      | HA Voice PE                                       | Stick server-AEC experiment                 |
| ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| `listening_mode`             | MANUAL_STOP                                                            | REALTIME                                                                                                                  | REALTIME (or AUTO_STOP)                           | REALTIME                                    |
| `codec.properties`           | duplex=false, ref=0, gain ceiling −18 dB                               | duplex=true, **reference_channels=1** (ES7210 TDM slot 1 hardware ref, stackchan `audio_pipeline.c:446-482`)              | duplex=true, ref=0, input_echo_cancelled=**true** | duplex=false→route-alternating, ref=0       |
| `processor`                  | null                                                                   | esp_sr FD AEC (+WebRTC VAD)                                                                                               | null                                              | **timestamp_echo**                          |
| Reference source             | —                                                                      | hardware TDM channel (software TX-tap ring is the fallback, not the plan — stackchan finding supersedes R11's assumption) | — (XMOS consumed it upstream)                     | worker-side ring, selected by echoed stamp  |
| Mic-open rule                | press intent → route CAPTURE (fence inside codec)                      | always open; VAD arms turns                                                                                               | always open; mute switch fail-closes              | always open while experimenting             |
| Commit rule                  | release intent → `uplink.commit` (in-band zero-length marker)          | `result.voice_active` falling edge                                                                                        | same                                              | server-side (worker speak-state gate first) |
| Turn-start polish            | drained-edge defer + 1-frame warmup (xiaozhi `application.cc:937-945`) | continuous — no defer                                                                                                     | continuous                                        | continuous                                  |
| Barge-in                     | INTERRUPT intent → playback purge (v1 epoch machinery verbatim)        | VAD edge during playback → same purge path                                                                                | same                                              | worker `response.cancel` + purge            |
| What changes between columns | **profile data only**: mode, processor selection, codec impl           |                                                                                                                           |                                                   |                                             |

No column adds a state to the pipeline machine. That is the falsifiable claim
of this candidate: if StackChan bring-up needs a new pipeline state (not a new
processor/codec), the architecture bet lost.

## 5. Server-side AEC as a processor variant (req 9)

### 5.1 On-device: `processors/timestamp_echo.c`

~60 LOC. `process()` copies mic→out and fills
`result.reference_playout_ms` from the atomic the pipeline publishes on every
DESCRIPTOR_COMPLETED beat (both timestamp domains already exist:
`realtime_playback.hpp:83-99` carries per-descriptor EOF stamps + the frame
metadata that produced them). The crucial property, stolen from xiaozhi:
**alignment is computed on the device, in its own playout timeline** — the
output task records played-packet timestamps, the encode path stamps outgoing
mic frames with the front of that queue
(`audio_service.cc:345-347, 546-553`) — so network jitter is irrelevant to
reference alignment. The classic server-AEC killer disappears.

### 5.2 Wire: xiaozhi BinaryProtocol2, little-endian, subprotocol-negotiated

Header layout copied verbatim from
`~/src/github.com/78/xiaozhi-esp32/main/protocols/protocol.h:17-24`
(u16 version, u16 type, u32 reserved, u32 timestampMs, u32 payload_size),
serialized **little-endian** (deliberate deviation: S16LE payload, LE on both
ends, interop with nobody bought by htons). Negotiated as
`iterate.kit.pcm.v2` alongside v1 via standard `Sec-WebSocket-Protocol`; a
v1-only peer answers v1 and the raw 640-B fast path is untouched. The `type`
field also carries the in-band zero-length uplink commit (type 2), killing the
cross-socket commit race (proxy-session doc §2.2). Cost: uplink workspace
648→664 B, +4 B × 32 downlink slots = 128 B, ~60 LOC firmware, ~40 LOC worker,
**zero IRAM** (IRAM has 1 byte free — `physical-device-voice-goal.md:352-354`;
the stamp publish is plain C on the owner task).

### 5.3 Where cancellation runs — the ladder (from proxy-session §3.3)

1. Rig-side speexdsp first (evidence: ERLE + stamp-accuracy vs PRBS31
   correlation ground truth ±0.5 ms — testing doc §3.5 scenario).
2. Worker speak-state gating (~30 LOC, no DSP) as the shipping duplex-ish mode
   for reference-less hardware.
3. Worker WASM speex-MDF (~0.2–0.6 ms per 20 ms frame ≈ 1–3 % core ≈
   $0.0014/session-hour) only on proven barge-in need — benchmark first.
4. xAI provider-side: not available (no documented echo-reference input,
   checked 2026-07-31) — watch item.

The candidate-B framing: steps 2–4 are _the processor, running remotely_. The
device's `timestamp_echo` processor + the v2 header is the complete on-device
discharge of requirement 9.

---

## 6. All 12 requirements → concrete mechanisms

| #   | Requirement                          | Mechanism in this candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | less code/complexity                 | Three asymmetric audio seams → two (codec + processor); 4 bespoke delivery machines → 2 (sampler + event ring); metrics schema 6 copies → 1 X-macro (audit a2, −2,260); dead code deletions (audit b1–b4, −1,800); CMake −710. Honest LOC in §8 — B buys capability, not headline shrinkage                                                                                                                                                                                                                                             |
| 2   | easier to test/reason                | Pipeline is one host-testable machine (scripted codec + fake processor + virtual clock); descriptor-identity proofs survive; fence state machine host-coverable for the first time; link-time core/audio boundary replaces text greps                                                                                                                                                                                                                                                                                                   |
| 3   | prior-art best practices             | Codec seam (xiaozhi), processor seam + fail-closed (esphome), DMA-owned cadence (unanimous), snapshot pattern, drain handshake, ref-ring discipline, drained-edge + warmup, priority ladder, timestamp echo — each with file:line provenance in §2/§7                                                                                                                                                                                                                                                                                   |
| 4   | pluggable hardware APIs              | Codec vtable + properties; per-board profile (tier-1 geometry header + tier-2 const policy struct, provisioning-overridable clamped subset); "more permissive" = append modules to the open table (`m5sticks3.c:158-176` mechanism, kept); output drivers/renderers as vtables                                                                                                                                                                                                                                                          |
| 5   | SD logs "(if present)"               | SD JSONL sink on the event ring; `has_sd` profile flag; sd-event-logging design adopted (contiguous preallocated segments, CRC32C blocks, prio-2 sink task, >30 s stall absorption); absent on Stick/VPE by hardware truth                                                                                                                                                                                                                                                                                                              |
| 6   | keep the best                        | §7's verbatim list: realtime_playback, lanes/conductor/sender/guard, capnweb, sans-I/O websocket stack, retry_gate, intent queue one-total-order, pthread-fakes rule, acoustic oracle                                                                                                                                                                                                                                                                                                                                                   |
| 7   | three test layers                    | L1: pipeline/codec/processor unit tests + golden event logs + fuzz; L2: decomposed rig scenarios incl. NEW uplink echo loop (physical regression test for the capture-orphan fix), AEC 3-phase proof (ERLE ≥10 dB / damage <3 dB), barge-in stopwatch ≤250 ms, timestamp-echo alignment; L3: <5-min checkride incl. AP-kill drill + mic loopback (xiaozhi `audio_service.cc:679-693`); one threshold module per device (testing doc §5)                                                                                                 |
| 8   | devices as streams                   | Event ring (64×64 B interned envelope) + sinks; X-macro type table = C enum + URI strings + TS types; `/pcm` worker cross-posts kit-voice/\* from its two logged seams (`worker.ts:247-252, 266-271`) via bounded drop-oldest outbox; **not** the on-device organizing principle (periphery by design)                                                                                                                                                                                                                                  |
| 9   | allow server-side AEC                | §5: timestamp_echo processor + BinaryProtocol2-LE v2 header + worker reference ring; cancellation ladder rig→gating→WASM                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10  | degrade/recover, both sockets always | v1 skeleton kept + four fixes: PCM gate reset on first _confirmed delivery_ (today: on mere connect, `pcm_transport.c:616-618` — verified: the reset fires on `socket_connected`); fleet jitter in the platform wrapper (where `retry_gate.c:6-12` says it belongs); retryable `pcm_transport_start` (today once-ever, `main.cpp:1262-1284`); SD-log + reboot as the explicit last rung (~15 min, ESPHome posture). Degraded-mode matrix with per-state LED/earcon (proxy doc §2.2); in-band commit makes PTT survive control-lane loss |
| 11  | no always-on Grok                    | Worker device-lane/upstream split: NO_UPSTREAM→DIALING→ACTIVE→DRAINING→COOLDOWN, DO alarm idle timer (90 s default), 2 s preroll ring (xiaozhi `wake_word_audio_cache.cc:26-27` shape) masks the 300–850 ms dial under press duration; transcript replay across hangups; rotation before the 30-min xAI cap; ~$4/day vs $115/day always-on                                                                                                                                                                                              |
| 12  | pluggable device I/O                 | v1 driver vtables + thin RPC modules survive verbatim (leds/servos/screen 78–127 LOC each); renderers consume the 40-byte render key (sprite/status/LED-ring/servo); inputs publish intents (buttons, touch, dial, mute) via one shared ISR-marshalling SPSC helper                                                                                                                                                                                                                                                                     |
| —   | addendum: audio-less devices         | Class-4 task model; `components/audio` fully absent from the link; negative link test in CI; a no-acoustics rig scenario (mount + buttons + events + SD) added to L2                                                                                                                                                                                                                                                                                                                                                                    |

---

## 7. Requirement 6 — what survives verbatim / adapted / deleted

The review's §3 preserve list is the floor; this is the module-by-module
disposition.

**Survives VERBATIM (files move at most):**

- `platforms/common/realtime_playback.hpp` (1,863) + `direct_i2s_stereo_output.hpp`
  (710) + their 3,093 LOC of descriptor-identity tests — the crown jewels;
  consumed by codec impls instead of the target.
- `components/core` PCM transmission stack → `components/audio`: `pcm_lane`
  (925 w/ header), `pcm_uplink_conductor` (781), `pcm_uplink_sender` (637),
  `pcm_peer_delivery_guard` (885), `pcm_websocket` (133). Epoch purge,
  capture-age ceiling, PING-barrier guard, in-band EOS — the stackchan autopsy
  is the empirical argument for every one of these (autopsy §5.6); none are
  traded away.
- `vendor/capnweb` core (minus §b4 dead surface), the TS interop suite + known-
  failure ledger, the fuzzer.
- Sans-I/O websocket `tx`/`rx`/`frame_writer`; `spsc_ring`; `retry_gate`;
  `configuration` TLV decoder; `atomic.h` (extended with the named
  acquire/release variants, then the 8 copy-pasted local sets die).
- `device_events` → `core/intent_queue` (rename only): bounded, single-task,
  one total order for physical+remote edges (`device_events.h:75-97`,
  `push_to_talk.c:7-13`).
- Capability modules `leds/servos/screen/push_to_talk/rpc_internal/
callback_budget` and the flat module-table composition-root idiom
  (`m5sticks3.c:158-176`).
- Host: acoustic oracle (tone + PRBS31 analyzers), SoX-only capture doctrine,
  `DeviceRuntimeProbe`, endurance ladder + frozen acceptance policy,
  deterministic providers.
- The pthread-fakes **rule**: every platform adapter compiles its real sources
  against `tests/fakes/` or it doesn't merge (testing doc §2.2); the two holes
  (`websocket_connection.c`, `peer.c`) get closed, not grandfathered.

**Adapted:**

- `audio.c/audio.h` controller → absorbed into `audio_pipeline.c` (the PTT
  intent logic survives as the MANUAL_STOP mode rules; the
  hardware/egress/capture vtable triplet dies).
- `m5sticks3_direct_audio.*` + `m5unified.*` → the Stick codec impl (fence
  moves inside; M5Unified shrinks toward board-init-only, the direction
  `m5sticks3_direct_audio.cpp:23-25` already took).
- `pcm_transport.c`: tick poll → socket wakeup (its own comment asks for
  this); gate-reset-on-confirmed-delivery; retry-able start.
- `itx_transport.c`: Wi-Fi station extraction (R13) into `wifi_station.c` on
  retry_gate — also the ESPHome-adapter prerequisite.
- `metrics.*`: rebuilt on the R7 X-macro (schema 6 copies → 1); the
  subscription scheduler merges with the event ring's capnweb sink machinery
  (one delivery machine, two data sources).
- `runtime_diagnostics`: snapshot struct stays; console pump becomes the
  event-ring console sink; `getDiagnostics` serializes retained-latest +
  latest sample via the generated emitter.
- `device_event_stream` → parameterization of the generic capnweb sink.
- Host worker: `KitVoiceWorker`/`PcmSessionBridge` lane/upstream split (§6
  req 11); `DevicePcmProxy` demoted explicitly to lab harness with the same
  bridge core (one bridge, two hosts).
- `device-e2e.ts` → scenario objects over `src/rig/*` modules (testing doc
  §3.6).

**Deleted:**

- `bounded_capture.hpp` (258) — borrow ledger replaced by copy-out beats.
- `bounded_playback.hpp` (389 + 383 test) — verified dead.
- `websocket_text` egress/ingress incl. the unreachable control-frame branch
  (`websocket_text.c:174-189` vs `itx_transport.c:570-573`) — −480.
- capnweb `responder.c` + `call_path` (−350, zero production callers).
- Managed-client dead metric fields (table-row deletions post-X-macro).
- `sampleRuntimeMetrics` main.cpp:455-924 (dies with the X-macro).
- Camera capability deferred (−160) until a target needs it.
- Both tick polls (capture pump; PCM downlink discovery).
- The 1 s synchronous route fence bound.

---

## 8. LOC estimate vs v1 — the honest version

Base: v1 = 85,310 total (firmware 31,228 prod + 20,727 tests + 1,640 build;
host 18,607 + 13,108 — code-reduction audit §1).

Candidate B's deltas differ from the audit's headline in two ways: it **declines
the full event-spine collapse** (keeps sampler + snapshot outside the ring;
takes only the shared-delivery-machinery dedup, ≈ −600 instead of −1,130, at
medium instead of high risk) and it **adds the analysis component now**
(stackchan port ≈ +1,100 prod +400 test).

| Bucket                                                                                                   |   Δ prod LOC |
| -------------------------------------------------------------------------------------------------------- | -----------: |
| Metrics X-macro (device+host)                                                                            |       −2,260 |
| Dead/superseded (b1–b4, camera, atomics, misc)                                                           |       −2,180 |
| audio.h controller + bounded_capture + fence consolidation                                               |         −900 |
| Delivery-machinery dedup (event ring replaces device_event_stream plumbing + half the metrics scheduler) |         −600 |
| Host e2e phase-runner + analyzer merge + parsers                                                         |       −1,390 |
| Codec seam + 3 ESP impls + scripted codec                                                                |       +1,100 |
| Pipeline core + processors (null/echo/fake) + leveler                                                    |         +850 |
| Analysis component (pose/key/cues/driver/2 drivers)                                                      |       +1,100 |
| Event ring + SD sink + profile structs + ts-echo + wire-gen                                              |       +1,180 |
| **Net production**                                                                                       | **≈ −3,100** |

|                     |         v1 |  B projected |        Δ |
| ------------------- | ---------: | -----------: | -------: |
| Firmware production |     31,228 |     ≈ 30,000 |     −4 % |
| Firmware tests      |     20,727 |     ≈ 20,400 |     −2 % |
| Build               |      1,640 |        ≈ 930 |    −43 % |
| Host production     |     18,607 |     ≈ 17,400 |     −6 % |
| Host tests          |     13,108 |     ≈ 13,000 |     −1 % |
| **Total**           | **85,310** | **≈ 81,700** | **−4 %** |

Read it straight: **candidate B is the least LOC-reductive of plausible v2
shapes** — roughly half the audit's −8 % — because it spends its budget on the
codec/processor/pipeline seams and the analyser stack. Its claim is complexity
concentration, not size: places-a-counter-is-spelled 7→1, audio seams 3→2,
tick polls 2→0, bespoke delivery machines 4→2, and one pipeline where v1 has
PTT-only lifecycle policy and prior projects grew two designs. If Jonas wants
the −8 %+ number, the event-spine collapse and analyser deferral are the
levers, both orthogonal to the pipeline center.

RAM: pipeline + codec beats generalize the existing 4-slot SPSC (+~100 B);
event ring 4 KiB; ref ring ~2.6 KiB (80 ms); analyser 112 B (spectral); SD
batching ~80 KiB PSRAM on SD boards only. StackChan AEC phase adds the
esp-sr budget (31–60 KB internal + 90–780 KB PSRAM + ~20 % core, review §4.5)
— gated on R4's IRAM clawback + PSRAM smoke landing first.

---

## 9. Honest cons and failure modes of THIS architecture

### 9.1 The addendum risk, owned

- **The periphery is 80 % of the module count and gets ~20 % of the design
  attention.** RPC, config, SD, events keep v1 shapes with light dedup. If the
  device fleet's future is mostly audio-less e-ink boards, candidate B
  optimized the minority. Mitigation is real but partial: the class-4 link set
  is CI-proven, and nothing in `core`/`events` imports audio headers
  (`device.h`'s `audio.h` include dies with the manifest→profile move —
  today `device.h:4` includes `audio.h`, dragging the mode enum everywhere).
- **Pipeline gravity.** When the best-designed component is the audio one,
  unrelated concerns migrate toward it (the leveler, taps, and timestamp
  publishing already live there legitimately; the failure mode is the next
  engineer putting _renderer_ or _SD_ logic on the owner task "because the
  frames are right there"). Guard: the owner-task loop has a per-beat work
  budget assertion, and taps are contractually O(frame)/no-locks.

### 9.2 Technical failure modes

- **The blocking beat is a philosophical break with v1's sans-I/O purity.**
  Pipeline tests need the scripted codec + thread fakes rather than pure
  function calls; a sloppy scripted codec could re-introduce real sleeps into
  L1 (budget rule: ≤5 s native suite — testing doc §2.4 — becomes the
  tripwire). If host-testability degrades measurably, the fallback is the
  hardware-plugability doc's nonblocking-event codec (Option C there), which
  keeps every other part of this candidate intact — the seam position is
  shared; only the clock discipline differs. This is Jonas decision #1.
- **Mode-machine swamp.** xiaozhi's `Application` shows how "one pipeline,
  three modes" degrades into a giant conditional state machine. Guard: modes
  select _policy structs_ (mic-open rule, commit rule, defer rule), never
  branch inside frame processing; the §4 table is the spec and "new mode = new
  policy row, zero new states" is an architecture test.
- **Codec abstraction vs descriptor identity.** Keeping descriptor tokens in
  the portable contract constrains codec impls (a future codec whose driver
  hides DMA slots must synthesize identities). Accepted cost: the identity
  proofs are the best physical-correctness asset in the tree.
- **AEC-inline-in-the-beat budget.** Class 2 runs FD AEC inside the beat
  (~6.4 ms of a 32 ms chunk at 20 %/core). A slow NLP setting or a future NS
  stage could overrun the beat and starve refills. Guard: per-stage µs
  telemetry with an over-budget counter (stackchan `audio_pipeline.c:220-274`)
  is a zero-tolerance endurance counter; the escape hatch is the feed/fetch
  worker split behind the same seam.
- **Analyser port before StackChan hardware exists** risks shelfware (+1,100
  LOC exercised only by host tests and the Stick status screen until CoreS3
  bring-up). Mitigation: land spectral+envelope only; MFCC and the sprite
  player stay in stackchan until a renderer consumes them.
- **Half-duplex fence inside the codec** makes the Stick codec impl the most
  complex of the four (~300 LOC with teardown ladder). A bug there now hides
  below the seam; the scripted-codec fence tests and the barge-in rig
  stopwatch are the compensating coverage.
- **Two-front risk with the codex agent**: the pipeline replaces exactly the
  files v1's agent is actively hardening (`audio.c`, capture pump, transports).
  §10's sequencing exists to keep the physical proof ladder green at every
  step; the real-world failure mode is merge friction and a long-lived
  divergence if v1 work continues past M2.

---

## 10. Migration/sequencing (codex agent mid-flight on v1)

Rules: the physical proof ladder (tone → PRBS → endurance → voice) must pass
after every milestone; acoustic thresholds never loosen; each anti-reduction
lands with the deletion that funds it; nothing touches files the v1 agent has
in flight without a coordination point.

- **M0 — safe-now, zero-conflict (can land during v1 flight):**
  CMake `add_iterate_kit_test()` (−710); dead code b1/b2/b4; atomics
  consolidation; host analyzer merge + `withTimeout` dedup; wire-constant
  generator (R10); **R4 chores** (IRAM clawback audit, PSRAM enable + smoke,
  placement-audit logging) — prerequisite for everything AEC-shaped.
- **M1 — the split (mechanical, coordinate with codex):** `components/core` →
  `core` + `audio` file moves; break `audio.h → peer.h`
  (`iterate_kit_poll_result` gets its own status enum); `device.h` drops
  `audio.h`; negative link test for the core-only build. Converts the
  text-grep boundary into linker truth; unblocks class-4 boards.
- **M2 — codec under the Stick, byte-identical:** Stick codec impl wrapping
  the existing I2sOps/BoardOps + new `esp_driver_i2s` PDM RX; capture pump
  moves to the audio task (R1); tick polls die (R5). Acceptance: tone + PRBS
  scenarios pass with thresholds unchanged, plus the NEW uplink echo-loop
  scenario (Mac speaker plays PRBS31 fixture; uplink-recorder provider;
  skipped-chip count is the physical regression test for the orphan fix —
  pre-M2 firmware should fail it under `--control-churn-hz` load, post-M2 must
  not).
- **M3 — pipeline + processor seam:** `audio_pipeline.c` subsumes the
  controller; null + fake processors; drained-edge + warmup as mode rules;
  scripted simulator codec; golden pipeline unit suite. Acceptance: full
  ladder + barge-in stopwatch ≤ 250 ms.
- **M4 — events periphery + SD:** event ring + X-macro table; capnweb sink
  generalization (behavioral suites from `metrics_subscription_test.c` +
  `m5sticks3_events_test.c` port and must pass against the new machinery
  before the old is deleted); metrics X-macro; SD sink portable core + host
  fake + simulator (hardware adapter rides the Waveshare bring-up — the only
  zero-conflict SD board).
- **M5 — host lane split + wire v2:** worker device-lane/upstream state
  machine + preroll + idle policy V-B; `timestamp_echo` processor + v2 header
  - rig alignment scenario (±20 ms vs PRBS ground truth).
- **M6 — StackChan phase:** ES8311 codec impl (+ AW88298 64·fs reg 0x06 fix
  verbatim, stackchan `audio_pipeline.c:174-208`); hardware-reference TDM
  capture with ISR sequence pairing; `esp_sr_fd_aec` processor; spectral
  analyser + one renderer; 3-phase AEC rig proof (ERLE ≥ 10 dB, damage
  < 3 dB); 3-channel diagnostic WAV rig (stackchan `docs/aec-validation.md`
  method + gates).

Waveshare audio bring-up is the seam's payoff test at any point after M6
starts: profile + pin table, ~0 new codec LOC (shares es8311.c).

---

## 11. Roads not taken

- **Events as the organizing spine** (the opposite candidate): rejected here —
  it optimizes the 80 % of modules that aren't the product's hard part, and
  the full collapse is the audit's one HIGH-risk item touching the control
  plane's correctness core mid-v1-flight.
- **ADF element/ringbuffer framework, ESPHome codegen, xiaozhi's class graph**:
  seam placement and scheduling policies transfer; machinery doesn't
  (review "explicitly not recommended", reaffirmed).
- **Per-stage ringbuffer chains between codec/processor/lane**: one buffering
  boundary per direction stays law (`pcm_lane` doctrine); the processor runs
  inline in the beat, not behind a queue.
- **FreeRTOS StreamBuffers anywhere near PCM**: structurally drop-newest with
  zero metrics — the stackchan disease (autopsy §5.2).
- **Opus now**: raw PCM v1 is settled, physically proven, and within Wi-Fi
  budget; revisit on battery/cellular pressure (record xiaozhi's settings:
  60 ms frames, DTX, complexity 0).
- **seekaudio engine**: eval-only blob pinned to esp-sr internals; steal only
  the MIT AECMOS/ERLE harness methodology.
- **MFCC viseme driver on device**: float + 20.8 KiB buys quality the 112-byte
  spectral driver approximates well enough for small sprites; MFCC runs
  host/userspace-side.
- **A universal HAL / runtime driver registry / board auto-detection**: link-time
  wiring in hand-written composition roots, one artifact per board.
- **QEMU/Wokwi emulation as a middle test layer**: timing infidelity makes it
  misleading; scripted codec + pthread fakes + the physical rig are the
  honest trio.

## 12. Decisions that belong to Jonas

1. **Blocking beat vs nonblocking event codec.** Candidate B's clock purity
   (cadence owned by DMA, one blocking call, esphome-style) vs the
   sans-I/O-everywhere alternative (nonblocking `next_event` drain, ~100 LOC
   more per platform impl, purer L1 story). This is the single deepest
   philosophical fork between the candidates; both preserve descriptor
   identity.
2. **Adopt the stackchan 40-byte render key + stage cues verbatim now, or a
   minimal 12-byte renderer input first?** Verbatim buys a tested,
   already-multi-device IR (and coarticulation/stage-direction headroom)
   at +~700 LOC of headers/converters before any avatar ships.
3. **Event periphery scope.** B keeps the metrics sampler and diagnostics
   snapshot outside the ring (−600, medium risk). The full spine collapse
   (−1,130, high risk) remains available later — do you want it in v2.0 at
   all, or is "one delivery machine, two data sources" the stable end state?
4. **PCM v2 header timing.** Ship the 16-byte header + timestamp echo + in-band
   commit in the first v2 firmware (my recommendation: it also fixes the
   commit race and unlocks the rig's alignment scenario), or keep wire v1
   pristine until server AEC has a product pull?
5. **Analysis component timing.** Land spectral/envelope + Stick status
   renderer pre-StackChan (keeps the tap honest, +1,100 LOC early), or gate
   the whole `components/analysis` on CoreS3 bring-up?
6. **Is a control-only (audio-less) target a near-term CI citizen** (build +
   simulator scenario now, hardware later), or does class 4 stay a guaranteed-
   by-link-test possibility until a real e-ink board lands?
