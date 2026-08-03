# Fable review: board audio paths and first-party AEC guidance — 2026-08-03

Independent, read-only review at `c-capabilities` (HEAD `0cef770f4`). Method:
first-hand reads of the CoreS3 owner/BSP-patch/bridge sources, the vendored
`esp_aec.h`/`esp_codec_dev` drivers (including the AW88298 driver), my own
`nm`/`ar` census of the shipped esp-sr 2.4.7 esp32s3 archives, the HAVPE
platform sources, and both 2026-08-03 sibling reviews — plus four delegated
deep audits: the complete StackChan firmware map, the esp-sr component
(headers + symbol census + the actual stackchan link map), the prior-art
`iterate/stackchan` experiment-02 tree with every retained
`report.json`/`tuning.json`, and the first-party HAVPE stack read at source
(`home-assistant-voice-pe` @ tag 26.2.2, `voice-kit-xmos-firmware` @ v1.3.1,
ESPHome `aic3204`/`i2s_audio`/`voice_kit` components). No hardware was
touched, nothing was flashed, no process was stopped; only this file was
created.

Kit paths are relative to `apps/kit/`. `SC` =
`~/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec`,
`SR` = `firmware/targets/stackchan/managed_components/espressif__esp-sr`
(v2.4.7, commit `2f8c4b04`), `XM` =
`~/src/github.com/esphome/voice-kit-xmos-firmware`, `HA` =
`~/src/github.com/esphome/home-assistant-voice-pe`.

## Executive verdict

Both boards already sit one small, well-evidenced step away from the best
practical on-device AEC, and on both boards that step is the same *first-party
pattern*: give the canceller a bit-exact digital copy of the playback stream as
its reference, delayed/aligned by construction, and keep everything else in the
shared owner/bridge/lane core. HAVPE already implements this pattern in
first-party hardware — the XMOS XU316 masters both I2S buses, snoops the
ESP32's speaker data line in parallel with the DAC as its AEC reference
(`XM/src/ffva/src/main.c:122-144`), deliberately delays the *mics* 40 ms so
that reference always leads (`XM/src/ffva/src/app_conf.h:47-51`), and measured
−47 dB far-end residual with 0.909 double-talk similarity — so HAVPE needs no
cancellation change at all. StackChan currently feeds ESP-SR's FD_HIGH_PERF
engine an electrical speaker-divider reference that arrives 9–18 dB below the
echo, and the engine — which my own symbol census confirms has **no double-talk
detector, no delay estimator, and (new finding) not even its reference-VAD hook
wired** — diverges on broadband while acing tones. The program's own prior art
already measured the fix: the TX-DMA-tap digital reference era scored
**33.7–50.5 dB** ERLE (at mic 25 dB, 0.033 % clipping, engine `FD_LOW_COST`)
against **13.2–16.4 dB** for the same divider used today, and the shortest
sound route is therefore: one instrumented flash (wire the already-written
`aec_diagnostic_trace`, add a TX-tap reference channel next to the divider,
land the digital ×8 reference scale, add runtime knobs), one offline
ideal-filter adjudication over the captured window, then one decision flash
whose engine (FD_LOW_COST / FD_HIGH_PERF / VOIP_HIGH_PERF) is chosen by that
evidence rather than by anyone's preference. This is the same plan as the
architecture-oracle review, sharpened and in seven concrete places corrected
by going one layer closer to the hardware, the schematics, and the shipped
binaries (§0) — including a closed-form resolution of the "+18 dB PGA
delivered +7.3 dB" anomaly from the newly-fetched CoreS3 schematic.

## 0. What this review adds or corrects vs the sibling reviews

The two 2026-08-03 sibling documents
(`fable-aec-architecture-oracle-review-2026-08-03.md`,
`fable-stackchan-reference-calibration-review-2026-08-03.md`) are sound on the
central mechanism (reference deficit + engine capability). Seven findings
here are new or corrective:

1. **VOIP's delay estimator is dead code in this build.** The
   `dios_ssp_aec_tde_*` module is compiled into
   `SR/lib/esp32s3/libesp_audio_processor.a` but **no object imports its
   entry points**, and the actual stackchan link map
   (`firmware/targets/stackchan/build/iterate-kit-stackchan.map`) links no
   `dios_ssp_aec_tde*` object at all. The oracle review's "VOIP has DTD +
   TDE" is half right: **DTD (`dios_ssp_aec_doubletalk_*`) and ERL
   estimation and residual suppression are linked; TDE is not.** Consequence:
   VOIP will *not* absorb bulk reference misalignment — every candidate
   reference must be aligned by construction (all of ours are).
2. **The AEC3 (SR/FD) reference-VAD hook is unwired.**
   `esp_aec3_dlfft_write_ref_vad`/`esp_aec3_hps16fft_write_ref_vad` are
   exported by the engines but have **zero importers** in either shipped
   archive, and our standalone integration never calls them (they are not in
   the public header). The esp-sr v1 AFE used to gate adaptation with a
   WebRTC VAD on the reference (`SR/src/esp_afe_sr_1mic.ref:94-96,229-240`).
   In v2.4.7 standalone use, **FD adaptation is completely ungated** — it
   adapts through silence, noise, and double talk alike. This strengthens the
   divergence explanation beyond "no DTD".
3. **The prior-art ERLE record was set with `FD_LOW_COST`, not
   FD_HIGH_PERF.** Every era-B artifact (`SC/local/aec-runs/20260729-*`) and
   the last live trial ran `fd_low_cost`, filter 4, NLP 1
   (`SC/local/live-trials/20260729T1702-simple-fix/status.json`). Espressif's
   live docs recommend exactly that mode ("generally recommended to choose
   `AEC_MODE_FD_LOW_COST`", quoted with URL in
   `docs/fable-v2-plan/exploration/afe-profile-decision.md:13-24`). Today's
   firmware runs FD_HIGH_PERF — a variant the record era never used, with a
   different FFT engine (§3.1). The engine A/B in flash 2 must therefore
   include FD_LOW_COST, not just the VOIP swap.
4. **The AW88298's hardware AGC and smart boost are disabled at init**, so
   the "the divider captures the amp's limiter/DSP behaviour" argument for
   keeping the electrical reference is much weaker than the oracle review
   assumed. Driver init writes `SYSCTRL2_REG05 = 0x0008` — comment verbatim
   "RMSE=0 HAGCE=0 HDCCE=0 HMUTE=0" — and `BSTCTRL2_REG61 = 0x0673`
   ("BOOST mode disabled")
   (`targets/stackchan/managed_components/espressif__esp_codec_dev/device/aw88298/aw88298.c:220-225`).
   Our "volume 100" maps to 0 dB *digital* attenuation into a fixed-gain
   class-D (`core_s3_audio_owner.c:57-66`, `aw88298.c:178-193`). Remaining
   echo-path nonlinearities are the speaker driver itself, supply sag, and
   output-stage distortion near clipping — real, but not a DSP the divider
   uniquely observes.
5. **HAVPE topology corrections from first-party source.** (a) The ESP32's
   speaker data line (GPIO10) feeds the AIC3204 DAC and the XMOS reference
   input **in parallel** — the XMOS does not re-transmit playback to the DAC
   (the only forwarding `rtos_i2s_tx(i2s1_ctx,…)` is commented out,
   `XM/src/ffva/src/main.c:207-211`); the reference is exactly the signal the
   DAC converts. (b) Stock ESPHome taps are ch0=AGC, ch1=**NS** — not "raw"
   (`HA/esphome/components/voice_kit/__init__.py:84-90`); raw requires NONE,
   which only our firmware selects. (c) There is **no ERLE query** in this
   XMOS firmware — the configuration servicer has exactly three commands:
   VNR_VALUE (0x00, read-only 0–100), CH0_STAGE (0x30), CH1_STAGE (0x40)
   (`XM/src/ffva/src/configuration/configuration_servicer.h:5-29`). The
   oracle review's `GET_ERLE_CH0_AEC` idea belongs to XVF3610 firmware, not
   this FFVA build; the free cross-check metric we can actually surface is
   **VNR**.
6. **The TX-tap reference leads the echo by a measured 28–44 ms, not
   0.5–2 ms.** Era-B reports put reference→mic lag at 28.1–44.1 ms
   (e.g. 36.06 ms on the 50.5 dB run), constant within a run, quantized by
   the 8 ms DMA chunk. That is comfortably inside the 128 ms filter span, and
   prior art measured the tolerance curve directly: adding software offset to
   an aligned tap degraded ERLE monotonically 26.1 dB @0 ms → 14.2 @32 →
   2.1 @64 (`SC/local/aec-runs/20260729-grok-eve-offset-nlp/candidates`).
   Alignment budgeting should use these measured numbers, not the ADF
   "0–10 ms" causality note.
7. **The CoreS3 "divider" is now schematic-proven, and the +18 dB→+7.3 dB
   PGA anomaly is solved in closed form.** The official CoreS3 schematic
   (`Sch_M5_CoreS3_v1.0.pdf` p.4, fetched this review) shows the echo
   reference is a **differential** tap of the BTL output: SPK_VOP →
   R40 150 kΩ → C102 (1 µF series) → MIC3P, mirrored SPK_VON → R42 150 kΩ →
   C104 → MIC3N, with the bottom divider legs **R41/R43 unpopulated (NC)**
   and only 22 pF shunts. There is no fixed divider ratio: attenuation is
   150 kΩ against the ES7210's own input impedance, which the datasheet
   specifies as **24 kΩ at PGA ≤12 dB and 6 kΩ at PGA ≥15 dB**. Predicted
   net: −17.2 dB at low-gain codes, −28.3 dB at high-gain codes — so
   commanding +18 dB buys 18 − 11.1 = **+6.9 dB**, matching the measured
   +7.3 dB within 0.4 dB. This resolves the calibration review's open
   uncertainties 1–2, supersedes its continuous-loading guess, and makes a
   sharp testable prediction: **PGA 12 dB should deliver *more* realized
   reference level than PGA 18 dB** (+12.0 vs +6.9) — a non-monotonic
   staircase no other mechanism produces (§6 E3). It also quantifies the
   corruption exposure: the tap sits after ferrite beads on a filterless
   class-D output (full-scale ≈16 V), and 150 kΩ·22 pF is a single pole at
   ≈48 kHz — modest suppression of switching residue reaching the ADC.

## 1. The actual end-to-end signal paths (Q1)

### 1.1 StackChan / M5Stack CoreS3

```
DOWNLINK  worker (×1 downlink; PCM16 @16 kHz, 320-sample frames)
  → WS → pcm_lane → pcm_clock_playback (io task, prio 23, core 1;
    blocking 8 ms writes of 128 samples; DMA 5×128 = 40 ms reserve)
  → I2S0 TX, Philips stereo 16-bit @16 kHz (shared MCLK/BCLK/WS pins)
  → AW88298 mono class-D amp (I2C 0x36 via BSP): DAC vol 0 dB at "100 %",
    HAGC/limiter OFF, smart boost OFF, forced 64·fs BCK (read-back verified)
  → speaker  ──acoustic (~0.3 ms)──►  2× analog mics
                                        │
        electrical divider across speaker output ──► ES7210 MIC3
                                        │                │
UPLINK  ES7210 quad ADC (I2C; TDM I²S mode R12=0x02):    │
    MIC1 (near, PGA 24 dB) → slot 0;  MIC3 (divider, PGA 18 dB) → slot 1;
    MIC2 (2nd mic, PGA 18 dB) → slot 2 (diagnostics only); MIC4 dead → slot 3
  → I2S0 RX, 4-slot 16-bit TDM @16 kHz — SAME controller/PLL as TX
  → RX DMA ISR: 1024-byte raw copy → 8-chunk reserve (64 ms) → AEC task
    (prio 20, core 1): deinterleave slots 0/1 → bridge accumulates 128→512
  → ESP-SR aec_linear_process + aec_nlp_process (FD_HIGH_PERF, filter 4,
    NLP AGGR, PSRAM caps, 512-sample/32 ms frames)
  → clean → 320-sample wire frames → WS → worker (fixed ×8 gain) → provider
```

Proven facts (first-hand):

- **One I2S controller, both directions, master role**: a single
  `i2s_new_channel()` allocates TX+RX with `dma_desc_num=5`,
  `dma_frame_num=128`
  (`platforms/iterate_esp_idf/idf_overrides/espressif__m5stack_core_s3/patch_core_s3.cmake:201-212`);
  TX and RX gpio configs name the same MCLK/BCLK/WS pins
  (`core_s3_audio_owner.c:402-449`). Capture and playback are
  sample-synchronous by construction; there is no drift to estimate.
- **Slot map**: near = slot 0, divider reference = slot 1
  (`core_s3_audio_owner.c:49-50`, consumed at `:765-768`). The ES7210 is put
  in TDM I²S mode by the vendored driver (`es7210.c:229-231`, R12=0x02);
  the datasheet's Fig. 2e pair-interleaved order makes the wire
  MIC1, MIC3, MIC2, MIC4, and the calibration review's mask-isolated gain
  trials confirmed slot 1 responds only to MIC3's gain register. The BSP
  patch selects MIC1|MIC2|MIC3 with the divider documented on MIC3
  (`patch_core_s3.cmake:374-387`).
- **Gains**: boot-time only — near 24 dB, both non-near PGAs 18 dB, volume
  100 (`targets/stackchan/main/main.c:992-1004`); no runtime knobs of any
  kind exist. ES7210 PGA steps are 3 dB to 30 then 33/34.5/36/37.5
  (`es7210.c:328-345`); measured realized gain on the divider input was
  +7.3 dB for the commanded +18 dB (calibration review §1) — the analog PGA
  is a compressed lever on this high-impedance input.
- **AEC invocation**: `aec_create_from_config` (mic 1 / ref 1 / out 1,
  filter_length 4, 16 kHz, `MALLOC_CAP_SPIRAM|8BIT`, FD_HIGH_PERF, AGGR),
  512-sample chunk asserted at startup (`core_s3_audio_owner.c:512-538`);
  split `aec_linear_process` → `aec_nlp_process` with µs timers and a
  preserved linear tap frame (`:568-636`, `owner.aec_linear` at `:144-145`).
  Recreate-on-gap is the only reset (`:540-566`).
- **Realtime discipline** (the constraints this review must preserve): the
  whole owner is one static DRAM object (`:180-187`); the ISR does exactly
  one bounded 1,024-byte copy (`:723-740`); steady state allocates nothing;
  the metrics are relaxed atomics; a spinlocked seven-scalar merge is the
  only cross-core section (`:189-197`). Playback never waits on capture and
  vice versa.
- **TX tap already exists**: the same ISR delivers every *completed* 128-sample
  TX DMA buffer with sequence + timestamp to `observe_playout`
  (`:687-716`), today consumed only by the avatar
  (`targets/stackchan/main/main.c:1007-1009`). This is the seam a digital
  reference plugs into; no new ISR work is needed beyond a second consumer.

Delay budget (measured where possible): divider reference vs near echo
≈ **0.375 ms** (prior-art cross-correlation, `SC` era-C reports — same ADC,
same clock); acoustic flight ~0.3 ms; TX-tap reference leads the acoustic echo
by a measured **28–44 ms** (§0.6), constant within a run. All candidate
references sit far inside the 4×32 ms = 128 ms filter span (filter-length
units: frame-sized partitions — inference from `SR/src/esp_afe_sr_1mic.ref:92-93`
pairing `frame=512` with `filter_length=4`, corroborated by the calibration
review's disassembly).

Divider hardware, now schematic-proven (§0.7): differential 150 kΩ series
legs from SPK_VOP/VON (post-ferrite-bead, filterless class-D PWM, full-scale
≈16 V in speaker mode per the AW88298 datasheet) through 1 µF into
MIC3P/MIC3N, bottom legs unpopulated, 22 pF shunts (single pole ≈48 kHz);
attenuation is therefore set by the ES7210's gain-dependent input impedance
(−17.2 dB at PGA ≤12 dB, −28.3 dB at ≥15 dB). Two ES7210 datasheet notes now
matter: the input-impedance table above, and an explicit speaker-feedback
application note — "ADC must be reset after speaker amplifier power up, if
its power up transient signal is out of ADC common mode input range". The
remaining open question is quantitative, not structural: whether the class-D
switching residue passing that 48 kHz pole and aliasing through the ES7210's
front end explains the divider era's 13–16 dB ceiling — E2/E3 discriminate
(§6). Also of note from the schematic: MIC4 is tied to GNDA, the AW88298's
DATAO sense pin is unconnected (no current/voltage-sense readback path
exists on this board), and there is no ES8311 anywhere on CoreS3.

### 1.2 Home Assistant Voice Preview Edition

```
DOWNLINK  worker (PCM16 @16 kHz) → WS → pcm_lane
  → voice-pe TX task (prio 24, core 1): 16 kHz mono → 48 kHz stereo by 3:1
    linear interpolation, no gain, sample<<16 into 32-bit slots
  → I2S0 TX (ESP32 = SLAVE; GPIO 7/8/10; 6×480 DMA, 50 ms reserve;
    10 ms blocking writes; silence preload)
  → GPIO10 data line, in parallel:
       ├─► AIC3204 codec DAC (I2C 0x18; digital vol pinned 0 dB; HP −2 dB;
       │    NDAC=2·MDAC=2·DOSR=128 from XMOS 24.576 MHz MCLK)
       │    → TPA6211A1 mono class-AB amp (GPIO47 enable) → speaker
       └─► XMOS XU316 I2S1 RX (XMOS = MASTER both buses + MCLK):
            48k→16k ds3 decimate → AEC reference X[0],X[1]
2× PDM mics (3.072 MHz, 71 mm apart) → XMOS mic array → 16 kHz, 240-sample
    (15 ms) frames → [static +40 ms MIC delay] → AEC (fwk_voice, 2 mic ×
    2 ref, 10 main + 5 shadow filter phases ⇒ 150 ms tail) → IC → NS → AGC
UPLINK  XMOS I2S2 TX (16 kHz, 32-bit stereo; XMOS master)
  → ESP32 I2S1 RX slave (GPIO 13/14/15; 5×320 DMA, 80 ms reserve; 20 ms
    blocking reads): ch0 = selected tap (ours: AEC, stage 1), ch1 = selected
    tap (ours: NONE = raw mic; stock: NS)
  → top-16-bit extraction → 320-sample frames → WS → worker (fixed ×16) → provider
Control  ESP32 I2C (GPIO5/6): XMOS @0x42 (resource 241: VNR read, ch0/ch1
    stage select+readback; resource 240: DFU/version — pinned 1.3.1, fail-closed),
    AIC3204 @0x18; XMOS reset GPIO4; speaker enable GPIO47.
```

Sources: our platform (`platforms/iterate_voice_pe_audio/voice_pe_audio_owner.c:47-62,570-612,674-771`,
`voice_pe_pcm_format.c:12-35,115-142`, `voice_pe_hardware_config.c` all), and
first-party (`XM/src/ffva/ffva_int.cmake:1-11` — I2S master, AEC ref = I2S;
`XM/.../audio_pipeline_dsp.h:13-27` — 10+5 phases, 150 ms delay buffer;
`XM/src/ffva/src/main.c:122-217` — reference RX and the 6-slot tap mux;
`XM/.../platform_start.c:149-186` — 48k ref decimation, 16 kHz mic-out bus;
`HA/home-assistant-voice.yaml:1487-1527` — both buses `i2s_mode: secondary`
on the ESP32; `HA/.../aic3204.cpp:24-27,153-168` — clock tree and volume
mapping). The official Nabu Casa schematic
(`home_assistant_voice_pe_schematic_v1.0_241009.pdf`, fetched this review)
confirms the part set — XU316-1024-QF60B-C24, TLV320AIC3204IRHBR,
**TPA6211A1** mono class-AB speaker amp (not a class-D), 2× MSM261DHP006 PDM
mics with a printed "distance between two microphones is 71mm" note — and
confirms in copper that net `I2S_DIN_ESP` (GPIO10) lands on **both** the
AIC3204 DIN and an XU316 I2S data-in pin: the parallel reference wiring of
§0.5 is schematic-proven, not inferred. A class-AB output stage also means
HAVPE's echo path has no switching-residue concern at all — one more reason
its XMOS AEC measures so well and needs nothing from us.

Group delay: the XMOS delays the mics +40 ms so the snooped reference always
leads causally (`XM/src/ffva/src/app_conf.h:47-51`) — the first-party
embodiment of exactly the fixed-lead property the StackChan TX tap has for
free. One measurement caveat inherited from this: the ch1 NONE (raw) tap
bypasses that 40 ms delay, so raw-vs-clean comparisons skew by ~40 ms
(`docs/fable-havpe-agc-ns-aec-review-2026-08-02.md:260`).

Measured health: far-end residual −47 dB, double-talk similarity 0.909 on the
AEC tap; the IC and NS stages measurably damaged double-talk speech and AGC
amplified echo residue ~two orders of magnitude, which is why the uplink is
pinned at the AEC stage (`voice_pe_hardware_config.c:67-92`).

## 2. Is the current reference semantically correct? (Q2)

**The divider is a legitimate echo reference (right signal class, sample-
synchronous, correct slot) delivered at the wrong scale and with a measured
quality ceiling well below the digital alternative.** The engine's contract
wants "audio samples sent to the speaker" (`SR/include/esp32s3/esp_aec.h:91,107`)
— playback-scale. The divider arrives 9–18 dB below the echo the near mic
carries even after the +18 dB PGA trial, the analog PGA delivers only
0.41 dB/dB on this input, and the retained runs show a monotonic
dose-response of far-only improvement with reference level (calibration
review §4.1). Meanwhile the program's own best-ever cancellation
(33.7–50.5 dB, era B) used the digital TX-DMA-tap copy of the same playback
stream, and the divider era's measured ceiling is 13.2–16.4 dB
(`SC/local/aec-runs/…` — §5 table below).

First-party precedent is on the digital side for this board:

- Espressif's Korvo-2 takes its default echo reference from the codec DAC
  output **pre-power-amp** (PA-output divider only via unpopulated
  resistors) — oracle review §1, Korvo-2 schematic. CoreS3 has **no pre-PA
  analog node at all**: the DAC lives inside the AW88298, and the prior-art
  review of Espressif's own WebRTC demo recorded the consequence — the
  AW88298 "has no ADC path and cannot loop back speaker audio onto the I2S
  bus" (`SC/docs/claude-review.md:40`). The closest realizable equivalent of
  Espressif's own default reference on CoreS3 **is the digital TX stream**.
- The board's other first-party voice stack (HAVPE/XMOS) uses precisely the
  digital-snoop-with-fixed-lead pattern in shipped hardware (§1.2).
- With the AW88298's HAGC and smart boost disabled at init (§0.4), the amp is
  configured as a fixed-gain, approximately-LTI stage at moderate volume, so
  the divider's one unique advantage — observing amp nonlinearity — applies
  mainly in the top few dB of drive, exactly where prior art already showed
  the correct mitigation is lowering gain/volume (mic 25 dB / 0.033 % clip
  produced the record), not modelling clipping with a linear filter.

**Smallest clean change** (ordered):

1. Route A first (already specified in the calibration review): both non-near
   PGAs → 0 dB, saturating digital ×8 on slot 1 in `deinterleave_capture`.
   Exact, host-testable, deletes the analog unknown; it is the falsifier's
   control arm, not the destination.
2. The destination: pair the existing TX-tap chunks (sequence + timestamp
   already delivered at `core_s3_audio_owner.c:687-716`) with RX chunks —
   prior art's `receive_aligned_dma_pair` pattern (`SC/firmware-ws/main/
   audio_pipeline.c:559-608`) — and feed that as `refdata`; demote slot 1 to
   a diagnostics/oracle channel. Keep the divider wired: it is the only
   independent physical witness of what the amp actually emitted, and the
   amp-linearity probe needs it (§6 E3).

## 3. First-party engine choices, precisely (Q3)

### 3.1 What actually ships inside esp-sr 2.4.7 (symbol census, this review)

`aec_create_from_config` dispatches by mode to **three distinct engine
families** (imports of `esp_aec.c.obj`; mode/config strings from the archive):

| Modes | Engine objects | NLP | Adaptation control | Frame |
| --- | --- | --- | --- | --- |
| SR_LOW_COST(0) / SR_HIGH_PERF(1) | AEC3: `esp_aec3_hps16fft` (int16 FFT) / `esp_aec3_dlfft_fp32` (float FFT) | **off** ("SR_*, NLP_OFF") | none linked; `write_ref_vad` hook exported but **unimported** | 512 / 32 ms |
| VOIP_LOW_COST(3) / VOIP_HIGH_PERF(4) | DiOS/athena-signal: `dios_ssp_aec_{api,firfilter,res,erl_est,doubletalk_fast}` via `esp_voip_process_api` | integrated, always on ("NLP_ON") | **DTD** (`doubletalk_fast`) + ERL estimation + residual suppressor; **TDE compiled but dead code** (§0.1) | 256 / 16 ms, ref_num must be 1; fused — no linear tap |
| FD_LOW_COST(5) / FD_HIGH_PERF(6) | same AEC3 pair as SR | hypergeometric post-filter, NORMAL/AGGR/VERYAGGR runtime-settable | none (§0.2) | 512 / 32 ms |

(Enum + comments verbatim at `SR/include/esp32s3/esp_aec.h:24-31`; NLP levels
`esp_aec_nlp.h:9-13`; "must be 16000" and "recommend filter_length 4" at
`esp_aec.h:60-61`; planar not interleaved I/O, 16-byte aligned, `esp_aec.h:87-92`.
LOW_COST↔int16-FFT / HIGH_PERF↔float-FFT is an inference from symbol names
plus the v1 source precedent; the doc-string "recommend AEC_MODE_SR_LOW_COST"
at `esp_aec.h:63` is stale boilerplate.)

**The first-party tension to resolve by measurement, not argument:** Espressif
names FD "for full duplex" and their docs recommend `AEC_MODE_FD_LOW_COST`
as the balanced default (URL-verified quote,
`docs/fable-v2-plan/exploration/afe-profile-decision.md:13-24`) — yet the FD
family contains no DTD and, in our standalone integration, no adaptation
gating at all, and the kit's measured double-talk collapse (near-similarity
0.080→0.0035 as the reference got hotter) is the signature of exactly that.
The VOIP family has the DTD but 16 ms fused frames, no linear tap, and an
internal-RAM claim (69.2 KB) near our whole free budget (~39 KB). Both
sibling reviews resolved this a priori in opposite directions at different
times (afe-profile-decision → FD_LOW_COST; oracle review → VOIP). The honest
position: FD's record (33.7–50.5 dB far-only, era B) was set with a
scale-true reference the current firmware has never been given, and FD's
double-talk behaviour with such a reference **has never been measured** on
this hardware (era B never scored double-talk; the divider era's collapse was
measured at a 9–18 dB reference deficit that drives any ungated NLMS into
divergence). Flash 2's A/B (§6 E4) settles it with pre-registered gates.

### 3.2 The AFE wrappers (what each adds beyond the bare engine)

`afe_type_t` (`SR/include/esp32s3/esp_afe_config.h:34-39`): SR = AEC(SR
modes)→VAD→WakeNet; VC = AEC(VOIP)→NS(WebRTC or nsnet2)→AGC(optional)→VAD,
NLP knob inert; FD = AEC(FD)+NLP→VAD→WakeNet, no NS stage. Facts that matter
for integration, from the census: **AFE v2 spawns no internal tasks** (no
`xTaskCreate*` import anywhere in `libesp_audio_front_end.a`; the
`afe_perferred_core` doc comment is stale v1 text — v1's `.ref` source did
spawn an 8 KB "afe_mase" task); feed input is *interleaved* with reference
last, engine input is planar (the AFE does the transpose); feed/fetch join
over an internal ring (`afe_ringbuf_size`, default 50 frames); fetch is
single-channel output with a 2 s timeout. `afe_aec_create` exists as a thin
AEC-only wrapper ("only support 1 microphone channel and 1 playback
channel", `esp_afe_aec.h:22-46`). There is no AEC model file of any kind in
`SR/model/` — AEC is pure DSP; nsnet/vadnet models serve NS/VAD only.

Verdict unchanged from the siblings, now with harder evidence: the full AFE-VC
pipeline buys us stages the program has measured and rejected on both boards
(AGC self-trigger on HAVPE; NS double-talk damage on HAVPE; server-side NS
available), at 30.6–32.2 % feed CPU + ~820 KB PSRAM + 49–91 KB internal. The
bare-engine seam we already have (`process_aec` behind the bridge) is the
right integration; wrappers add opacity, not capability we want.

### 3.3 HAVPE's first-party engine (for completeness)

fwk_voice AEC on the XU316: 2 mic × 2 ref channels, 10 main + 5 shadow filter
phases of 240 samples ⇒ 150 ms main tail with shadow-filter divergence
protection, 15 ms frames, fixed +40 ms mic delay instead of TDE
(`XM/.../audio_pipeline_dsp.h:13-27`, `app_conf.h:42-51`). Downstream IC
(tuned for the 71 mm mic pair), NS, AGC (ASR profile) are cumulative optional
taps; we pin AEC. This is a healthy, measured first-party AEC we already use
correctly; nothing in the shared core should try to duplicate it.

## 4. Mechanisms that make a tone cancel while broadband fails (Q4)

The measured signature to explain (four-stage means,
`docs/voice-device-adventures-2026-08-02.md:37-41`): far tone 4,957→197/183
(−28 dB, linear does nearly all of it); far PRBS 3,513→3,268/3,174 (−0.9 dB,
essentially nothing; in earlier runs clean *exceeded* near); far speech
7,109→1,267/1,174 (−15.6 dB) with the near mic railing at 32,768; NLP <1 dB
everywhere. Checklist with verdicts:

| # | Candidate mechanism | Verdict on this hardware | Evidence |
| --- | --- | --- | --- |
| 1 | Reference below engine's expected playback scale → fixed-point/regularized FD update starved on all bins except strongly-excited ones; a tone needs one bin, broadband needs all | **Primary, dose-response-proven** | +7.3 dB ref moved every far-only phase monotonically (0.33–0.55 dB/dB); `refdata` contract (`esp_aec.h:91`); deficit 9–18 dB post-trial (calibration §0) |
| 2 | Ungated adaptation (no DTD, ref-VAD unwired §0.2) → filter walks off on double talk, and a hotter reference makes the *wrong* updates bigger | **Proven for double-talk; contributes to broadband instability** | near-sim 0.080→0.0035 and far residual +4.66→+21.50 dB as ref rose; `linearMA ≈ cleanMA > nearMA` places the energy addition before the NLP (calibration §4.2) |
| 3 | Near-mic clipping during loud far playback (24 dB PGA + volume 100) — a nonlinearity no linear filter models | **Proven secondary** | `nearPeak` 32,768 for 5–6 consecutive windows in every retained run, worst exactly in the broadband phases; prior art: clipping 5.4 %→0.033 % (mic 37→25) was the single biggest ERLE lever (18.7→50.5 dB family) |
| 4 | Bulk delay outside the filter span, or non-causal reference — the classic "tone cancels regardless of delay, broadband cannot" | **Excluded for the divider** (0.375 ms measured, same-ADC construction); **bounded for the TX tap** (28–44 ms lead, inside 128 ms; tolerance curve measured §0.6) | prior-art era-C reports; era-B offset sweep |
| 5 | Clock drift between reference and mic | **Excluded by construction** (one controller/PLL both directions; HAVPE: XMOS masters everything) | `patch_core_s3.cmake:201-212`; §1.2 |
| 6 | Slot/channel misassignment (canceling against the wrong signal) | **Excluded** — datasheet order + mask-isolated gain trials; slot 2 never enters the AEC (`core_s3_audio_owner.c:748-768`) | calibration §1 |
| 7 | Format errors: 16/32-bit, endian, interleave, alignment | **Excluded** — 16-bit slots verified by boot geometry (`ws_width 32, total_slot 4`), planar single-channel arrays match the API, buffers 16-byte aligned (`core_s3_audio_owner.c:123-149`) | first-hand |
| 8 | Polarity inversion | **Irrelevant to a linear filter** (absorbs sign); tone convergence proves modelability | calibration §4.7 |
| 9 | Filter too short for the room | **Excluded as primary** — 128 ms covers this desk geometry; divergence (energy addition) is not a tail-length symptom | calibration §4.6 |
| 10 | Divider reference corrupted by class-D switching residue / aliasing through the ES7210 front end, capping achievable ERLE regardless of scale | **Open hypothesis, now with schematic-level parameters** — the tap is post-ferrite filterless PWM (≈16 V full-scale) behind only a 48 kHz single pole (150 kΩ·22 pF, §0.7); the best remaining explanation for the divider era's 13–16 dB ceiling vs the tap's 33–50 dB; E2 (offline ceiling) / E3 (coherence) discriminate | era ERLE gap; CoreS3 schematic p.4; AW88298 datasheet transfer function; `hardware-ref-initial` bring-up history |
| 11 | NLP level policy | **A masker, not a cause** — VERYAGGR's good far-only numbers coexisted with destroyed double-talk; AGGR exposed the linear failure | calibration §4.3 |

The practical reading: fix #1 and #3 (scale-true reference + headroom), keep
#4/#5 excluded by construction (which every candidate reference here does),
and #2 becomes the deciding engine question; #10 decides whether the divider
has any production future at all.

## 5. First-party support we bypass, and measured local prior art (Q5)

**StackChan.** The board's divider-on-MIC3 *is* the first-party echo-reference
convention (Espressif BSPs gain MIC3 at 0 dB with a `// reference` comment;
esp-webrtc pairs MIC1|MIC3 — calibration §1), so the wiring is not the
mistake. What we bypass is Espressif's *packaging* (AFE), and §3.2 concludes
we are right to. What we under-use is our own prior art: the complete TX-tap
reference machinery — ISR `on_sent` readback, sequence pairing, 8-deep chunk
queue, optional reference-only delay ring — exists working in
`SC/firmware-ws` (§1 era B) and its kit-side ISR half already ships in
production (the avatar tap). Reference-era ERLE record, all from retained
artifacts:

| Era | Reference | ERLE (far) | Lag | Conditions |
| --- | --- | --- | --- | --- |
| A: stream-copy at `esp_codec_dev_write` | software, pre-DMA-queue | 3.7–18.6 dB, semantic leak even on the 18.6 dB pass | 86.8–101.8 ms (stock DMA), 29–45 ms after shrink, run-to-run variable | the era that created the "software reference failed" folklore |
| B: TX **DMA-completion tap**, sequence-paired | software, post-DMA | 18.7–27.4 dB @ mic 37 (5.4 % clip); **33.7 / 37.0 / 50.5 dB @ mic 25 (0.033 % clip)** | 28–44 ms, constant | `fd_low_cost`, filter 4, NLP 1–2; offsets degrade monotonically |
| C: MIC3 electrical divider (today's kit choice) | analog | **13.2 / 15.1 / 16.4 dB** | 0.375 ms | first bring-up captured silence until the AW88298 64·fs fix; no recorded rationale for abandoning B |

(Artifacts: `SC/local/device-aec-*/…`, `SC/local/aec-runs/20260729-grok-eve-analog-gain/`,
`…/20260729-dma-tap-repeat-1/`, `…/speaker-64fs-smoke/`,
`…/20260729T1718-network-isolation/`; era-B/C ERLE computed by the same
`tools/aec_lab.py` gates: far ERLE ≥12 dB after 0.75 s, leakage ≥6 dB, near
similarity ≥0.80.)

**HAVPE.** We already sit on the first-party path (XMOS AEC tap), configured
more conservatively than stock (AEC vs stock's AGC/NS taps) for measured
reasons. Unused first-party affordances, ranked by value: (a) **VNR query**
(resource 241 cmd 0x00, 0–100) — a free runtime voice/noise confidence signal
from inside the DSP, one I2C read, could join the metrics view; (b) runtime
**stage re-select with readback** — we already implement the commands
boot-only; exposing them as a capability knob turns tap experiments into
remote calls (same lesson as StackChan's knobs); (c) the **hardware mute
slider on GPIO3** is not sensed by our firmware — one GPIO read would explain
otherwise-mysterious silent captures. Not available despite prior notes:
any ERLE/telemetry command beyond VNR (§0.5). Not flashable from our side:
the XMOS firmware (DFU exists in stock ESPHome only; our boot fails closed on
any version ≠ 1.3.1 — `voice_pe_hardware_config.c:9-11,144-150`).

**Would first-party simplify the shared architecture?** It already defines
it: on both boards the realtime core's seams (owner → bridge → lane) stay
identical; the only per-board difference is *where cancellation happens*
(ESP-SR behind `process_aec` on StackChan; XMOS silicon on HAVPE) and *which
signals the oracle captures*. The TX-tap change strengthens the symmetry:
both boards then derive their reference from "the PCM the owner wrote",
which is the one signal every present and future platform necessarily has.

## 6. Ranked experiments (Q6)

Ordered by information-per-risk; each names its discriminator, measurements,
and stop/rollback. E1–E3 need one flash total; E4 needs the second.

- **E1 — Instrumented flash (no behavioural change).** Wire
  `aec_diagnostic_trace` (exists, host-tested, zero callers —
  `firmware/components/core/src/aec_diagnostic_trace.c` + test), planes
  {near, ref_divider, ref_txtap, linear, final} in PSRAM
  (5 ch × 2 B × 16 kHz × 20 s ≈ 3.2 MB vs ~6.9 MB free), TX-tap pairing ring
  as a *fifth trace channel only* (engine still eats the divider), route A's
  digital ×8 with PGAs 0|0, runtime knobs {mic PGA, ref scale, NLP level,
  volume}. *Measurements:* trace window drains with identity header and zero
  gap-aborts; boot geometry log unchanged; far-tone `referenceMeanAbsolute`
  lands ≈8× the PGA-0 baseline (≈4,400; ≈550/1,300 mean the shift didn't
  land, ≈10,300 means it stacked on analog 18 dB — calibration §3).
  *Stop/rollback:* any capture/uplink drop or added `maximum_*_us` regression
  while the trace is ARMED → disable trace (it is additive; previous image is
  the rollback). This flash also ends the ROM-loader-per-hypothesis loop —
  the single largest schedule lever in the program.
- **E2 — Offline adjudication (no hardware risk).** On E1's captured far-PRBS
  and far-speech windows, run an offline ideal linear filter (block
  NLMS/Wiener, ~128 ms tail) per reference, plus GCC-PHAT delay/polarity,
  band-ERLE, and MSC coherence. *Pre-condition:* analyzers must first
  reproduce the prior-art known results from the retained 3-channel WAVs
  (13–16 dB divider era, 33–50 dB tap era) within ±3 dB — the oracle is not
  trusted until it measures planted truth. *Decision arms* (pre-registered):
  tap ceiling ≥15 dB ∧ divider ceiling ≪ tap → divider is
  corruption-limited, adopt tap (expected, per era record); both ceilings
  <12 dB → operating point is nonlinear (clipping/volume) — fix headroom
  before judging engines; divider ceiling ≥12 dB ∧ on-device FD still fails
  PRBS with route-A scale → scale wasn't binding, engine is (go E4).
- **E3 — Amp-linearity and headroom staircase (runtime knobs only).** Volume
  ∈ {100, 90, 75, 60} × mic PGA ∈ {24, 21, 18} during far speech;
  measure near rail-count (must reach 0), divider-vs-tap coherence (≥0.95
  defines the linear regime), divider THD on the tone phase. *Discriminates*
  #3 vs #10 of §4 and yields the production operating point as a gated
  number, not advice. *Stop:* if coherence never reaches 0.95 even quiet →
  divider is corrupt at all levels; drop it as an engine-reference candidate
  permanently (it stays as an emission witness). Fold in the 5-minute PGA staircase
  {0, 6, 12, 15, 18, 24} dB on mask 2 during the tone phase: §0.7's impedance
  model predicts realized levels (vs the PGA-0 baseline) of **+6, +12, +3.9,
  +6.9, +12.9 dB** — a sharp ~8 dB *drop* crossing the 15 dB impedance
  threshold, then 3 dB per step again —
  observing that non-monotonic step is closed-form confirmation of the
  loading mechanism (its absence falsifies it); documentation either way,
  since route A removes the analog lever from the signal path.
- **E4 — Engine A/B at the winning reference (decision flash).** Candidates:
  FD_LOW_COST (Espressif's recommendation, the prior-art record engine,
  cheapest: 30.9 KB int / 90 KB PSRAM / 19.6 %), FD_HIGH_PERF (today's,
  keeps linear tap), VOIP_HIGH_PERF (only DTD engine; 16 ms frames; fused;
  69.2 KB internal claim **must** be verified against the ~39 KB free budget
  via its `caps` steering before commitment). *Gates:* far-PRBS steady linear
  (or final, for VOIP) ≥12 dB; double-talk near-similarity ≥0.5 vs the
  near-only anchor; far-speech STT zero far-phrase content; zero near rails
  at the E3 operating point; p99 frame cost within §7 budgets. *Stop:* any
  engine that fails its RAM/CPU budget on boot metrics is out regardless of
  acoustics; if all fail double-talk with a proven-clean reference, that is
  the cue for the Speex-MDF fallback (same seam), not more tuning.
- **E5 — HAVPE (no cancellation change).** Same oracle ladder with channels
  {raw ch1, clean ch0, `playback_pcm` tap}; surface VNR per window; add
  GPIO3 mute sensing to metrics. *Stop:* none needed — all additive
  observability; the standing gates (−47 dB residual, 0.909 DT similarity)
  must simply not regress.

## 7. Resource and latency implications (Q7)

First-party table (S3 @240 MHz, docs.espressif.com esp-sr, quoted with
provenance in `docs/fable-v2-plan/exploration/afe-profile-decision.md:76-98`)
against measured reality:

| Option | Internal RAM | PSRAM | Claimed CPU | Measured on this board |
| --- | --- | --- | --- | --- |
| FD_HIGH_PERF (today) | 20.3 KB | 126.2 KB | 8.08 ms/32 ms = 25.3 % | linear 6.0–11.0 + NLP 6.3–8.6 ms per 32 ms = **38–61 % of core 1** under PSRAM contention (`aec-metrics.json` maxima 10,979+8,049 µs) |
| FD_LOW_COST | 30.9 KB | 90.0 KB | 6.28 ms/32 ms = 19.6 % | unmeasured here; prior-art era B ran it inside budget on the same silicon with avatar active |
| VOIP_HIGH_PERF | **69.2 KB** | 66.6 KB | 5.05 ms/16 ms = 31.6 % | unmeasured; internal-RAM claim vs **~39 KB free internal** is the open risk — verify `caps` steering to PSRAM on-device before committing |
| VOIP_LOW_COST | 26.9 KB | 64.1 KB | 4.37 ms/16 ms = 27.3 % | unmeasured |
| AFE-VC pipeline | 48.7–91.1 KB | ~820 KB | 30.6–32.2 % feed + 4.7 % fetch | rejected (§3.2) |

Latency: TX-tap reference adds zero path latency (passive ISR consumer; one
256 B copy per 8 ms + an ~8-deep pairing ring ≈ 2–4 KB). VOIP's 256-sample
frames *reduce* DSP-frame latency 32→16 ms. The trace adds nothing when idle
(one atomic load) and only bounded memcpys when armed; its 3.2 MB lives in
PSRAM allocated at capability-open, never in steady state. HAVPE budgets are
unaffected by everything here (its DSP is off-chip; ESP32 audio tasks are
memcpy + format conversion at priority 24 with 50/80 ms DMA reserves).

Frame-size ripple: switching to VOIP halves `processing_frame_samples`
512→256 — the bridge parameterizes it, owner arrays shrink, but the startup
`aec_get_chunksize` contract check (`core_s3_audio_owner.c:527-535`) and the
architecture test pins must move with it in the same commit.

## 8. Deletions and simplifications

Endorsed from the siblings, still correct after this review's evidence:
delete the analog reference-calibration path (PGAs 0|0 + digital exact scale;
then delete even that scale once the TX tap is the engine reference — the
reference becomes a memcpy); delete the flash-per-hypothesis loop via the
four runtime knobs; unify HAVPE's private 2-tap window onto the shared
`aec_signal_window` with a channel bitmap (one serializer, one schema);
retire speech-shaped noise as an acceptance phase once real far speech lands;
make far-only gates uplink-gain-aware and stop the ×8 from clipping evidence
(55–70 % of PRBS/double-talk uplink samples rail today — assessment gates at
`src/device/aec-waveform-assessment.ts:107-133` are post-gain).

New from this review:

1. **Delete the both-masks gain hedge and the stale owner comment.** Slot
   identity is datasheet-proven; `initialize_codecs`' comment
   (`core_s3_audio_owner.c:378-385`) still says the physical origin is
   unproven and gains both candidates — replace with mask 2 only (or 0|0
   under route A) and a comment citing the calibration review.
2. **Do not add** any adaptation-gating hack via the exported-but-undeclared
   `esp_aec3_*_write_ref_vad` symbols; they are blob internals with no header
   contract (§0.2). The engine A/B (E4) is the sanctioned route.
3. **Stop planning around `GET_ERLE_CH0_AEC` on HAVPE** — it does not exist
   in this firmware's control surface; VNR (cmd 0x00) is what is real (§0.5).
4. Prior-art tree hygiene (out of scope to execute here): `SC`'s README and
   `docs/aec-validation.md` still describe the TX-tap as the active
   reference while the code cancels against the divider
   (`SC/firmware-ws/main/audio_pipeline.c:719-721`) — worth a one-line
   correction the next time that tree is touched, since it is the program's
   canonical prior art and the mislabel is exactly how the "software
   reference failed" folklore propagates.

Do not touch (re-affirmed): slot constants; the AGGR pin and its test while
FD; the frame-exact transport accounting; the 431 Hz near-phase pilot; the
divider *wiring* (it graduates to oracle probe); protocol v1 for audio
frames; HAVPE's AEC-stage tap and 0 dB volume pin.

## 9. First three changes, and the evidence that keeps each

1. **Flash 1 — instrument without changing behaviour** (E1): trace wiring +
   TX-tap fifth channel + route-A digital ×8 (PGAs 0|0) + runtime knobs.
   *Keep it if:* the trace drains complete, identity-stamped, zero-abort
   windows while every realtime health counter (drops, recreates,
   `maximum_capture_to_uplink_us`, ring depths) stays at its pre-flash
   baseline, and the reference lands at its predicted ≈×8 level. Any
   realtime regression → the trace half is disabled by its own switch; the
   knobs and scale stand alone.
2. **Offline adjudication before any engine change** (E2): ideal-filter
   ceilings for divider vs TX-tap on one captured window, analyzers
   pre-validated against the prior-art WAVs. *Keep its verdict if:* the
   analyzers reproduced the known 13–16 dB / 33–50 dB era results within
   ±3 dB and the two ceilings differ by more than the analyzer's
   demonstrated error; otherwise fix the oracle, not the firmware. This step
   is also the fastest falsifier of this review: a divider ceiling ≥ the tap
   ceiling would overturn §2's recommendation before it costs a second
   flash.
3. **Flash 2 — apply the verdict** (E4): expected per current evidence to be
   TX-tap reference + the engine that passes the pre-registered gates
   (FD_LOW_COST and VOIP_HIGH_PERF are the leading candidates; FD_HIGH_PERF
   remains only if it passes double-talk with the clean reference). *Keep it
   if:* far-PRBS steady ≥12 dB, double-talk near-similarity ≥0.5 with zero
   far-phrase STT content, zero near rails at the E3-gated volume/gain
   operating point, p99 frame cost inside §7's budget, and the provider-edge
   replay produces zero false `speech_started` on far-only material — then
   re-derive the worker uplink gain (the ×8 was calibrated against a broken
   AEC) and only then re-run the interruption proofs.

HAVPE's parallel change is observability-only (E5) and needs no keep-gate
beyond "standing gates do not regress".

## 10. Proven / strong inference / hypothesis ledger

**Proven (source read or retained measurement, cited above):** both boards'
full signal topologies (§1); shared-controller sample-synchronous clocking on
StackChan; slot map and divider identity; boot gains and the absence of
runtime knobs; AW88298 init with HAGC/boost disabled and 0 dB digital volume
at "100 %"; the engine dispatch table, DTD-only-in-VOIP, TDE-dead-code, and
ref-VAD-unwired census; 512/32 ms vs 256/16 ms frames; planar 16-bit aligned
I/O contract; the four-stage failure signature and its dose-response; near
rail clipping in every retained run; prior-art era table including the
FD_LOW_COST + TX-tap 33.7–50.5 dB record, the divider 13.2–16.4 dB ceiling,
the 0.375 ms divider lag, the 28–44 ms tap lead, and the measured offset
tolerance curve; the CoreS3 echo-reference network itself (differential
150 kΩ + 1 µF into MIC3P/N, bottom legs unpopulated, 22 pF shunts,
post-ferrite tap of the BTL PWM output — official schematic p.4) and the
ES7210's gain-dependent input impedance (24 kΩ→6 kΩ at the 15 dB threshold,
datasheet) whose closed-form prediction of +6.9 dB matches the measured
+7.3 dB; HAVPE's XMOS pipeline config (2×2, 10+5 phases, 40 ms mic delay,
15 ms frames), schematic-proven parallel DAC/reference wiring at GPIO10,
TPA6211A1 class-AB output stage, tap mux semantics, three-command control
surface, version pin, and −47 dB / 0.909 measured health; trace scaffold
existing with zero callers; the ×8/×16 fixed worker gains; the post-gain
assessment-gate framing.

**Strong inference:** LOW_COST↔int16-FFT / HIGH_PERF↔float-FFT engine
identity (symbol names + v1 precedent); filter span = filter_length ×
frame (v1 source pairing + sibling disassembly); the scale-starvation
mechanism behind tone-passes/broadband-diverges (measurement-backed,
arithmetic unattributable in a closed blob); the PGA-loading account of the
+7.3 dB anomaly (schematic + datasheet + measured triangulation — E3's
non-monotonic staircase is the remaining physical confirmation).

**Hypothesis (each with its discriminating experiment):** divider corruption
by class-D residue/aliasing capping its ceiling (E2/E3 coherence + ceiling);
VOIP internal-RAM steerability to PSRAM within the ~39 KB budget (E4 boot
metrics); FD double-talk behaviour under a scale-true reference (E4 gates);
Speex-MDF CPU fit on S3 if the fallback is ever needed (no credible
benchmark exists anywhere — measure in the host rig first).

## Sources

Local first-hand: `platforms/iterate_core_s3_audio/core_s3_audio_owner.c`
(full), `platforms/iterate_esp_idf/idf_overrides/espressif__m5stack_core_s3/patch_core_s3.cmake`,
`components/core/src/{aec_capture_bridge.c,aec_diagnostic_trace.c}` (+header),
`targets/stackchan/main/main.c` (gain/mode sites),
`targets/stackchan/managed_components/espressif__esp-sr/include/esp32s3/esp_aec.h`,
`…/espressif__esp_codec_dev/device/aw88298/{aw88298.c,aw88298_reg.h}`,
`…/es7210/es7210.c` (via calibration review + spot checks),
`platforms/iterate_voice_pe_audio/{voice_pe_audio_owner.c,voice_pe_hardware_config.c,voice_pe_pcm_format.c}`,
`src/device/aec-waveform-assessment.ts`, `apps/kit/evidence/stackchan-production-aec-waveform/*`,
`docs/voice-device-adventures-2026-08-02.md`,
`docs/fable-v2-plan/exploration/afe-profile-decision.md`, both 2026-08-03
sibling reviews. Delegated with citations verified against the same trees:
esp-sr 2.4.7 symbol/link-map census; `SC` experiment-02 full artifact sweep;
first-party HAVPE stack (`HA` @26.2.2: `home-assistant-voice.yaml`,
`voice_kit`, ESPHome `aic3204.cpp`, `i2s_audio`; `XM` @v1.3.1: `ffva_int.cmake`,
`main.c`, `audio_pipeline_{t0,t1}.c`, `audio_pipeline_dsp.h`, `app_conf.h`,
`configuration_servicer.{h,c}`, `platform_{init,start}.c`, `NC-VOICE-KIT.xn`).
First-party web, fetched and read this review:

- ESP-SR AEC / AFE / benchmark pages —
  https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/acoustic_echo_cancellation/README.html
  (mode guidance incl. the FD_LOW_COST recommendation; cost table; note the
  public docs never mention DTD or delay estimation, and never define
  filter_length units),
  …/audio_front_end/README.html, …/benchmark/README.html.
- ES7210 datasheets — register-level Rev 21.0
  https://files.waveshare.com/wiki/common/ES7210_DS.pdf and brief Rev 22.0
  https://files.waveshare.com/wiki/common/ES7210-datasheet.pdf (R12
  SDOUT_MODE, Fig. 2e slot order, PGA code table, the gain-dependent input
  impedance 24 kΩ/6 kΩ, and the speaker-feedback application note).
- AW88298 datasheet (M5Stack's official mirror) —
  https://m5stack.oss-cn-shenzhen.aliyuncs.com/resource/docs/datasheet/core/K128%20CoreS3/AW88298.PDF
  (BTL filterless class-D, smart boost, HDCC→HAGC→Volume→Mute DSP chain,
  16 V full-scale transfer function, slave-only I2S).
- M5Stack CoreS3 schematic —
  https://m5stack-doc.oss-cn-shenzhen.aliyuncs.com/490/Sch_M5_CoreS3_v1.0.pdf
  page 4 (the AEC_P/AEC_N reference network, mic wiring, bus sharing).
- Home Assistant Voice PE schematic v1.0 (Nabu Casa) —
  https://raw.githubusercontent.com/NabuCasa/support/refs/heads/main/static/docs/voice/home_assistant_voice_pe_schematic_v1.0_241009.pdf
  (XU316-1024-QF60B-C24, TLV320AIC3204, TPA6211A1, MSM261DHP006 ×2 @71 mm,
  parallel I2S_DIN_ESP wiring).
- XMOS lib_aec / XVF3610 docs —
  https://www.xmos.com/documentation/XM-014660-PC/html/modules/voice/modules/lib_aec/doc/src/overview.html
  (15 ms/240-sample chunks, main+shadow filters, phases = tail length).
- ESP-IDF ESP32-S3 I2S driver —
  https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-reference/peripherals/i2s.html
  (full-duplex channels share BCLK/WS; TDM slot-mask semantics; slave
  bclk_div ≥ 8).
- Korvo-2 V3 schematic (pre-PA reference convention) — via the oracle
  review's verified citation.
