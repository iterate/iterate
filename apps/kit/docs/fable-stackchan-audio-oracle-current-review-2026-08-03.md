# StackChan audio-oracle and harness simplification review — 2026-08-03

Reviewer: Claude Fable (maximum effort), read-only pass over the working tree at
`c-capabilities` (all StackChan audio work is uncommitted on top of
`29be889c9`). Everything below was verified against source and raw evidence;
every number was re-read from the artifact named beside it, not from prior
reports.

Anchors inspected:

- `apps/kit/scripts/prove-production-stackchan-grok.ts` (H) and every gate
  module it imports
- `apps/kit/scripts/prove-local-aec.ts`, `apps/kit/scripts/prove-production-aec-waveform.ts`,
  shared oracle `apps/kit/src/device/aec-waveform-assessment.ts`
- `apps/kit/src/userspace/config-worker/pcm-proxy.ts`, `worker.ts`,
  `providers.ts`, `server-vad-policy.ts`, `pcm-diagnostic-capture.ts`
- Firmware: `platforms/iterate_core_s3_audio/core_s3_audio_owner.c`,
  `components/core/src/{aec_capture_bridge,aec_reference_scaler,aec_uplink_selector,pcm_uplink_conductor,pcm_clock_playback,pcm_capture_turn}.c`
- Evidence: `stackchan-analog-reference-voip-20260803/2026-08-03T18-00-26-107Z`
  (written by `prove-production-aec-waveform.ts` — its `failure.json` stack says
  so; the run is not a `prove-local-aec.ts` product),
  `stackchan-production-grok-receipt-fix-20260803/2026-08-03T18-19-08-334Z`,
  `stackchan-grok-uplink-incident-20260803/*` (the "Hey pal" capture corpus),
  `stackchan-vad-replay-20260803/README.md`

Per instruction, the solved transport question was not reopened. It was
re-verified once and holds: in the 18:19 run `failure.json → worker.terminal`
reads 364 items sent, 364 acknowledged, 0 in flight, 357 receipts, 0 receipt
timeouts, 3/3 interruption barriers, `downlinkDroppedBytes ===
downlinkInterruptedBytes === 316,554` (all drops are the planned purge),
socket open at the end, and `network.json` shows flat socket counters with
RSSI −39…−43 dBm. `digital.passed: true`. Nothing below weakens the gates that
proved this.

---

## 1. Verdict

**The device did not fail the 18:19 run the way the harness says it did.**
Decomposing both newest "failures" against source:

1. **Every hard failure recorded at 18:19 except one is a harness artifact.**
   The `aec.assessment` reasons ("clean/input ratio 4.000, expected 0.5–2",
   "playback reset 3 times", "discarded 8 frames during reset") are the legacy
   per-window oracle (`stackchan-aec-assessment.ts:164-183, 185-307`) meeting
   the _new_ firmware architecture: the raw uplink branch is deliberately ×4
   (`aec_uplink_selector.c:89-95`, wired `core_s3_audio_owner.c:1366`), and the
   3 playback resets _are_ the 3 interruption barriers the same run's digital
   gate requires. The acoustic gate failed a reply that its own independent STT
   heard ("It is clear and audible.") because zero of 278 energy windows crossed
   a threshold derived from one ambient spike (`activeThresholdRms 1030.6` =
   2.5 × ambient max 412.2; response max RMS 391.9). The avatar failures
   (framebuffer size, 58.6 ms LCD transfer) are real but not audio.
2. **The one real acoustic/semantic event is double-talk near damage at the
   provider.** Grok transcribed the barge-in utterance "Stop and reply exactly
   interruption test complete" as "Open reply. Production test complete."
   That matches the 18:00 waveform measurement: during double-talk the clean
   uplink preserves the near phrase with _less_ unexplained noise than the
   repeat control (degradation-from-repeat **−0.88 dB**, i.e. better) but
   ducked to **gain 0.583** (−4.7 dB). Ducked-but-clean near speech at a
   provider whose input transcription is already fragile on short phrases is
   sufficient to explain the mangling. No far-end content leaked: residual↔far
   similarity **0.005** against a 0.2 limit.
3. **The double-talk gates that "failed" at 18:00 are arithmetically
   self-defeating, not evidence of echo.** Details in §3; the far-leak −40 dB
   energy branch cannot be satisfied by a perfect canceller in this room, and
   the 0.85 preservation-similarity floor is unreachable at any gain below
   ≈ 0.63 while the gain gate explicitly licenses 0.5.
4. **The short-greeting mistranscription is now a corpus, not an anecdote.**
   Four same-protocol "Hey pal." captures with retained accepted-uplink PCM +
   sha256: 16:54 → **"Hey Pal."** (correct), 18:07 → "Hey now." → **"Playtime."**,
   18:37 → "Hey now." → **"PayPal."** All conserve frames (122/137 frames,
   cadence clean), so this is audio-content and provider variance, not
   transport. Firmware already root-caused one contributor: the retained slot-0
   capture has a broad 4.5–5.7 kHz interference shelf ("Hey pal" → "PayPal" at
   the independent STT oracle), and the working tree moves the near mic to TDM
   slot 2 (`core_s3_audio_owner.c:401-420`, `CORE_S3_TDM_NEAR_SLOT 2U` at `:71`).
5. **VAD self-trigger is currently clean but ungated.** The 18:19 run had
   exactly 3 `speech_started`, all paired to scripted utterances. The replay
   ladder (`stackchan-vad-replay-20260803/README.md`) shows why this must stay
   a standing gate: real speaker-only audio from the prior firmware at ×4
   opened **three false VAD turns** ("Yeah", "Stop", "Hi") despite passing an
   18.64 dB ERLE check, while near-only speech needs ×8 to be heard at all.

The oracle stack requested in the prompt (seven separations) turns out to be
**~85 % built**. What is missing is wiring, not machinery: per-turn accepted-PCM
retention in the Grok proof, replay-with-expectations as a scripted gate, gate
arithmetic corrections, and exporting four firmware counters that already
exist. §5 gives the five actions.

---

## 2. What today's evidence proves, layer by layer

The seven separations the prompt asks for, with the current witness and its
measured state:

| #   | Layer                                   | Current witness                                                                                                                                                                     | Measured state (today)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Raw mic hardware                        | near slot capture on the raw branch (selector raw ×4 when reference silent) + independent STT                                                                                       | Slot 0 has a 4.5–5.7 kHz shelf → "PayPal"; slot 2 experiment in tree, discriminating run not yet retained. Per-slot peaks (`tdm_slot_peak[0..3]`, `core_s3_audio_owner.c:836-837`) are collected but **unexported**                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2   | Local AEC far-only suppression          | `prove-production-aec-waveform.ts` far phases through the deployed worker (deterministic fixture, `kit-pcm-mode=tone`)                                                              | **PASS with margin**: clean −42.11 dBFS (tone), −45.39 (PRBS31), −46.76 (speech-shaped) vs limit max(−40, ambient+6 dB = −39.15); source similarity ≤ 0.0087; clean lands at/below the −45.17 dBFS ambient floor                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3   | Double-talk near preservation           | same harness, double-talk phase vs near-repeat control                                                                                                                              | Near phrase retained: far-leak similarity 0.005, unexplained-noise −0.88 dB _better_ than control; but **ducked to gain 0.583**. The two "failures" are gate arithmetic (§3)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 4   | Exact accepted PCM                      | `PcmDiagnosticCapture` in the deployed worker (`onAcceptedUplinkPcm`, post-gain, post-provider-accept — `pcm-proxy.ts:954-979`), sha256 persisted per phase by the waveform harness | Exists and proven — but **absent from the production Grok proof**: the 18:19 evidence has no PCM artifact for the mangled barge-in turn. The 6 s / 300-frame single-slot arm/finish RPC (`worker.ts:172-216`) is the seam                                                                                                                                                                                                                                                                                                                                                                                                        |
| 5   | Grok transcription/provider behavior    | raw `provider-events.jsonl` (journaled verbatim to `/devices/stackchan`), `replay-production-grok-vad-pcm.ts`                                                                       | grok-transcribe revises within one turn ("Hey now." → "Playtime.") and flips across identical protocol runs (16:54 correct, 18:07/18:37 wrong). Transcription events carry **no confidence/model fields**. Replay uses the identical `session.update` builder — VAD triple 0.1/500 ms/400 ms byte-identical by construction (`providers.ts:536-556`); only `instructions` and the sprite tool differ (`replay-production-grok-vad-pcm.ts:43-44`). `keep_context: true` biases later turns toward session vocabulary — "Open reply. **Production** test complete." echoes turn 1's phrase; fresh-session replay removes that bias |
| 6   | Physical speaker playout                | Mac mic energy gates (currently) — but the device already has three better witnesses                                                                                                | Mac gate false-missed an audible reply (STT heard it; 0/278 windows over threshold). Available instead: the analog divider **is a wire to the speaker** (`referencePeak 25,880` during far windows in the same run's AEC metrics), `lifetimePlaybackContentSamples` delta, ISR-level `playout_observer_frames` / `physicalPlayoutSampleClock` (`core_s3_audio_owner.c:771-781`, avatar metrics)                                                                                                                                                                                                                                  |
| 7   | VAD self-trigger vs genuine near speech | provider `speech_started` counting (exact-turn digital gate H:1690-1709) + the replay ladder                                                                                        | 18:19: 3/3 planned, zero self-triggers at threshold 0.1 with current firmware. Ladder: near ×4 → no edge; near ×8/×16 → exactly 1 edge + correct transcript; speaker-only (old firmware) ×4 → **3 false edges**. There is **no device VAD at all** — server VAD is the only VAD in the system (`pcm_capture_turn.c:143-155`; PTT rejected at `devices/stackchan/stackchan.c:59-62`)                                                                                                                                                                                                                                              |

Supporting facts worth pinning (all verified in-source):

- The AEC reference is the **electrical speaker divider (TDM slot 1) ×8
  saturating** (`aec_reference_scaler.c:11-36`, applied
  `core_s3_audio_owner.c:856-861`); the exact completed TX DMA PCM is a
  _separate fourth lane_ consumed only by the uplink selector as the far-active
  oracle (`core_s3_audio_owner.c:641-648`). Two stale comments still claim the
  opposite (`core_s3_audio_owner.h:60-66`, `targets/stackchan/main/main.c:1178-1183`)
  and will mislead the next reader.
- Uplink provenance is invisible on the wire: raw ×4 vs processed ×8 frames are
  byte-indistinguishable, and the selector's `raw_frames` / `processed_frames` /
  `clipped_samples` counters are never exported (grep-verified). Server VAD
  threshold 0.1 was restored **on the explicit premise** that AEC removes
  self-talk (`providers.ts:539-553`); nothing currently measures that premise
  per run.
- Reference pairing is healthy under the receipt-fix firmware: pair skew max
  1,354 µs against the 4 ms destroy/recreate guard
  (`CORE_S3_REFERENCE_PAIR_MAXIMUM_SKEW_US`, `core_s3_audio_owner.c:59`),
  `lifetimeReferencePairResets` flat at 1 across the 18:00 run.

---

## 3. The two double-talk gates are measuring the wrong thing

`assessAecWaveformRun` (`apps/kit/src/device/aec-waveform-assessment.ts:107-133`)
is the shared oracle for both AEC harnesses. Its far-only and near-only gates
are sound (they passed with margin). Its double-talk phase has two defects,
both confirmed by recomputation from the run's own numbers:

**(a) The far-leak energy branch is unsatisfiable in this room.** The gate
demands residual energy ≤ −40 dB relative to the far source
(`:132-133, 332-341`). The residual is built by subtracting `gain ×`
(near-only capture) from the double-talk capture (`:520-537`), so it
mechanically contains **two** captures' ambient: √(180.7² + (0.583·180.7)²) ≈
209 RMS ≈ **−20.6 dB** relative to the 2,250-RMS far source — a _perfect_
canceller fails this branch by ~19 dB. The measured −12.47 dB is ambient plus
the level-modulated near speech. The branch that actually detects speaker
content — correlation of the residual against the known PRBS source — measured
**0.005** against a 0.2 limit. Delete the energy branch (or floor it at
ambient-derived attainability); keep the similarity branch.

**(b) The preservation-similarity floor contradicts the gain gate.** Similarity
is fully determined by the fitted gain and residual:
`sim = g / √(g² + nE/refE)` (`:504-517`). Double-talk measured g = 0.5827,
residual −8.211 dB ⇒ nE/refE = 0.151 ⇒ sim = 0.832 — exactly the failing
number. The passing repeat control had _more_ relative noise (0.185). With
double-talk's own noise, sim ≥ 0.85 requires g ≥ 0.627; the gain gate licenses
g ≥ 0.5 (`:116`). So any duck in the licensed 0.5–0.63 band fails on similarity
arithmetic alone. Gate instead on what each number means: keep `gain ∈ [0.5, 2]`
(duplex duck bound), keep `residualDegradationFromRepeat ≤ 8 dB` (distortion,
measured −0.88 dB), keep far-leak similarity ≤ 0.2 (echo), and drop the
redundant composite similarity floor — or evaluate it gain-normalized.

Whether a 0.583 duck is _acceptable to Grok_ is not a waveform question — it is
exactly what the replay oracle answers (§5, action 2): replay
`double-talk.accepted-uplink.pcm` into a fresh production-config session and
require a speech edge plus near-phrase tokens.

Also in this family: the run-level reason `"The PCM recorder did not close
complete."` at 18:00 was a single 72 ms inter-frame **arrival** gap against the
fixed 60 ms limit (`production-aec-diagnostic-capture.ts:9-11, 307-313`) on the
near-repeat phase, with frames fully conserved and the device reporting a 65 ms
transport-accept stall (9 consecutive send deferrals) — a Wi-Fi hiccup, already
the network-validity family's business, mislabeled as a recorder failure by a
message inherited from the local-recorder path (`aec-waveform-assessment.ts:406`).

---

## 4. The oracle stack (proposed shape)

Principles: one witness per layer; byte identity via the already-recorded
`pcmSha256`; deterministic stimuli (the fixture's fixed-seed PRBS31/tone/speech-
shaped renderers and the fixed `say` WAV); **replay as the inner loop** (fresh
session, production config) so firmware changes are judged in minutes without a
room. Everything references an existing seam:

| #   | Layer                           | Oracle                                                                                                                                                                                                         | Stimulus                                                                       | Seam                                                                                                                   | Pass rule                                                                                                  |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Raw mic quality                 | independent STT (`--sample-rate 16000`) + spectral inspection of a raw-branch capture; per-slot peaks                                                                                                          | fixed "Hey pal." / `mac-near-source.wav`, speaker silent (selector raw branch) | `capture-production-stackchan-grok-uplink.ts` (already loops arm→speak→finish→persist) + `tdm_slot_peak` export (§5.5) | STT text contains "pal"; no 4.5–5.7 kHz shelf; slot-peak pattern matches divider-on-slot-1                 |
| 2   | Far-only suppression            | clean-uplink RMS + source-similarity (unchanged)                                                                                                                                                               | deterministic fixture far phases through deployed worker                       | `prove-production-aec-waveform.ts` + `deterministic-aec-fixture.ts`                                                    | existing thresholds (passing today)                                                                        |
| 3   | Double-talk preservation        | corrected waveform gates (§3) **and** semantic replay of the same capture                                                                                                                                      | fixture PRBS + fixed near WAV                                                  | `aec-waveform-assessment.ts` + `replay-production-grok-vad-pcm.ts`                                                     | gain ≥ 0.5, degradation ≤ 8 dB, far-sim ≤ 0.2; replay yields 1 speech edge + near-phrase tokens            |
| 4   | Exact accepted PCM              | per-turn `PcmDiagnosticCapture` snapshot + sha256 in evidence                                                                                                                                                  | every near prompt in the Grok proof                                            | `worker.ts:172-216` RPCs; persist pattern from `prove-production-aec-waveform.ts:857-888`                              | every turn's PCM retained, ordinal-conserved; sha256 recorded                                              |
| 5   | Provider behavior               | N-replay distribution on identical bytes; verbatim event journal (exists)                                                                                                                                      | retained accepted PCM (e.g. the four "Hey pal" captures)                       | `replay-production-grok-vad-pcm.ts` with expectations; `provider-events.jsonl`                                         | ≥ k/N replays transcribe the phrase ⇒ audio fine, live miss = provider/context; ≤ k ⇒ uplink audio damaged |
| 6   | Physical playout                | electrical: divider `referenceMeanAbsolute/Peak` active during response windows; `lifetimePlaybackContentSamples` delta; `physicalPlayoutSampleClock` advance. Acoustic: Mac STT as _witness_, not energy gate | normal responses                                                               | AEC/avatar metrics (exported today); `xai-streaming-stt.ts` on the response window                                     | divider energy present for every response; STT of window shares ≥ 60 % tokens with provider transcript     |
| 7   | VAD self-trigger vs near speech | live: `speech_started` delta == planned turns (exists, H:1690-1709). Bench: speaker-only replay rung                                                                                                           | real assistant speech captured far-only; near-only capture as control          | vad-replay method, scripted                                                                                            | speaker-only replay at deployed gain: **0** edges; near-only control: exactly 1 edge + transcript          |

The identity chain that makes a failed turn attributable in one pass:
near-end AIFF (stimulus) → accepted-uplink.pcm + sha256 (layer 4) → live
provider events (layer 5 live) → N fresh-session replays of the same bytes
(layer 5 bench) → independent STT of the same bytes (vendor-shared but
socket-independent; `vad_threshold=0`, so treat its short-clip readings as
evidence about audio, not ground truth about words).

---

## 5. Five near-term actions, in rank order

**1. Retain the exact accepted PCM for every turn of the production Grok
proof.** Seam: `prove-production-stackchan-grok.ts` already holds the worker
handle; call `startPcmDiagnosticCapture(300)` before each `playMacSpeech` and
`finishPcmDiagnosticCapture()` after the turn-terminal wait, persisting
`turn-<n>.accepted-uplink.pcm` + sha256 exactly as
`prove-production-aec-waveform.ts:837-888` does per phase (the capture RPCs:
`apps/kit/src/userspace/config-worker/worker.ts:172-216`; 300 frames = 6 s
covers every scripted prompt; barge-in needs two arms, one per utterance).
**Pass:** every turn in the evidence dir has a conserved capture
(ordinal span == frames, `truncatedFrames 0`) with sha256; a mangled transcript
now always has its bytes. **Fail:** any turn without a conserved capture.

**2. Make replay an asserting gate, and run it on the retained corpus.** Seam:
`replay-production-grok-vad-pcm.ts` — add `--expect-edges N`,
`--expect-tokens "…"`, `--sessions K` (fresh session per replay; pass
`instructions: undefined, enableSpriteSetTool: true` for byte-identical
production `session.update`). Then: (a) the four "Hey pal" captures
(`stackchan-grok-uplink-incident-20260803/*/accepted-uplink.pcm`) × 5 sessions —
if ≥ 4/5 transcribe "pal" the live misses are provider variance/context;
if ≤ 2/5 the uplink audio is damaged and layer 1/3 owns it; (b)
`double-talk.accepted-uplink.pcm` from the 18:00 run — **pass:** 1 speech edge

- ≥ 60 % of the near-phrase tokens (answers whether the 0.583 duck survives
  Grok); (c) far-only `far-speech-shaped.accepted-uplink.pcm` — **pass:** 0
  edges. This is the fast inner loop the script's own docstring promises; today
  it prints events and asserts nothing.

**3. Gate surgery — delete the five false-failure generators in one commit,
keeping the protected families intact.**

- `prove-production-stackchan-grok.ts:698-705, 880-893`: replace transcript
  _equality_ with (i) far-leak detection — fail only if any input transcript
  contains a ≥ 3-token n-gram of the assistant's own `response.output_audio_transcript.done`
  text (known verbatim per turn), and (ii) recorded token-overlap WER against
  the prompt, failing only below 0.5. The exact-turn counters (H:1690-1709)
  already catch echo-opened turns and stay untouched.
- `physical-speech-transcription.ts:73-100`: drop the 2.5× ambient-max RMS
  ratio, active-window count, and zero-clipping hard gates; the audibility
  witness becomes STT-of-window token overlap ≥ 0.6 with the provider
  transcript (the 18:19 run demonstrates STT hears what energy windows miss)
  plus the electrical playout witnesses of §4 layer 6. Keep the capture and
  energy numbers as recorded evidence.
- `stackchan-aec-assessment.ts:164-183`: the clean/near ∈ [0.5, 2] window gate
  predates the ×4 raw branch — either teach it
  `CORE_S3_AEC_RAW_GAIN_MULTIPLIER` (expect ≈ 4 on reference-quiet windows) or
  drop it from the Grok proof in favor of the waveform harness. Same file's
  lifecycle zero-deltas: budget `lifetimePlaybackResets` /
  `FramesDiscardedByReset` by the run's completed interruption barriers
  (3 resets ≡ 3 barriers at 18:19) instead of demanding 0.
- `aec-waveform-assessment.ts:130-133, 332-341` + `:115, 274-285`: the §3
  arithmetic fixes (delete −40 dB energy branch; gain-consistent
  preservation).
- `production-aec-diagnostic-capture.ts:307-313`: reclassify a >60 ms
  _arrival_ gap as a network-validity observation (that family already owns
  RTT) rather than `recorderComplete=false`; frame/ordinal conservation stays
  a hard audio gate. Also fix the misnomer message.
  **Pass:** re-running the assessments over the retained 18:00 and 18:19
  artifacts yields: far-only pass, double-talk pass on echo/distortion (duck
  recorded, judged by action 2b), barge-in pass unless far n-grams appear, one
  network-family observation. **Fail:** any genuinely contaminated fixture run
  (assistant text in input transcript) must still fail — replay the
  `prior-far-speech-old-firmware-x4` events through the new matcher as the
  negative control.

**4. Stand up the speaker-only real-speech VAD rung as a permanent gate.**
Seam: the method is already proven in `stackchan-vad-replay-20260803` — script
it: capture one far-only real-speech interval per firmware/gain candidate (the
Grok proof's story turn already produces one; action 1 retains its bytes), then
replay at deployed gain. **Pass:** 0 `speech_started` across the full replay,
while the near-only control (action 2a) yields exactly 1. This encodes the
README's own conclusion — "any gain candidate must also replay real speaker
speech without producing an xAI speech edge" — and directly guards the
threshold-0.1 premise (`providers.ts:539-553`).

**5. Export the counters that already exist, so layers 1/2/7 stop being
inferences** (the only firmware change proposed, and it is additive telemetry):
add to the AEC view (schema v7 → v8, `components/capabilities/src/metrics.c:1038-1131`)
the uplink-selector `raw_frames` / `processed_frames` / `clipped_samples`
(`aec_uplink_selector.c:74, 92-95`), `reference_scale_clipped_samples`
(`core_s3_audio_owner.c:202, 861`), and `tdm_slot_peak[0..3]`
(`core_s3_audio_owner.c:836-837, 1629-1633`); surface the receipt-fix ledger
(`downlink_items_released/acknowledged`, `receipts_sent`,
`receipt_send_deferrals` — `pcm_uplink_conductor.c:658-667`) in
`getDiagnostics`. **Pass:** a far-only run shows `processed_frames` covering
playout (+128 ms hangover) with `raw_frames ≈ 0`; a near-only run the inverse;
both clipping counters 0 at deployed gains; slot peaks identify the divider.
Second rung, when a reference question next arises: wire the five-plane
`aec_diagnostic_trace` (implemented + host-tested, **zero callers** —
`components/core/src/aec_diagnostic_trace.c`, registered only in CMake) behind
a device capability; it is the one tool that can prove reference
delay/polarity/channel-swap from a single armed capture.

---

## 6. Deletions and simplifications (beyond the five actions)

Protected and untouched: item/receipt conservation, socket/reset counters,
exact-planned-turn deltas, bounded startup discard, provider-event stream
continuity + secret scan, network-validity classification (single-sample RTT
severity stays — it classifies rather than judges audio, and today's
"audio-invalid, reasons: []" verdict shows the split working), the double-talk
phase itself, and frame/ordinal conservation of every capture.

Cleanups found on the way:

- `pcm-proxy.ts:141-156, 477-492`: `downlinkPacing*` and
  `deviceDownlinkDepthCorrection*` metric fields are declared and never
  incremented — vestiges of the pre-receipt pacing design. Delete.
- Stale firmware comments claiming the exact-TX DMA is the AEC reference
  (`core_s3_audio_owner.h:60-66`, `targets/stackchan/main/main.c:1178-1183`);
  the accurate description already exists at `core_s3_audio_owner.c:1448-1455`.
- `prove-local-aec.ts:1046-1063` requires `referencePeak ≥ 500` for
  `playbackObserved`; the current divider reports 128–160 during the −54 dBFS
  pilot, so the local harness would false-fail near phases on current firmware.
  Align with the production check (`lifetimePlaybackContentSamples` delta ≥
  8,000, `prove-production-aec-waveform.ts:808-833`).
- Avatar gates (`framebufferBytes`, LCD transfer time) are coupled into
  `audioPassed` (H:1241-1251). Record them, but let the audio verdict be an
  audio verdict; the 18:19 framebuffer complaint likely tracks the new
  `face_scale.c` and deserves its own gate review.
- Stray directory `apps/kit/apps/kit/evidence/stackchan-grok-uplink-incident-20260803/`
  — a relative-path bug in one capture invocation; fix the resolution and
  remove the nest.
- `transcribe-pcm16.ts:67` defaults to 48 kHz; a 16 kHz accepted-uplink capture
  transcribed without `--sample-rate 16000` plays 3× fast and yields exactly
  the kind of garbled short reading that muddies incident notes. Make the flag
  mandatory.
- Capture summaries (`stackchan-grok-uplink-incident-*/summary.json`) carry no
  firmware provenance; with slot/gain experiments in flight, stamp the build id
  (and, after action 5, the slot constant) into every capture summary so the
  corpus stays interpretable.

---

## 7. Appendix — verified numbers

| Claim                                                | Value                                                                                                                                                      | Source                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Transport at 18:19                                   | 364/364 sent/acked, 0 in flight, 0 receipt timeouts, 3/3 barriers, purge 316,554 B == dropped                                                              | `failure.json → worker.terminal` (re-read via jq)                                                                  |
| Fatal 18:19 gate                                     | "contaminated input transcript(s)" quoting "Open reply. Production test complete."                                                                         | `failure.json → error.message`; throw at H:889                                                                     |
| Acoustic false-miss                                  | STT heard "It is clear and audible."; ratio 0.95×, 0/278 active windows, threshold RMS 1030.6                                                              | `failure.json → acoustic.*`                                                                                        |
| Legacy AEC gate vs new architecture                  | "clean/input 4.000, expected 0.5–2"; "playback reset 3 times"; "discarded 8 frames"                                                                        | `failure.json → aec.assessment.reasons`; ×4 at `aec_uplink_selector.c:92`, wired `core_s3_audio_owner.c:1366`      |
| 18:00 far-only                                       | clean −42.11 / −45.39 / −46.76 dBFS; src-sim ≤ 0.0087; ambient −45.17                                                                                      | agent-extracted from `failure.json`, spot-checked reasons verbatim                                                 |
| 18:00 double-talk                                    | sim 0.832, gain 0.583, residual −8.21 dB; far-leak energy −12.47 dB, far-sim 0.005; degradation-from-repeat −0.88 dB                                       | `failure.json` reasons (grep-verified verbatim); sim identity recomputed: 0.5827/√(0.5827²+10^(−0.8211)) = 0.832 ✓ |
| Cadence false-failure                                | near-repeat max gap 72 ms vs 60 ms; frames 216/216 conserved; device `maximumTransportAcceptAgeMs` 65                                                      | `phase-summary.json` (read directly); `failure.json` device sample                                                 |
| "Hey pal" corpus                                     | 16:54 "Hey Pal." ✓; 18:07 "Hey now."→"Playtime."; 18:37 "Hey now."→"PayPal."; captures 122–137 frames, conserved                                           | `stackchan-grok-uplink-incident-20260803/*/provider-events.json` + `summary.json` (grep/jq-verified)               |
| Slot-0 shelf                                         | 4.5–5.7 kHz interference shelf; near slot moved 0 → 2                                                                                                      | `core_s3_audio_owner.c:401-420, :71` (read directly)                                                               |
| VAD ladder                                           | near ×4 no edge; ×8/×16 one edge + correct transcript; old-firmware speaker-only ×4 → 3 false turns ("Yeah","Stop","Hi") after passing 18.64 dB ERLE       | `stackchan-vad-replay-20260803/README.md` (read directly)                                                          |
| Server VAD config                                    | threshold 0.1, silence 500 ms, prefix 400 ms; identical for both calibrated profiles; grok-transcribe, language_hint en; `keep_context: true`              | `providers.ts:443-556`; `session.updated` in `provider-events.jsonl`                                               |
| Accepted-PCM tap                                     | post-gain, post-provider-accept, ordinal-stamped; 300-frame arm/finish RPC; sha256 persisted per phase                                                     | `pcm-proxy.ts:954-979`; `worker.ts:172-216`; `double-talk.capture.json → pcmSha256` (read directly)                |
| Replay fidelity                                      | same `connectGrokRealtimeVoice`/`providerTurnDetection` code as production; deltas = instructions + sprite tool; 2 s silence tail for the 500 ms VAD close | `replay-production-grok-vad-pcm.ts` (read in full)                                                                 |
| No device VAD; uplink continuous, conversation-gated | end marker suppressed in server-VAD mode; PTT rejected                                                                                                     | `pcm_capture_turn.c:143-155`; `devices/stackchan/stackchan.c:59-62`                                                |
| `aec_diagnostic_trace`                               | five-plane recorder, host-tested, zero callers                                                                                                             | `components/core/src/aec_diagnostic_trace.c`; CMake registrations only                                             |

Provenance corrections for future readers: the
`stackchan-analog-reference-voip-20260803` run was produced by
`prove-production-aec-waveform.ts` (not `prove-local-aec.ts`); the
"Playtime"/"PayPal" turns live in `stackchan-grok-uplink-incident-20260803`
(not in the 18:19 receipt-fix run, whose own turn 1 transcribed perfectly); and
the "Yeah, and one PayPal" independent-STT reading exists only in prompt/notes,
not in any retained summary — after action 1, no such reading should ever be
quoted without its capture's sha256 beside it.
