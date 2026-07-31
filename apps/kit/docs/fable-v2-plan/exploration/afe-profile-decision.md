# AFE profile decision: SR vs VC vs FD, and what StackChan runs

Date: 2026-07-31. Scope: settles the question the Jonas prior-art report
(`inputs/jonas-prior-art-report-2026-07-31.md` §2 finding 2, §3) reopens by
recommending "the VC (voice communication) profile — the one you want for
full-duplex calling" — against PLAN.md's D3/stage-5 choice of **standalone
FD_LOW_COST AEC + WebRTC VAD**. All sources verified live: local esp-sr clone
(master, CHANGELOG head 2.4.6), xiaozhi at `e0074e90` (2026-07-28),
esphome-audio-stack (2026-07-17) + esphome-intercom, esp-webrtc-solution
(2026-07-31) + esp-gmf `esp_capture` 1.0.2 (2026-07-24), iterate/stackchan,
the ESP Component Registry API, and the published esp-sr docs.

## 0. Verdict up front

- **The report's "use the VC profile for full-duplex calling" is REFUTED as a
  recommendation** — not because VC is wrong-headed, but because the report
  (written without live verification) predates or misses `AFE_TYPE_FD`, the
  profile Espressif added in esp-sr 2.4.3 (registry release **2026-04-28**,
  verified live) _specifically for_ full-duplex + barge-in, and now documents
  as the recommended default ("It is generally recommended to choose
  `AEC_MODE_FD_LOW_COST` for the best balance between performance and
  resource consumption" — live at
  docs.espressif.com/projects/esp-sr/en/latest/esp32s3/acoustic_echo_cancellation/README.html,
  same text in the clone at `docs/en/acoustic_echo_cancellation/README.rst:30-32`).
  The report says AFE "exposes two profiles" (SR and VC); the current enum has
  four (`esp_afe_config.h:34-39`).
- **PLAN.md D3/stage-5 stands: standalone `afe_aec` FD_LOW_COST + standalone
  WebRTC VAD.** Every live source checked either corroborates it or, where a
  shipping project chose differently (xiaozhi), the difference is explained by
  budgets and requirements we don't share (§2.1).
- **The D3 processor-seam contract text needs no change** (§5). One optional
  clarifying parenthesis is suggested.

## 1. SR vs VC vs FD, precisely

### 1.1 The types and what each is for

`afe_type_t` (`~/src/github.com/espressif/esp-sr/include/esp32s3/esp_afe_config.h:34-39`):

| Type                 | Header comment                                                                      | AEC engine used                          | Full-AFE pipeline (S3 benchmark, `docs/en/benchmark/README.rst:29-54`)            | Frame           | NLP-level knob                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `AFE_TYPE_SR` (0)    | "Speech recognition scenarios, excluding nonlinear noise suppression"               | `AEC_MODE_SR_*` — **linear filter only** | AEC → VAD(vadnet1) → WakeNet                                                      | 512 smp / 32 ms | n/a (no NLP)                                                                                            |
| `AFE_TYPE_VC` (1)    | "Voice communication scenarios, 16KHz input, including nonlinear noise suppression" | `AEC_MODE_VOIP_*`                        | AEC → **NS(nsnet2)** → VAD(vadnet1) — no WakeNet stage in the benchmarked configs | 256 smp / 16 ms | **inert** — "Currently, it is only effective for FD mode" (`acoustic_echo_cancellation/README.rst:117`) |
| `AFE_TYPE_VC_8K` (2) | same at 8 kHz input                                                                 | `AEC_MODE_VOIP_*`                        | (8 kHz variant; ADF's SIP/VoIP example uses it)                                   | 128 smp / 16 ms | inert                                                                                                   |
| `AFE_TYPE_FD` (3)    | "Full duplex scenarios, including nonlinear noise suppression"                      | `AEC_MODE_FD_*` — linear + tunable NLP   | AEC → VAD(vadnet1) → WakeNet — **no NS stage**                                    | 512 smp / 32 ms | **effective**: NORMAL / AGGR (default) / VERYAGGR (`esp_aec_nlp.h:9-13`, `esp_afe_config.h:100`)        |

The AEC engine itself exposes the linear/NLP split as separate calls —
`aec_linear_process()` then `aec_nlp_process()` (`esp_aec.h:111-120`), with
`aec_process()` doing both and `aec_set_nlp_level()` runtime-tunable
(`esp_aec.h:134`). The mode enum (`esp_aec.h:24-31`) has all three families:
SR (0/1), VOIP (3/4), FD (5/6).

Intended use, per the AEC doc's own scenario table
(`acoustic_echo_cancellation/README.rst:13-32`): SR = wake/command
recognition during playback (linear-only keeps the signal wake-word-friendly);
VOIP = "ordinary voice calls" (human on the far end, 8/16 kHz); FD =
"Full-Duplex dialogue scenarios" — the play-and-listen-simultaneously,
barge-in case, which is exactly our product requirement.

### 1.2 When FD arrived and what it changed

- CHANGELOG (`esp-sr/CHANGELOG.md`): **"2.4.3 — Add Full-Duplex AEC and AFE
  for esp32s3 and esp32p4."**
- Registry release date, verified live via
  `components.espressif.com/api/components/espressif/esp-sr/`: **2.4.3 =
  2026-04-28** (2.4.0 2026-03-19 … 2.4.6 2026-05-25, 2.4.7 2026-07-20). So FD
  is ~3 months old today — after the Jonas report's evident knowledge
  horizon, which is why the report frames the choice as SR-vs-VC.
- What it added: `AFE_TYPE_FD`, `AEC_MODE_FD_LOW_COST/HIGH_PERF` (enum values
  5/6), and the FD-only `aec_nlp_level` control surface. esphome-audio-stack
  annotates all of these "esp-sr 2.4+" (`esp_aec.cpp:51-67`,
  `esp_afe/__init__.py:84`).

### 1.3 Cost tables, restated with provenance

Standalone AEC, ESP32-S3 @240 MHz
(`acoustic_echo_cancellation/README.rst:140-183`; frame 32 ms for SR/FD,
16 ms for VOIP):

| Mode            | Internal RAM | PSRAM       | ms/frame    | CPU (1 core) |
| --------------- | ------------ | ----------- | ----------- | ------------ |
| SR_LOW_COST     | 18.8 KB      | 64.0 KB     | 2.29/32     | 7.2 %        |
| SR_HIGH_PERF    | 8.2 KB       | 100.1 KB    | 4.51/32     | 14.1 %       |
| VOIP_LOW_COST   | 26.9 KB      | 64.1 KB     | 4.37/16     | 27.3 %       |
| VOIP_HIGH_PERF  | 69.2 KB      | 66.6 KB     | 5.05/16     | 31.6 %       |
| **FD_LOW_COST** | **30.9 KB**  | **90.0 KB** | **6.28/32** | **19.6 %**   |
| FD_HIGH_PERF    | 20.3 KB      | 126.2 KB    | 8.08/32     | 25.3 %       |

Full AFE, ESP32-S3, MR input (`benchmark/README.rst:62-120`; feed column
carries the AEC, fetch carries the models):

| Config               | Internal    | PSRAM        | Feed CPU   | Fetch CPU |
| -------------------- | ----------- | ------------ | ---------- | --------- |
| MR, SR, LOW_COST     | 60.1 KB     | 739.7 KB     | 8.8 %      | 9.8 %     |
| **MR, FD, LOW_COST** | **60.2 KB** | **777.7 KB** | **12.1 %** | **9.8 %** |
| MR, FD, HIGH_PERF    | 49.2 KB     | 813.8 KB     | 12.5 %     | 9.8 %     |
| MR, VC, LOW_COST     | 48.7 KB     | 819.7 KB     | **30.6 %** | 4.7 %     |
| MR, VC, HIGH_PERF    | **91.1 KB** | 822.2 KB     | **32.2 %** | 4.7 %     |

Caveats that stay attached to these numbers: the S3 standalone table's
footnote says "ESP32-P4 @ 240 MHz" while listing S3 cache options (doc typo,
`README.rst:183`), and the P4 section of the full-AFE benchmark repeats the
S3 numbers verbatim — treat all of it as indicative, not lab-grade. (P4's own
standalone table shows FD_LOW_COST at 11.5 % @400 MHz — headroom if the
platform ever moves.)

Chunk sizes, confirmed: SR/FD types = **512 samples / 32 ms**, VOIP/VC =
**256 samples / 16 ms** (`README.rst:180-183`); always queried at runtime via
`aec_get_chunksize()` / `get_feed_chunksize()`, never hardcoded. Output
buffers for `afe_aec_process` must be 16-byte aligned (`esp_afe_aec.h:53-54`).
Standalone AEC is the only configuration that fits in double-digit KB of
PSRAM; every full-AFE config wants 0.74–1.24 MB.

## 2. What the four reference projects actually run (all verified in source)

### 2.1 xiaozhi — AFE_TYPE_VC, but only since July 19, and it doesn't transfer

Verified at `~/src/github.com/78/xiaozhi-esp32/main/audio/engines/afe_audio_engine.cc:128-151`:
`afe_config_init(fmt, models, AFE_TYPE_VC, AFE_MODE_HIGH_PERF)` with
`aec_mode = AEC_MODE_VOIP_HIGH_PERF`, `aec_nlp_level = AEC_NLP_LEVEL_VERYAGGR`,
`ns_init = false`, `agc_init = false`, `MORE_PSRAM`. The agent report's
claim is CONFIRMED — with a history the clone (depth 1) hides but the GitHub
API shows: commit `5f6c09b8` (2026-07-19, "feat: enhance BoxAudioCodec with
input gain and reference channel support") flipped
`AFE_TYPE_FD + AFE_MODE_LOW_COST + AEC_MODE_FD_LOW_COST` →
`AFE_TYPE_VC + AFE_MODE_HIGH_PERF + AEC_MODE_VOIP_HIGH_PERF`, keeping
VERYAGGR, with **no stated rationale** (the commit message is entirely about
reference-channel gain). `main/audio/README.md:22-24` still says "currently
uses FD_LOW_COST" — stale. So the one shipping project on VC **shipped FD for
the ~3 months before that**, and its switch is 12 days old, bundled into a
reference-gain tuning change, and undocumented.

Why xiaozhi's current choice doesn't transfer to StackChan:

- **Budget**: MR/VC/HIGH_PERF is benchmarked at 91.1 KB internal + 32.2 %
  feed CPU — over both our 31–60 KB internal envelope and our ~20 %-of-one-core
  budget (brief, "Hard constraints"). xiaozhi tolerates it: Opus complexity 0,
  60 ms frames, no 20 ms PCM-over-websocket loop, and the AFE is their whole
  DSP story.
- **The NLP lever they set is documented as inert for VOIP modes**
  (`acoustic_echo_cancellation/README.rst:117`: "only effective for FD
  mode") — their `AEC_NLP_LEVEL_VERYAGGR` line is a vestige of the FD config
  it replaced. Whatever suppression VOIP_HIGH_PERF applies is baked in, not
  tunable.
- **Requirement shape**: xiaozhi's uplink feeds ASR for an assistant;
  maximal echo suppression at the cost of near-end damage during double-talk
  is an acceptable trade there. Our goal doc gates StackChan on **<3 dB
  near-end damage during double-talk** with ≥10 dB echo reduction and spoken
  interruption (`physical-device-voice-goal.md:551`) — a barge-in-quality
  bar, which is the FD design point, and one that needs the NLP level to be
  _adjustable_ (FD-only capability).

### 2.2 esphome-audio-stack + esphome-intercom — FD for full duplex, in both processor shapes

The stack ships exactly the two shapes our topic names, and both offer FD:

- `esp_aec` (standalone `afe_aec_create` wrapper, `esp_aec.cpp:99`): default
  `sr_low_cost` — but the doc says why: "`sr_*` modes preserve a
  wake-word-friendly linear output and are the best default for **assistant
  devices**" (`docs/esp_aec.rst`). Full-duplex is called out separately.
- `esp_afe` (full AFE wrapper, `esp_afe.cpp:279-294`): all six presets;
  default type `sr`.
- The actual full-duplex intercom configs choose FD in both shapes:
  `yamls/full-experience/single-bus/generic-s3-full-aec.yaml:233-237` =
  `esp_aec` with `mode: fd_high_perf`;
  `spotpear-ball-v2-full-afe.yaml:373-385` = `esp_afe` with `type: fd`,
  `mode: high_perf`, `aec_nlp_level: normal`, NS+VAD+AGC on. Pin: esp-sr
  `^2.4.6` (`esp_afe/__init__.py:255`).

Nobody in this stack reaches for VOIP/VC for device full duplex.

### 2.3 esp-webrtc-solution's OpenAI demo — full AFE, **SR** type, not VC

The demo captures through `esp_capture_new_audio_aec_src`
(`solutions/openai_demo/main/media_sys.c:49-57`, ES7210 4-channel TDM with
`channel_mask = 1|2` = mic + reference on S3). That source lives in the
`esp_capture` registry component (pin `~1.0` via
`components/esp_webrtc/idf_component.yml`, resolving to 1.0.2, 2026-07-24 —
source in the esp-gmf clone), and it builds a **full AFE with
`AFE_TYPE_SR, AFE_MODE_LOW_COST`**
(`esp-gmf/packages/esp_capture/impl/capture_audio_src/capture_audio_aec_src.c:99`)
— linear-only AEC, leaning on OpenAI's server VAD for turn-taking and on the
Korvo/BOX boards' acoustic isolation. So Espressif's own flagship
voice-agent demo uses neither VC nor FD; a third data point against "VC is
the one you want", and a demonstration that with a clean hardware reference
plus server-side turn-taking, even linear-only AEC ships.

### 2.4 iterate/stackchan — standalone FD on our exact hardware, already measured

`experiments/02-minimal-realtime-aec/firmware-ws/main/audio_pipeline.c`:
standalone `aec_create_from_config` (`:810-813`) with mic_num/ref_num/out_num
1, `filter_length 4` (`app_config.h:54`), **`AEC_MODE_FD_HIGH_PERF`**
(`:34`; the `fable-cozmo-acting-2` worktree variant runs `FD_LOW_COST`),
`nlp_level 2` (VERYAGGR, `app_config.h:55`), and — notably —
`caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT`: the FD AEC ran with its state
in PSRAM on the CoreS3. It consumed the **hardware ES7210 TDM reference**
(slot 1 = MIC3 wired across the speaker output, `audio_pipeline.c:446-452`;
see `stackchan-autopsy.md` §3.2) with DMA-completion sequence-paired
alignment, and its acceptance rig gated **ERLE ≥ 12 dB after 750 ms,
near-end attenuation ≤ 8 dB** (`docs/aec-validation.md:67-80`). This is
in-house evidence that the FD family works on the exact silicon, codec
topology, and reference path StackChan will use — which materially discounts
the "FD is new in 2026" risk _for us specifically_.

## 3. The decision

Requirements being weighed (goal doc + brief): full-duplex voice call with
barge-in as the product requirement; hardware ES7210 reference channel;
**server VAD does turn-taking** ("StackChan is full-duplex with server VAD
and device AEC", `physical-device-voice-goal.md:531`; device VAD is only for
UI/events); CPU budget ~20 % of one core; 31–60 KB internal RAM; PSRAM fine;
small speaker near mic; no wake-word requirement.

| Candidate                            | CPU                            | Internal/PSRAM         | Double-talk story                                                                              | Disqualifier                                                                                                                                    |
| ------------------------------------ | ------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Standalone FD_LOW_COST** (chosen)  | 19.6 %                         | 30.9 / 90 KB           | designed for barge-in; NLP runtime-tunable NORMAL↔VERYAGGR                                     | —                                                                                                                                               |
| Standalone VOIP_LOW_COST / HIGH_PERF | 27.3 / 31.6 %                  | 26.9/64 / 69.2/67 KB   | suppression baked in; NLP knob documented inert                                                | CPU over budget; no double-talk tuning lever for the <3 dB bar                                                                                  |
| Full AFE_TYPE_VC (xiaozhi shape)     | 30.6–32.2 % feed + 4.7 % fetch | 48.7–91.1 KB / ~820 KB | same inert-NLP problem, plus NS we don't need (nsnet2 model partition)                         | CPU and (HIGH_PERF) internal RAM over budget                                                                                                    |
| Full AFE_TYPE_FD                     | 12.1 % feed + 9.8 % fetch      | 60.2 KB / 777.7 KB     | same FD AEC, but drags vadnet+WakeNet (the fetch cost), model partition, feed/fetch task split | pays ~700 KB PSRAM + 2× internal for WakeNet/vadnet/AGC we don't use; this is the G13 alternative already priced as "a different resource plan" |

**Decision: CONFIRM D3/stage-5 as written.** Standalone
`afe_aec_create`/`aec_create_from_config` in **FD_LOW_COST**, filter_length 4
(`esp_afe_aec.h:38-40`), hardware reference from ES7210 TDM slot 1, NLP level
default AGGR (the esp-sr default; stackchan ran VERYAGGR and still passed its
≤8 dB near-end gate, so tune on the rig), plus standalone WebRTC VAD
(`vad_create_with_param`, 16 kHz, 10/20/30 ms frames, no model partition —
`esp_vad.h:97-126`) for UI/event edges only. NS: none at first — note the FD
full-AFE pipeline ships without an NS stage too, and xiaozhi disables NS
entirely; if the small-speaker-near-mic enclosure proves noisy, `esp_ns`
(WebRTC mode, no model) can be added behind the same seam later.

Three additional facts that settle it beyond the table:

1. **Espressif's own recommendation is FD_LOW_COST** — the exact mode D3
   picked (`README.rst:30-32`, live).
2. **The only tunable echo-vs-near-end lever (NLP level) exists only in FD
   modes.** Meeting "≥10 dB echo reduction AND <3 dB near-end damage AND
   spoken interruption" will almost certainly require moving that lever
   during bring-up; VOIP/VC modes take it away.
3. **`aec_create_from_config` takes separate mic/ref buffers**
   (`esp_aec.h:96`), which matches the D3 seam signature
   `process(mic, reference)` with no interleave shim; the `afe_aec_*`
   wrapper is the interleaved-input alternative if we feed raw 4-slot TDM.

Maturity, stated honestly: FD is 3 months old (2.4.3, 2026-04-28) and the
prior-art study already warned "expect API movement". Mitigations: pin esp-sr
(xiaozhi pins `~2.4.7`, esphome-audio-stack `^2.4.6`); the API we depend on
(`aec_create_from_config`/`aec_process`/`aec_get_chunksize`/`aec_set_nlp_level`)
is the small, stable-shaped core; our own stackchan experiment plus two
shipping projects (xiaozhi pre-July-19, esphome-intercom today) have run FD
in the field; and the fallback ladder below has a working rung that predates
2.4.3 entirely.

## 4. Fallback ladder and bring-up triggers

All measurements come from the stage-5 rig scenarios (AEC proof + barge-in
stopwatch) and the stackchan-style 3-channel capture (raw mic / exact
speaker reference / AEC output, recorded in the same frame loop). Order:

1. **FD_LOW_COST, NLP AGGR** (start).
2. **Tune NLP in place** — it's a runtime call (`aec_set_nlp_level`):
   - Trigger up (→ VERYAGGR): far-end single-talk echo reduction < 10 dB
     after 750 ms adaptation with reference alignment already verified.
   - Trigger down (→ NORMAL): near-end damage > 3 dB during double-talk, or
     barge-in recognition failing while echo gates pass.
3. **FD_HIGH_PERF** — trigger: echo gates still failing at VERYAGGR.
   Cost: 25.3 % CPU (over budget — this rung requires re-opening the 20 %
   budget line with measurement in hand) but _less_ internal RAM (20.3 KB).
4. **Before any further rung: re-verify the reference**, not the algorithm —
   the 0–10 ms mic-lags-ref window, TDM slot mapping, and the AW88298
   64-BCLK shared-clock register (`stackchan-autopsy.md` §3.2). Both the ADF
   tree and our own prior art say misalignment is the most common cause of
   "AEC doesn't work".
5. **SR_LOW_COST + server-side assistance** — trigger: FD family burns too
   much CPU on the real image (frame time > ~9.4 ms i.e. 1.5× the 6.28 ms
   benchmark, or audio-task deadline misses in the capture-starvation
   scenario). Linear-only AEC at 7.2 % CPU / 18.8 KB, with the D7 timestamp
   echo giving the worker what it needs for residual suppression — the same
   posture as Espressif's OpenAI demo. Degrades echo quality, keeps duplex.
6. **VOIP_LOW_COST** — only if some FD-specific defect appears (instability,
   regression in a pinned upgrade): 27.3 % CPU, 16 ms frames (the seam's
   frame-size self-report absorbs the 256-sample change), fixed suppression.
   This rung exists mostly to record that we considered and deprioritized it.
7. **SeekAudio commercial conversation** — trigger: no esp-sr configuration
   passes the goal-doc gates on the real enclosure (prior-art study §5
   verdict stands: benchmark-credible, blob + eval license, esp-sr-pinned).

## 5. Impact on the D3 processor-seam contract: none required

Checking each clause of D3 (PLAN.md) and Q16 (synthesis §4) against the
chosen profile:

- "report your required frame size; a revision counter" — covers FD's 512
  just as it would VC's 256; `aec_get_chunksize()` is queried, not assumed.
  **Unchanged.**
- "the pipeline (not the processor) converts between the wire's 320-sample
  frames and the 512-sample frames esp-sr actually wants" — the 512 is
  correct for the chosen FD (and SR) modes. _Optional clarification:_ append
  "(512 for the chosen FD mode; the seam's frame-size report, not this
  number, is normative — VOIP modes would say 256)".
- "if the processor can't run, output silence — never raw microphone";
  "reference built only from complete frames"; "reference ring resets on
  capture session start/end" — all AEC-mode-independent. **Unchanged.**
- Implementation notes that ride along (not contract text): output buffers
  16-byte aligned (`esp_afe_aec.h:53-54`); 16 kHz/int16 only; and the NLP
  level should be surfaced as a per-board profile knob in stage 3 (it is the
  bring-up tuning lever, and stage 3 already says every profile value is
  reported through metrics so each run records the knobs it ran with).

## 6. Claim-by-claim verdicts

| Claim                                                                                  | Source                                               | Verdict                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AFE "exposes two profiles: SR and VC"; "VC — the one you want for full-duplex calling" | Jonas report §2.2, §3                                | **REFUTED / OUTDATED.** Four types exist (`esp_afe_config.h:34-39`); FD (added 2.4.3, 2026-04-28, registry-verified) is the full-duplex/barge-in profile and Espressif's recommended default. VC's VOIP AEC costs 27–32 % CPU and its NLP knob is documented inert. |
| AFE chunk "commonly 16 ms @ 16 kHz = 256 samples — verify"                             | Jonas report §1 (Tier 1, esp-sr)                     | **NUANCED.** True only for VC/VOIP; SR/FD = 512/32 ms (`README.rst:180-183`). The report's own "verify" hedge was warranted.                                                                                                                                        |
| "SR profile is tuned for wake-word... not conversational echo"                         | Jonas report §3                                      | **CONFIRMED** (linear-only, `esp_afe_config.h:35`) — but the omitted FD type, not VC, is the conversational answer.                                                                                                                                                 |
| xiaozhi uses `AFE_TYPE_VC` + `AEC_MODE_VOIP_HIGH_PERF` + NLP very-aggressive           | `inputs/agent-reports/xiaozhi.md` §4                 | **CONFIRMED** (`afe_audio_engine.cc:128-137`) — with the July-19 FD→VC switch history and the inert-NLP nuance added here.                                                                                                                                          |
| esphome-audio-stack supports AEC-only and full-AFE processors                          | topic statement                                      | **CONFIRMED**; both support FD, and the shipping full-duplex intercom configs choose FD in both shapes.                                                                                                                                                             |
| esp-webrtc-solution OpenAI demo's AEC                                                  | (new here)                                           | Full AFE via `esp_capture`, **AFE_TYPE_SR + LOW_COST** (`capture_audio_aec_src.c:99`, esp_capture 1.0.2) with ES7210 hardware reference — not VC.                                                                                                                   |
| Prior-art study's benchmark numbers and "FD-AEC added in 2.4.3 (2026-04)"              | `inputs/agent-reports/espressif-prior-art.md` §2, §7 | **CONFIRMED** against the local docs and, for the date, the live registry (2026-04-28).                                                                                                                                                                             |
| PLAN D3/stage-5: standalone FD_LOW_COST + WebRTC VAD, hardware ES7210 slot-1 reference | PLAN.md                                              | **CONFIRMED as the decision**, with the §4 ladder and §5 optional clarification.                                                                                                                                                                                    |
