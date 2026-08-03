# Fable Max review: shared AEC architecture and the physical oracle — 2026-08-03

Independent, read-only review at `c-capabilities` (working tree, including the
uncommitted owner/window/metrics diffs and the untracked `aec_diagnostic_trace`
trio). Method: first-hand reads of the calibration/adventures/goal documents and
retained evidence, plus five delegated deep audits — the firmware audio map
(both targets), the vendored esp-sr 2.4.7 headers with `nm`/disassembly of the
shipped `.a` libraries, the prior-art `iterate/stackchan` experiment-02 tree
with its retained run artifacts, the complete host-side proving pipeline, and
first-party web sources (Espressif docs/schematics, XMOS, xAI, Amazon, NS4150
datasheet). Every load-bearing delegated claim was cross-checked against at
least one other source. No hardware was touched, no process stopped, nothing
flashed; only this file was created.

## Executive verdict (five sentences)

The measured failure — tone cancels at −26…−30 dB while broadband PRBS gains
energy and double-talk collapses — is a *reference-conditioning and
engine-capability* problem, not an alignment, slot-mapping, or NLP-threshold
problem, and the program's own history contains the strongest clue: the
prior-art DMA-tap **digital** reference era measured the best linear
cancellation ever recorded on this hardware (33.7–50.5 dB candidates at mic
25 dB, 0.03 % clipping) while the electrical-divider era measured 13.2–16.4 dB,
so the institutional memory that "software reference failed" rests on the
earlier 86.8 ms stream-copy era and on a semantic-leak criterion that is an
oracle gap, not a reference verdict. The simplest robust architecture is
therefore: reference = the already-existing I2S **TX ISR tap** (bit-exact
"audio sent to the speaker", sample-synchronous on the shared controller,
leading the echo well inside ESP-ADF's published 0–10 ms causality window),
engine = same-library **VOIP mode** (the only engine in the shipped binary with
double-talk detection and delay estimation — `dios_ssp_aec_doubletalk_*`,
`dios_ssp_aec_tde_*`), the divider demoted from production dependency to the
oracle's amp-linearity probe, and level policy unchanged (fixed worker-side
gain, no adaptive gain anywhere on the uplink — the HAVPE AGC lesson). The
oracle that decides all of this without another guessing loop is one flash
away: wire the already-written-and-host-tested `aec_diagnostic_trace`
(four-plus-one planar taps in PSRAM, capture-then-drain through the ordinary
Cap'n Web capability, USB serial stays excluded) and run the seven-step
sequence below; its captured near + both-references windows let an offline
ideal filter compute the achievable-ERLE ceiling for each reference *before*
any engine is swapped, which is also the fastest falsifier of this review's
recommendation. HAVPE needs no cancellation change — its XMOS hardware AEC
measured −47 dB far-end residual and 0.909 double-talk similarity — it needs
only the same oracle with a smaller channel set (raw/clean/playback-tap), so
the shared contract is the oracle and the owner seam, not a shared DSP.

## 1. Evidence map

All kit paths relative to `apps/kit/`; `SC` = prior-art
`~/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec`,
`SR` = `firmware/targets/stackchan/managed_components/espressif__esp-sr`
(v2.4.7, locked).

| Area | Exact source | What it establishes |
| --- | --- | --- |
| Capture topology (StackChan) | `firmware/platforms/iterate_core_s3_audio/core_s3_audio_owner.c:49-50` (slots 0/1), `:412-446` (TDM 4-slot 16-bit, one controller), `:341-367` (AW88298 forced to 64-BCLK, read-back verified) | Near mic and electrical reference arrive in the **same RX DMA descriptor**; TX/RX share one I2S controller/PLL — sample-synchronous by construction |
| Reference PGA state (shipped) | `core_s3_audio_owner.c:499-503`, `targets/stackchan/main/main.c:987,998` | Near 24 dB; reference masks 1\|2 at 18 dB, boot-only. **The digital ×8 is a proposal, not code**; no runtime knobs of any kind exist |
| AEC invocation | `core_s3_audio_owner.c:509-535` (`AEC_MODE_FD_HIGH_PERF`, filter 4, NLP AGGR, PSRAM caps, chunk 512 asserted), `:565-633` (linear/NLP split with µs timers) | Exactly one proven configuration; linear tap `owner.aec_linear[512]` exists (uncommitted) |
| Engine internals | `SR/include/esp32s3/esp_aec.h:24-31,85-120`; `nm`/disasm of `SR/lib/esp32s3/libesp_audio_processor.a` | DTD (`dios_ssp_aec_doubletalk_*`) and TDE (`dios_ssp_aec_tde_*`) exist **only** in the VOIP engine; SR/FD (AEC3) has neither — only NLP levels + `write_ref_vad`. VOIP is fused (`esp_voip_process_api`): **no linear tap**. VOIP frame 256/16 ms, ref_num must be 1; SR/FD 512/32 ms; inputs planar int16, 16-byte aligned |
| First-party cost tables | docs.espressif.com esp-sr AEC README (quoted in `docs/fable-v2-plan/exploration/afe-profile-decision.md:80-98`) | S3 @240 MHz: FD_HIGH_PERF 20.3 KB int / 126.2 KB PSRAM / 8.08 ms per 32 ms / 25.3 %; VOIP_HIGH_PERF 69.2 KB / 66.6 KB / 5.05 ms per 16 ms / 31.6 % |
| Measured on-device cost | evidence `aec-metrics.json` (`maximumLinearUs` 10 979 + `maximumNlpUs` 8 049); prior art `SC/local/…/aec-timing-ab/tuning.json` (15.5–41.8 ms/32 ms) | FD_HIGH_PERF+NLP really costs 38–61 % of core 1 under PSRAM contention — 1.5–2.3× the datasheet |
| Causality window | ESP-ADF `algorithm_stream` docs: "recording signal is delayed by around 0 – 10 ms compared to the … reference" (docs.espressif.com/projects/esp-adf) | The only published numeric alignment tolerance; TX-tap reference sits inside it, the 86.8 ms stream-copy era did not |
| Espressif reference convention | Korvo-2 user guide + schematic (`SCH_ESP32-S3-Korvo-2_V3.1.2`): echo ref = **ES8311 DAC output, pre-PA, default**; PA-output divider only via NC resistors | First-party default is a pre-power-amp reference — precedent for a scale-true, pre-nonlinearity reference |
| Prior-art measured ERLE by reference era | `SC/local/device-aec-volume-100/far/report.json` (18.6 dB, stream-copy, lag 86.8 ms); `SC/local/aec-runs/20260729-grok-eve-analog-gain/tuning.json` (DMA-tap: mic 37→5.4 % clip/18.7–20.6 dB; **mic 25→0.03 % clip/33.7–37.0 dB, repeat candidate 50.5**); `speaker-64fs-smoke` + `20260729T1718-network-isolation` (divider: 13.2–16.4 dB, lag 0.375 ms, ref −31 dBFS ≈ 11 dB below echo) | Digital DMA-tap reference at clean mic headroom outperformed the divider ~20 dB; analog mic clipping is the dominant spoiler |
| Prior-art double-talk | `SC` suite.json set: scripted double-talk 0.21–1.53 dB FAIL every time; near-similarity gate never passed; divider-era near/double **never measured** | The FD engine's missing DTD showed up long before the kit; kit's 0.080→0.0035 collapse is its confirmation |
| Kit measured failure | `docs/fable-stackchan-reference-calibration-review-2026-08-03.md` §0–4 (runs 01-45…06-02); `docs/voice-device-adventures-2026-08-02.md` 07:12 (tone 4 957→197/183; PRBS 3 513→3 268/3 174; near rails 32 768) | Linear stage diverges on broadband at 9–18 dB reference deficit; NLP adds <1 dB; near mic clips during loud far speech in every run |
| Trace scaffold (unwired) | `firmware/components/core/{src/aec_diagnostic_trace.c,include/iterate/kit/aec_diagnostic_trace.h}` + `firmware/tests/aec_diagnostic_trace_test.c` (untracked, host-tested) | Planar 4-tap exact recorder with IDLE→ARMED→CAPTURING→READY lifecycle, atomic, allocation-free, `read_planar(offset,count)`; **zero callers, no buffers allocated, no capability route** |
| Existing capture today | worker `PcmDiagnosticCapture` schema 2 (`src/userspace/config-worker/pcm-diagnostic-capture.ts`, 300×640 B accepted-uplink); no device-side raw ever reaches the host | The oracle's central gap is device-side raw persistence |
| Host oracle today | `scripts/prove-production-aec-waveform.ts` (six-phase deterministic-provider fixture, thresholds at `src/device/aec-waveform-assessment.ts:107-133`), `physical-network-{run,validity}.ts` (whole-run interval), `production-aec-diagnostic-capture.ts:193-263` (`maximumInterFrameGapMs` recorded, **not gated**) | What exists, and exactly where the gates are blind (no acoustic witness, no drift fit, no per-step network attribution) |
| HAVPE topology | `firmware/platforms/iterate_voice_pe_audio/voice_pe_audio_owner.c:566-620` (I2S slave ×2, XMOS-mastered), `voice_pe_pcm_format.c:115-142` (ch0 processed / ch1 raw), `voice_pe_hardware_config.c:67-92` (ch0 = **AEC stage** tap, read-back verified; IC/NS/AGC rejected with measured causes) | Hardware AEC (XCORE-VOICE FFVA `ffva_int_fixed_delay`, XMOS fw 1.3.1); no reference channel exists on the ESP bus; playback tap `owner.playback_pcm[160]` is the digital reference proxy |
| XMOS first-party | xmos.com XCORE-VOICE FFVA + XVF3610 datasheet | AEC tail 225 ms, automatic bulk-delay to 150 ms, `GET_ERLE_CH0_AEC` runtime query exists; no published ERLE dB spec |
| Level/VAD anchors | `docs/fable-havpe-agc-ns-aec-review-2026-08-02.md` §5 table; `src/userspace/config-worker/server-vad-policy.ts:40-48` | Fires/doesn't-fire ladder: clean speech mean 810 fires @0.1; residual 466 does not; HAVPE ×16 speech 1 150–1 300 fires 3/3. Fixed worker gain, never adaptive |
| Industry ERLE anchors | Amazon patent US10586534B1 ("converged … about 25 dB on average; steady state … about 15 dB to about 25 dB"); QSC AEC white paper (filter-only ~30 dB; >40 dB ≈ silence; convergence perceptible 1–2 s); NS4150 datasheet (1 % THD @~2.1 W, 10 % @~2.9 W of the "3 W" rating) | Calibratable external anchors for thresholds; class-D amps inject 1–10 % nonlinear products in their top 3 dB |

## 2. Why the current configuration fails on broadband (proven vs inferred)

**Proven.** (a) The reference reaches the engine 9–18 dB below the echo the
near mic carries, against a documented contract of playback-scale `refdata`
(`esp_aec.h:91,107`); every reference increase improved every far-only phase
monotonically. (b) The FD engine has no double-talk detector and no delay
estimator (binary symbol census); adaptation continues through double talk,
which is why a hotter reference made double talk *worse*. (c) The near mic
rails (32 768) for 5–6 consecutive windows during loud far speech in every
retained run — a nonlinearity no linear filter can model, at exactly the phase
that behaves worst. (d) Alignment and slot mapping are correct
(datasheet-proven order; 0.375 ms divider lag; tone converges). (e) NLP is a
masker: <1 dB effect in the measured windows, and VERYAGGR's "good" far-only
numbers coexisted with near-speech destruction.

**Inferred (mechanism, closed engine).** A frequency-domain block-adaptive
filter normalizes its update by per-bin reference power plus a regularizer
tuned for playback-scale input. A reference 20 dB under scale pushes every bin
into the regularizer-dominated regime and demands a +9…+27 dB filter gain that
a fixed-point coefficient representation may not span; a tone needs only one
well-excited bin (and cancels), broadband needs all bins simultaneously (and
diverges — clean *exceeding* near is an instability signature, not a noise
floor). The dose-response (0.33–0.55 dB per reference dB) is the measurement;
the arithmetic attribution is inference and does not need to be resolved:
scale-true reference is required under every candidate mechanism.

**Open.** Whether scale alone heals the FD linear stage (the §9 falsifier
decides), and whether the AW88298's limiter/DSP makes the *acoustic* echo path
materially nonlinear at operating volume (the dual-reference capture decides).

## 3. Candidate architectures

The baseline for comparison is the shipped state: electrical divider (slot 1)
at analog 18 dB into `AEC_MODE_FD_HIGH_PERF` + AGGR NLP, no runtime knobs,
worker ×8 fixed uplink gain.

### D1 — Scale-true divider: digital exact gain + VOIP engine

Keep the electrical reference; return both non-near PGAs to 0 dB; apply a
saturating digital ×8 (+18.06 dB) to slot 1 in `deinterleave_capture`
(calibration review route A — queued, unimplemented); swap the engine to
`AEC_MODE_VOIP_HIGH_PERF` via the same `aec_create_from_config` (frame
512→256; the bridge already parameterizes `processing_frame_samples`).

- *Cancellation quality*: divider carries the AW88298's real output (its
  limiter/volume behavior) — best-case nonlinearity coverage; but measured
  divider-era linear ceiling on this board is 13.2–16.4 dB, and the +7.3-dB-
  per-18-dB analog anomaly shows this analog chain is not fully understood.
- *Double talk*: fixed — VOIP has DTD + TDE + ERL estimation (symbol-proven).
- *Nonlinear speaker/codec effects*: reference is post-amp — nonlinearity is
  *in* the reference, which a linear filter still cannot invert, but at least
  the filter is not asked to explain amp compression as room response.
- *Clock domain*: same RX frame — zero-risk.
- *Latency*: engine 16 ms frames (an improvement); no added path latency.
- *CPU*: first-party 5.05 ms/16 ms (31.6 %); expect ~1.5× under PSRAM
  contention → comparable to today's measured FD cost.
- *Internal RAM*: first-party 69.2 KB — **the risk**: free internal is ~39 KB
  today; must be verified with `caps` steering to PSRAM (66.6 KB PSRAM in the
  same table suggests the split is configurable but unproven on this target).
- *Ownership/concurrency*: unchanged (same task, same bridge).
- *Portability*: StackChan-only by construction (HAVPE has no divider);
  observability: **loses the linear tap** (VOIP is fused).

### D2 — Exact digital TX-tap reference (recommended end-state), engine per evidence

Reference = the I2S TX ISR tap that already exists (`i2s_tap(transmit=true)`,
`core_s3_audio_owner.c:695-713`, physically-completed 128-sample DMA buffers,
currently feeding only the avatar's `observe_playout`). Pair TX-completion
chunks with RX chunks by sequence (the prior-art `receive_aligned_dma_pair`
pattern), feed the AEC that pair, and demote slot 1 to a diagnostics/oracle
channel. Engine: start with what the falsifier says — FD if scale heals it,
VOIP for its DTD if double talk still fails.

- *Cancellation quality*: this is the configuration family that produced the
  program's best measured linear ERLE (33.7–50.5 dB candidates at mic 25 dB);
  the reference is bit-exact and scale-true *by construction* (it is literally
  the "audio sent to the speaker"), so the entire reference-level calibration
  question — PGA compression, divider impedance, ×8 headroom — is deleted.
  Espressif's own Korvo-2 default reference is likewise pre-PA.
- *Double talk*: engine-determined (VOIP fixes it; FD does not).
- *Nonlinear speaker/codec effects*: the honest cost — the AW88298's limiter
  and class-D distortion are *not* in this reference. Bounded two ways: run
  the speaker at/below the volume where the oracle's divider-vs-tap coherence
  stays ≥0.95 (class-D amps are ~0.1 % THD until their top ~3 dB), and keep
  the divider channel captured so the operating point is continuously proven.
- *Clock domain*: TX and RX share one controller/PLL (`i2s_ll_share_bck_ws`;
  RX slaved to TX clock) — drift-free; TX-completion leads the acoustic echo
  by ≈0.5–2 ms plus ≤8 ms descriptor quantization, inside ADF's 0–10 ms
  causality window and trivially inside any tail.
- *Latency*: none added (the tap is passive).
- *CPU*: one extra 256 B copy per 8 ms + a small pairing ring — noise.
- *Internal RAM*: one 8-deep 128-sample TX ring ≈ 2–4 KB (or PSRAM).
- *Ownership/concurrency*: the TX tap ISR contract already exists and is
  IRAM-safe; pairing runs on the AEC task; no new tasks or locks.
- *Portability*: the *pattern* ports anywhere the owner writes PCM (HAVPE's
  `owner.playback_pcm` is the same seam); the divider stays available as a
  physical probe on StackChan only.

### D3 — First-party AFE-VC pipeline owns the interleaved pair

`afe_config_init("MR", …, AFE_TYPE_VC, AFE_MODE_HIGH_PERF)` consuming
interleaved [mic, ref] (either reference source), yielding VOIP AEC + NS
(WebRTC fallback — no model partition) + optional AGC/VAD; the v2.4.7 library
spawns **no internal tasks** (the task-creation worry in earlier docs is stale
v1 documentation) — the caller supplies feed/fetch contexts joined by a
50-frame ring.

- *Cancellation quality / double talk*: same VOIP engine as D1/D2.
- *Nonlinearity*: as per chosen reference.
- *Clock*: as per chosen reference.
- *Latency*: +ring buffering between feed and fetch (default 50 frames — must
  be sized down hard); 16 ms cadence.
- *CPU*: benchmark 30.6–32.2 % feed + 4.7 % fetch — the most expensive path.
- *RAM*: 48.7–91.1 KB internal + ~820 KB PSRAM — **over the internal budget**
  in HIGH_PERF; MORE_PSRAM mode unmeasured on this board.
- *Ownership/concurrency*: a second calling context and an opaque ring inside
  the audio path; the owner's single-writer discipline gets harder to prove.
- *Portability*: StackChan-only; HAVPE parity argument is weak because the
  stages HAVPE's XMOS adds (NS/AGC) are exactly the ones the program has
  *rejected* on the uplink (AGC destroyed VAD levels; on-device NS is not
  needed with server-side NS available). Verdict: capabilities we don't want
  at a price we can't verify — rejected unless D1/D2-standalone fails.

### D4 — Worker-side AEC: device uplinks raw near + playback cursor

Delete on-device cancellation for StackChan. The worker already possesses the
exact downlink PCM it paced; the device adds a per-frame playback content
cursor (which downlink sample its DAC is emitting, plus silence-fill/underrun
ledger) — a versioned `iterate.kit.pcm.v2` frame header — and uplinks the raw
near mic. The worker reconstructs the reference timeline, runs an open AEC
(Speex MDF compiled to WASM, or NLMS in TS) before gain and Grok VAD.

- *Cancellation quality*: worker CPU headroom permits longer tails and better
  engines than an S3; iteration is a worker deploy (minutes) instead of a
  ROM-loader flash — this attacks the program's costliest loop directly.
- *Double talk*: engine of choice (Speex robust-adaptation / two-path).
- *Nonlinearity*: same blind spot as D2 (pre-amp reference), same bounds.
- *Clock domain*: sound in principle — cursor and capture share the device
  sample clock, so network jitter does not affect alignment — but the
  reference must be *reconstructed* through the device's underrun/purge
  ledger, and every discard/reset path (400 ms age gate, generation fences,
  interruption purges) becomes an alignment hazard the device currently
  resolves for free by tapping its own DAC buffer.
- *Latency*: none added on-path (AEC inline before provider append).
- *CPU/RAM on device*: reclaims 38–61 % of core 1 and ~130 KB PSRAM.
- *Worker cost*: ~0.5–2 ms CPU per 20 ms frame in a single-threaded DO that
  is also pacing playback — real, unmeasured, and billed.
- *Ownership*: moves the hardest realtime DSP into TypeScript with vitest
  fixtures — the best testability of any option.
- *Portability*: trivially per-mode (HAVPE bypasses); but it makes audio
  quality depend on a protocol bump + worker correctness, and the HAVPE
  downlink teardown work shows the transport is still the program's most
  fragile layer. Verdict: the strongest *radical* option; not first, because
  D2 reaches the same reference quality with two orders of magnitude less
  moving-part change. Revisit if the flash loop stays the bottleneck after
  runtime knobs land.

### D5 — Open on-device engine: SpeexDSP MDF

`speex_echo_state` (BSD, plain C, fixed-point) at 16 kHz, frame 128–256, tail
1 024–2 048, fed by the D2 reference; optional `speex_preprocess` residual
suppression. The decisive property: **the identical C runs in the existing
native host rig**, so convergence, double-talk, and regression tests execute
in CI on recorded fixtures — impossible with the esp-sr blob.

- *Cancellation quality*: solid linear MDF; generally below tuned commercial
  engines; residual suppression needed for the last 10 dB.
- *Double talk*: no explicit DTD but Valin's optimally-varied learning rate is
  substantially divergence-resistant — better than FD's nothing, likely below
  VOIP's DTD; must be measured.
- *CPU*: **no credible S3 benchmark exists** (verified); an ESP32 port exists
  (rjsachse/ESP32-SpeexDSP, 16 ms/64 ms example). Must be measured in the host
  rig then on-device; risk it lands at FD-like cost without FD's optimization.
- *RAM*: tail 128 ms ≈ tens of KB, PSRAM-placeable.
- *Ownership/portability*: same seam as today; adds a vendored C dependency
  we own forever. Verdict: the right **fallback** — pull it if esp-sr VOIP
  underperforms or its opacity blocks diagnosis, because it uniquely converts
  AEC from blob-behavior into tested first-party-style code.

### Comparison

| | Ref scale truth | DTD/double-talk | Amp nonlinearity in ref | Clock risk | CPU (core 1) | Int RAM | PSRAM | New moving parts | Testable off-device | Ports to HAVPE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline (shipped) | −9…−18 dB deficit | none | yes | none | 38–61 % meas. | ~5 KB frames | 126 KB | — | blob | n/a (hw AEC) |
| D1 divider ×8 + VOIP | exact ×8, analog chain still in path | **yes** | yes | none | ~31 % + contention | **69 KB claim — must verify split** | 67 KB | digital gain + engine swap | blob | no (divider) |
| **D2 TX-tap ref (+engine per evidence)** | **exact by construction** | per engine | no (bounded by coherence probe) | none (shared PLL) | +ε over engine | +2–4 KB ring | unchanged | TX/RX pairing ring | blob engine, but ref path fully host-testable | **pattern yes** |
| D3 AFE-VC | per ref | yes | per ref | per ref | 35–37 % | 49–91 KB | ~820 KB | AFE ring + fetch context | blob | weak parity |
| D4 worker AEC | exact (reconstructed) | engine of choice | no | cursor/underrun reconstruction | −38…−61 % (freed) | −5 KB | −126 KB | pcm.v2 header + worker engine + cursor ledger | **best** | per-mode |
| D5 Speex + D2 ref | exact | partial (robust µ) | no | none | **unmeasured** | ~10 KB | ~50 KB | vendored engine | **engine itself host-testable** | pattern yes |

## 4. Recommendation and fallback

**Recommended (simplest that can be excellent):** D2's reference with the
engine decided by measurement, landed as *one* instrumented flash and *one*
decision flash:

1. **Flash 1 — instrument, don't change behavior**: wire `aec_diagnostic_trace`
   (PSRAM planes, capability export, §5), add the TX-tap pairing ring feeding a
   **fifth trace channel** (digital reference candidate) while the engine still
   consumes the divider, land route A's digital ×8 + PGAs 0\|0 (already
   specified in the calibration review), and add the runtime knobs
   (`setMicGain`/`setReferenceScale`/`setNlpLevel`/`setVolume`) — all four are
   safe runtime calls and end the ROM-loader iteration tax.
2. **One seven-step oracle run** (§5) + **offline upper bound** (§9) on the
   captured window: this simultaneously adjudicates scale-sufficiency (route A
   endpoint), reference choice (divider vs TX-tap ideal-filter ceilings), amp
   linearity (coherence between the two references), and engine ceiling.
3. **Flash 2 — apply the verdict**: expected outcome per current evidence is
   TX-tap reference + `AEC_MODE_VOIP_HIGH_PERF` (DTD for the double-talk
   collapse; 16 ms frames; accept the linear-tap loss and record final-only in
   the window's channel bitmap). If the falsifier instead shows FD healed by
   scale alone including double talk, stay FD and keep the linear tap — the
   architecture is identical either way.

Level policy is part of the architecture and stays: fixed worker-side uplink
gain re-derived after the AEC heals (the ×8 was calibrated against a broken
AEC), explicit VAD params, **no adaptive gain on the uplink on any board** —
the HAVPE AGC episode is the standing proof. Headroom becomes a gated
operating point, not advice: far-only near-mic rail count must be zero at the
production volume, achieved by holding volume at/below the coherence-proven
linear regime (prior art: mic 25 dB @ 0.03 % clip produced the best ERLE ever
measured here).

**Fallback:** D5 (SpeexDSP MDF behind the same seam, same D2 reference),
chosen over D3/D4 because it preserves the owner architecture, removes blob
opacity, and is the only engine option whose exact production code runs in the
existing native CI rig. D4 (worker AEC) stays on the shelf as the radical
simplification if the physical iteration loop remains the program bottleneck
after runtime knobs land.

**HAVPE:** no cancellation change. Adopt the same oracle with channels
{raw ch1, clean ch0, `playback_pcm` tap}; optional enhancement (open question):
surface XMOS `GET_ERLE_CH0_AEC` over the existing I2C control path as a
cross-check metric.

## 5. The shared physical oracle

One sequence, both boards, deterministic provider (the existing worker mode
fence), Grok never required for AEC acceptance. Every step interval is
independently network-gated; transport-invalid evidence never passes — and
never fails — audio.

### 5.1 Step ladder

| # | Step | Stimulus | Duration | Raw capture | Primary verdicts |
| --- | --- | --- | --- | --- | --- |
| 0 | Preflight | — | — | — | identity: firmware build hash + `__describe` + knob snapshot (volume, gains, engine mode, NLP, worker commit) recorded into provenance; route preflight as today |
| 1 | Ambient | none | 10 s | stats only | floors: near/ref idle levels, ref crosstalk ceiling, heap/stack baseline |
| 2 | Far tone | 1 kHz, existing coefficient | 8 s | stats only | **sanity, never acceptance** (tones flatter every pipeline stage — measured NO-GO for echo work); coarse delay check |
| 3 | Far PRBS | dual-carrier PRBS31 (existing, run-ID-keyed) | 15 s | **yes** | linear ERLE by band + over time, convergence curve, delay/polarity (GCC-PHAT), clock-slip fit, residual coherence, ideal-filter ceiling input |
| 4 | Far speech | pre-rendered real speech served by the deterministic provider (new asset, hashed) | 20 s | **yes** | ERLE by band; **semantic leak gate**: STT of the accepted uplink must contain no far-phrase content (the 18.6–21.9 dB-with-similarity-1.0 wall is why scalar ERLE cannot be the only gate) |
| 5 | Near-only ×2 | Mac speech + 431 Hz pilot (existing design, keep — it pins the XMOS on its AEC path) | 12 s ×2 | stats + accepted uplink | near preservation anchor; repeatability control |
| 6 | Double talk | far **speech** (not noise) + Mac speech, marker-aligned overlap | 20 s | **yes** | near-end damage vs step-5 anchor (band energy + similarity + STT keyword recovery); far residual vs step 4; no false "turns" in provider-edge replay |
| 7 | Endurance under load | continuous far speech/PRBS alternation + avatar animation + background network traffic | 5–10 min | 10 s window per minute | drift (ppm fit across windows), gaps/resets, heap/stack monotonicity, ring depths, per-frame µs p99, zero drops |

Steps 1–6 ≈ 2 minutes of audio; with per-step drains the full run stays under
~15 minutes. Steps 2 and 5 keep today's phases; 4, 6-as-speech, and 7 are the
additions the measured failures demand.

### 5.2 Capture: wire `aec_diagnostic_trace`, don't build anything new

- **Planes**: StackChan {near, ref_engine, ref_tx_tap, linear (FD only —
  bitmap), final}; HAVPE {raw, clean, playback_pcm}. A channel bitmap in the
  window header declares what a given engine/board can produce; consumers key
  on the bitmap, never on the device name.
- **Storage**: planes allocated **once per oracle session in PSRAM**
  (`heap_caps_malloc(SPIRAM)` at capability-open, freed at close; never
  internal — free internal is ~39 KB and the plane math is 5 ch × 2 B ×
  16 kHz × 20 s ≈ 3.2 MB against ~6.9 MB free PSRAM). Allocation happens on
  the control task, outside the audio path; steady state allocates nothing.
- **Producer**: the AEC task calls `…_record()` with the frames already in
  scope — the trace is bounded memcpys behind one atomic state load when idle
  (already its contract), so diagnostics cannot cause the fault they measure.
  Ring-full is impossible by design: the trace is capture-to-length, completes
  to READY, and a slow reader can only fail to arm the *next* window. Frame
  sequence gaps abort the capture with a counter — a torn window is evidence
  of the fault, never silently spliced.
- **Drain**: capture-then-drain over the ordinary Cap'n Web capability
  (`aec.trace.arm/status/read(offset,count)/release`) in chunks bounded by the
  existing 8 KiB control envelope → a 3.2 MB window drains in roughly half a
  minute *after* the step, when nothing realtime is in flight. USB serial
  remains excluded (opening it reboots the board). The drain follows the
  bounded-diagnostics task's rules: safe to starve indefinitely, explicit loss
  accounting, correlation identity (boot id, firmware hash, audio epoch, first
  `capture_frame_seq`) in the window header.
- **Alignment**: all planes are written at the same frame index by the same
  task — sample-exact by construction; host alignment work is only
  device↔Mac (marker tones) and device↔worker (existing frame ordinals).

### 5.3 Host analyzers (all pure, all unit-testable)

Delay/polarity via GCC-PHAT ref→near per step (report ms + sign; compare to
design bounds: divider ≈0.4 ms, TX-tap 0.5–10 ms); clock slip via the delay
estimate's linear fit across step 7 (reuse the PRBS analyzer's ppm machinery —
it already measures drift to 500 ppm resolution and is currently unused by the
AEC oracle); ERLE(t, octave bands 250 Hz–4 kHz) near→linear and near→final at
250 ms hop; residual coherence MSC(ref, final) — high coherence residual =
linear misconvergence (fixable), incoherent residual energy = nonlinearity or
noise (engine cannot fix; look at clipping/volume); amp-linearity probe =
coherence(divider, TX-tap) + divider THD during step 2; clipping = consecutive
rail counts per channel (device already counts, oracle asserts zero in far-only
steps); double-talk near-end preservation = band-energy damage vs step-5
anchor + existing similarity + STT keyword recovery; health = heap/stack
watermarks, ring depths, bridge/trace counters, per-frame µs from the existing
metrics — plus two closed gaps: `maximumInterFrameGapMs` gets a threshold, and
a SoX-CoreAudio Mac-mic recording (never ffmpeg-AVFoundation) runs as an
**acoustic emission witness** so a dead amplifier can no longer pass silently.

### 5.4 Mac stimulus discipline

Pre-render all speech with `say -o` (voice/rate pinned, hashed into
provenance); play via `afplay` with wall-clock logging; every asset starts
with a 500 ms 1 kHz marker tone so the device-side capture aligns the corpus
to ±1 sample by matched filter instead of trusting `afplay` onset (today's
±750 ms correlation search remains as fallback). Mac volume stays the fixture's
40 % ceiling with save/restore on all exit paths. The Mac microphone is a
witness, never the ERLE instrument.

### 5.5 Network validity, per step

Keep the existing 1 s probe fabric and fail-closed classification, but stamp
every probe/diagnostic sample with the step id and classify **per step
interval**: a step is judged only if its own interval is network-valid; an
invalid interval re-runs that step (bounded retries) rather than voiding the
run; no audio verdict is ever computed from a transport-invalid interval, and
no transport evidence ever substitutes for an audio verdict. This preserves
the 06-02 precedent (correctly rejected run) while ending whole-run
invalidation by a single stray ping minutes away from the phase under test.

### 5.6 Provider-edge confirmation (separate, replayed)

AEC acceptance is Grok-free. The provider-edge gate reuses the replay harness:
step-4 and step-6 accepted uplinks replayed through the real Grok socket at the
production gain/threshold must produce **zero** `speech_started` in far-only
material and exactly the scripted count in double-talk — the "no false
provider turns" contract, with the measured anchors (466 no-fire / 810 fire;
×4 false turns "Yeah/Stop/Hi") as the calibration rails.

## 6. Acceptance thresholds

[M] = measured in-house anchor; [F] = first-party published; [E] = estimate —
must be calibrated physically before it becomes a gate.

| Quantity | Gate | Provenance |
| --- | --- | --- |
| Far-PRBS steady linear ERLE (300–3 400 Hz) | ≥ 12 dB (falsifier floor); target ≥ 15 dB | [M] calibration-review falsifier; prior-art divider passes 13.2–16.4 dB; [F] Amazon steady state 15–25 dB |
| Far-speech final ERLE | ≥ 15 dB broadband; ≥ 10 dB per octave 500 Hz–4 kHz | [E] anchored on [M] prior-art 18.6 dB pass and [F] Amazon 25 dB converged |
| Far-speech semantic leak | STT of residual: zero far-phrase content words | [M] the similarity-0.96–1.0 leak wall; replay false-turns precedent |
| Far tone | ≥ 25 dB (sanity only, never acceptance) | [M] current firmware already passes −26…−30 dB |
| Convergence | ≤ 1 s to within 3 dB of steady ERLE | [M] prior-art 0.75 s skip; [F] QSC 1–2 s perceptible |
| Double-talk near-end damage | ≤ 3 dB in speech bands vs near-only anchor; similarity ≥ 0.85 vs repeat; ≥ 0.5 immediately post-fix | goal doc hypothesis [E→gate]; [M] HAVPE 0.909 proves achievable |
| Provider edge | 0 unexpected `speech_started` far-only; exact scripted count in DT | [M] anchor table (466/810; ×16 3/3) |
| Near-mic clipping (far-only, production volume) | 0 railed samples | [M] currently fails — deliberately red |
| Reference scale (engine input) | within ±4 dB of near-echo level; 0 clamp saturations | [F] `esp_aec.h` contract; [M] deficit dose-response |
| Delay (digital ref) | lead 0–10 ms, stability ±1 ms, polarity constant | [F] ESP-ADF causality window; [E] stability |
| Clock slip | < 5 ppm across step 7 | [E]; shared-PLL design predicts ≈0 — gate catches config regressions |
| Residual coherence MSC(ref, final), far-only steady | < 0.25 above 500 Hz | [E] — calibrate, then freeze |
| Amp linearity (divider vs TX-tap coherence) | ≥ 0.95 at production volume | [E]; [F] NS4150-class THD cliff in top 3 dB motivates the probe |
| AEC frame cost | FD: p99 linear+NLP ≤ 20 ms/32 ms; VOIP: p99 ≤ 8 ms/16 ms | [M] today 12.4–19.0 ms; [F] 5.05 ms/16 ms table ×1.5 contention margin |
| Realtime health (steps 1–6) | 0 capture/uplink/downlink drops, 0 recreates, 0 trace aborts | [M] current runs already achieve this — keep |
| Endurance (step 7) | heap/stack watermarks flat after warm-up; ring depth p99 < 50 % capacity; interFrameGap ≤ 60 ms gated | goal doc; [M] gap currently recorded-not-gated |
| Free memory during capture | internal ≥ 25 KB; PSRAM ≥ 2 MB after planes | [M] baselines 39 KB / 6.9 MB |

## 7. Deletions and refactors that reduce moving parts

1. **Delete the analog reference-calibration path** (PGAs to 0\|0, digital
   exact scale; already specified) — then delete the digital divider scale too
   once the TX-tap reference lands: the reference becomes a memcpy.
2. **Delete the flash-per-hypothesis loop**: the four runtime knobs land with
   flash 1; every subsequent tuning question becomes a remote call. This is
   the single largest schedule lever in the program (two days of log entries
   blocked on one RST button).
3. **Unify the signal windows**: HAVPE's private 2-tap window
   (`voice_pe_audio_owner.c:312-385`) reimplements `aec_signal_window` with
   duplicated helpers; move it onto the shared component with the channel
   bitmap, collapsing schemas v3/v4 into one bitmap-keyed schema and deleting
   one of the two serializers in `metrics.c`.
4. **Retire speech-shaped noise as an acceptance phase** once real far speech
   (step 4) lands — keep it as a diagnostic stimulus only; noise cannot leak
   semantically, and semantic leak is the production failure mode.
5. **Make the far-only gates gain-aware and stop evidence clipping** (retain
   native pre-gain uplink; assess device-native) — already specified in the
   calibration review §6.2–6.3; fold in here so the oracle never regresses on
   policy artifacts.
6. Previously queued, reaffirmed: `voicelab_stream.c` gated out of device
   builds; single `STACKCHAN_AUDIO_MODE` constant; stale
   `pcm_transport.c:66` priority comment fixed; firmware build hash into
   `capability-description.json`.
7. **Do not** touch: slot constants, the AGGR pin and its test (while FD), the
   frame-exact transport accounting, the 431 Hz pilot, the divider *wiring*
   (it graduates to permanent oracle probe), or protocol v1 for audio frames
   (the trace drains over the control lane; pcm.v2 only if D4 is ever chosen).

## 8. Red-test-first implementation sequence

1. **Analyzer truth tests (host, red first)**: synthetic fixtures with known
   injected delay/gain/echo-path → GCC-PHAT, band-ERLE, coherence, slip-fit
   analyzers must recover the planted values; include a deliberately clipped
   and a deliberately incoherent fixture. The oracle is not trusted until it
   measures synthetic truth.
2. **Trace wiring tests (native, red first)**: owner records into an armed
   trace (fake clock, fake frames); gap → ABORTED with counters; arm-while-
   busy → BACKPRESSURE; read_planar bounds; then the capability route through
   the fake control transport (chunked read, loss accounting, identity
   header). The trace component's own tests already exist — these tests cover
   the *wiring* that today does not.
3. **TS reassembly tests**: chunk → planes → WAV, bitmap handling for
   missing-linear (VOIP) and HAVPE channel sets.
4. **Offline rehearsal (no hardware)**: run the analyzers and the ideal-filter
   ceiling on the prior-art 3-channel WAVs (`SC/local/*/capture.wav`) —
   known-era results (13–16 dB divider, 33–50 dB tap) must reproduce within
   tolerance; this validates the NLMS ceiling tool before it judges anything.
5. **Flash 1** (§4): trace + TX-tap fifth channel + route A + knobs. Boot log
   asserts unchanged geometry; off-device suites stay green.
6. **Oracle run against the current engine — expected RED** on steps 3/4/6:
   the oracle must reproduce the known defect signature (broadband fail,
   double-talk collapse, near clipping) before any fix is credited.
7. **Offline upper bound → §9 decision → flash 2** (engine and/or reference
   per the falsifier's arm), rerun, and only then re-derive the uplink gain
   and run the provider-edge replay + interruption proofs.

## 9. Fastest experiment that can falsify the recommendation

One capture run (after flash 1, no engine change) yields aligned
{near, divider-ref, TX-tap-ref} for far-PRBS and far-speech. Run an offline
ideal linear filter (block NLMS/Wiener, 128 ms tail, no double talk in these
steps) against each reference:

- **TX-tap ceiling < 12 dB while divider ceiling ≥ 12 dB** → the
  recommendation is falsified: the amp/limiter path is materially nonlinear at
  the operating point and the electrical reference is load-bearing — keep D1
  (divider ×8 + VOIP) and drop the TX-tap plan.
- **Both ceilings < 12 dB** → no linear engine can pass at this operating
  point: the defect is acoustic/headroom (near clipping, amp distortion) —
  reduce volume/mic gain until ceilings recover before judging any engine.
- **TX-tap ceiling ≥ 15 dB but the on-device FD stage (with route A scale)
  still fails PRBS** → scale was not the binding constraint; the engine is —
  proceed directly to VOIP (flash 2).
- **On-device FD passes PRBS after route A but double-talk still collapses**
  → confirms the missing-DTD attribution → VOIP swap justified on its own.

Every arm names its next action; none requires more than the two flashes
already planned. The analyzers themselves are falsifiable today, before any
flash, against the prior-art captures (step 4 of §8).

## 10. Proven / inferred / open

**Proven (source or measurement, cited above):** slot order and divider
identity; reference deficit and its monotonic dose-response; FD-engine DTD/TDE
absence and VOIP presence (symbol census); VOIP's fused processing (no linear
tap) and 256/16 ms frames; near-mic rail clipping in every retained run;
sample-synchronous shared-controller clocking on StackChan; HAVPE hardware AEC
health (−47 dB residual, 0.909 double-talk similarity) and its absent
reference channel; the trace scaffold's existence, test coverage, and zero
wiring; prior-art per-era ERLE record including the DMA-tap 33.7–50.5 dB
candidates and the divider 13.2–16.4 dB; the current oracle's blind spots
(no raw capture, no acoustic witness, whole-run network interval, ungated
inter-frame gap, no drift fit).

**Inferred:** the fixed-point/regularization mechanism behind
tone-passes-PRBS-diverges (measurement-backed, arithmetic unattributable in a
closed blob); the semantic-leak wall belonging to the NLP/criterion layer
rather than the tap (the era evidence supports it; divider-era double-talk was
never measured in prior art); VOIP internal-RAM split being steerable to PSRAM
via `caps` (config plumbing exists; unverified on this board); Speex MDF CPU
fitting the S3 (no benchmark exists anywhere — measure first).

**Open questions:** does route A's scale-true divider alone heal the FD linear
stage (§9 decides); is `DIOS_SSP_AEC_TDE_ON` enabled by default inside
`esp_voip_init_api` (decompile or measure via the oracle's delay sweep); can
HAVPE's XMOS expose `GET_ERLE_CH0_AEC` through the existing I2C surface for a
free cross-check; VOIP_HIGH_PERF's real internal-RAM footprint next to the
~39 KB free budget (flash-1 metrics will answer before flash 2 commits);
whether worker-DO CPU headroom would actually absorb D4's engine if the
program ever takes that road.
