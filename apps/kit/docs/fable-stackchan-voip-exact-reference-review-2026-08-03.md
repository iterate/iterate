# Fable Max review: StackChan VOIP AEC with exact TX reference — 2026-08-03

Read-only review at `c-capabilities` per
`apps/kit/docs/fable-stackchan-voip-exact-reference-prompt-2026-08-03.md`.
Sources: first-hand reads of the current diff and the CoreS3 audio platform
(`core_s3_audio_owner.c`, both reserves, `aec_capture_bridge`,
`aec_signal_window`, `pcm_clock_playback`, the patched BSP), the vendored
ESP-SR 2.4.7 headers **and disassembled esp32s3 libraries**, ESP-IDF v5.4.2
driver source at `~/esp/esp-idf` (the toolchain the build actually uses, per
`apps/.build/stackchan/CMakeCache.txt`), the prior art at
`~/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec/`, the
retained run `apps/kit/evidence/stackchan-exact-tx-reference-reset-fix-20260803/2026-08-03T15-21-34-016Z/`,
and new offline spectral analysis of that run's retained PCM performed for this
review. No code was edited, no device flashed, no audio played; only this file
was created. Sibling document: the same-day semantic-oracle review
(`fable-stackchan-semantic-oracle-review-2026-08-03.md`) measured the
provider-facing invariant; this review supplies the signal-level attribution
that document asked for.

## Executive verdicts

1. **Pairing (Q1): semantically correct in this run, and better than the prior
   art's sequence pairing — but the 12 ms skew gate leaves two silent
   8 ms-slip paths open.** All 11,585 pairs rode one timestamp anchor with
   callback skew ≤ 1.428 ms. Cross-side DMA _sequence_ equality is not a valid
   key on this platform (independent callback counters, per-boot enable phase,
   and GDMA EOF coalescing that under-counts callbacks); the exact key is
   per-side FIFO order plus one tight timestamp anchor. Shrinking the gate
   from 12 ms to 4 ms closes both slip paths with 2.8× margin over the
   measured jitter envelope.
2. **VOIP expectations (Q2): Espressif documents nothing about reference
   timing, scale, or polarity — and two of the firmware's three AEC knobs are
   inert.** Disassembly proves `filter_length` and `nlp_level` are ignored in
   VOIP modes, the engine runs internally at 8 kHz (uplink is band-limited to
   4 kHz), and bulk delay must be absorbed by ~128 ms of subband taps because
   TDE is dead code. No deliberate reference delay is needed or wanted; the
   only hard requirement is that the reference must never lag the mic.
3. **The −20.77 dBFS tone residual (Q3) is not echo: it is loudspeaker/amp
   harmonic distortion.** Offline decomposition of the retained uplink shows
   the 997 Hz fundamental suppressed to −50…−75 dBFS (≈ 55 dB of linear
   cancellation) while 60–97 % of the residual energy sits at exactly
   2×997 = 1994 Hz and 3×997 = 2991 Hz — frequencies the fundamental-only
   digital reference cannot express to a linear filter. The attributing
   measurement already exists in this run's evidence; the confirming device
   run is a one-constant amplitude A/B, not a tuning maze.
4. **DTD yes, TDE no (Q4).** The esp32s3 2.4.7 binary runs an ERL-ratio
   double-talk detector unconditionally on the VOIP path; the WebRTC-style
   delay estimator is compiled in but has zero callers (`DIOS_SSP_AEC_TDE_ON`
   is written, never read). Double-talk far-end suppression held in this run
   (residual energy in the 2 kHz carrier band: 1.1 %); the failing double-talk
   gates are dominated by a one-time near-level ramp in the control phase and
   a content-blind energy gate with a +18.06 dB domain bias, not by echo leak.
5. **Smallest next step (Q5): one micro-patch (skew gate + telemetry stride +
   comment truth), one harness correction, one quiet-network rerun, then the
   real-speech far-only proof.** The local maximum to avoid is polishing the
   deterministic fixture's dBFS gates: the tone gate is physically unreachable
   at volume 90 with any linear reference, and green-by-tuning there proves
   nothing about the Grok invariant, which the sibling review already measured
   red at playback tails.

## 0. What this run actually was

Fixture: `deterministic-aec-fixture.ts` — six 6 s responses at 16 kHz played
through the device speaker: 997 Hz tone (amp 4500), dual-carrier PRBS31
(1 kHz + 2 kHz BPSK carriers, 16-sample = 1 ms chips, amp 2250 each),
speech-shaped noise, two 431 Hz pilots (amp 64) under the Mac-only controls,
and a second PRBS during double-talk. Device: volume 90, mic PGA +24 dB,
`AEC_MODE_VOIP_HIGH_PERF`, exact completed-TX reference
(`targets/stackchan/main/main.c:1176-1183`). The worker multiplies every
accepted uplink sample by **×8** with clamping before Grok and before the
recorder (`server-vad-policy.ts:40-43`, `pcm-proxy.ts:917-937`), so every
dBFS number in the evidence — and in this review's spectra — is post-gain;
device-side values are 18.06 dB lower. Gate formula: far-only clean ≤
max(−40 dBFS, ambient + 6 dB) = −30.92 dBFS here
(`aec-waveform-assessment.ts:187-195`).

Run health: 11,585 reference pairs, exactly 1 epoch reset (bounded startup
handoff: 3 producer-side drops, reserve depth peaked at 4, then steady 1:1),
per-pair callback skew 376–384 µs all run, maximum 1.428 ms, zero capture
loss, frame conservation in all seven phases. The run is `network-invalid` by
its own hierarchy (router RTT spikes to 113 ms at t≈18.5/21.5/50.5 s), and
"The PCM recorder did not close complete" is a misnomer for two 62/66 ms
inter-accept gaps that co-time with those spikes (sibling review §"misnomer";
`production-aec-diagnostic-capture.ts:259-336`).

## 1. Q1 — Is the pairing semantically correct?

### What the mechanism actually is

- BSP patch (`patch_core_s3.cmake`, generated file
  `targets/stackchan/build/iterate_patched/m5stack_core_s3_idf5.c:36-96`):
  `on_i2s_tx_sent` / `on_i2s_rx_received` run in GDMA EOF ISR context,
  increment a per-side `__atomic_add_fetch` **callback counter**, and hand the
  tap `(sequence, esp_timer_get_time(), event->dma_buf, event->size)`.
- Owner (`core_s3_audio_owner.c:696-765, 809-941`): TX pushes into an 8-chunk
  poison-on-anomaly reserve, RX (after a 5-chunk startup drain) into another;
  the AEC task pairs strictly by **FIFO arrival order**, holding a lone
  capture chunk when the reference side is momentarily empty, and validates
  each pair with `|captured_through − played_through| ≤ 12 ms`
  (`CORE_S3_REFERENCE_PAIR_MAXIMUM_SKEW_US`, `core_s3_audio_owner.c:49-56`).
  Violation ⇒ poison both reserves + destroy/recreate the AEC.

### Driver facts the design rests on (ESP-IDF v5.4.2, verified in source)

- `on_sent` fires from the GDMA TX-EOF ISR with `dma_buf` = **the buffer that
  just finished being read out of memory**, and the ISR order is: user
  callback → `auto_clear` memset → msg-queue post that unblocks
  `i2s_channel_write` (`i2s_common.c:614-659`). The tap therefore reads the
  true transmitted bytes race-free, and during TX underrun the ring keeps
  cycling zeroed buffers with `on_sent` still firing — the reference stays
  honest through starvation (silence reported when silence played).
- TX and RX are one `i2s_new_channel` duplex pair: shared BCLK/WS via
  `sig_loopback`, RX forced slave (`i2s_std.c:114-125`, `i2s_tdm.c:122-133`,
  `hal/i2s_ll.h:1096`). One clock domain, both descriptors 128 frames = 8 ms ⇒
  EOF trains advance in 1:1 lockstep with **zero drift**. The _phase_ between
  them, however, is explicitly disclaimed by the driver ("full-duplex mode
  can't guarantee TX/RX channels write/read synchronously",
  `i2s_common.h:108-109`) — it is set by the enable-order gap and differs per
  boot. Measured this run: RX completes ≈ 0.38–1.43 ms before its TX partner.
- The literal channel configs in `initialize_codecs` are not the final
  hardware state: `esp_codec_dev` re-configures both channels during open
  (`audio_codec_data_i2s.c:432-518,626-655`), landing on TX = Philips mono
  16-in-32-bit-slot (256 B descriptors) and RX = TDM 4×16 (1024 B) on a
  64·fs wire — which is why `configure_speaker_for_shared_tdm_clock` exists
  and why the reserve byte contracts (256/1024 B) hold.

### Verdict and the two silent slip paths

**In this run the pairing was semantically exact**: one anchor at startup,
skew never above 1.428 ms, zero mid-run resets — the reference chunk paired
with each mic chunk covered the same 8 ms of the shared clock. The
"one-shot paired-reset fix" (`discard_current_epoch` consuming its own poison
via `take()`, `core_s3_playback_reference_reserve.c:212-228`) did its job:
`lifetimeReferencePairResets` stayed at 1.

But "must TX/RX be aligned by DMA sequence rather than callback timestamps?"
has a precise answer: **neither alone is sufficient, and sequence is the
weaker key of the two on this platform.**

- Cross-side sequence equality is meaningless: the counters are per-side
  callback counts with independent start epochs (init churn predates the tap
  install at `core_s3_audio_owner.c:1348-1353`). The prior art paired by
  `delta == 0` sequence equality (`audio_pipeline.c:559-608` in experiment 02) and got a mic-vs-reference lag of 28–44 ms **that changed per boot in
  exact 8 ms steps** — its celebrated 50.5/33.7 dB candidates failed their own
  confirmation reruns at 21.9/12.9 dB when the lag family flapped. The current
  timestamp-anchored design is strictly better: it pins the anchor to ≤1.4 ms.
- Sequence numbers also **under-count**: the GDMA ISR reads status once and
  hands only the latest EOF descriptor to a single callback
  (`gdma.c:827-853`). If ISR latency ever exceeds 8 ms (e.g. a
  flash-cache-off window; these ISRs are `LOWMED` on the init core), one side
  silently loses a descriptor while its counter advances by 1 — so the
  reserves' `sequence == last+1` continuity check
  (`core_s3_playback_reference_reserve.c:115-124`) **can never fire for real
  DMA loss**; today it detects only tap uninstall/reinstall.

The two paths that break alignment _and pass the 12 ms gate_:

1. **Anchor roulette at epoch reset.** A reset's queue discard lands at a
   random phase. If it falls inside the ≈0.4–1.4 ms window between an RX
   completion and its TX partner (probability ≈ φ/8 ≈ 5–18 % per reset), the
   wiped RX chunk makes the first new pair (RX[k+1], TX[k]): skew 8−φ ≈
   6.6–7.6 ms — accepted — and the reference now **lags** the mic by 8 ms
   forever.
2. **Asymmetric coalesced EOF.** An RX-side coalesced EOF drops one capture
   chunk: every later pair is (RX[m+1], TX[m]), skew ≈ 8−φ ms — accepted —
   reference lags 8 ms. (The TX-side twin makes the reference _lead_ 8 ms,
   which the filter absorbs; the lag direction is the fatal one.)

A lagging reference is unrecoverable in this engine: with TDE dead (§4) and a
causal adaptive filter, echo whose source samples sit in the _future_ of the
presented reference stream cannot be modeled at all — cancellation collapses
to zero while every counter reads healthy. The comment justifying 12 ms
("…plus the physical acoustic lead expected by ESP-SR's delay estimator",
`core_s3_audio_owner.c:49-56`) is built on the TDE that does not run.

**Fix shape (smallest):** change the constant to 4 ms. Steady-state jitter
measured ≤1.428 ms leaves 2.8× margin; both slip paths present as ≈6.6–9.4 ms
and now trigger the existing paired reset instead of being accepted. For
exactness-by-construction, the tap already receives `event->dma_buf`, and the
5-buffer ring is a driver invariant (`i2s_common.c:516-523`): remembering the
last five pointers per side and requiring period-5 recurrence detects a
coalesced EOF deterministically (~15 lines) — worthwhile, but the 4 ms gate
alone already converts silent corruption into a bounded reset.

## 2. Q2 — What does VOIP AEC expect from the reference?

**Documented (exhaustive):** `esp_aec.h` says only that `refdata` is "16-bit
signed audio samples sent to the speaker", planar layout, aligned allocation,
16 kHz. The vendored component ships no docs (excluded in
`idf_component.yml`), and the complete ESP_LOG string inventory of
`libesp_audio_processor.a` contains **no** runtime warning about reference
delay, divergence, or resets. There is no documented delay tolerance, scale,
polarity, or lead/lag guidance. Filter length is documented only as "Number of
filter, recommend to set 4".

**Inferred from the esp32s3 binary (disassembly + DWARF, high confidence):**

| Property              | Reality in `AEC_MODE_VOIP_HIGH_PERF`                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine                | athena-signal `dios_ssp` subband AEC (Didi), dispatched via `esp_voip_*`                                                                                                                                          |
| Internal rate         | **8 kHz** — Speex resamplers 16k→8k (mic, ref) and 8k→16k (out), quality 5; `AEC_SAMPLE_RATE` global = 8000                                                                                                       |
| Frame                 | 256 samples @16 k → 128 @8 k; `aec_get_chunksize()` = (rate×16)/1000                                                                                                                                              |
| `filter_length`       | **Ignored** — `stCfgData` has no such member; VOIP sizing comes from mode                                                                                                                                         |
| `nlp_level`           | **Ignored** — applied only for modes 5/6 (FD); guarded by `bgeui a15,2`; warning string "Only full-duplex AEC support NLP level setting". VOIP NLP (two-stage `dios_ssp_aec_res`) is always on and not adjustable |
| HIGH_PERF vs LOW_COST | Subband taps 8 vs 4, processed bands 18 vs 4 (`NTAPS_*`, `NUM_MAX_BAND`)                                                                                                                                          |
| Delay budget          | ≈ NTAPS 8 × 16 ms ≈ **128 ms** shared bulk-delay + echo-tail; no delay estimator (TDE dead, §4)                                                                                                                   |
| Scale / polarity      | Free — two-path FIR+ADF adaptive filter absorbs constant gain and sign. Measured this run: mic echo ran +8.9 dB above the digital reference (tone: nearMA 8003 vs refMA 2877) and cancellation was fine           |
| AGC/NS inside         | **None** — `esp_voip_api.c.obj` links only the AEC modules + resamplers; `ptr_ns/ptr_agc/...` struct slots are unwired                                                                                            |

Consequences:

- **No deliberate reference delay/lead should be added.** The completed-TX
  reference leads the acoustic echo by the small constant path delay
  (FIFO + amp + acoustics + ADC ≈ low ms), which sits comfortably inside the
  128 ms tap span. The only hard constraint is causality: the reference must
  never lag (§1). The prior art's offset sweeps agree: 0 ms was optimal and
  ERLE decayed monotonically toward 64 ms of added reference delay.
- **The firmware config is misleading on three counts** (all comment/config,
  no behavior): `CORE_S3_AEC_FILTER_LENGTH` and `CORE_S3_AEC_NLP_LEVEL` are
  inert in this mode; the `create_aec` comment's "integrates TDE, DTD and
  residual suppression" is one-third false; and the AGGR-vs-VERYAGGR
  double-talk observation cited in the NLP comment was necessarily gathered
  on the FD engine (where the knob works) — prior-art status snapshots
  confirm its record runs were `fd_low_cost`.
- **VOIP mode band-limits the uplink to ≤4 kHz** (8 kHz internal rate).
  Content above 4 kHz in "clean" output is resampler reconstruction. This is
  an accepted property of the mode, but it belongs in the decision record —
  it affects STT quality and explains why tone harmonics above H4
  (3988 Hz) measure at zero.

## 3. Q3 — Why does the tone stay at −20.77 dBFS while speech-shaped passes?

**Measured attribution (new, from this run's retained PCM).** Offline
decomposition of `far-tone.accepted-uplink.pcm` (1 s windows; quadrature
projection at 997 Hz; FFT band shares):

| Window | rms dBFS | f0 997 Hz | H2 1994 Hz | H3 2991 Hz | other    |
| ------ | -------- | --------- | ---------- | ---------- | -------- |
| 0 s    | −22.2    | 0.2 %     | 16.1 %     | 82.4 %     | 1.2 %    |
| 1 s    | −20.2    | 0.4 %     | 8.5 %      | 51.6 %     | 39.6 %\* |
| 2 s    | −21.1    | 0.1 %     | 8.3 %      | 88.5 %     | 3.1 %    |
| 3 s    | −21.0    | 0.0 %     | 8.3 %      | 74.5 %     | 17.2 %   |

\*window 1 contains the run's single 8-sample full-scale burst (t≈1.613 s).
Coherent 997 Hz content: −50.4 dBFS worst window, −74.6 dBFS best — i.e. the
**fundamental is suppressed ≈ 55 dB** below its mic level while the residual
is almost entirely the 2nd and 3rd harmonic. The top spectral peak of the
mid-phase residual is 2991 Hz at 58.6 % of total energy.

A linear adaptive filter fed the digital fundamental-only reference is
mathematically blind at 1994/2991 Hz: those components exist only after the
AW88298 + micro-speaker + enclosure distort the waveform. This is the same
physics the firmware already recorded once at the mic ("the near microphone
railed even though the exact completed-TX reference remained far below full
scale… a linear AEC cannot cancel information the speaker has already
distorted", `main.c:1165-1175`) — now quantified at the _output_. The gate
(ambient+6 dB = −30.92) is therefore unreachable for this stimulus at volume
90 regardless of pairing, filter length, or delay: **the tone phase currently
measures speaker THD, not AEC quality.** Speech-shaped passes because its
distortion products spread across the band and land under the same
ambient+6 dB yardstick; PRBS missed by 0.19 dB with a residual that is 79.6 %
below 300 Hz (room/ambient floor, not carriers — carrier bands hold 15.4 %).

**The one attributing measurement** is the harmonic decomposition above — it
already exists offline and needs no new run. If a physical confirmation is
wanted, the cheapest falsifier is a one-constant A/B, not a tuning maze:
rerun the tone phase at amplitude 2250 (−6 dB). Loudspeaker distortion is
superlinear (H2 ≈ 2:1, H3 ≈ 3:1 in dB), so the residual should drop ≥12 dB
(to ≈ −33 dBFS, under the gate); a linear leak would drop exactly 6 dB.
Equivalently, redefine the tone gate on what the AEC can actually control:
coherent-f0 content ≤ −45 dBFS post-gain (this run already measures −50.4 or
better).

Two secondary observations from the same analysis, both worth recording:

- **Onset re-convergence transients are real and ×8-clips the uplink.** The
  PRBS phase opens with ≈200 ms at −5…−4 dBFS (630 clipped samples); the
  speech-shaped phase opens with 23 clipped samples. Cold-start convergence of
  the 8 kHz subband filter on new broadband content takes ~1–2 s; the gated
  window [1 s, 4 s) hides most but not all of it. This is the natural
  signal-level bridge to the sibling review's false `speech_started` edges at
  playback boundaries: response onsets/tails briefly pass near-raw echo that
  is spectrally _speech_ when the far content is speech.
- **The mic itself clips during the loudest stimulus**: device-side nearPeak
  hit 32768 throughout the speech-shaped phase (PGA +24 dB, volume 90). A
  clipped near signal is another nonlinearity no reference can explain.
  Headroom, not gain, is the lever the next time double-talk quality is
  tuned.

## 4. Q4 — DTD/TDE in this build; does double-talk survive?

**Binary facts (disassembly of `libesp_audio_processor.a`, esp32s3, 2.4.7):**

- **DTD: present and active.** `dios_ssp_aec_doubletalk_process` sits
  unconditionally on the per-frame VOIP path (relocation order:
  subband analyse → firfilter → ERL estimate → res stage 1 → **doubletalk** →
  res stage 2 → compose). It is an ERL-ratio/band-energy detector
  (`dtd_thr`, `erl_ratio`, `far_end_talk_holdtime`), complemented by the
  two-path (fixed FIR + adaptive) filter's MSE comparison.
- **TDE: dead code.** The complete WebRTC-style delay estimator is compiled
  in, but an exhaustive per-object sweep of every S3 library shows zero
  external callers; `DIOS_SSP_AEC_TDE_ON` is stored (0/1 by mode) and never
  loaded. `AEC_MODE_VOIP_HIGH_PERF` sets the flag to 1 and nothing reads it.

**This run's double-talk, reread against that:** the far stimulus (dual
carrier at 1 k/2 kHz) is nearly absent from the double-talk residual — the
1.7–2.7 kHz band holds 1.1 % of residual energy, and farEndSimilarity is
0.011. Far-end suppression held while near speech continued: DTD did its job.
What failed:

- `farEndResidualDb = −3.15 dB` — an **energy** ratio computed
  clean-minus-scaled-control vs far source, carrying a +18.06 dB
  gained-vs-ungained domain bias (sibling review §3) and blind to content; it
  fails on near-speech mismatch energy even with zero echo. The similarity
  half of the same gate (≤0.2) passed 18× over.
- The near-preservation comparisons (similarity 0.774, gain 0.807,
  −3.60 dB residual) are all measured **against the near-only control — and
  the control itself was unstable**: per-250 ms levels of the identical
  Samantha utterance rose ≈ +4 dB across the first near-only phase
  (−24…−26 → −19…−22 dBFS) and started instantly loud in near-repeat, which
  is why even repeat-vs-first failed its own −6 dB residual bound (−5.59 dB).
  A one-time level ramp on first exposure (Mac speaker soft-start or a
  capture-side adaptation — indistinguishable from this evidence) contaminates
  every double-talk verdict derived from that control. The 14.16 dB
  above-ambient shortfall (needs 15) says the Mac source was also marginal.
- Real near-end cost still exists: gain 0.807 ≈ −1.9 dB and similarity loss
  0.14 during double-talk are consistent with the always-on two-stage residual
  suppressor chewing near speech while echo is present, plus the 4 kHz
  band-limit (§2). Usable, measurably degraded, and _not_ the erase-the-user
  failure VERYAGGR produced on the FD engine.

**Answer:** yes, VOIP mode provides an active DTD (not TDE) in this build,
and double-talk survives it at conversation-usable quality; the red
double-talk gates in this run are dominated by control-phase nonstationarity
and a mis-specified energy gate, both harness-side.

## 5. Q5 — Smallest next patch/run, deletions, local maximum

**Smallest firmware patch (one micro-PR, no behavioral risk):**

1. `CORE_S3_REFERENCE_PAIR_MAXIMUM_SKEW_US` 12 ms → **4 ms** (closes both
   silent slip paths; 2.8× margin over measured jitter). Optionally add the
   period-5 `dma_buf` recurrence check per side for exactness-by-construction.
2. Fix the telemetry stride blind spot: `CORE_S3_AEC_SIGNAL_SAMPLE_STRIDE 8`
   sampled from offset 0 aliases with the PRBS 16-sample chip — both carriers
   are exactly zero at chip positions 0 and 8, and content always starts
   128-aligned (`pcm_clock_playback_render` fills from offset 0), so
   `referencePeak/referenceMeanAbsolute` read **identically zero for both
   entire PRBS phases** in this run while the true reference was full-scale.
   Rotate the sampling offset per frame (or use stride 7). This nearly sent
   this review down a "reference tap is dead" path; the oracle must not lie.
3. Comment truth: delete "integrates TDE", stop presenting `filter_length`
   and `nlp_level` as active policy in VOIP mode, re-attribute the
   AGGR/VERYAGGR observation to the FD era, and delete the 12 ms comment's
   "delay estimator" rationale.

**Deletions (explicitly proposed):**

- The divider-reference remnants: `reference_gain_db` option + validation +
  the slot-1|2 `set_in_channel_gain` call, `CORE_S3_TDM_REFERENCE_SLOT`, and
  the stale "Using the latter—not a software copy…" divider comment block in
  `initialize_codecs` (`core_s3_audio_owner.c:379-393`) that describes the
  architecture this diff replaced. Keep the 4-slot TDM geometry and the
  AW88298 64·fs programming — they are clock requirements, not reference
  plumbing; shrinking `slot_mask`/ISR copy is a separate change that must pin
  `total_slot = 4` and is not part of the smallest patch.
- The reserves' `sequence == last+1` producer continuity check _as a DMA-loss
  detector_: driver analysis proves it can never fire for a real loss
  (coalesced EOFs still increment by exactly 1). Either replace it with the
  `dma_buf` recurrence check or stop counting on it.
- Harness: the `farEndResidualDb ≤ −40 dB` energy gate in its current form
  (domain-biased, content-blind). Keep the similarity gate; if an energy gate
  is wanted, measure the **carrier bands** (1 k/2 kHz ± chip bandwidth) of the
  residual against the same bands of ambient — content-aware and computable
  from already-retained PCM.

**Smallest run:** no flash is needed to settle Q3 (the decomposition above is
the measurement). The next physical run should be the same fixture on a quiet
network _after_ the micro-patch, expecting PRBS and speech-shaped green and
the tone phase judged on coherent-f0. The invariant itself is then decided by
the sibling review's R0 offline VAD replay plus a real-speech far-only window
in the Grok proof — not by this fixture.

**Local maximum, named:** iterating volume/gain/NLP/threshold to push the
deterministic fixture's tone dBFS gate green. The tone residual is speaker
THD; the gate cannot be reached at volume 90 with a linear reference, and
every knob that reaches it anyway (VERYAGGR-equivalent suppression, uplink
attenuation, higher VAD threshold — all previously rejected in
`providers.ts:531-539`) spends double-talk or barge-in to buy a diagnostic
number. A scalar speaker-active energy gate is the same trade and is
additionally disproven by measurement: Grok VAD firing is spectral, not
energetic (noise at 0.083 normalized RMS never fired; real speech at 0.039
fired — sibling review §1). The road forward is: exact pairing kept honest
(action 2), physics acknowledged in the gates (action 3), and the invariant
proven on real speech (action 5).

## Ordered actions (≤5) with numeric falsifiers

1. **Commit the working tree** (firmware + harness + evidence; two firmware
   files are untracked — `core_s3_playback_reference_reserve.{c,h}`).
   Falsifier: `git status --short apps/kit` is empty and the evidence dir is
   referenced from a commit; a rerun after `git stash` would lose the exact-TX
   reference entirely — that risk goes to zero.
2. **Land the firmware micro-patch** (skew gate 4 ms; telemetry stride
   rotation; comment truth; optional `dma_buf` recurrence check).
   Falsifiers: a soak that forces ≥100 epoch resets during playback shows
   **0** epochs settling with steady pair skew in [6, 10] ms (today's design
   expects ≈5–18 broken epochs); first-pair-after-reset skew ≤4 ms in 100 % of
   resets; PRBS-phase `referenceMeanAbsolute` reads ≥1500 (today: 0); steady
   maximum skew stays ≤2 ms (no new false resets).
3. **Correct the harness gates** (tone phase judged on coherent-997 Hz
   content ≤ −45 dBFS post-gain; double-talk far-leak judged on carrier-band
   residual vs ambient carrier band + similarity ≤0.2; fix the +18.06 dB
   domain bias; add one discarded warm-up Samantha utterance before the
   near-only control). Falsifiers: recomputing this run's retained PCM flips
   tone (coherent f0 −50.4 dBFS ≤ −45) and double-talk far-leak (2 kHz-band
   residual ≈ 1 % of residual energy) to pass while leaving the near-repeat
   verdict red until a warm-up run shows repeat residual ≤ −6 dB and a flat
   (±1 dB) near-only per-250 ms trajectory.
4. **Rerun the fixture once, quiet network, post-patch.** Falsifiers: router
   RTT < 50 ms for 100 % of samples; both recorder gaps ≤ 60 ms; PRBS clean ≤
   −30.92 dBFS (this run: −30.73, ambient-floor-limited); speech-shaped ≤
   −30.92; `lifetimeReferencePairResets` ≤ 1; maximum pair skew ≤ 2 ms.
5. **Prove the invariant on real speech** (sibling R0 + the ~25-line far-only
   window in `prove-production-stackchan-grok.ts`): offline replay of this
   run's three far `accepted-uplink.pcm` files through the Grok VAD path must
   produce **0** `speech_started`; live, ≥10 assistant-only replies with
   **0** false edges (including `response.done` tails, where the current
   count is 1 per run), while a scripted near barge-in still raises its edge
   within 1 s. This — not the fixture's dBFS ledger — is the semantic
   invariant the prompt names.
