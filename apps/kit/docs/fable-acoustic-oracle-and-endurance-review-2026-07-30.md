# Fable acoustic-oracle and playback-endurance review

Status: independent Fable Max review, delivered 2026-07-31 (~00:45 local),
covering the physical state as of the 2026-07-30 evening runs plus the
post-midnight schema-4 run. No production code or tests were edited; this file
is the only working-tree change made by this review. All numbers below were
independently recomputed from the retained artifacts with scripts kept outside
the working tree (§12); nothing is quoted from the existing aggregate without
being reproduced.

Scope note: unlike the earlier startup investigation, this review ran **no new
physical experiments**. Every conclusion rests on the seven retained capture
artifacts, their run logs, and source. Where only an experiment can settle a
question, the exact experiment is specified instead of a verdict.

## 0. Verdict

1. **Every failure recorded for the reference run is an oracle/instrument
   boundary artifact, not a device playback defect.** My sample-exact replica
   of the analyzer that actually ran at 23:02 reproduces the recorded output
   to full float precision (§3), and locates every anomaly: the `gapCount: 2`,
   `longestInternalGapMs: 635`, all 16 phase discontinuities, and the 1.626 dB
   amplitude step live entirely in (a) an ~11 ms stale fragment at file sample
   zero and (b) the post-tone ring-down decay after 10,595 ms. The 9.95 s of
   actual tone in between is pristine: zero gaps, zero discontinuities above
   threshold (max error 0.064 rad), max amplitude step 0.517 dB, amplitude CV
   2.4 %, frequency 996.9974 Hz (−2.6 ppm in the Mac's clock).
2. **The recorded output came from a stale analyzer.** The run at 23:02 used
   the analyzer as of commit `a0c54771d`; the working tree's uncommitted
   23:22 edit added the −12 dB relative level gate. The current working-tree
   analyzer, run on the same artifact, **passes the strict gate outright**
   (span 9,952.5 ms, gap 0, missing 47.5 ms, phase max 0.064 rad) — §4.
3. **The file-start fragment is recorder warm-start replay, and it recurs.**
   All seven retained artifacts obey one rule: the first ~10–12 ms of every
   SoX/CoreAudio capture replays what was entering the _previous_ capture
   session's input stream when it stopped, followed by a near-digital-silence
   dead zone before live audio starts (§5). Two of the seven fragments are at
   **91–100 % of playback level** — those defeat the new relative level gate,
   and the current analyzer still reports `observedStartMs: 0` plus a false
   ~635–652 ms "internal" gap for them (verified on three artifacts, including
   the schema-4 run whose 635 ms gap the evidence doc lists as unattributed).
   The uncommitted test's premise — "the important distinction is level, not
   position" — is therefore insufficient. The robust fix is positional and
   physically grounded: anchor the analysis window to the already-recorded
   capture markers (§6).
4. **The oracle works mid-stream, and this is now positively controlled.** In
   the four truncated runs that had real device recovery events, the acoustic
   gap census matches the device's `underrunSilenceFrames*` counters
   one-for-one (3↔3, 1↔1, 1↔1, 1↔1), with gap lengths of 17.5–20 ms and
   resumption phase steps of 0.13–0.34 rad — the exact predicted signature of
   one 20 ms slot replaced by silence at 997 Hz (§7).
5. **The hardware-reserve descriptor policy is sound, correctly conservative,
   and correctly instrumented in the digital domain — but it is a deadline
   model, not a jitter reservoir, and endurance will keep failing until the
   acceptance policy and the pacing design change, not the descriptor count**
   (§8). Five of six evening runs died from the zero-tolerance counter policy
   on 1–3 late frames or from a brownout; none died from audio-path
   corruption.
6. **The remaining device-side realities to keep separate:** one genuine
   brownout (level-7 detector = 2.44 V, a real rail collapse coincident with
   PA turn-on + Wi-Fi at playback start — classify terminal, never hide), and
   a measured 70 ms device-ingress interarrival against a 60 ms reuse window,
   which makes single-frame recovery events an expected ~1-per-tens-of-seconds
   occurrence under the current real-time-paced, zero-reserve design.

No recommendation below increases any queue as a substitute for freshness.

## 1. What was inspected

Working tree `/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`
at `a0c54771d` (checkpoint commit, 23:02) **plus uncommitted edits** to
`acoustic-tone-analysis.ts`/`.test.ts` (23:19–23:22, the level gate),
`local-fetch-websocket-server.*` (23:36–23:37), `device-e2e.ts`, and firmware
`pcm_lane.*`/schema-4 files (23:54–23:58). Citations state which version they
refer to; `platforms/` firmware files are clean vs HEAD.

- Analyzer and harness: `src/device/acoustic-tone-analysis.ts` (+test diff),
  `scripts/device-e2e.ts`, `src/device/device-e2e-cli-options.ts`,
  `src/device/macos-pcm16-capture.ts`, `src/device/macos-avfoundation-provenance.ts`,
  `src/device/acoustic-prbs31-challenge.ts`,
  `src/device/m5sticks3-playback-endurance-target.ts` and the
  `playback-endurance-*` family, `src/device/playback-counter-policy.ts`,
  `playback-recovery-*`, `src/voice/deterministic-pcm-tone-provider.ts`,
  `deterministic-pcm-provider.ts`, `device-pcm-proxy.ts`,
  `src/device/local-fetch-websocket-server.ts`.
- Firmware playback path end to end:
  `platforms/iterate_m5unified/m5sticks3_direct_audio.cpp/.hpp`,
  `platforms/common/include/iterate/kit/platforms/realtime_playback.hpp`,
  `.../direct_i2s_stereo_output.hpp`, `.../esp_idf_direct_i2s_backend.hpp`,
  `platforms/iterate_esp_idf/pcm_transport.c`, `websocket_connection.c`,
  `components/core/src/pcm_lane.c`, `targets/m5sticks3/main/main.cpp`,
  `targets/m5sticks3/sdkconfig`, ESP-IDF v5.4.2 `esp_driver_i2s`.
- All seven retained tone artifacts and run logs under
  `evidence/m5sticks3-playback/` (2250, 2310, retry-2302, 2328, 2330, 2341,
  schema4-20260731-0000) plus the PRBS31 physical retry.
- Context documents: the voice goal, the evidence brief, the alternatives
  review, the reconciliation ledger, the acoustic-startup investigation, and
  firmware `AGENTS.md` / `reasoning-comments.md`.
- StackChan current source at
  `~/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec`
  (branch `main`, `2a7aec9`), read as prior art with its known growing-delay
  defect treated as a defect (§9).

## 2. Source-proven facts

F1. **The 23:02 reference run used the analyzer without the level gate.** The
level gate (`minimumRelativeToneAmplitude`, `ToneAmplitudeReferencePass`, the
third artifact pass) exists only in the uncommitted 23:22 diff
(`git diff HEAD -- src/device/acoustic-tone-analysis.ts`, +100 lines). HEAD
`a0c54771d` was committed at 23:02, the same minute the run's analysis was
logged. In the HEAD analyzer, active = amplitude ≥ 128 **and** coherence ≥ 0.7
with no relative floor.

F2. **The analyzer aggregates by first-to-last active window.** Any run of ≥ 2
consecutive active 5 ms windows (10 ms of signal) becomes part of the span;
every inactive window between `firstActiveIndex` and `lastActiveIndex` counts
toward `gapCount`/`longestInternalGapMs`
(`acoustic-tone-analysis.ts:202-210,682-704`, working tree). The new gate
raises the activation floor to `max(128, 0.25 × median)` (`:188-201,311-315`)
but position never enters the decision.

F3. **Capture markers are file-size counters quantized to 4,096 bytes.**
`recordAcousticMarker` (`scripts/device-e2e.ts:209-237`) pairs a precise
`performance.now()` with `inspectProgress()`, which is a `stat()` of the
artifact (`macos-pcm16-capture.ts:395-407`). Every marker sample count in every
retained log is an exact multiple of 2,048 samples (42.67 ms); three markers
spanning 0.75 ms of host time share the same value (16,384). A marker is a
**lower bound** on the capture position of its event: the file lags the live
stream by SoX's flush granularity plus pipe latency.

F4. **Capture deliberately starts ≈340 ms before the provider request and the
recorder needs ~85 ms to prove liveness.** Runner order: capture start
(`device-e2e.ts:486-493`) → marker → `requestVoiceText` (`:531-534`).
`#waitUntilRecording` polls `stat()` every 25 ms for ≥ 4,800 bytes
(`macos-pcm16-capture.ts:265-293`), which with 4 KiB flushes first passes at
8,192 bytes ≈ 85 ms.

F5. **The tone is 997 Hz at 16 kHz, amplitude 24,576, phase-accumulated across
chunks, no fade-in/out, no dither** (`device-e2e.ts:181-199`,
`deterministic-pcm-tone-provider.ts:43-64`). Provider chunks are 1,000 bytes /
31.25 ms, deliberately misaligned with the 640-byte / 20 ms device frame. A
duplicated or skipped whole frame at 997 Hz produces a wrapped phase offset of
`2π·(997·0.020 mod 1) ≈ 0.377 rad` — the design rationale at
`device-e2e.ts:191-196`, and the number to keep in mind for §7.

F6. **The strict thresholds are duplicated in two files.** `device-e2e.ts:646-653`
and `m5sticks3-playback-endurance-target.ts:66-74` hard-code the identical
`{maxAmpStep 1.5 dB, p99 1.5 dB, durationError 200 ms, internalGap 0 ms,
missingTone 200 ms, phaseStep 0.1 rad}`.

F7. **The device-side playback policy ("hardware reserve"), exactly:** 4 DMA
descriptors × 320 mono samples = 20.000 ms each; ESP-IDF's private
finished-pointer queue holds `desc_num − 1 = 3` (`i2s_common.c:334`). Completed
descriptors are retained un-refilled while `refillCredits ≤ 2`; at 3 credits
exactly one classified recovery silence is written
(`realtime_playback.hpp:1118-1137`, consume loop `:1234-1296` with
`while (credits ≥ DmaFrameCount − 1)`); ≥ 4 credits is a hard reset (`:881-895`).
The reuse deadline is a derived model — `60,000 µs − (now − oldestEofUs)` —
recomputed at every poll (`esp_idf_direct_i2s_backend.hpp:549-587`) and again
around every write (`:377-399`), with a 2,000 µs minimum lead
(`m5sticks3_direct_audio.hpp:110`) whose violation is a counted deadline miss
plus reset (`realtime_playback.hpp:1092-1103,1574-1585`). Credits must equal
the backend's pending-refill count on every pump or the run fails as a state
error (`:1531-1541`).

F8. **Recovery is phase-preserving and exactly conserved.** One recovery
silence ⇒ one scalar debt ⇒ exactly one later late content frame discarded
(`realtime_playback.hpp:1277-1284,1141-1232`); terminal conservation
`submitted = completed + retired` is schema-3 law. The acoustic consequence of
one event is one 20 ms-slot silence and one skipped frame.

F9. **Every reset/EOS path is an uncounted-duration acoustic hole with amp and
codec transients.** `resetAfterUnderrun`/`resetForFreshness`/`finishEndOfStream`
all run `stopAndRelease` (amp off → I2S disable+delete) and re-enter buffering,
which requires a fresh 4-frame preload (≥ 80 ms at real-time pacing) before
`startPlayback` re-enables I2S and re-enables the amp
(`realtime_playback.hpp:1350-1374,1589-1709`,
`esp_idf_direct_i2s_backend.hpp:98-143,168-199,429-445`). The amp is a hard
M5PM1 register switch mid-waveform (`m5sticks3_direct_audio.cpp:288-311`); the
ES8311 is reprogrammed clockless each time with soft-ramp disabled
(`0x37=0x08`, `:319-328`). Incidents are counted; their **durations are not**,
and no timestamp anchors the first clocked sample.

F10. **The device cannot observe its own clock drift.** `esp_timer` and the
I2S divider share the 40 MHz crystal, so on-device EOF cadence is 20.000 ms by
construction. Combined ±crystal tolerance vs the Mac is tens of ppm ≈ up to
~144 ms/hour of relative slip. The only cross-clock observables are the PRBS31
affine fit (measured **6.29 ppm** on this rig) and the new schema-4
receive-to-DMA age (not yet trended).

F11. **The audio owner has no liveness watchdog in `playing`.** Wait ticks are
`portMAX_DELAY` outside buffering (`m5sticks3_direct_audio.cpp:497-517`);
wakeups come from the EOF ISR, downlink notifications, and the 1 Hz metrics
subscription. If EOFs stop, no counter moves; audio liveness currently depends
on a diagnostics subscriber existing.

F12. **Brownout is configured at the least sensitive level and is real.**
`CONFIG_ESP_BROWNOUT_DET_LVL_SEL_7` = 2.44 V (IDF default, the lowest
threshold; `targets/m5sticks3/sdkconfig:1229-1231`). The host converts the
serial string into an immediate terminal failure
(`device-runtime-log.ts:123,354-365`). The 2310 trigger landed at the exact
playback-start instant — I2S enable, then PA turn-on into a real load at full
level with no soft-start, coincident with Wi-Fi RX of the stream. Note the
interaction: every recovery reset **re-runs the same PA/codec inrush**, so a
recovery-heavy run multiplies brownout exposure as well as transients.

F13. **The five failed evening runs died from policy or power, not audio
corruption.** 2250: counter policy, 3 underrun incidents at ~0.75 s of tone.
2310: brownout at ~0.6 s. 2328 (60 s): counter policy, 1 incident at ~6.9 s.
2330: device-origin close 4013 "LAN bridge backpressure" at ~13.9 s. 2341:
counter policy, 1 incident at ~10.5 s (host bridge telemetry simultaneously
showed max interarrival 22.79 ms, zero buffered bytes — the lateness arose
past the host socket). Schema-4: counter policy, 1 incident at ~18.2 s, with
device lane interarrival max 70 ms against the 60 ms reuse window.

## 3. Independent replay of the reference artifact (deliverable 1)

Artifact `direct-lan-tone-10s-hardware-reserve-retry-20260730-2302/`
`iterate-kit-acoustic-2OXLQp/microphone.pcm16le`: 1,155,072 bytes = 577,536
samples = 12,032.0 ms at 48 kHz.

**Replica fidelity.** I re-implemented both analyzer generations (window
projection with per-window oscillator restart, stable-run retention, bounded
histograms with bin-center quantiles, the 6-window amplitude-step context, and
the 2-window phase-step spans) in NumPy. Against the HEAD (no-gate) semantics
the replica reproduces the recorded JSON **exactly**, including float tails:

| field                             | recorded (run.log:73)  | replica      |
| --------------------------------- | ---------------------- | ------------ |
| `medianToneAmplitude`             | 2504                   | 2504.0       |
| `amplitudeCoefficientOfVariation` | 0.08121884639157353    | 0.081219     |
| `maximumAmplitudeStepDecibels`    | 1.6260540205125569     | 1.626054     |
| `amplitudeStepP99Decibels`        | 0.15234375             | 0.152344     |
| `medianPhaseStepRadians`          | −0.0003834951969712286 | −0.000383495 |
| `maximumPhaseStepErrorRadians`    | 0.3462271442062306     | 0.346227     |
| `phaseDiscontinuityCount`         | 16                     | 16           |
| `gapCount` / longest              | 2 / 635 ms             | 2 / 635 ms   |

The same replica with the uncommitted level gate matches the current
working-tree analyzer, which I also ran directly on the artifact (§4).

**Component timeline (sample-accurate, all times file-relative):**

| interval                        | content                                                                                                                                                                                                                                                                  | evidence                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| 0 – ~10.3 ms                    | **stale 997 Hz fragment at ~15 % level**, already mid-waveform at sample 0 (first samples −107, −248, −337…), amp ≈ 362–389, coherence 0.958–0.984; strong samples end at sample 494                                                                                     | window table w0–w3; §5          |
| ~11 – ~100 ms                   | **near-digital silence**, 1 ms RMS 0.5–3 — no MacBook room floor looks like this                                                                                                                                                                                         | RMS bins; §5                    |
| ~100 – 341 ms                   | live room noise, RMS ≈ 30–70                                                                                                                                                                                                                                             | noise profile                   |
| 341.3 ms (+0/−0 s, +≤43 ms lag) | `provider.request.before` marker at 16,384 samples; `accepted` +0.62 ms; `response.created` +0.75 ms (same quantized count)                                                                                                                                              | run.log:39-43, F3               |
| 341 – 645 ms                    | request→onset: proxy 3-frame reservoir (60 ms) + device 4-frame preload (80 ms) + connect/enable/amp; observed onset−marker = 304 ms, true request→onset ∈ ~[160, 304] ms after marker-lag correction — consistent with the prior raw-tap 210 ms measurement             | M9 of the startup investigation |
| **645 – 10,595 ms**             | **the tone.** 3,980 active windows, **0 gaps**, **0 discontinuities** > 0.1 rad (max error 0.064 rad at 10,592.5 ms, the fall edge), max amplitude step **0.517 dB**, CV **2.4 %**, median amp 2504; onset envelope 10→90 % in < 2 ms at w256–w258 (476 → 1,619 → 2,400) | replica dumps                   |
| 10,595 ms                       | fall edge: one window at amp 1,113, coherence 0.693 — the old analyzer's second "gap" (2.5 ms) is this single threshold-crossing window                                                                                                                                  | w4238                           |
| 10,597.5 – ~10,670 ms           | **coherent ring-down**, amp 427 → 142 (16 % → 6 %), coherence 0.97–0.99 — free decay of the speaker/room at ~997 Hz                                                                                                                                                      | w4239–w4266                     |
| 10,670 – 11,947 ms              | quiet tail; `response.done` marker at 10,325 ms, `device.playback.completed` at 11,435 ms, `capture.tail.completed` at 11,947 ms                                                                                                                                         | run.log:65-72                   |
| 11,947 – 12,032 ms              | final SoX flush past the last marker                                                                                                                                                                                                                                     | file size                       |

**Capture integrity (wall vs sample), from the markers themselves:**
created→done Δwall 9,969.2 ms vs Δsamples 9,984.0 ms (+14.8 ms);
done→completed 1,119.2 vs 1,109.3 ms; completed→tail 501.9 vs 512.0 ms. All
within one 42.67 ms flush quantum. **This SoX capture is wall-honest**; the
ffmpeg-era ~20 % timeline loss is absent.

**Frequency/drift:** least-squares phase slope over the tone gives
996.9974 Hz in the Mac's clock (−2.6 ppm); per-second fits drift only
−0.0035 → −0.0013 Hz across the run. Consistent with the PRBS31 fit (6.29 ppm)
at the level where mic-position and estimator effects dominate.

**Where the recorded failures actually were (HEAD analyzer):** the 635 ms gap
is w4–w257, i.e. the quiet between the stale fragment and true onset. Both
fragment windows w2–w3 carry phase-step errors (0.134, 0.262 rad). The other
fourteen discontinuities all sit between 10,602.5 and 10,665 ms, inside the
ring-down (amp 142–409), max 0.346 rad at 10,650 ms. Every amplitude step

> 0.6 dB, including the failing 1.626 dB, sits between 10,605 and 10,660 ms on
> the decay slope (amps 280 → 269 → 237 → 197 → 170 → 142). **Nothing above any
> threshold occurs between 645 and 10,595 ms.**

## 4. What the current analyzer says (and where it still breaks)

Running the working-tree `analyzeAcousticTonePcm16Artifact` +
`assessAcousticToneAnalysis` with the production thresholds over all seven
artifacts:

| run                          | start / span (ms) | gaps (longest ms) | phase disc (max rad) | verdict, and what it means                                                                             |
| ---------------------------- | ----------------- | ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| retry-2302 (10 s, completed) | 645 / 9,952.5     | 0                 | 0 (0.064)            | **passes strict** — the reference run's recorded failure is entirely the stale analyzer                |
| 2250 (killed at 1.4 s)       | 642.5 / 765       | 3 (20)            | 4 (0.338)            | honest: 3 real recovery silences, truncation                                                           |
| 2310 (brownout at 1.28 s)    | **0** / 1,280     | 1 (**640**)       | 0                    | **false pre-roll gap** — full-level fragment defeats the level gate                                    |
| 2328 (60 s, killed at 7.5 s) | 647.5 / 6,860     | 1 (17.5)          | 1 (0.207)            | honest: 1 real recovery silence, truncation                                                            |
| 2330 (killed at 14.5 s)      | **0** / 10,305    | 1 (**652.5**)     | 1 (0.125)            | **false pre-roll gap** — full-level fragment again                                                     |
| 2341 (killed at 10.7 s)      | 642.5 / 10,492.5  | 1 (20)            | 1 (0.170)            | honest: 1 real recovery silence                                                                        |
| schema4 (killed at 18.2 s)   | **0** / 18,645    | 2 (**635**, 20)   | ≥1                   | **decomposed:** 635 ms = false pre-roll; 20 ms at 18,137.5 ms = the run's single real recovery silence |

The schema-4 decomposition answers the evidence brief's open item ("those
larger acoustic absences are not yet attributed"): its 635 ms gap is the
stale-fragment artifact; the single real underrun is the 20 ms gap at
18,137.5 ms; the ~2 s of missing tone is the counter-policy abort at 18.2 s of
a 20 s source. Nothing acoustically unexplained remains in any retained run.

The mid-stream truth of the oracle is now positively controlled (§7), and its
boundary failure mode is precisely characterized: **any ≥10 ms coherent
fragment at ≥25 % of median level ahead of the true onset still poisons
`observedStartMs`, converts real pre-roll into a fictitious internal gap, and
fails the duration gate** — and such fragments demonstrably occur at 91–100 %
level (2310 head amp 2,291/coh 0.980; 2330 amp 2,455/coh 0.993; schema4 amp
2,445/coh 0.991, each within 2 % of that run's tone level).

## 5. The stale-fragment mechanism (measured, and how to prove it further)

Measured rule, consistent across **7/7** artifacts: the first ~10–12 ms of a
capture ≈ one 512-sample CoreAudio HAL buffer replaying the audio that was
entering the **previous** capture session's stream when it stopped, then a
near-zero dead zone (RMS 0.5–35 for tens of ms) until the live stream engages.

| previous session ended…                                          | tail (last 10 ms) amp/coh @997 | next capture head (first 10 ms) amp/coh | NCC of head vs predecessor tail region                 |
| ---------------------------------------------------------------- | ------------------------------ | --------------------------------------- | ------------------------------------------------------ |
| 2250 mid-tone (policy kill)                                      | 2,330 / 0.985                  | 2310: 2,291 / 0.980                     | **0.996** at 43 ms before file end                     |
| 2310 at brownout (tone died, ring-down while capture wound down) | 2,348 / 0.984 (file end)       | retry: 366 / 0.969 (≈ ring-down level)  | 0.956 (level ≠ file end; matches post-death ring-down) |
| retry quiet tail                                                 | 1.1 / 0.04                     | 2328: 1.3 / 0.134 (no fragment)         | n/a                                                    |
| 2328 mid-tone                                                    | 2,484 / 0.997                  | 2330: 2,455 / 0.993                     | **0.997**                                              |
| 2330 quiet (post-close)                                          | 0.1 / 0.007                    | 2341: 2.0 / 0.116 (no fragment)         | n/a                                                    |
| 2341 mid-tone (policy kill)                                      | 2,469 / 0.993                  | schema4: 2,445 / 0.991                  | level match within 1 %                                 |

Caveat stated honestly: NCC against a periodic tone cannot by itself prove a
byte-copy (any 997 Hz segment correlates with any other). The load-bearing
evidence is (a) the level correspondence across all seven runs, including the
distinctive 15 % ring-down pairing, (b) the fragment starting mid-waveform at
sample 0, (c) the dead zone after it — live MacBook mic audio never has 1 ms
RMS of 0.5 — and (d) fragments appearing **only** when the predecessor ended
loud, independent of elapsed time (9 min and 1 min gaps both reproduce it;
quiet predecessors never do, even at 1 min).

Decisive device-free experiment (minutes, no tuning): start a capture, play a
distinctive **non-periodic** sound (chirp or PRBS burst) through the Mac
speaker, kill the capture mid-sound; immediately start a second capture in a
silent room and check its first 512 samples for the chirp. Byte-level match ⇒
warm-start replay proven with non-periodic content. Repeat with a 15-minute
wait to bound the persistence window.

Implication: this is a **capture-hygiene defect class**, not a room or device
event, and it will recur on every back-to-back run whose predecessor aborted
mid-tone — which under the current fail-fast policy is the common case.

## 6. Oracle correction: smallest public-contract change plus red waveforms (deliverables 3–4)

**Can the first-active/last-active aggregation misclassify pre/post-roll false
positives? Yes — by construction (F2) and by three artifacts in evidence.**
The uncommitted level gate fixes only sub-25 %-level fragments (it was
calibrated on the retry artifact's 15 % fragment; its own test fixture uses
`gain: 0.15`). The full-level fragments in 2310/2330/schema4 pass any level
test, because they _are_ the tone, recorded earlier.

**Why not "pick the dominant episode":** the existing in-source worry is
correct — selecting the longest/loudest run would mask a real outage that
splits playback into two same-level episodes. Any waveform-shape heuristic
(minimum episode length, fragment trimming, cluster selection) either has a
tunable that will eventually eat a real resumption tail, or fails on a
same-level fragment. Don't go there.

**The principled anchor already exists in every run: the capture markers.**
`provider.request.before` is recorded as a capture-file sample count _before_
the request is issued (F3, F4). Because the marker lags the live stream, it is
a **conservative lower bound**: no device playback can exist in the artifact
before it. Symmetrically `device.playback.completed` (+ EOS drain + decay
margin) upper-bounds it.

**Smallest public-contract correction.** Two optional fields on
`AcousticToneAnalysisOptions`/`AcousticToneArtifactAnalysisOptions`:

```ts
/** Capture-file time (ms) before which device playback is physically
 *  impossible; windows earlier than this are excluded from the span and
 *  reported separately. Sourced from the provider-request capture marker. */
analysisStartMs?: number;
/** Capture-file time (ms) after which device playback is physically
 *  impossible (playback-completed marker + drain + decay margin). */
analysisEndMs?: number;
```

plus one report field, e.g. `excludedCoherentWindowCount` (count of stable
coherent windows outside the anchored window). The runner passes
`analysisStartMs` from the marker it already records
(`device-e2e.ts:531/638-643` — today the analyzer call receives no anchor even
though the marker value is in scope), and `analysisEndMs` from the
playback-completed marker + ~250 ms. Semantics: windows outside the anchored
range never set `firstActiveIndex`/`lastActiveIndex` and never count as gaps;
everything inside is measured exactly as today. `excludedCoherentWindowCount`

> 0 becomes a _capture-hygiene warning_ (and a great tripwire for the
> warm-start defect), not a playback failure.

Why this cannot mask a real mid-stream gap: the anchors derive from host
events, not from the waveform; every window between the request and completion
markers — where all real playback and all real outages live — is judged
unchanged. A device that starts seconds late still fails
`missingToneMs`/duration exactly as today.

**Red regression waveforms** (synthetic 48 kHz, riding on the existing
`renderRecording` helper):

- **RED-A (fails today, green after):** `coherentLeakageRuns: [{ startMs: 0,
endMs: 11, gain: 1.0 }]` — a _full-level_ leading fragment — plus lead
  silence, 2 s tone, ring-down, tail; `analysisStartMs: 341`. Current
  analyzer: `observedStartMs 0`, false internal gap ≈ 490 ms, strict fail.
  Anchored: start ≈ 500, gap 0, pass. (The existing 15 %-leakage test stays;
  it protects the level gate.)
- **RED-B (must fail before _and_ after — anti-masking):** RED-A plus a real
  300 ms silence injected mid-tone. Both analyzer versions must report
  `longestInternalGapMs ≥ 300`. This is the fixture that proves the anchor
  cannot hide an outage.
- **RED-C (anchor is not a cleanser):** a full-level 11 ms fragment _after_
  `analysisStartMs` but before onset must still produce the pre-onset gap —
  in-window early sound is device-attributable and must stay visible.

Also worth landing while in there: a **capture warm-start detector** in the
capture layer (flag when the first ~50 ms contain a ≥0.9-coherence head
followed by ≥20 ms of sub-noise-floor RMS), reported through provenance — it
converts §5 from forensic analysis into a per-run boolean; and the
**wall-vs-sample invariant** the startup investigation already specified,
computed from the markers that now exist (the §3 table is exactly that check,
done by hand).

## 7. Distinguishing device, codec/amp, recorder, environment, and analyzer (deliverable 5)

The evening's data already demonstrates the two most important signatures:

**Real device-inserted silence has a fingerprint the oracle detects.** In
2250/2328/2341/schema4 the acoustic gap census equals
`underrunSilenceFramesSubmitted` exactly (3/1/1/1), each gap is 17.5–20 ms
(one slot at 5 ms-window resolution), and each resumption carries a phase-step
error of 0.13–0.34 rad ≈ `2π·(997·gap mod 1)` (F5). A skipped-early frame
(content played ahead of schedule) would show the same ±0.377 rad class
without silence; a slot-aligned silence with on-schedule resume shows the gap
with near-zero phase step. The oracle distinguishes these; keep that.

The discrimination matrix, with the exact experiment and metric for each:

| cause                                                            | positive signature                                                                                                                                                   | discriminating experiment                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device I2S/refill discontinuity                                  | gap ≈ n×20 ms; 1:1 with recovery/underrun counters; phase step ≈ 0.377·n rad; PRBS timeline-anchor offset localizes the exact chip                                   | already controlled (this section); for sub-frame effects, PRBS31 anchors every 1,000 chips (`acoustic-prbs31-challenge.ts:761-823`) give ms-level localization                                                                                                                                |
| Codec/amp behavior                                               | transients only at generation boundaries; pop/step at amp toggle; no mid-stream events                                                                               | instrument F9: add `lastPlaybackOutageMs`/`maximumPlaybackOutageMs` (stop→start) and a `startPlayback` timestamp; then run N deliberate recovery resets (public-tunnel adversity lane) and correlate each boundary with capture transients; A/B a run with the amp left enabled across resets |
| Mac recorder discontinuity                                       | wall-vs-sample deficit (markers, §3); warm-start head (§5); anomaly spacing quantized to 512 samples (startup investigation M5)                                      | per-run: assert the marker wall-vs-sample invariant (≤ 1 flush quantum + 50 ms); loopback control fixture (Mac speaker 997 Hz through the production recorder+analyzer, span ≥ 0.99, already specified in the startup investigation §5); dual raw-tap capture only when suspicion remains     |
| Environmental interference (incl. the adjacent StackChan device) | coherence collapses while **amplitude holds and RMS rises** (noise added on top of tone) vs amplitude collapse (tone gone); events uncorrelated with device counters | goal doc already mandates powering down the sibling device; add a capture-only room census (60 s, no playback: count stable coherent 997 Hz windows — should be zero); report per-gap `{amp, rms, coherence}` context so noise-masking is legible                                             |
| Analyzer error                                                   | replica divergence; synthetic-truth failure                                                                                                                          | property fixtures with known truth (gap/step/drift/fragment injections — §6 fixtures are the start); keep my replica scripts as an out-of-tree cross-check for any disputed run                                                                                                               |

One analyzer subtlety surfaced by w4238 and worth a deliberate decision rather
than an accident: a window can go inactive because coherence dropped while
tone amplitude persisted (noise burst over a present tone). Today that is
indistinguishable from tone loss and can fail a 10-minute run on one keyboard
click near the mic with `maximumInternalGapMs: 0`. Recommendation: classify
inactive-with-amplitude-held windows separately (`maskedWindowCount`) with a
small budget, while amplitude-collapsed windows remain hard gaps. Land it with
a fixture (tone + 10 ms broadband burst ⇒ today a gap; desired: masked, no
gap) — falsifiable, not tuned to any artifact.

The PRBS31 path is the right escalation for anything the tone cannot localize:
its physical retry acquired both carriers, fitted 6.29 ppm drift, and found
**zero** skipped/duplicated chips and zero timeline discontinuities — strong
independent evidence that no capture time-loss remained. Two caveats before
promoting it: its `maximumAdjacentAmplitudeStepDecibels: 53.65` almost
certainly measures across the episode boundary (same aggregation family as the
tone bug — verify and anchor it identically), and
`decodedSeedMatchesExpected` is derived from confidence/offset flags
(`:631-635`), not an independent decode; the field name overclaims.

## 8. The hardware-reserve policy, judged (deliverable 6)

**Is retaining completed descriptors until their measured reuse deadline
sound?** Yes. The EOF hands the owner a descriptor that DMA will not touch
again for `(N−1)·20 ms`; holding it empty while content is merely tens of ms
late is strictly better acoustically than writing silence eagerly, and the
policy consumes with classified silence exactly at the 3-credit boundary where
ESP-IDF's private queue would otherwise overflow (F7). The dual deadline
computation (poll-time and write-bracketed), the credits-equals-pending
invariant, the 2 ms floor treated as unsafe-equality, and the refusal to
enforce deadlines during EOS drain are all correct and test-covered
(`tests/realtime_playback_test.cpp:524-571,886-997`).

**Is it simpler than alternatives?** Than a second PCM queue or an
always-write-silence-at-EOF design, yes: it adds two scalars (credits, debt)
to bookkeeping the IDF queue forces anyway, holds zero extra payload, and its
conservation law is host-testable. The genuinely simpler create-once substrate
(no per-response channel delete, amp as the only per-session action) is
already accepted-for-comparison in the reconciliation ledger; nothing here
changes that ordering, but §F9/F12 add two reasons it should stay high on the
list (uncounted outage holes; PA-inrush-per-reset vs brownout).

**Is it correctly instrumented?** In the digital domain, yes —
EOF-to-refill, write duration, reuse lead min/max, credits, and the recovery
conservation counters give a complete picture of the _refill_ race, and the
23:02 run's numbers (max EOF→refill 21,232 µs, min reuse lead 38,768 µs, max
write 97 µs, playback high-water 4, downlink high-water 1) are internally
consistent and healthy. Four gaps keep it from being sufficient (all from F9–F11):
no outage-duration measurement, no first-sample/amp timestamps, no
substituted-slot sequence numbers (which acoustic gap was which incident), and
no EOF-cadence watchdog. Add those four before endurance; each is a counter or
timestamp, not a queue.

**The strategic caveat — a reserve is not a reservoir.** With a sender paced
at exactly 20 ms (provider grid → proxy grid → device), the 80 ms preload is a
one-time phase lead. Steady state keeps the lane at depth ≤ 1 and each frame
arrives just-in-time against a 60 ms reuse window minus accumulated
drift/jitter erosion; the schema-4 run then measured a 70 ms device-ingress
interarrival — past the window — from a host that provably wrote on time
(22.76 ms max at the socket). Under this design, single-frame recovery events
at ~1 per 10–60 s are the _expected_ behavior of Wi-Fi + scheduler physics,
not a regression; the descriptor policy is working as designed when it
converts them into one 20 ms classified silence. The evidence brief's own
conclusion — make the device clock authoritative and hold a small, explicit,
freshness-bounded playout reserve — is the correct next design step, and it
is a different thing from "grow the queue": it is 3–5 frames of _measured,
age-bounded_ lead replenished opportunistically, with drops-by-freshness
preserved. Until that lands (or when running the strict zero-recovery lane
deliberately), the acceptance policy, not the descriptor count, decides
whether runs survive (§9).

## 9. Endurance protocol: 1, 2, and 10 minutes (deliverable 7)

Two lanes with different contracts, both required (this matches and sharpens
the existing recovery-vs-strict split):

- **Lane S (strict continuity, direct-LAN):** all recovery/underrun/reset
  counters zero, acoustic `internalGap 0`, phase ≤ 0.1 rad. This lane proves
  the pipeline and the rig under the most honest conditions. It is a
  _diagnostic_ lane: a single 70 ms ingress excursion legitimately fails it.
- **Lane P (product-shaped):** bounded recovery allowed and **cross-checked**:
  every acoustic gap must match a classified recovery incident one-for-one
  (§7 fingerprint: count, ≈20 ms length, ≈0.377 rad step), with budget
  ≤ 1 incident/min, no single gap > 25 ms, total inserted silence ≤ 0.2 % of
  the run, zero resets/overflows/state errors. An acoustic gap _without_ a
  matching counter is an automatic hard fail in both lanes — that
  cross-check, not the zero, is what makes recovery honest.

**Prerequisites (red-first, before any minutes-long run is meaningful):**

1. Marker-anchored analysis window + RED-A/B/C fixtures (§6).
2. Warm-start detector + per-run wall-vs-sample marker invariant (§6).
3. Loopback control fixture wired as a harness stage (proves
   recorder+analyzer health per session, ~duration+2 s).
4. Firmware: outage-duration + start timestamps + substituted-slot sequence
   numbers + EOF-cadence watchdog (§8); all are counters/timestamps.
5. Wide Spectrum mic-mode gating aligned between the endurance manifest
   (which already rejects non-WS) and the CLI path (which today records
   `standard` and never checks); or an explicit decision that SoX/CoreAudio
   clients are out of scope for mic-mode DSP with the loopback fixture as the
   binding gate. The fixture is the stronger instrument either way.
6. Mid-run markers: extend `recordAcousticMarker` with a 10 s heartbeat so a
   10-minute artifact has a piecewise wall-vs-sample check rather than only
   end-to-end.
7. Power down/mute the adjacent device (goal doc requirement) and record its
   state in provenance; capture-only room census once per session.

**1 minute — tone, both lanes.** Source: existing 997 Hz provider (60,000 ms,
3,000 frames — the digest-pinned source contract already exists). Gates:
anchored acoustic pass per lane; counter policy per lane; heap
(`minimum_free_internal_heap` non-decreasing after warm-up), stack floors,
CPU permille ceiling (~350‰), wall-vs-sample; loopback fixture green before
the session. Stop conditions (all lanes, all durations): any zero-budget
counter delta (lane S) or budget breach (lane P), brownout (always terminal
and reported as power, never as an audio-continuity failure), device/socket
close, watchdog, wall-vs-sample breach, or analysis failure.

**2 minutes — switch the primary oracle to PRBS31, add load.** The
non-periodic dual-carrier challenge (`acoustic-prbs31-challenge.ts`) is the
right instrument for anything ≥ 2 min because whole-frame skip/duplicate/replay
cannot hide in it and it measures cross-clock drift structurally
(`fittedClockDriftPpm`, anchors every second). Precondition: fix its
episode-boundary amplitude measurement (§7) and apply the same marker anchors.
Keep one tone run alongside for continuity with the ladder history. Load =
the existing `capability-churn` profile (bounded lower-priority Cap'n Web /
display churn), plus one run with verbose metrics on to prove diagnostics
don't perturb the audio owner.

**10 minutes — PRBS31 under load, drift-aware.** Additional gates: fitted
drift |ppm| sane and _stable_ (baseline this rig at ~6–10 ppm; the 500 ppm
manifest bound is a typo-catcher, not a physics gate — tighten to ≤ 50 ppm
after three baselines); timeline-anchor offsets 0 throughout (lane S) or
exactly matching recovery events (lane P); `receive-to-DMA age` trend slope
exported and bounded (this is the on-device drift proxy, F10); memory gates
per the goal doc (min-heap, stack high-water, no monotonic latency growth);
recorder integrity via 10 s heartbeat markers. Expected physics to write into
the run plan: at ~40 ppm worst-case relative drift a 10-minute run slips up to
~24 ms — within one frame, so lane S is _possible_ but marginal by design;
lane P's budget (≤ 10 incidents) is the honest product gate until the
device-clocked reserve lands. Do not chase lane-S 10-minute greens by
enlarging queues; that outcome is meaningful only after the pacing design
change.

Artifacts per run (mostly already in the manifest): run log, capture +
SHA-256, source digest, per-second metrics, marker set, provenance (mic mode,
recorder argv, adjacent-device state), analyzer version/options, and both
assessments. The endurance runner itself is currently fail-closed
(`device-e2e.ts:444-458` passes an empty runtime); wiring it up is a
prerequisite to running the ladder at all.

## 10. StackChan: what to borrow, what must not migrate (deliverable 8)

Read at `2a7aec9`. The growing-delay defect is fully explained in source, and
none of it is subtle bad luck — it is a design family this codebase has
already rejected. Borrow the instruments, not the pipeline.

**Borrow (high value, low risk):**

- **Analogue loopback AEC reference:** the speaker output is wired through a
  divider into ES7210 MIC3 and captured on TDM slot 1, clock-synchronous with
  the near mic (`audio_pipeline.c:446-452,544-548`) — reference alignment by
  construction, zero software delay estimation. This is the single best idea
  in the repo and directly informs the StickS3/StackChan duplex substrate
  (the reconciliation's "sample-synchronous speaker reference" goal).
- **Sequence-numbered DMA tap** with TX-before-auto-clear + RX join and
  explicit resync (`m5stack_core_s3.h:191-226`, `audio_pipeline.c:559-614`):
  DSP alignment decoupled from task scheduling. Also its DMA-layer stats
  snapshot (`tx/rx_dma_events`, `*_queue_overflows`).
- **Post-playout face tap:** visemes driven from the TX buffer that has
  _finished_ DMA (`audio_pipeline.c:710-716`) — lipsync structurally immune to
  upstream buffering. Combined with the **seqlock pose handoff**
  (`face_animator.c:33-43,321-364`) and the pure-function integer renderer
  contract (`face_render.h:9-18`), this is the avatar architecture the goal
  doc asks for.
- **`speech_leveler.c`** (integer soft-knee limiter, ~80 lines, host-testable).
- **Epoch-guarded last/max/avg timing snapshots with an explicit over-budget
  counter** (`audio_pipeline.h:21-55`, `audio_pipeline.c:226-235`).
- **Tooling discipline:** `aec_lab.py`'s `self-test` (synthesize known-good and
  known-bad captures and prove the thresholds separate them — adopt for the
  tone/PRBS oracles); `realtime_probe.py`'s dual wall-clock/sample-clock
  per-frame manifest (the latency-drift instrument); `audio_assess.py`'s
  capture-only response-latency estimator; `collect_device_evidence.py`'s
  one-command evidence zip including a real screen snapshot.

**Must not migrate (each with its failure mode):**

- 12 s + 4 s series StreamBuffer FIFOs with no watermark/latency target
  (`realtime_client.c:39-41`, `audio_pipeline.c:27-28`) — burst absorption
  becomes seconds of conversational lag by design.
- The **zero-fill ratchet**: underruns insert silence but never drop to catch
  up (`audio_pipeline.c:646-654`); playout lag is monotonically non-decreasing
  for the session, and a _total_ dropout increments no counter at all
  (`received > 0` guard).
- **Tail-drop on overflow** (discard newest, keep 12 s of stale;
  `realtime_client.c:910-917`) — the exact inverse of the freshness policy.
- **Flush that silently no-ops when it matters:** `xStreamBufferReset` fails
  while a sender blocks on the full buffer, return value discarded
  (`audio_pipeline.c:1214-1219` vs the 100 ms blocking send at
  `realtime_client.c:787-789`) — barge-in leaves up to 4 s of stale speech.
- TCP window inflated to defeat backpressure (`CONFIG_LWIP_TCP_WND_DEFAULT=32768`
  with an explicit comment) — removes the only end-to-end flow control.
- No rate-adaptive element on the native-rate path (both ASRC stages disabled,
  `realtime_client.c:1298-1303`) — clock drift integrates into buffer depth
  forever. (Kit's answer must be freshness + device-clocked pull, not ASRC.)
- Audio producer taking the LVGL display mutex twice per 100 ms chunk
  (`realtime_client.c:809-815` → `ui.c:235,249`) and a 32 ms-deadline DSP task
  taking a `portMAX_DELAY` status mutex shared with HTTP (`audio_pipeline.c:758`
  → `app_status.c:52-57`) — priority inversion patterns Kit's owner rules
  already forbid.
- Silent uncounted mic discard when the uplink stalls (`audio_pipeline.c:744-747`)
  — invisible VAD corruption upstream.

## 11. Keep / simplify / delete / defer, and the red-test-first sequence (deliverable 9)

| item                                                                                                     | disposition                                      | why                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tone analyzer core (windowed coherent projection, stable runs, bounded histograms, streaming three-pass) | **Keep**                                         | Sample-exact replication confirms it measures what it says; mid-stream behavior positively controlled (§7)                                                                                                                                                                                                                     |
| Uncommitted −12 dB relative level gate + 15 %-leakage test                                               | **Keep**                                         | Correctly rejects ring-down and quiet coherent copies (it alone turns the reference run green); just not sufficient for full-level fragments                                                                                                                                                                                   |
| First/last-active span with no positional anchor                                                         | **Simplify (fix)**                               | Add `analysisStartMs`/`analysisEndMs` from the existing markers + `excludedCoherentWindowCount`; RED-A/B/C fixtures (§6)                                                                                                                                                                                                       |
| Marker mechanism (`stat()`-based sample counts)                                                          | **Keep, document the quantum**                   | 42.67 ms lower-bound semantics are fine for anchoring; add the 10 s heartbeat for long runs                                                                                                                                                                                                                                    |
| SoX/CoreAudio recorder                                                                                   | **Keep + add warm-start detector**               | Wall-honest (§3); its first HAL buffer is stale (§5) — detect and report, don't trust file-start                                                                                                                                                                                                                               |
| Strict thresholds duplicated in two files (F6)                                                           | **Simplify**                                     | Single exported constant; they will drift apart otherwise                                                                                                                                                                                                                                                                      |
| `maximumInternalGapMs: 0` + coherence-only gap definition                                                | **Simplify (classify)**                          | Split "masked" (amplitude held, coherence lost) from "absent" (amplitude collapsed); fixture-first (§7)                                                                                                                                                                                                                        |
| Hardware-reserve descriptor policy (credits/debt/deadline)                                               | **Keep**                                         | Sound, conservative, conserved, test-covered (§8); do not extend into a content queue                                                                                                                                                                                                                                          |
| Zero-tolerance underrun acceptance for _every_ lane                                                      | **Simplify (two lanes)**                         | Lane S stays zero; lane P budgets recovery with 1:1 acoustic cross-check (§9). Matches the reconciliation's recovery-vs-continuity split; the 1:1 cross-check answers its "budget would redefine audible discontinuity as success" objection — the discontinuity is counted, bounded, and acoustically verified, not redefined |
| Reset/EOS instrumentation                                                                                | **Simplify (add 4 observables)**                 | Outage duration, start timestamp, substituted-slot sequence, EOF watchdog (§8, F9–F11)                                                                                                                                                                                                                                         |
| Per-response I2S delete + codec repower + amp toggle                                                     | **Defer to the accepted create-once comparison** | Unchanged from the reconciliation; F9/F12 add urgency arguments (transients, brownout inrush) but not a new decision                                                                                                                                                                                                           |
| Brownout detector                                                                                        | **Keep untouched**                               | Level-7 = real rail collapse; classify as power, terminal, separate from audio continuity; mitigations (soft-start, amp-across-resets, supply audit) belong to the create-once comparison                                                                                                                                      |
| PRBS31 challenge                                                                                         | **Keep, fix episode boundary, then promote**     | Zero skip/dup/drift-fit already proven physically; anchor its amplitude analysis like the tone's; rename or truly derive `decodedSeedMatchesExpected`                                                                                                                                                                          |
| Endurance runner fail-closed `runtime: {}`                                                               | **Simplify (wire it)**                           | Prerequisite for the ladder                                                                                                                                                                                                                                                                                                    |
| ffmpeg anywhere in capture                                                                               | **Keep deleted** (enumeration only)              | Already replaced; keep as known-bad control                                                                                                                                                                                                                                                                                    |
| StackChan playback buffering (all of §10's do-not-migrate list)                                          | **Delete from consideration**                    | Named failure modes, each anti-matching a Kit invariant                                                                                                                                                                                                                                                                        |
| StackChan instruments (loopback reference, DMA tap, face tap, seqlock, leveler, self-test discipline)    | **Defer-adopt with the duplex/AEC tranche**      | High value; none block the current milestone                                                                                                                                                                                                                                                                                   |

**Red-test-first sequence:**

1. **RED:** fixtures A/B/C (§6) against the current analyzer — A fails
   (false gap), B must keep failing after any fix, C pins in-window behavior.
   **GREEN:** `analysisStartMs`/`analysisEndMs` + runner passes markers.
2. **RED:** warm-start fixture (stale head + dead zone synthesized) →
   capture-provenance flag; plus the wall-vs-sample marker invariant as a
   runner assertion (would have flagged every ffmpeg-era artifact loudly).
3. **RED:** masked-vs-absent gap fixture (tone + noise burst) → classified
   `maskedWindowCount` (§7).
4. **RED (host, then firmware):** outage-duration/first-sample-timestamp
   contract via the existing fake driver; then schema increment.
5. **RED:** lane-P manifest policy — a synthetic run with one classified
   recovery incident and one matching 20 ms acoustic gap passes lane P and
   fails lane S; an acoustic gap with _no_ matching counter fails both.
6. Re-run the 10 s and 20 s direct-LAN proofs (expect: strict green on
   completed runs, honest truncation reports otherwise), then the §9 ladder:
   1-min tone → 2-min PRBS+load → 10-min PRBS+load.
7. PRBS episode-boundary fix rides in parallel (its own RED: synthetic
   full-level leading fragment must not produce a 50 dB "adjacent step").

## 12. Provenance

Analysis scripts (NumPy via `uv`, plus one tsx runner importing the
working-tree analyzer) are retained outside the working tree in the job
scratch directory `/Users/jonastemplestein/.claude/jobs/746b7639/tmp/`:
`analyze_artifact.py` (current-semantics replica + timeline),
`old_analyzer_replica.py` (HEAD-semantics replica + cross-artifact warm-start
scan), `stale_ring_check.py` (head/tail pairings + NCC),
`schema4_check.py` (schema-4 decomposition), `run_current_analyzer.ts`
(actual analyzer over all artifacts). Artifacts analyzed in place under
`apps/kit/evidence/m5sticks3-playback/`; no artifact was modified. Reference
artifact: `…retry-20260730-2302/iterate-kit-acoustic-2OXLQp/microphone.pcm16le`,
1,155,072 bytes. The five aborted-run causes are quoted from their run logs'
terminal lines; subagent-verified line citations for firmware and StackChan
were spot-checked against source during drafting.

## 13. What would falsify this report

- A completed direct-LAN tone run, analyzed with marker anchors, that still
  shows an internal gap or > 5 phase discontinuities between onset and EOS
  while device counters are clean — that would reopen a true device-side
  continuity ledger (start at F9's boundary transients and the ingress path,
  with the §7 matrix).
- A capture whose first ~12 ms fragment does **not** match the previous
  session's ending audio (e.g., the §5 chirp experiment finds live room audio
  at file start) — that would demote warm-start replay to coincidence and
  reopen the environmental hypothesis for fragments.
- A lane-P endurance run in which acoustic gaps and recovery counters diverge
  (gaps without incidents, or incidents without gaps at the predicted length)
  — that would indicate either an uninstrumented device hole (F9 class) or an
  oracle defect, in that order of prior.
