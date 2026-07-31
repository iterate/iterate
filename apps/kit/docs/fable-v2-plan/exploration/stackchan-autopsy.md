# Autopsy: `~/src/github.com/iterate/stackchan` (read-only clone)

Exploration-round artifact for the kit v2 plan. Everything below cites
`<experiment-relative path>:<line>` inside
`~/src/github.com/iterate/stackchan/experiments/…`. The clone is a snapshot:
only 4 commits exist (`git log`: 2a7aec9 ← 742320b ← 20837fb ← 71bd2d9) and the
entire `firmware-ws/`, `firmware-sticks3/`, `tools/` trees plus most docs are
**uncommitted working-tree files** — there is no useful git history, so
"got worse over time" has to be reconstructed from the code and its own docs.

## 0. TL;DR

- The repo contains **three firmwares**: `02/firmware` (Espressif
  esp-webrtc-solution `openai_demo` port, abandoned), `02/firmware-ws` (the
  real one: continuous mic + esp-sr AEC + Grok/OpenAI Realtime + PCM face,
  ~69k LOC under `main/` of which only ~4.5k is the voice core — the rest is
  face-renderer sprawl), and `02/firmware-sticks3` (a 336-line M5StickS3
  sprite-face demo).
- **Harvest with both hands:** the pluggable face-analysis architecture
  (`face_algorithm_t` vtable, three allocation-free PCM→pose drivers at 60 B /
  112 B / 6.3 KiB state), the **40-byte `face_render_key_t` renderer IR + 32-byte
  sample-clock stage cues** (this _is_ the goal doc's renderer-input structure,
  already designed and tested), the sprite atlas format + player, the seqlock
  snapshot pattern, the DMA-completion face clock, the AEC hardware-reference
  discovery on CoreS3 (ES7210 TDM slot 1 = MIC3 wired across the speaker
  output), the AW88298 64·fs BCLK register fix, and the three-channel
  synchronized AEC validation rig with numeric gates.
- **Never repeat:** FreeRTOS StreamBuffers as PCM queues (forced drop-**newest**
  with zero metrics), a 12 s + 4 s unfenced downlink buffer chain, the mic pump
  time-sliced on a control task doing blocking 5 s TLS sends through
  `esp_websocket_client`'s shared lock, per-frame PSRAM heap churn plus a
  grow-only 1 MB event buffer, no generations/epochs anywhere, and 100 ms
  transfer quanta. Each observed symptom in the goal doc ("increasing delay,
  large TLS writes, queued microphone audio, jagged playback, memory
  pressure") maps to a specific line below (§5).
- **Servo choreography does not exist in this repo** (grep-verified: servos are
  only mentioned in docs/tables; experiment 01's upstream with servo code is
  gitignored and not present). **Wake handling does not exist either** — the
  design is continuous mic + provider `server_vad`. Nothing to steal on either
  axis; xiaozhi remains the wake/drain reference.

---

## 1. Repo layout

```
stackchan/
  experiments/01-ai-stackchan-ex-realtime/   # AI_StackChan_Ex bring-up. upstream/ gitignored
    docs/realtime-quality.md                 # honest teardown of why it felt bad (§5.6)
  experiments/02-minimal-realtime-aec/
    firmware/          # esp-webrtc-solution openai_demo CoreS3 port (committed, abandoned)
    firmware-ws/       # THE artifact: ESP-IDF, WS Realtime, esp-sr AEC, PCM face
      main/            # 121 files; audio_pipeline.c, realtime_client.c + ~40 face_* modules
      host/            # face_host_bridge.c — host/WASM adapter for the same C
      tests/           # ~80 native C tests/benches/dumps for the face stack
      managed_components/espressif__m5stack_core_s3/  # PATCHED BSP (I2S DMA tap, §4.3)
    firmware-sticks3/  # M5StickS3 240x135 sprite-face demo (M5Unified)
    tools/             # face_simulator.py, fake_grok_server.py, aec_lab.py,
                       # test_face_rig.py, make_grok_face_videos.py, face-grid/ (WASM),
                       # sprite-pipeline/ (atlas generator + characters)
    docs/              # architecture, pcm-face-rig, aec-validation, sprite pipeline,
                       # device-observability, claude-review, task-multi-device-abstraction
```

Weight distribution (from `wc -l`): `firmware-ws/main` totals ~69,317 lines;
`audio_pipeline.c` 1,247 + `realtime_client.c` 1,534 + leveler/status/wifi/web
≈ 4.5k form the whole voice path. The other ~60k lines are face renderer
variants (`face_render.c` alone is 5,770 lines; `face_closeup_toon_actors.c`
3,505; `face_mouth_study_redux.c` 3,264; four embedded sprite atlases at
0.6–1.4k lines each). That imbalance _is_ the "got worse over time" feeling:
the audio core stayed small and decent; the repo accreted ~40 renderer/actor
study modules that were never pruned.

---

## 2. (a) The viseme/phoneme algorithms — verbatim, with the shared contract

### 2.1 The shared driver contract (steal this interface nearly verbatim)

All analysers implement one vtable and emit one compact pose; the caller owns
all storage. `firmware-ws/main/face_driver.h:33-52`:

```c
typedef struct {
    const char *name;
    size_t state_size;
    size_t state_alignment;
    bool (*init)(void *state, uint32_t sample_rate,
                 const void *config, size_t config_size);
    void (*push_pcm)(void *state, const int16_t *samples,
                     size_t sample_count);
    void (*push_event)(void *state, const face_stream_event_t *event);
    void (*snapshot)(const void *state, face_pose_t *pose);
} face_algorithm_t;

/* A non-owning, allocation-free dispatch handle. The caller owns the selected
 * algorithm's state storage and its implementation-specific configuration. */
typedef struct {
    const face_algorithm_t *algorithm;
    void *state;
} face_driver_t;
```

Lifecycle/state events carry a **playout-clock dispatch marker** so text events
(transcripts, response-done) can be released in sync with the speaker rather
than network arrival — `face_driver.h:19-31`:

```c
typedef struct {
    face_stream_event_type_t type;
    /* Network-order marker and authoritative dispatch clock. A stream adapter
     * records the cumulative assistant PCM received when the event arrived,
     * then dispatches it when that marker reaches speaker playout. */
    uint32_t received_audio_samples;
    uint32_t dispatch_playout_samples;
    const char *utf8;
    size_t utf8_bytes;
    bool cumulative;
} face_stream_event_t;
```

The pose all three algorithms produce (`face_pose.h:39-56`): `frame_index`,
`playout_samples` (sample clock), `level` (energy), five mouth channels,
eye/gaze, `viseme`, `phoneme`, `confidence`, `activity`
(IDLE/LISTENING/THINKING/SPEAKING, `face_pose.h:27-32`), `speaking`. Note this
covers, field for field, the goal doc's renderer-input bullets (state, energy,
viseme, timing/confidence) before the richer IR (§4) is even involved.

All three drivers publish through an identical **seqlock**: odd/even
`published_sequence` bumped around every mutation
(`face_viseme.c:116-126`, snapshot spin at `face_viseme.c:729-748`,
`face_spectral.c:388-439`, `face_animator.c:314-365`). Audio writer never
blocks; display reader retries on torn reads. Production rule set
(`docs/architecture.md`, "Concurrency and allocation"): audio is the sole
writer; face analysis does **no heap, float (in the device-default driver),
FFT, queue send, lock, or logging**; LVGL redraws only when the visible pose
changed.

### 2.2 Candidate 1 — `FACE_ALGORITHM_VISEME`: MFCC + Gaussian-prototype

classifier (the "viseme determination algorithm")

`firmware-ws/main/face_viseme.c` (787 lines + `face_viseme_tables.inc`
generated tables + a 14,352-byte binary model). Provenance is explicit —
`face_viseme.c:8-12`:

```c
/* PCM acoustic front-end and Gaussian prototype classifier adapted from
 * met4citizen/HeadAudio (MIT, Copyright 2025 Mika Suominen). The immutable
 * English model remains a separate binary asset. See THIRD_PARTY_NOTICES.md. */
```

Model asset: `firmware-ws/main/assets/head_audio_model_en_mixed.bin`
(14,352 B = 39 prototypes × 368 B records; record layout: 8-byte header with
the viseme id at byte 7 and a packed UTF-16 phoneme pair in bytes 0-3, then 12
float means, then 78 floats of triangular inverse covariance —
`face_viseme.c:22-26,141-155,169-183`). 15-shape OVR-style vocabulary
(`face_pose.h:6-25`: AA E I O U PP SS TH DD FF KK NN RR CH SIL).

**How it consumes PCM** (`viseme_push_pcm`, `face_viseme.c:661-702`): per
sample — pre-emphasis (α=0.97), a 32-tap FIR (`filter_native_16k`,
`face_viseme.c:608-621`; coefficients in the generated `.inc`), into a
512-sample power-of-two ring; every 256-sample hop (16 ms at 16 kHz) it runs
`finish_feature`:

1. **Windowed FFT** — Hamming window + radix-2 in-place FFT with precomputed
   stage twiddles and 9-bit bit-reversal, no allocation
   (`hamming_fft`, `face_viseme.c:266-320`).
2. **Warped mel filterbank** — 40 triangular bands 30–7800 Hz, warped by
   `speaker_mean_hz/150` clamped to [0.6,1.8] (a cheap speaker-pitch
   adaptation knob), bins precomputed at init (`build_mel_bins`,
   `face_viseme.c:228-254`).
3. **12 MFCCs** via precomputed DCT rows, each passed through
   `tanhf(sum * lifter[i])` (`extract_features`, `face_viseme.c:322-367`).
4. **Classification** — Mahalanobis distance against every prototype using the
   stored triangular inverse covariance; silence prototypes get a sensitivity
   scaling; confidence = margin between best and second-best
   (`mahalanobis_distance` `face_viseme.c:369-390`, `classify`
   `face_viseme.c:398-447`):

```c
    float confidence = 0.0f;
    if (isfinite(second_distance)) {
        confidence =
            (second_distance - best_distance) /
            (fabsf(second_distance) + 1e-6f);
    }
```

5. **Temporal vote** — majority over a 4-hop ring (`vote`,
   `face_viseme.c:457-475`), primed with the first prediction on VAD open so
   onset is not delayed by an empty window (`prime_vote_on_speech`,
   `face_viseme.c:545-551`).
6. **Own hysteresis VAD** on mean |PCM| per hop: open ≥36, close ≤18 for
   4 hops (`update_pose`, `face_viseme.c:528-591`; defaults
   `face_viseme.c:64-77`).
7. **Pose synthesis** — viseme → 5-channel mouth targets from a shape table
   (`s_shapes`, `face_viseme.c:46-62`), energy-scaled opening
   (`speech_scale`, `face_viseme.c:513-526`), asymmetric attack/release EMA
   (45/85 ms converted to u8 alphas, `smoothing_alpha` `face_viseme.c:187-200`,
   `smooth_u8` `face_viseme.c:202-221`), plus deterministic idle blink/gaze
   (xorshift seeded by the sample clock — `update_idle_motion`,
   `face_viseme.c:477-511`).

Costs (host-measured, `docs/pcm-face-rig.md:200-205`): state 6,472 B + model
14,352 B; float math + 62.5 FFT/s. Fine on host/WASM and as the crosspost
analyser in the kit userspace `/pcm` worker; heaviest option for device.

### 2.3 Candidate 2 — `FACE_ALGORITHM_SPECTRAL`: fixed-point 7-band Goertzel

(the "second candidate algorithm")

`firmware-ws/main/face_spectral.c` (450 lines). Integer-only, **112-byte
state**, no FFT, no retained PCM, no model. The analysis core, verbatim:

Band set + window (`face_spectral.c:6-20`):

```c
enum {
    ANALYSIS_WINDOW_SAMPLES = 320,          /* 20 ms @ 16 kHz */
    COEFFICIENT_SCALE = 16384,              /* Q14 */
    TRIANGLE_PEAK_INDEX = ANALYSIS_WINDOW_SAMPLES / 2 - 1,
    ...
};
/* 2*cos(2*pi*f/16000) in Q14 for:
 * 350, 550, 800, 1100, 1600, 2400, and 3200 Hz. */
static const int16_t BAND_COEFFICIENTS[FACE_SPECTRAL_BAND_COUNT] = {
    32459, 32007, 31164, 29758, 26510, 19261, 10126,
};
```

Per-sample recurrence with a triangular window applied on the way in
(`spectral_push_pcm`, `face_spectral.c:320-363`):

```c
        const uint32_t triangle_index =
            state->window_fill <= TRIANGLE_PEAK_INDEX
                ? state->window_fill
                : ANALYSIS_WINDOW_SAMPLES - 1U - state->window_fill;
        const int32_t window_weight =
            (int32_t)(triangle_index * UINT8_MAX / TRIANGLE_PEAK_INDEX);
        const int32_t windowed = (sample / 16) * window_weight / UINT8_MAX;

        state->sum_abs += magnitude;
        for (size_t band = 0; band < FACE_SPECTRAL_BAND_COUNT; ++band) {
            const int32_t recurrence =
                windowed +
                (int32_t)((int64_t)BAND_COEFFICIENTS[band] *
                          state->recurrence_1[band] / COEFFICIENT_SCALE) -
                state->recurrence_2[band];
            state->recurrence_2[band] = state->recurrence_1[band];
            state->recurrence_1[band] = recurrence;
        }
```

Window close → band energies (`goertzel_energy`, `face_spectral.c:100-111`)
and a formant-heuristic classifier (`classify_shape`,
`face_spectral.c:143-190`) — verbatim, because this is the whole trick:

```c
    const uint64_t fricative = energies[FACE_SPECTRAL_BAND_COUNT - 1];
    if (fricative * 100U >= total * state->config.fricative_percent) {
        *confidence = ratio_u8(fricative, total);
        return FACE_VISEME_SS;                      /* sibilant */
    }
    const uint8_t first_formant =
        strongest_band(energies, 0, 3, &low_sum, &low_winner);   /* 350/550/800 */
    const uint8_t second_formant =
        strongest_band(energies, 3, 3, &high_sum, &high_winner); /* 1100/1600/2400 */
    ...
    if (first_formant == 2) return FACE_VISEME_AA;      /* high F1 = open */
    if (first_formant == 1)
        return second_formant == 0 ? FACE_VISEME_O      /* mid F1, low F2 */
                                   : FACE_VISEME_E;
    return second_formant == 0 ? FACE_VISEME_U          /* low F1, low F2 */
                               : FACE_VISEME_I;
```

Energy gate first (`mouth_open_for_level`, floor 220, range 4400 —
`face_spectral.c:40-47,88-98`), then viseme shapes from a 7-entry table
(`VOWEL_SHAPES`, `face_spectral.c:30-38`), percent-based attack/release
(72/22/58, `smooth_value` `face_spectral.c:70-86`), confidence = min of the
two formant-group dominance ratios. ~7 multiply-accumulate per sample + a
per-20 ms classify: well under 1 % of one S3 core. **This is the on-device v2
candidate.**

### 2.4 Baseline — `FACE_ALGORITHM_ENVELOPE` (what the CoreS3 firmware

actually shipped with)

`firmware-ws/main/face_animator.c` (408 lines, 60-byte state, integer-only).
10 ms windows (`ANALYSIS_WINDOWS_PER_SECOND = 100`, `face_animator.c:6-10`):
mean |PCM| → mouth open through floor 256 / range 4600 (tuned against real
levelled Grok speech, comment at `face_animator.c:12-22`), 75 %/25 %
attack/release, and **zero-crossing rate → mouth width** so fricatives read
differently without any spectral analysis (`mouth_width_for_crossings`,
`face_animator.c:76-89`); width also drives round/teeth heuristically
(`face_animator.c:163-174`). A `listening_lock` closes the mouth while the
_user_ speaks so downlink-tail echo can't animate the face
(`face_animator.c:134-141,268-293`). The production firmware wires this one
directly into the AEC task (`audio_pipeline.c:714-716`); viseme/spectral are
selectable through the same vtable on host/WASM
(`host/face_host_bridge.c:17-24`).

**Which is "the existing algorithm" vs "the second candidate":** the MFCC
`FACE_ALGORITHM_VISEME` is the repo's own "viseme determination algorithm" (it
literally emits viseme+phoneme+confidence); `FACE_ALGORITHM_SPECTRAL` is the
second candidate built to answer "how far can 112 bytes of integer state go".
The envelope driver is the control group all comparisons run against. All
three are behind one interface precisely so the choice can be A/B'd on the
same PCM (`docs/pcm-face-rig.md:81-85`).

### 2.5 Properties worth keeping as _requirements_, not just code

- **Packet-boundary invariance**: same pose for the same PCM regardless of
  WebSocket chunking; enforced by hash-equality across two different
  packetisations in `tools/test_face_rig.py` (`docs/pcm-face-rig.md:163-165`).
- **Playout-clocked, not network-clocked**: PCM is fed at the last point
  before sound leaves (completed TX DMA buffers, §3.2), so a 12 s network
  buffer can't make the mouth lead the speaker
  (`docs/architecture.md` "The face tap is inside the audio task…").
- Measured onset: PCM-to-mouth 9.9375 ms; regression gate at 20 ms
  (`docs/pcm-face-rig.md:166,203`).
- Deterministic idle motion from the sample clock (xorshift + schedule), so
  replays are bit-exact (`face_animator.c:24-31,91-132`).

---

## 3. (b) AEC / DSP integration

### 3.1 What the shipped pipeline uses

esp-sr **standalone AEC** (not the full AFE), configured at
`audio_pipeline.c:803-826`:

```c
    aec_config_t config = {
        .mic_num = 1, .ref_num = 1, .out_num = 1,
        .filter_length = STACKCHAN_AEC_FILTER_LENGTH,     /* 4  (app_config.h:54) */
        .sample_rate = STACKCHAN_AUDIO_SAMPLE_RATE,       /* 16 kHz */
        .caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT,      /* AEC state in PSRAM */
        .mode = STACKCHAN_AEC_MODE,                       /* AEC_MODE_FD_HIGH_PERF (:34) */
        .nlp_level = (aec_nlp_level_t)STACKCHAN_AEC_NLP_LEVEL,  /* 2 (:55) */
    };
    s_aec = aec_create_from_config(&config);
    s_frame_samples = (size_t)aec_get_chunksize(s_aec);   /* frame owned by AEC */
```

Processing is split **linear + NLP with separate µs timing per stage**
(`audio_pipeline.c:731-736`): `aec_linear_process(s_aec, raw, ref, clean)` then
`aec_nlp_process(s_aec, clean)`; NLP aggressiveness is runtime-switchable and
applied **only by the owning AEC task** via an atomic request slot
(`audio_pipeline.c:723-730`, setter `:992-1002`) — the same
mutation-by-owner discipline the architecture review found in xiaozhi.

### 3.2 The reference story — two references, one big discovery

**Discovery (headline): the CoreS3 has a _hardware_ AEC reference.** The
ES7210 is run in 4-slot TDM; slot 1 carries MIC3, which "is wired to an
analogue divider across the speaker output and is therefore clock-synchronous
with the near mic" (`audio_pipeline.c:446-452`, gain setup `:469-482`,
`STACKCHAN_TDM_NEAR_INDEX 0` / `STACKCHAN_TDM_REFERENCE_INDEX 1`
`:38-39`). This falsifies the earlier review's assumption
(`docs/claude-review.md:34-40`) that CoreS3 has no loopback — that review was
written against the abandoned `02/firmware` WebRTC port and predates the TDM
find. Consequence for kit v2: **StackChan device AEC can use a hardware
reference; the R11 software TX-tap is the fallback, not the plan.**

To make 4-slot TDM RX coexist with the AW88298 speaker on the _shared_ I2S
peripheral, the amp must be told to expect 64 BCLK/LRCK
(`configure_speaker_for_shared_tdm_clock`, `audio_pipeline.c:174-208`):
read-modify-write-verify of AW88298 reg 0x06 to `0x20` (64·fs). Hard-won
board knowledge; copy verbatim when kit's StackChan bring-up starts.

**Both signals are captured at DMA completion, not at read() return.** The BSP
managed component is patched with `on_sent`/`on_recv` I2S event callbacks that
assign monotonic sequence numbers per direction and forward the raw DMA buffer
to an app tap
(`managed_components/espressif__m5stack_core_s3/m5stack_core_s3_idf5.c:27-75,138-163,238-251`).
The ISR-side tap copies 128-sample chunks into two static 8-deep queues,
deinterleaving near/reference from the 4-channel TDM buffer and tracking
per-slot peaks (`audio_i2s_tap`, `audio_pipeline.c:486-557`). Depth is a
deliberate freshness decision — `audio_pipeline.c:44-50`:

```c
/* Eight completed 8 ms DMA chunks cover two complete 32 ms AEC frames.
 * A 16-entry queue retained 128 ms of stale audio in internal SRAM and could
 * itself mask scheduling problems. ... */
#define STACKCHAN_I2S_TAP_QUEUE_DEPTH 8
```

Mic/ref alignment is by **sequence-number pairing with skip-forward resync**
(`receive_aligned_dma_pair`, `audio_pipeline.c:559-608`): block on both
queues, compare sequences, drop the older side until they match, count
`s_tap_sequence_skips`. This plus the ISR tap is the strongest alignment
mechanism in any of the studied prior art (ADF only offers a debug-dump
method) — steal the pattern for kit's mic-lags-ref 0–10 ms contract.

A runtime **reference pre-delay ring** (0–64 ms, default 0) delays only the
signal the AEC sees, never audible playback
(`prepare_aec_reference`, `audio_pipeline.c:296-335`; knob setter
`:970-984`). The un-delayed reference and the raw mic stay in every
diagnostic capture.

Task shape (`app_config.h:59-63`): `aec_task` prio 8, core 1, does
pair-assembly → face push → reference-delay → AEC → diagnostics → clean-out;
`audio_task` prio 12, core 1, only services the two blocking codec calls
(`audio_task` comment `audio_pipeline.c:610-614`: "do no DSP here; the
authoritative AEC inputs come from the completed DMA buffers"). RX prime:
2 startup frames drained so the duplex clock starts aligned
(`audio_pipeline.c:627-636`).

### 3.3 The AEC acceptance rig (steal the method + thresholds)

`docs/aec-validation.md`: firmware records one synchronized 3-channel 16 kHz
WAV — ch0 raw mic, ch1 exact PCM written to the speaker path, ch2 AEC output —
**all written in the same audio-frame loop** ("recording the speaker reference
in a different task would hide timing and queue errors — the most common
reason an apparently configured AEC fails", `aec-validation.md:17-19`).
HTTP: `POST /api/diag/signal|start`, `GET /api/diag/status|capture.wav`
(`:21-28`). Host harness `tools/aec_lab.py` runs far-end / near-end /
double-talk fixtures with a self-test that must produce known-good and
known-bad outputs first (`:35-44`). Initial gates (`:67-80`): ERLE ≥ 12 dB
after 750 ms; reference-correlation reduction ≥ 6 dB; near-end attenuation
≤ 8 dB; raw/clean similarity ≥ 0.80; clipping ≤ 0.1 %. These numbers are a
ready-made acceptance spec for the goal doc's "AEC provably works".

### 3.4 The abandoned WebRTC track (why it matters anyway)

`02/firmware` (committed): esp-webrtc-solution `openai_demo` port —
`webrtc.c` 601 lines, `media_sys.c`, `openai_signaling.c`. Its post-mortem
(`docs/claude-review.md`) documents a class of bug kit must design against:
the esp_capture AEC source defaulted to `mic_layout="MR"` while the board
supplied one channel, so the AFE **overread its feed buffer** and "AEC output
is undefined" (`claude-review.md:44-64`). Lesson generalized: an AEC seam must
carry an explicit, validated frame-spec (channels/layout/rate) — exactly the
`frame_spec()/frame_spec_revision()` shape recommendation R2 already makes.
Also there: the PSRAM cache-config regression list (`claude-review.md:118-135`,
32 KB icache / 64 KB dcache / 64 B lines) worth checking when kit enables
PSRAM (R4).

---

## 4. (c) The renderer input shape — already the goal doc's structure

### 4.1 The 12/40-byte layered IR

`face_keyframe.h:16-39` — a 12-byte endian-independent control prefix
(`mouth_open/width/round/press/teeth`, per-eye open, gaze, brow, `expression`
= activity state, flags; `_Static_assert(sizeof == 12)`).

`face_keyframe.h:62-129` — the full 40-byte `face_render_key_t` (schema
version 2, `_Static_assert(sizeof == 40)`), layered by byte ranges (the header
comment maps them): controls prefix; `viseme`, `phoneme`, `viseme_weight`,
`audio_level`; **`viseme_set` vocabulary selector** (OVR15 / VRM5 / Preston9 /
Microsoft22 / custom, `face_keyframe.h:46-53`) + `viseme_secondary` +
`viseme_blend` for coarticulation + `speech_phase`
(IDLE/STARTING/ACTIVE/ENDING, `:55-60`); reduced FACS-ish upper/lower-face
actions (mouth corners, tongue, cheek, squints, three brow channels); affect
(`valence`/`arousal`); head/body performance (`head_roll/yaw/pitch`,
`body_lean`), `expression_weight`, `attention`, `schema_version`,
`stage_expression`. Two deliberately separate axes —
`face_keyframe.h:80-85`:

```
`controls.expression` remains the conversational activity state ...
(idle/listening/thinking/speaking). `stage_expression` is the independent
authored/AI-directed emotion. Keeping those axes separate prevents a "joy"
cue from accidentally turning an activity-aware renderer idle.
```

1,200 bytes/s at 30 fps; "deliberately richer than any one renderer"
(`face_keyframe.h:86-89`). Converters both ways:
`face_render_key_from_pose` / `face_pose_apply_render_key`
(`face_keyframe.h:131-134`).

### 4.2 Stage directions: 32-byte sample-clock cues

`face_stage.h:72-98` — `face_stage_cue_t` (`_Static_assert == 32`):
`start/attack/hold/release` in **samples** on the shared 16 kHz playout clock,
`cue_id`, expression (11-entry taxonomy `face_stage.h:14-28`), gesture
(NOD/SHAKE/TILT/LEAN_IN/BOUNCE), gaze target, blend mode
(REPLACE/ADD/MAX), easing (LINEAR/SMOOTHSTEP/OVERSHOOT), **interrupt policy**
(BLEND/CUT/QUEUE), intensity, VAD-style `valence/arousal/dominance`.
`face_stage_cue_apply(cue, sample_clock, render_key)` mixes cues into the
dense IR **without touching articulation bytes** (`face_stage.h:100-108`,
impl `face_stage.c`). This is the goal doc's "explicit future stage
directions" solved: sparse authored/AI cues resolve onto the same 40-byte
frame the audio analysers fill.

### 4.3 How sprite renderers consume it

`face_sprite_sheet.h` defines a flash-resident, validation-first atlas format
(magic `FSPR` v2): palette-indexed cells (raw or PackBits), painter-order
compositing base→brows→eyes→pupils→mouth→overlay (`:9-26`), expression
**banks chosen by proximity in action space, not by enum**
(`face_sprite_expression_target_t`, `:135-147` — valence/arousal/corner/brow/
squint distance keeps atlases compatible with "local audio, authored
animation, and future AI stage-direction producers"), a viseme→mouth-slot map
per vocabulary with a 9-role canonical fallback (`:44-60,166-175`), selector
thresholds incl. `explicit_viseme_min` to ignore low-confidence recognizer
output (`:199-217`), and **all timing in 16 kHz samples**
(`face_sprite_timing_t`, `:219-231` — mouth min-hold 70 ms, close-delay
120 ms, blink phases, saccade, breathe). Entry points render into any
caller-owned RGB565 surface with stride (`face_sprite_surface_t` `:291-297`,
`face_sprite_render_to` `:323-327`); a backwards clock jump resets playback
for deterministic replay (`:308-311`). Player state is 24 bytes
(`face_sprite_player_t`, `:271-284`); no allocation anywhere.

Proof it ports: `firmware-sticks3/main/app_main.cpp` drives the same atlas
player on an M5StickS3 at 240×135/30 fps from a 63 KB PSRAM framebuffer with
M5Unified `pushImage` (`app_main.cpp:23-33,249-268,286-296`), building
`face_render_key_t` by hand (PTT → LISTENING activity, mic level → EMA'd
`audio_level`, expression targets table) — i.e. the IR already served both a
CoreS3/LVGL device and a Stick/M5GFX device plus WASM Canvas from one C
codebase. CoreS3 display side: LVGL timer at 33 ms pulls
`audio_pipeline_face_snapshot` → `face_render_key_from_pose` → registry
renderer (`ui.c:69-101`).

### 4.4 Fit against the goal doc's required structure

| Goal-doc bullet                            | Where it already exists                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| idle/listening/thinking/speaking           | `face_pose_t.activity` + `controls.expression` + `speech_phase`                                                               |
| audio energy/envelope                      | `face_pose_t.level` (u16 mean-abs) + IR `audio_level` (u8)                                                                    |
| existing viseme algorithm output           | `viseme`/`phoneme`/`confidence` (MFCC driver)                                                                                 |
| second candidate output                    | same fields from spectral driver; `viseme_secondary`+`viseme_blend` allow carrying both                                       |
| explicit future stage directions           | `face_stage_cue_t` + `stage_expression` axis                                                                                  |
| timing/confidence for coherent transitions | `playout_samples` sample clock, `dispatch_playout_samples` event gating, `confidence`, `viseme_weight`, sprite `timing` block |

Verdict: **do not redesign this structure — adopt it** (rename freely). The
only genuine v2 deltas: wrap it in the kit event shape (path/type/payload)
for SD-card logging/stream crossposting, and specify units/provenance per
field in one header comment block.

---

## 5. (d) The audio queueing autopsy — where the delay and jaggedness lived

### 5.1 The full dataflow with every buffer (firmware-ws, Grok track)

```
DOWNLINK
 Grok WS ──(esp_websocket_client task, prio 5, 8 KB buffer)──▶ accept_output_pcm
   └ s_message_buffer: grow-only PSRAM, up to 1 MB           [realtime_client.c:1139-1155]
 ▶ s_output_stream  StreamBuffer 12 s / 384,000 B PSRAM      [app_config.h:41; realtime_client.c:39-42]
 ▶ playout_task (prio 7, PSRAM stack) 100 ms chunks          [realtime_client.c:727-817]
 ▶ s_playback      StreamBuffer 4 s / 128,000 B PSRAM        [audio_pipeline.c:27-28,839-841]
 ▶ audio_task (prio 12, core 1): 0-timeout read, zero-fill,
   leveler, blocking esp_codec_dev_write                     [audio_pipeline.c:642-665]
 ▶ AW88298 speaker
UPLINK
 ES7210 TDM DMA ISR ─▶ rx tap queue (8×8 ms static)          [audio_pipeline.c:50,96-98]
 ▶ aec_task (prio 8, core 1): pair, AEC, face push
 ▶ s_clean         StreamBuffer 200 ms / 6,400 B PSRAM       [app_config.h:52; audio_pipeline.c:29-33]
 ▶ control_task (prio 6, PSRAM stack): 20 ms event-wait loop,
   read 100 ms chunk, leveler, BLOCKING ws send (≤5 s)       [realtime_client.c:654-710,501-503]
 ▶ esp_websocket_client (shared lock with RX) ─▶ TLS ─▶ Grok
```

Worst-case queued audio downstream of the network: **16.2 s**. Uplink
transfer quantum: 100 ms. No epochs, no generation counters, no residence-time
or depth metrics on any of the four stream buffers (drop counters exist only
for output-stream overflow, `realtime_client.c:910-927`).

### 5.2 "Queued microphone audio" — drop-newest with zero telemetry

`audio_pipeline.c:744-747`:

```c
        if (xStreamBufferSpacesAvailable(s_clean) >= frame_bytes) {
            (void)xStreamBufferSend(s_clean, s_clean_frame, frame_bytes, 0);
        }
```

When `s_clean` (200 ms) is full, the **newest** AEC frame silently vanishes —
no counter, no log (contrast: everything else in the file is metered). Any
consumer stall > 200 ms therefore yields: buffer permanently holding the
_oldest_ 200 ms (a fixed +200 ms staleness plateau on every uplinked sample)
plus an unrecorded mid-word gap. The consumer stalls easily, because:

- The mic pump shares `control_task` with session config, cancel handling,
  probes **and reconnects**; `restart_websocket()` runs stop+start with up to
  3×500 ms retries on that same task (`realtime_client.c:398-427,664-665`).
- Each send is `esp_websocket_client_send_bin(..., pdMS_TO_TICKS(5000))`
  (`realtime_client.c:501-503`); the client serializes send with its receive
  path over one lock, so a fat downlink burst delays the mic send.
- Even the happy path pays a 20 ms `xEventGroupWaitBits` per loop iteration
  (`realtime_client.c:658-662`).

FreeRTOS `StreamBuffer` **cannot drop-oldest** (no overwrite semantics), so
the data structure forced the wrong freshness policy. Kit v1's SPSC ring +
epoch purge is the correct inversion; keep it.

### 5.3 "Increasing delay" — 16 s of unfenced buffer and no age policy

- `STACKCHAN_REALTIME_OUTPUT_BUFFER_SECONDS 12` (`app_config.h:41`) admits an
  entire provider response burst; `PLAYBACK_BUFFER_BYTES` adds 4 s
  (`audio_pipeline.c:27-28`). Nothing ever examines the _age_ of queued audio;
  the only bound is space.
- Turn-end is detected by **polling both buffers empty**
  (`finish_playout_if_drained`, `realtime_client.c:712-725`) — buffer depth
  directly extends the perceived turn, and any stuck byte wedges the state
  machine.
- Barge-in does flush (`request_output_flush` `realtime_client.c:365-369` +
  reset in `playout_task` `:731-734`), but the flush is two non-atomic resets
  on different tasks with a re-arm window: a chunk already copied into
  `playout_task`'s local 100 ms buffer before the flag flips is still written
  _after_ the pipeline flush (flag rechecks at `:744-746,786` shrink but do
  not close the window). With no generation tag on the PCM, stale audio is
  indistinguishable from fresh.
- No `i2s_channel_tune_rate` / depth controller: provider-vs-DAC clock drift
  during long responses surfaces as slowly growing depth, and there is no
  metric that would even show it (depth is only read for the drained check).
- Session VAD config adds a fixed 1,000 ms `silence_duration_ms` + 400 ms
  prefix padding (`realtime_client.c:56-60`) on top of pipeline latency — the
  perceived "the robot keeps getting slower" is the sum of a policy constant
  plus the unmeasured queue growth above.

### 5.4 "Jagged playback"

1. **No device-side prebuffer**: `audio_task` reads with timeout 0 and
   zero-fills any shortfall (`audio_pipeline.c:646-655`), so the first frame
   of every response and every marginal scheduling hiccup becomes an audible
   zero-gap + click. The _host simulator_ got a 40 ms prebuffer
   (`docs/architecture.md` "Real-time mode uses ... a 40 ms prebuffer");
   the firmware never did. Underruns are at least counted
   (`app_status_note_playback_underrun`).
2. **Silent tail drop on backpressure** — `realtime_client.c:784-791`:

```c
        while (written < output_samples && !flush_requested) {
            const size_t count = audio_pipeline_write_playback(
                output + written, output_samples - written,
                pdMS_TO_TICKS(100));
            if (count == 0) {
                break;              /* rest of the 100 ms chunk is DISCARDED, unmetered */
            }
```

When `s_playback` stays full >100 ms, mid-utterance samples are thrown away
with no counter (`s_played_output_samples` counts only what was written). 3. 100 ms burst granularity through two byte-oriented buffers means frame
boundaries do not survive transport; partial reads are legal at every hop
(`audio_task` explicitly handles "received > 0 && received < frame_bytes").

### 5.5 "Large TLS writes" and "memory pressure"

- OpenAI/JSON track: each 100 ms mic chunk becomes ~12.9 KB
  (`{"type":"input_audio_buffer.append","audio":"…"}` around 4,800 resampled
  samples base64'd) allocated fresh from PSRAM per send
  (`realtime_client.c:521-552`) against an 8,192 B WS client buffer
  (`app_config.h:43`) — multi-fragment TLS writes under the shared client
  lock. Grok/binary track is 3,200 B per 100 ms — better, but still a 100 ms
  latency quantum vs kit's 20 ms/640 B.
- Downlink JSON deltas: per-event malloc/free of the decoded PCM
  (`accept_output_audio`, `realtime_client.c:938-957`), full cJSON parse per
  event (`:960-967`), and a **grow-only** reassembly buffer that permanently
  keeps the largest event ever seen, capped only by
  `STACKCHAN_REALTIME_MAX_EVENT_BYTES` = 1 MB
  (`app_config.h:42`, `realtime_client.c:1139-1155`).
- Task stacks for control/playout/AEC live in PSRAM
  (`xTaskCreateWithCaps(..., MALLOC_CAP_SPIRAM)`,
  `realtime_client.c:1339-1354`; `audio_pipeline.c:872-876` for the AEC task)
  — a realtime task taking cache misses on its own stack.
- Exp01 (`docs/realtime-quality.md:17,27-30`) shows the ancestral form of the
  same disease: base64 JSON audio plus `while (Speaker.isPlaying())` **inside
  the WebSocket callback**, and serial logging in the audio loop. That is the
  "older StackChan buffering design" at its most extreme; firmware-ws fixed
  the callback-blocking but retained the deep-buffer, big-quantum shape.

### 5.6 What kit v1 already does right against each mechanism (keep!)

Drop-newest → epoch purge/drop-oldest with counters; 16 s buffers → 32-slot
(640 ms) rings + capture-age ceiling + peer-delivery guard; no generations →
five-counter fencing to DMA teardown; 100 ms quantum → 20 ms frames; blocking
shared-lock sends → sans-I/O tx + nonblocking sockets on a dedicated PCM task;
polled turn-end → in-band zero-length EOS. The stackchan autopsy is the
strongest empirical argument for those exact v1 properties; v2 must not trade
any of them away.

---

## 6. (e) Everything else worth stealing

| Item                                                                                                                                                                                                                                                                        | Where                                                                                                | Why                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Speech leveler (Q16 gain table + soft-knee limiter at 29490, per-frame metrics: limited/overrange/peaks)                                                                                                                                                                    | `speech_leveler.c:1-60+`, wired at `audio_pipeline.c:276-294` and uplink `realtime_client.c:698-701` | Tiny, integer, tested (`tests/speech_leveler_test.c`); kit has no leveler yet and Grok output needed +8 dB (`app_config.h:49`)                  |
| Per-stage audio timing telemetry (frame/write/read/reference/AEC-linear/AEC-NLP µs, last/max/avg + over-budget counter, epoch-reset)                                                                                                                                        | `audio_pipeline.c:220-274,1004-1101`                                                                 | Exactly the observability the goal doc demands, already shaped for a metrics capability                                                         |
| ISR-tap + sequence pairing + per-slot peak meters                                                                                                                                                                                                                           | `audio_pipeline.c:486-608` + patched BSP                                                             | The mic/ref alignment mechanism for R11's 0–10 ms contract                                                                                      |
| 3-channel synchronized diagnostic WAV + HTTP diag API + `aec_lab.py` gates                                                                                                                                                                                                  | `docs/aec-validation.md`, `diagnostics.c`, `tools/aec_lab.py`                                        | Ready acceptance rig for "AEC provably works"                                                                                                   |
| Deterministic host rig: `fake_grok_server.py` (protocol subset, configurable packetisation, injected stall, absolute-deadline pacing), `face_simulator.py` (realtime/virtual clock), `test_face_rig.py` (hash-equality across packetisations, 250 ms stall → ~25 underruns) | `tools/`, `docs/pcm-face-rig.md:87-171`                                                              | Complements kit's sans-I/O harness with a provider-protocol-level fake; the stall-injection + hash-equality patterns port directly              |
| Real-provider video evidence rig (capture real Grok PCM + WS frame manifest → run production C → MP4 with waveform/packet overlay)                                                                                                                                          | `tools/make_grok_face_videos.py`, `docs/pcm-face-rig.md:129-148`                                     | The visual analog of kit's acoustic oracle; ideal for face-quality review with Jonas                                                            |
| Sprite atlas toolchain (generator, per-device builds, contact-sheet review, Grok multimodal advisory critique with manual verification rule)                                                                                                                                | `tools/sprite-pipeline/`, `docs/sprite-avatar-pipeline.md`, `run_face_render_quality.py`             | Asset pipeline exists; characters already built (mossling, gameboy-bot, karakuri-brass, starbyte, dot-matrix-oracle) incl. Stick-sized variants |
| WASM face grid (six algorithm/config combos side-by-side on deterministic or live PCM)                                                                                                                                                                                      | `tools/face-grid/`, `docs/wasm-face-grid.md`                                                         | The A/B instrument for choosing v2's device analyser                                                                                            |
| Multi-device abstraction sketch (capability matrix: display/duplex/mic topology/speaker reference/talk modality/indicators/actuators; "PTT on Stick and open-mic on Voice PE should be the same session with a different talk-modality gate")                               | `docs/task-multi-device-abstraction.md`                                                              | Independently converges with the brief's req 4/12; the capability-axes table is worth lifting into the v2 plan                                  |
| AW88298 volume-curve extension (BSP's declared 15 dB PA gain leaves stock 0 dB max at −15 dB; extend curve to reach M5Stack's own 0 dB)                                                                                                                                     | `audio_pipeline.c:152-165`                                                                           | Explains "why is the CoreS3 quiet" before anyone loses a day to it                                                                              |
| RX prime-frame drain at duplex start                                                                                                                                                                                                                                        | `audio_pipeline.c:621-636`                                                                           | Same family as kit's warmup discard; the duplex-clock-alignment rationale is written down                                                       |
| Deterministic xorshift idle motion (blink/gaze schedules advanced by playout samples)                                                                                                                                                                                       | `face_animator.c:24-31,91-132`                                                                       | Replayable "aliveness" with zero RNG state issues                                                                                               |

**Servo choreography: absent.** `grep -ri servo` across firmware and tools
matches only docs tables and a node*modules README; experiment 01's upstream
(AI_StackChan_Ex, which does drive the serial servos) is gitignored and not in
the clone. If v2 wants servo motion tied to the IR, the natural place already
exists (`head_yaw/head_pitch/head_roll/body_lean*\*`in`face_render_key_t` —
a servo renderer is just another consumer), but there is no prior
implementation here to harvest.

**Wake handling: absent by design** (continuous mic + `server_vad`,
`realtime_client.c:56-60`). Nothing to take; xiaozhi's drain-before-mic-open +
warmup remains the reference per the architecture review §4.6.

---

## 7. How the harvested pieces slot into portable-C v2

The architecture review already reserves the slot: `components/analysis`
consuming the R2 `audio_processor` seam's output as "a second, non-realtime
consumer" (review §5, R2). Concretely:

```
components/analysis/                         (portable, allocation-free, no floats on device path)
  face_pose.h            ← verbatim (rename face_→kit_ if desired)
  face_keyframe.h        ← verbatim 12-byte prefix + 40-byte render key
  face_stage.h/.c        ← verbatim 32-byte stage cues
  face_driver.h/.c       ← the analyser vtable; s/face_algorithm/kit_face_analyser/
  analyser_envelope.c    ← face_animator.c (60 B state; integer)
  analyser_spectral.c    ← face_spectral.c (112 B state; integer; device default)
  analyser_viseme.c      ← face_viseme.c + tables (host/userspace build only: float, 6.3 KiB + 14 KiB model)
components/audio         (review R2/R3)
  audio_processor seam → after `process()` produces the playback frame the
  platform writes, the SAME completed-DMA identity kit already tracks
  (RealtimePlayback EOF timestamps) feeds analyser.push_pcm — the stackchan
  face clock (§2.5) mapped onto kit's existing descriptor-identity machinery.
devices/*
  renderers = consumers of face_render_key_t:
    sprite renderer      ← face_sprite_sheet.h/.c + one atlas per device
    LED-ring renderer    ← new, trivial: activity+level+affect → ring pattern (HA Voice PE)
    servo renderer       ← new, head_yaw/pitch/roll → servo targets (StackChan)
```

Integration sketch (kit idiom — snapshot pulled by the display/background
lane, events from the device event stream):

```c
/* boot (target composition root): storage static, algorithm chosen per profile */
static kit_face_analyser_state_spectral s_face_state;      /* 112 B */
static kit_face_driver s_face;
kit_face_driver_init(&s_face, &KIT_FACE_ANALYSER_SPECTRAL,
                     &s_face_state, sizeof s_face_state,
                     16000, NULL, 0);

/* audio owner, after a descriptor completes playout (already have the frame + EOF ts) */
kit_face_driver_push_pcm(&s_face, completed_frame_pcm, 320);

/* control lane, on itx events — SAME event objects that go to SD-card log */
kit_face_driver_push_event(&s_face, &(face_stream_event_t){
    .type = FACE_STREAM_ASSISTANT_RESPONSE_STARTED,
    .received_audio_samples = downlink_samples_received,
    .dispatch_playout_samples = playout_samples,          /* gate on playout clock */
});

/* display tick (30 Hz), never blocks the writer */
face_pose_t pose;  face_render_key_t key;
kit_face_driver_snapshot(&s_face, &pose);
face_render_key_from_pose(&pose, &key);
face_sprite_render_to(&player, &key, pose.playout_samples, &surface);
```

Sizing/budget: spectral analyser ≈ 7 MAC/sample + 20 ms classify ⇒ ≪1 % of a
core; sprite render of a 240×135 frame proved viable at 30 fps on the Stick
alongside M5Unified (§4.3). The 40-byte IR at 30 fps is 1.2 KB/s — cheap
enough to crosspost to the os stream (brief req 8) or SD log verbatim.

The `face_stream_event_t` marker pattern (`received_audio_samples` →
`dispatch_playout_samples`) is exactly how kit should sync provider-side
events (transcripts, speak start/end) to the device's playout clock when the
userspace `/pcm` worker crossposts them.

## 8. Roads NOT to take (with reasons)

- **Do not port the renderer zoo.** ~60k LOC of `face_*` actor/study variants
  exist because visual exploration happened in-repo and nothing was deleted.
  v2 takes the sprite player + at most one procedural renderer; exploration
  stays in the stackchan repo/WASM grid.
- **No FreeRTOS StreamBuffers for PCM** (§5.2 — byte-oriented, no frame
  boundaries, structurally drop-newest). Kit's SPSC frame rings are strictly
  better.
- **No esp_websocket_client** — reconfirmed by §5.2/§5.5; kit's ws-transport
  replacement decision stands.
- **No 100 ms chunk quanta, no JSON/base64 audio path** — wire v1's
  640 B/20 ms binary framing is settled and better on every axis measured
  here.
- **Not the esp-webrtc track** (`02/firmware`): heavyweight, wrong protocol
  for kit's dual-socket design; keep only its post-mortem lessons (§3.4).
- **Do not adopt the MFCC driver on-device by default** — float + 20.8 KiB
  (state+model) buys mouth-shape quality that the 112-byte spectral driver
  already approximates well enough for 160×120 sprites; run MFCC host-side
  where its output can be compared and streamed down as IR if ever wanted.
- **Do not copy the LVGL coupling** — the sprite renderer's surface API is
  already display-agnostic; kit devices should keep pushing RGB565 directly.
