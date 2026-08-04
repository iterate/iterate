# StackChan AEC/double-talk current-state review — 2026-08-03

Prompt: `fable-stackchan-aec-double-talk-current-prompt-2026-08-03.md`. Read-only
review; the only write is this report. Sibling report written the same evening,
covering the harness/oracle side of the same two runs:
`fable-stackchan-audio-oracle-current-review-2026-08-03.md` — this review
cross-references it rather than repeating it, and independently re-derived its
two central harness findings (the unsatisfiable double-talk gates and the
gain-blind device metrics) from the metric source code before reading it.

## 0. Exactly what was reviewed (provenance)

- Worktree `c-capabilities` at HEAD `29be889c9` with a large **uncommitted**
  firmware diff. The tree changed _during this review_:
  `components/core/src/pcm_high_pass.c` appeared at 19:33–19:34 (a stateful
  100 Hz one-pole high-pass applied in place to the near channel before AEC,
  `core_s3_audio_owner.c:857-873`), and `CORE_S3_AEC_RAW_GAIN_MULTIPLIER`
  moved **4 → 6** at 19:35:43 (`core_s3_audio_owner.c:69`). Line numbers below
  are the 19:35 state unless marked otherwise.
- The two evidence runs named in the prompt were flashed from the ~18:0x tree
  state: **raw gain ×4** (proved by the run's own ambient windows:
  `cleanMeanAbsolute ≈ 4 × nearMeanAbsolute` in every quiet window), **no near
  high-pass**. Every double-talk number in the prompt therefore describes a
  binary that no longer matches source. No artifact records a build id
  (`failure.json` → `provenance: null`); run identity rests on directory names
  and flash times. Three prior reviews asked for the tree to be committed; it
  still is not.
- Deterministic run A:
  `apps/kit/evidence/stackchan-analog-reference-voip-20260803/2026-08-03T18-00-26-107Z`.
  Production run B:
  `apps/kit/evidence/stackchan-production-grok-receipt-fix-20260803/2026-08-03T18-19-08-334Z`.
- ESP-SR pinned `==2.4.7` (component commit `2f8c4b04…`), ESP-IDF v5.4.2.
  Binary claims below were verified against
  `targets/stackchan/managed_components/espressif__esp-sr/lib/esp32s3/*.a`
  with the xtensa toolchain (`nm`/`ar`/`objdump`), headers, and the same-commit
  first-party docs. Prior art re-read at
  `~/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec`.

## 1. Verdict

**V1 — Far-end cancellation is healthy. The "10.24 dB production suppression"
is a metric artifact, not a regression.** `echoSuppressionDb` is computed from
mean-absolutes measured **after** the uplink selector's ×8 processed output
gain (`stackchan-aec-assessment.ts:145-162` over `clean*` fields that
`core_s3_audio_owner.c:646-676` fills post-selection). Removing the branch gain
from run B's far window (nearMA 439, cleanMA 135, referencePeak 25880 → far
active → processed ×8): 20·log10(439/(135/8)) ≈ **28.3 dB engine suppression**
— the best production figure measured to date (the exact-TX-reference build of
15:26 read 22.4 dB with ×1 branch gains). The deterministic far-only battery
passes outright: clean −42.11 dBFS tone / −45.39 PRBS / −46.76 speech, at or
below the ambient+6 gate (ambient −45.17).

**V2 — The deterministic double-talk failure decomposes into four parts, two
real and two artifactual:**

1. _Real:_ the dios VOIP residual suppressor **ducks near speech during
   playback**. Measured `nearGain 0.583` compares double-talk uplink
   (processed branch, ×8) against near-only uplink (raw branch, ×4), so the
   engine-level near amplitude factor is 0.583·(4/8) ≈ **0.29 (−10.7 dB)** —
   sustained, per 250 ms window analysis of the PCM (double-talk runs 3–5 dB
   below near-only in matched windows; no clipping, no mutes, no gain steps
   inside the analysis window).
2. _Real:_ the VOIP engine processes at **8 kHz internally** (binary-proven,
   §5), so the processed branch — exactly the audio a barge-in leaves on — is
   band-limited to ≤4 kHz and NLP-shaped. This plus (1) is the production
   failure mechanism: Grok STT heard _"Open reply. Production test complete."_
   instead of _"Stop and reply exactly interruption test complete."_
3. _Artifact:_ `farEndResidualDb −12.47` is measured relative to the digital
   far source and gated at −40 dB — but the rig's own **replay-variance floor**
   is −7.33 dB (the near-repeat phase: same Mac file played twice, no far end
   at all, leaves −7.33 dB residual). The double-talk residual −8.21 dB is
   _better than the repeat floor_ (`residualDegradationFromRepeat = −0.88 dB`,
   passing), and the residual does not correlate with the far source
   (`farEndSimilarity 0.005`). The −40 dB branch is arithmetically
   unsatisfiable; the sibling report reaches the same verdict.
4. _Artifact:_ `similarity 0.832` fails an absolute 0.85 gate whose measured
   ceiling — the rig replaying the same audio with no far end — is 0.906.
   Double-talk lost only 0.074 of similarity versus that ceiling
   (`similarityLossFromRepeat` gate ≤0.1 passes).

**V3 — Self-talk did not open server VAD on the current firmware.** Run B's
provider journal shows exactly 3 `speech_started`, all Mac-injected; zero
unsolicited responses. The "response/self-talk could open server VAD" framing
in the prompt describes the ≤15:26 builds (semantic-oracle review measured 3
false opens then), not the 18:0x divider builds. The standing production red is
**barge-in intelligibility**, not self-talk.

**V4 — No hard ESP-SR precondition is violated (Q1).** Channel order, chunk
size, format, and rate are all correct and enforced. Two first-party _guidance_
deviations exist (reference headroom at the ×8 scale, and the tap point being
PA-post-stage), plus one genuine configuration defect outside ESP-SR: the
**reference channel's ES7210 analog path is unmanaged** — the BSP never selects
MIC3, so the driver powers the MIC3/4 pair down, never sets its gain-enable
bit, disables the codec's TDM mode, and silently no-ops the owner's
`reference_gain_db` write (§3, §4).

**V5 — Fastest technically sound route:** Option 1 (one flash: equal branch
gains + export the dark clip counters + an always-processed probe run) with the
sibling report's gate recalibration, then Option 2 (reference/headroom ladder
including the MIC3 repair and a same-build divider-vs-exact-TX A/B), and only
if both leave double-talk red, Option 3 (wire the 3-plane diagnostic trace and
run an offline falsifier before considering any engine replacement). §7.

## 2. What is actually running (19:35 tree)

```
AW88298 speaker ◄─ I2S TX (Philips stereo, mono content) ◄─ pcm_clock_playback ◄─ lane ◄─ Grok
     │ hardware volume register only (vol 90 ≈ +10 dB of a −34.5…+15 dB curve;
     │ esp_codec_dev sw_vol==NULL, so TX PCM is never scaled in software)
     │
     ├─► analog divider (150 kΩ series, ~48 kHz RC pole) ─► ES7210 MIC3 ─► TDM slot 1
     │
     ▼ acoustics
ES7210 MIC2 (near, +24 dB PGA) ─► TDM slot 2 ┐
ES7210 MIC1 (diagnostic)       ─► TDM slot 0 ├─ one 8 ms RX DMA chunk (128×4 samples)
                                  TDM slot 3 ┘
TX DMA completion ─► playback_reference_reserve (exact TX PCM, 8×8 ms)   [ISR]
RX DMA completion ─► capture_reserve (raw 4-slot, 8×8 ms)                [ISR]
        AEC task (prio 20, core 1): pair TX/RX chunks, skew gate 4 ms
        deinterleave → near ← 100 Hz HPF (new) ; ref ← divider ×8 saturating
        bridge reframes 128 → 256-sample frames (16 ms)
        aec_process(VOIP_HIGH_PERF, near, divider×8) → clean          [engine]
        uplink selector: any playout sample ≠ 0 (exact TX) or ≤128 ms hangover
              → clean = AEC out ×8 ; else clean = raw near ×6 (was ×4)
        signal window (stride 7, 1 s) measures near/ref/clean POST-selection
        reframe 256 → 320-sample wire frames → capture turn → lane → WS → worker (×1) → Grok
```

Constants (`core_s3_audio_owner.c:29-75`, `targets/stackchan/main/main.c:1160-1184`):
filter_length 4 (inert, §5), NLP `AGGR` (inert, §5), skew gate 4000 µs, hangover
8×16 ms, raw ×6, processed ×8, reference ×8, near slot 2, ref slot 1, volume 90,
mic PGA 24 dB, ref PGA 0 dB (write is a no-op, §3), engine state in PSRAM.
There is **no local VAD or energy gate anywhere on the uplink** (verified by
sweep; the only playback-aware element is the selector, which never mutes), and
the worker relays at gain ×1 (`server-vad-policy.ts:42`).

Run A device counters over the whole run: 8306 reference pairs, **0 pair
resets** (max skew 1354 µs — the 4 ms gate never fired), 0 bridge errors,
0 dropped capture chunks, aec_process last/max 11.3/12.3 ms per 16 ms frame.

## 3. Q1 — precondition audit

| Requirement                                                                                                                            | First-party source                                                                       | Current code                                                                                                                                                                                                                                                                                                                                                                             | Verdict                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Argument order: `indata`=mic, `refdata`="samples sent to the speaker"                                                                  | `esp_aec.h:85-96`                                                                        | `aec_process(aec, near, reference, clean)` at `core_s3_audio_owner.c:630`; reference = divider                                                                                                                                                                                                                                                                                           | ✓ (also empirical: −45 dBFS far-only is impossible with swapped args)                                                  |
| Chunk size: VOIP = 16 ms (256 @16 k); SR/FD would be 512                                                                               | binary: `frame_size = rate·16/1000` on the VOIP branch; docs "SR/FD 32 ms, VOIP 16 ms"   | `aec_get_chunksize()==256` enforced at startup, hard-fail otherwise (`:565-577`)                                                                                                                                                                                                                                                                                                         | ✓                                                                                                                      |
| int16, 16-byte-aligned buffers                                                                                                         | `esp_aec.h:87`, AEC README                                                               | static frames `__attribute__((aligned(16)))`                                                                                                                                                                                                                                                                                                                                             | ✓                                                                                                                      |
| Rate 16 kHz                                                                                                                            | `aec_create` doc; VOIP resamples internally                                              | 16000                                                                                                                                                                                                                                                                                                                                                                                    | ✓ (consequence: 8 kHz internal, §5)                                                                                    |
| Layout: planar per channel, **not** interleaved ("MR" interleave is AFE-only)                                                          | `esp_aec.h:89` vs `esp_afe_aec.h:25-46`                                                  | mic_num=1, separate arrays                                                                                                                                                                                                                                                                                                                                                               | ✓ — corrects any lingering "MR" concern from older notes                                                               |
| Reference amplitude: "when volume is at maximum, recovery signal peak −3 to −5 dB"; must not saturate the ADC                          | Microphone Design Guidelines `:59-67`                                                    | ref peak ×8 at **vol 90** = 25880 ≈ **−2.1 dBFS** (run B); the volume curve adds ≈+5 dB from 90→100 → **×8 clips at vol 100**; `reference_scale_clipped_samples` counted but **never exported**                                                                                                                                                                                          | ⚠ marginal now, violated at vol 100, and unobservable                                                                  |
| Reference tap point: "as close to the speaker side as possible… DA post-stage and PA pre-stage"; add LPF when tapping a Class-D output | same doc                                                                                 | CoreS3 divider is **PA post-stage** (Class-D output) behind a single 150 kΩ·22 pF pole (~48 kHz)                                                                                                                                                                                                                                                                                         | ⚠ deviation; empirically working (28 dB); it is also why the divider models amp limiter/harmonics that exact TX cannot |
| Reference timing                                                                                                                       | **no numeric bound exists in 2.4.7 docs** (verified; only "adjust delays per algorithm") | divider is sampled in the _same TDM frame_ as the mics — ref leads the acoustic echo by ≲1 ms (prior art measured 0.375 ms); dios HIGH_PERF budget ≈8 subband taps                                                                                                                                                                                                                       | ✓                                                                                                                      |
| ES7210 reference channel driver contract                                                                                               | `es7210.c:188-235`                                                                       | BSP builds `es7210_codec_cfg_t{.ctrl_if}` only (`m5stack_core_s3.c:440-442`) → `mic_select` defaults to MIC1\|MIC2 → driver writes `MIC34_POWER_REG4C=0xff` (MIC3/4 powered down), never sets REG45 gain-enable, writes `REG12=0x00` (TDM off); `esp_codec_dev_set_in_channel_gain` for mask 2 **silently no-ops** (esp_codec_dev returns OK unconditionally, `esp_codec_dev.c:439-442`) | ✗ config defect: the reference channel works by accident of power-on registers                                         |

Bottom line for Q1: the engine feed itself is compliant. The violations live in
(a) reference headroom with a dark clip counter, (b) an unmanaged reference
analog path, (c) everything _after_ the engine (selector gains).

## 4. Q2 — divider calibration: what is settled, and the measured ladder

Already verified — do not spend flashes on these:

- **Polarity**: irrelevant to the adaptive filter (sign is absorbed by the
  taps); far-only −45 dBFS proves adaptation converges with current polarity.
- **DC/high-pass**: ES7210 HPF quick-setup registers are written at open
  (`es7210.c:420-423`), the divider is AC-coupled in hardware (series C102 per
  the CoreS3 schematic finding in the hardware review), and since 19:33 the
  near channel additionally gets a 100 Hz one-pole HPF. The near/ref filter
  asymmetry this introduces is LTI and absorbable by the filter (it becomes
  part of the modeled echo path); no action.
- **Delay alignment**: divider and mic share one TDM frame; measured lag
  0.375 ms (prior art) ≪ engine budget. The 4 ms TX/RX pair gate (landed from
  the exact-reference review) protects only the _selector's_ playout lane —
  the engine reference cannot slip by construction.
- **TDM tap choice**: slot 1 is the divider; wire order MIC1, MIC3, MIC2, MIC4
  confirmed twice. No other tap carries the speaker.
- **Scale ×8 at volume 90**: lands the reference almost exactly on Espressif's
  documented "−3…−5 dB peak" target. The calibration question is headroom at
  volume 100 and the unmanaged analog path, not the ×8 concept.

The ladder (each rung: measured procedure → pass metric → decision):

- **L0 (enabler, one BSP line + read-back):** set
  `es7210_cfg.mic_selected = MIC1|MIC2|MIC3` in the kit BSP override (this is
  exactly what prior art does, `m5stack_core_s3.c:395-404` there). This powers
  MIC3, sets its gain-enable bit, makes `reference_gain_db` writes real, and
  flips the codec into true TDM (`REG12 0x00→0x02`). **Risk: the wire format
  may change.** Pass metric: `tdm_slot_peak[]` still shows near on slot 2 and
  a speaker-tracking slot 1 during a far tone; if the order moved, remap the
  two constants and re-run. Do this before any PGA work — until L0, PGA sweeps
  on the reference are physically impossible.
- **L1 (headroom, no flash beyond the counter export):** export
  `reference_scale_clipped_samples`, the selector's `clipped_samples`, and the
  near-HPF clip counter into `KitAecMetrics` (schema bump; all three exist in
  RAM today and are invisible). Far-tone at volume {80, 90, 100}: require ref
  clips = 0 and near rail (`tdm_slot_peak[2] < 32767`) at the chosen operating
  point. If ref clips at 100: either pin product volume ≤90 or drop the scale
  ×8→×6/×4 targeting ≈−4 dBFS peak at vol 100 (the engine is scale-free; only
  headroom and the ~6 dB quantization-floor shift matter, and the divider's
  floor is ≥55 dB below its peak, so ×4 is safe).
- **L2 (near ADC de-rail):** run A shows near peak 31368 (−0.4 dBFS) during
  far playback at vol 90 / PGA 24 — the near mic is grazing the rail from the
  device's own speaker, and a railed near input is uncancellable nonlinearity
  precisely during double-talk (`main.c:1165-1175` records the team knows;
  nothing gates it). Sweep mic PGA {24, 21, 18} at vol 90/100 far-speech:
  pick the highest PGA with zero rails. Re-derive the uplink gain constant via
  the VAD replay ladder (existing `stackchan-vad-replay` tooling) on the new
  near-only capture: lowest rung that opens VAD and transcribes, plus one rung
  margin — and verify the _double-talk_ capture at that gain also opens VAD
  (barge-in must not be under-powered).
- **L3 (reference A/B, one-argument flash):** the exact-TX playout lane is
  already aligned and delivered to the same callback (`aec_playout`); swapping
  the engine's reference is a one-argument change at
  `core_s3_audio_owner.c:1009-1016`/`:630`. Same build, same room, same day,
  run the full rig battery both ways. Divider arm models amp distortion but
  carries an accidental analog path (until L0) and clip risk; exact-TX arm is
  noiseless but volume-blind (TX PCM never scales with the hardware volume
  register — verified `esp_codec_dev.c:198-207` leaves `sw_vol` NULL) and
  historically measured 22.4 dB production / −20.77 dBFS tone (speaker-THD
  limited). **Decide on measurements, not history**: the prior-art "33.7–50.5
  dB DMA-tap" legend does not survive its own primary data — those candidates
  failed their confirmation reruns at 12.9/21.9 dB and were never left active
  (`local/aec-runs/20260729-*/best/`), so neither reference direction inherits
  a presumption.
- **L4 (band-limit documentation, no flash):** play a 5–6 kHz near tone during
  device playback; if the uplink loses it on the processed branch, the ≤4 kHz
  band-limit is confirmed end-to-end (binary analysis says the engine core is
  8 kHz; whether an upper-band passthrough exists in `esp_voip_process_api` is
  the one open question — probe-bin analysis of run A was inconclusive because
  the rig's near speech has almost no energy above 4 kHz at Mac volume 40%).
  This is knowledge for the STT story, not a knob.
- **L5 (divergence probe, harness change):** append a far-only phase _after_
  the double-talk phase in the rig. If post-double-talk far-only re-converges
  slowly, the dios DTD failed to freeze adaptation during double-talk —
  evidence for Option 3; if it resumes at −45 dBFS immediately, the DTD holds
  and the duck is pure residual-suppressor policy.

## 5. Q3 — is VOIP the right primitive? (with binary-verified internals)

What `AEC_MODE_VOIP_HIGH_PERF` actually is in 2.4.7 on esp32s3 (all
relocation/disassembly-verified in `libesp_audio_processor.a`):

- `aec_create_from_config` → `esp_voip_init_api` → **DIOS SSP subband AEC**
  (`dios_ssp_aec_*`), hard-wired to 1 mic + 1 ref (literal `0x00010001`),
  internal `AEC_SAMPLE_RATE = 8000`; at 16 kHz input it creates three Speex
  resamplers (mic in, ref in, out — quality 5). Per-frame chain: noise-level
  estimators → subband analysis → FIR filter → ERL estimate → residual
  suppressor → **double-talk detector** (`dios_ssp_aec_doubletalk_process`,
  called every frame; the `doubletalk_fast` energy/statistics implementation)
  → subband synthesis → residual suppressor second pass.
- **`filter_length` is discarded** on the VOIP branch (the register holding it
  is overwritten before the engine parameter block is built); the only knob the
  engine receives is the HIGH_PERF flag → NTAPS 8/8, 18 bands (LOW_COST: 4/4,
  4 bands). **`nlp_level` applies to FD modes only** ("Only full-duplex AEC
  support NLP level setting"); VOIP's residual suppressor is always on with
  fixed parameters. The `AGGR` constant and the filter-length 4 in our config
  are decoration — the source comment at `core_s3_audio_owner.c:552-560`
  already says so and is correct.
- **TDE is dead code** (four `dios_ssp_aec_tde_*` objects reference only each
  other; `DIOS_SSP_AEC_TDE_ON` is written and never read — re-verified across
  all 11 archives). **No AGC and no NS exist in the VOIP path** (the WebRTC
  AGC/NS objects are reachable only from the AFE's separate pipeline stage) —
  this also formally eliminates "hidden AGC" as an explanation for the
  production `cleanToNearRatio 4.0`; that number is the raw branch's ×4.

Direct answers:

- **FD*HIGH_PERF would materially \_worsen* double-talk.** The FD/SR engines
  (`esp_aec3_*`) have **no double-talk detector**, and their exported ref-VAD
  gate hook has zero importers in 2.4.7 — adaptation is ungated. This is not
  theoretical: the kit's own FD era measured near-similarity collapsing
  0.080→0.0035 as the reference got hotter, and prior art's scripted
  double-talk failed every attempt under FD (0.21/1.53 dB). FD's advantages
  (fullband 16 k, honored filter_length, selectable NLP) are exactly the wrong
  trade for barge-in.
- **AFE (`AFE_TYPE_VC`) adds nothing to cancellation.** Its AEC stage calls
  the identical `aec_create_from_config`; it wraps NSNET + VAD around it
  (AGC default **off** — verified from `afe_config_init` disassembly), runs
  mono, and costs ~31% of a core on feed plus ~820 KB PSRAM with models. The
  earlier rejection stands re-verified.
- **Within ESP-SR, VOIP is the only primitive with any double-talk protection,
  and its tuning surface is empty.** The levers that remain are ours: input
  levels, reference choice/quality, and post-engine policy.

Resources (first-party table, esp32s3 section of the AEC README, 16 kHz mono;
plus measured):

| Mode                         | Internal RAM | PSRAM    | Time/frame | CPU (doc) | Measured here                                                                                                                  |
| ---------------------------- | ------------ | -------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| SR_LOW_COST                  | 18.8 KB      | 64.0 KB  | 2.29/32 ms | 7.2 %     | —                                                                                                                              |
| SR_HIGH_PERF                 | 8.2 KB       | 100.1 KB | 4.51/32 ms | 14.1 %    | —                                                                                                                              |
| VOIP_LOW_COST                | 26.9 KB      | 64.1 KB  | 4.37/16 ms | 27.3 %    | —                                                                                                                              |
| **VOIP_HIGH_PERF (current)** | 69.2 KB      | 66.6 KB  | 5.05/16 ms | 31.6 %    | **last 11.3 ms, max 12.3 ms per 16 ms frame (≈70–77 % of core 1 at peak; engine state in PSRAM via `caps=MALLOC_CAP_SPIRAM`)** |
| FD_LOW_COST                  | 30.9 KB      | 90.0 KB  | 6.28/32 ms | 19.6 %    | —                                                                                                                              |
| FD_HIGH_PERF                 | 20.3 KB      | 126.2 KB | 8.08/32 ms | 25.3 %    | 38–61 % of core 1 measured earlier under PSRAM contention                                                                      |

The S3-with-PSRAM reality is ≈2.2× the doc figure for VOIP_HIGH_PERF; it fits
today (0 bridge errors, 0 missed frames in run A) but leaves little headroom on
core 1. If CPU ever becomes the constraint, VOIP_LOW_COST (4 bands, shorter
tail) is the in-family fallback to measure — not FD.

**Answer: yes, VOIP AEC is the right ESP-SR primitive.** The double-talk duck
is the _fixed_ dios residual-suppressor policy plus the ≤4 kHz internal band —
neither reachable by any first-party knob. If, after Options 1–2, the honest
near gain during double-talk is still unacceptable, the choice is not another
ESP-SR mode; it is a third-party canceller (speexdsp MDF is the only realistic
candidate) — gated behind Option 3's falsifier because no S3 benchmark exists
and dios currently delivers 28 dB.

## 6. Q4 — defect ledger (ranked; each with the failure it produces)

1. **Asymmetric uplink gains around the NLP** (`core_s3_audio_owner.c:68-70`:
   raw ×6 — ×4 in the flashed evidence — vs processed ×8, selected per 16 ms
   frame). Consequences, all measured: every double-talk metric is biased by
   the 8/4 branch ratio (near gain reads 0.583 when the engine-level factor is
   ≈0.29); the +18 dB processed gain re-amplifies exactly the double-talk
   residual the NLP releases; branch flips add a gain step the harness's
   single-gain fit cannot model (depressing similarity); and the device
   metrics (`echoSuppressionDb`, `cleanToNearRatio`) silently change meaning
   with the branch. Fix: **one gain constant for both branches** (value from
   the replay ladder), i.e. delete `processed_gain_multiplier` as a separate
   concept.
2. **Dark clip counters + reference headroom.**
   `reference_scale_clipped_samples` (`:885-895`), the selector's
   `clipped_samples`, and the new HPF's clip counter are all counted and never
   exported (`metrics_snapshot` at `:1529-1654` copies neither). Reference
   peak is −2.1 dBFS at vol 90 and the curve adds ≈+5 dB to vol 100 — the ×8
   reference **will clip at max volume and nothing will report it**; a clipped
   reference is a nonlinear reference at exactly the loudest, hardest moments.
   Fix: export all three (schema bump) and gate them at zero in the harness.
3. **Near ADC rail during playback** (run A far-speech `tdm_slot_peak[2]`
   31368 = −0.4 dBFS at vol 90 / PGA 24). A railed near input corrupts
   double-talk at the ADC before any DSP. Fix: L2 (PGA down, digital gain up,
   rail gated to zero).
4. **Harness gate arithmetic** (independently derived here; jointly owned by
   the sibling report, which carries the full action list): the −40 dB
   double-talk far-residual branch is unsatisfiable (rig floor ≈ −7 dB; even a
   perfect device only reaches the uncorrelated-ambient bound ≈ −19 dB); the
   0.85 absolute similarity gate sits 0.056 under the rig's own repeat
   ceiling; `cleanToNearRatio` 0.5–2.0 predates the deliberate raw-branch
   calibration gain and now fails by design; `echoSuppressionDb` is
   gain-blind; run B's "3 playbackResets" are the three _planned_ interruption
   barriers being counted as failures.
5. **Reference PGA writes silently no-op & unmanaged MIC3 analog path** (§3
   last row). Until L0, `reference_gain_db` is dead code, the divider's
   PGA/power state is whatever the chip reset to, and `esp_codec_dev` hides
   the failure by always returning OK. This also blocks every PGA-based
   calibration idea from earlier reviews.
6. **Engine destroy/recreate on playout-lane skew** (`:966-1002`): a >4 ms
   TX/RX completion skew poisons both reserves and recreates the AEC —
   re-converging from scratch — even though the engine's reference (divider)
   is sampled in the same RX frame as the mics and cannot slip; only the
   _selector's_ far-active decision depends on TX pairing. It fired zero times
   in run A (max skew 1.354 ms) but is armed for every Wi-Fi/CPU contention
   spike. Fix (deletion of blast radius): on skew, resync the playout lane
   only (hold the last far-active decision for ≤1 frame); reset the engine
   only on genuine RX discontinuity.
7. **VOIP band-limit + fixed duck on the barge-in path** (§5): engine-fixed;
   mitigated by 1–3 (honest level, no rail, no ref clip), decided by L3–L5;
   replaced only via Option 3.
8. **Selector hangover vs long tails and underrun zeros**: the zero-test runs
   on exact TX content, so render-silence during a mid-response underrun
   flips to raw ×6 after 128 ms — but the speaker is silent then too, so only
   the room's >128 ms reverb tail leaks, unprocessed. Benign at current room
   RT60; watch `playback_underrun_incidents` alongside. Becomes fully benign
   once gains are equal.
9. **Test constants drifted from production** (`tests/aec_uplink_selector_test.c`
   still initializes `(2U, 4U, 8U)` — raw 4 vs shipped 6): the suite pins
   semantics, not the shipped ratio. Fold the ratio into the single-gain
   change and update the test to the named constants.
10. **Near/ref HPF asymmetry** (new, 19:33): mathematically benign (the
    one-pole becomes part of the modeled path). Noted so it isn't
    re-discovered; its clip counter joins defect 2.

## 7. Q5 — three ranked options

**Option 1 — Honest levels (one flash + one rig run + one Grok run; same day).**
Set both selector gains to one constant chosen by the replay ladder (replay the
_current_ near-only capture at absolute rungs {×4, ×6, ×8}: lowest rung that
opens VAD and transcribes, plus one rung; verify the double-talk capture also
opens VAD at that rung). Export the three dark counters. Keep the selector.
Add one **probe build variant** (single line: force `use_processed = true`) and
run the rig's near-only phase through it once — this measures, for the first
time, what dios+divider does to near-only speech (the selector's whole reason
to exist is a "92–99 % near-only removal" measured under the _exact-TX_ ref
whose silence is exactly zero; the divider ref is never exactly zero, so that
result does not transfer and has never been re-measured).
_Decisive test:_ deterministic rig + production barge-in, same day. Pass =
double-talk `nearGain` (now reading the engine factor directly) ≥ 0.7, far-only
battery unchanged, production interruption transcript exact.
_Rollback/kill:_ constants revert in one line. If honest nearGain < 0.6 with
zero ref clips and zero near rails → the dios duck dominates → Option 2; if the
probe shows near-only survives the processed path ≥0.95 similarity, delete the
selector entirely (one branch, one gain) as a follow-up simplification.

**Option 2 — Reference & headroom ladder (L0–L3 above; 1–2 days).**
BSP `mic_selected` repair with slot-map re-verification; ref scale set by the
measured −3…−5 dB peak target at vol 100 with clip gates; near PGA de-rail with
VAD-floor re-derivation; then the one-argument divider-vs-exact-TX A/B on the
same build.
_Decisive test:_ the A/B, judged on recalibrated gates — pass = one arm meets
both far-only ≤ ambient+6 **and** double-talk nearGain ≥ 0.7 / similarity
within 0.1 of the repeat ceiling.
_Rollback/kill:_ every rung is a constant or one argument; if _neither_ arm
passes both sides, the dios policy is the proven ceiling → Option 3.

**Option 3 — Instrument, then (maybe) replace the engine (only on kill of 1–2).**
Wire `aec_diagnostic_trace` in its reduced 3-plane form (near / reference /
clean — the linear and playout planes are unobtainable under fused VOIP; the
module is compiled, host-tested, and has zero callers today). Capture real
double-talk and far windows on-device; run the offline falsifier on those exact
pairs: NLMS ceiling + speexdsp MDF vs the measured dios output.
_Decisive test:_ offline speex on real pairs beats dios by ≥6 dB double-talk
residual at equal far-only suppression, and an S3 CPU spot-bench fits beside
the 11–12 ms VOIP budget.
_Rollback/kill:_ if offline alternatives don't beat dios on real pairs, dios
**is** the ceiling — stop engine work, keep Option 1/2 results, and treat any
remaining double-talk gap as an acoustic operating point (volume, speaker-mic
coupling). Server-side gates and speaker-active mutes stay rejected: the
selector never mutes, genuine double-talk always ships upstream, and the
spectral-VAD evidence (semantic-oracle review) already killed energy gating.

Explicitly _not_ proposed, re-checked against current code/measurements:
FD_HIGH_PERF (no DTD — would collapse double-talk, §5); AFE-VC (same engine,
paid twice); any deliberate reference delay (TDE dead, alignment already
hardware-exact); NLP level changes (inert in VOIP); worker-side gain changes
(×1 is correct; gain belongs on-device where the selector knows the branch).

## 8. Number reconciliation (every headline number → mechanism)

| Number (prompt)                        | What it actually is                                                             | Corrected reading                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| far-only −42.11 / −45.39 / −46.76 dBFS | accepted-uplink RMS, post ×8 processed gain, 1–4 s window                       | genuinely healthy; at/below ambient+6 (−39.2); engine output sits near the noise floor                                                                                  |
| double-talk near gain 0.583            | least-squares scalar of DT uplink (processed ×8) onto near-only uplink (raw ×4) | engine-level near factor ≈ 0.29 (−10.7 dB dios duck) — the real defect                                                                                                  |
| near similarity 0.832 (gate 0.85)      | normalized cross-correlation vs near-only uplink                                | rig's own repeat ceiling is 0.906; DT lost 0.074 (relative gate passes); remainder = duck + band-limit + branch-gain step                                               |
| residual-to-near −8.21 dB              | energy of (DT − 0.583·near-only) rel. near-only                                 | **better** than the −7.33 dB near-repeat replay floor; passes its own gate                                                                                              |
| far residual −12.47 dB (gate −40)      | same residual rel. the _digital_ far source                                     | ≈ −35.7 dBFS absolute; `farEndSimilarity 0.005` → dominated by replay variance, not far content; gate unsatisfiable (floor ≈ −7 dB measured, ≈ −19 dB theoretical best) |
| production far suppression 10.24 dB    | 20·log10(nearMA/cleanMA), cleanMA post ×8                                       | ≈ **28.3 dB** engine suppression — best to date                                                                                                                         |
| near-only clean/raw 4.0 (gate 0.5–2)   | mean-absolute ratio post-selector in a quiet window                             | the raw branch's deliberate ×4 (now ×6 in source); stale gate                                                                                                           |
| "self-talk could open server VAD"      | provider journal, run B                                                         | did **not** happen on 18:0x firmware (3/3 speech_starts were Mac); historical on ≤15:26 builds                                                                          |
| "recorder did not close complete"      | one 72 ms inter-accept gap in near-repeat                                       | Wi-Fi cadence, not the recorder (misnomer already established by the semantic-oracle review)                                                                            |

## 9. Inherited-claim re-verification (per the prompt's "don't repeat old advice")

| Claim                                                                                                    | Status today                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TDM wire order MIC1, MIC3, MIC2, MIC4; near/ref slot constants                                           | VERIFIED empirically — **with a new nuance**: the kit runs the ES7210 with `REG12=0x00` (TDM _off_, packed I2S) because `mic_selected` is unset, unlike prior art's `0x02`; the packed order coincides. L0 changes this deliberately.                                                                  |
| ES7210 impedance switch at high PGA codes explains the +7.3 dB anomaly                                   | Stands, but **moot** at ref PGA 0 — and unreachable anyway until L0 makes MIC3 writes land.                                                                                                                                                                                                            |
| VOIP `filter_length`/`nlp_level` inert; 8 kHz dios core; DTD present; TDE dead; no AGC/NS                | RE-PROVEN independently at register/relocation level (§5).                                                                                                                                                                                                                                             |
| 12 ms pair gate has silent 8 ms slip paths → tighten to 4 ms; telemetry stride 8 aliases PRBS → stride 7 | Both LANDED in the current tree (`:59-60`, `:49-50`); gate never fired in run A.                                                                                                                                                                                                                       |
| "VOIP residual suppressor removes 92–99 % of near-only speech" (selector's founding measurement)         | UNVERIFIED under the divider reference — measured only with exact-zero exact-TX silence; Option 1's probe re-measures it.                                                                                                                                                                              |
| Prior-art DMA-tap 33.7–50.5 dB vs divider 13.2–16.4 dB                                                   | **CORRECTED**: the 33.7/50.5 candidates failed their own confirmation reruns (12.9/21.9 dB, `accepted_and_left_active: false`), and the best confirmed tap run carried a far-phrase transcript leak (similarity 1.000). No reference direction inherits a presumption; L3 decides on current hardware. |
| "Software reference failed" is a stream-copy-era myth                                                    | Refined as above — the honest era-B record is ≈21.9 dB confirmed; the current divider+VOIP build measures ≈28 dB in production and passes the rig far-only battery.                                                                                                                                    |
| VERYAGGR NLP destroyed barge-in → keep AGGR                                                              | Historically true, now IRRELEVANT — the knob is inert in VOIP; the comment block at `:39-48` documents a setting the engine never reads.                                                                                                                                                               |
| AW88298 HAGC/limiter off; hardware-register volume only                                                  | RE-VERIFIED in the vendored driver (`SYSCTRL2=0x0008`, `sw_vol` never allocated) — grounding for "divider tracks volume, exact TX does not, ×8 tracks neither".                                                                                                                                        |
| aec_diagnostic_trace exists, host-tested, zero callers                                                   | RE-VERIFIED (still zero callers); Option 3 wires the 3-plane reduction.                                                                                                                                                                                                                                |

## 10. Standing housekeeping

The worktree remains uncommitted (fourth review in a row to note it), now
including this report, the 19:3x owner changes, and `pcm_high_pass.{c,h}`.
Evidence artifacts still carry no build identity; adding `git describe` + the
five AEC constants to `capability-description.json` would have collapsed a full
day of "which binary produced this number" reconstruction into one field.
