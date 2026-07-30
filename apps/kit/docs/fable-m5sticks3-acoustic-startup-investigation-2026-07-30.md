# M5StickS3 acoustic startup-loss investigation

Status: independent Fable Max investigation report, delivered 2026-07-30
(~21:50 local). No production code was edited; this file is the only
working-tree change. All hypotheses below were tested against retained
artifacts, live instruments, and new physical control experiments run during
the investigation. Analysis scripts and new capture artifacts live outside the
working tree (paths and SHA-256 hashes in §11) so this repository gains only
this report.

Investigated defect (as posed): a fresh 250-frame / 5-second 997 Hz run with
perfectly clean device counters (250 accepted / 250 submitted / 250 completed,
zero drops/underruns/overflows/backpressure/state errors, EOS 1/1, 3 EOS
silence descriptors, max EOF-to-refill 39,375 µs, min descriptor-reuse lead
20,625 µs) whose room recording contains the tone only from ≈3.15 s to
≈7.10 s — ≈3.98 s instead of 5 s — plus 99 inactive 5 ms windows and 40 phase
discontinuities.

## 0. Verdict

**The missing startup audio, the short inactive windows, and the phase
discontinuities are artifacts of the acoustic measurement pipeline, not of the
device.** The ffmpeg AVFoundation recorder used for every retained artifact
drops roughly one in five 512-sample CoreAudio capture buffers on this host,
splicing the recording. Time removed from the file shortens the measured tone
span (the analyzer reads that as "missing startup"), and the splices produce
the micro-gaps, the phase steps, and the smeared ≈988 Hz spectrum.

Three independent discriminating experiments, all run tonight without touching
production code, close the case:

1. **Device-free reproduction.** The Mac's own speaker playing a generated
   997 Hz wav through the identical `ffmpeg -f avfoundation` pipeline shows the
   same signature: span/expected = 0.784 (5 s) and 0.790 (10 s), instant
   full-level onset, −78 dB before onset, ~1,500/~3,000 small phase steps —
   numerically indistinguishable from the device artifacts (§3, M7).
2. **Simultaneous dual capture of one acoustic event.** A raw CoreAudio tap
   (AVAudioEngine `installTap`, no AVCaptureSession) recorded the same 10 s
   tone as a pristine 997.000 Hz, 10.01 s span, 2 phase steps, exact cycle
   census — while the AVFoundation capture running at the same moment produced
   an 8.33 s span, a 987 Hz smear, and 3,230 phase steps (§3, M8).
3. **Direct raw measurement of the device.** During a live harness run the
   M5StickS3's own output, measured by the raw tap, is 997.00 Hz, first
   audible ≈210 ms after `response.created`, with 2/761 phase-step hops — and
   the working tree's brand-new SoX/CoreAudio recorder (landed tonight,
   21:11–21:17) measured the same event equally clean: 997.00 Hz, 0/702 phase
   steps (§3, M9–M10). **There is no device-side startup loss.** The device
   counters were telling the truth; the room recording was lying.

Two genuinely device-relevant findings fell out along the way:

- The freshly-repaired EOS finished-pointer behavior verified clean in both
  retained runs (250/250 and 500/500, `endOfStreamSilenceDescriptors: 3` =
  `dma_desc_num − 1`, exactly the designed padding). It is unrelated to the
  apparent startup loss, as the brief suspected.
- A **real** but separate defect reproduced live in my own harness run: one
  late downlink frame ≈2.1 s into playback produced exactly one underrun +
  deadline-miss + driver-queue-overflow, and the current zero-tolerance policy
  stack turned that single 20-ms-class event into a dead generation and a dead
  run (§8). That is the fortress blast-radius already accepted for migration
  in the reconciliation ledger; this report adds a live fixture for it.

No recommendation below increases any buffer.

## 1. What was inspected

Working tree `/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`
(actively edited during the investigation — `src/device/macos-pcm16-capture.ts`
changed at 21:11 and `scripts/device-e2e.ts` at 21:17 while this review was
running; citations name which version they refer to).

- Retained artifacts and logs: `apps/kit/evidence/m5sticks3-playback/`
  (`iterate-kit-acoustic-xQVuWR/microphone.pcm16le`, verified SHA-256
  `81404d…53e94`, 752,640 bytes; `control-10s-current-order/run.log` +
  `iterate-kit-acoustic-yIAlXD/microphone.pcm16le`).
- Harness/host: `scripts/device-e2e.ts`, `src/device/macos-pcm16-capture.ts`,
  `src/device/macos-avfoundation-provenance.ts`,
  `src/device/acoustic-tone-analysis.ts`,
  `src/voice/deterministic-pcm-tone-provider.ts`,
  `src/voice/device-pcm-proxy.ts` (startup reservoir/pacing context only).
- Firmware: `firmware/platforms/iterate_m5unified/m5sticks3_direct_audio.cpp`,
  `…/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_direct_i2s_backend.hpp`,
  `…/common/include/iterate/kit/platforms/realtime_playback.hpp` (startup
  path), `firmware/AGENTS.md`, `firmware/docs/connected-device-inventory.md`.
- First-party/prior-art source (line-verified by parallel research agents,
  spot-checked): ESP-IDF v5.4.2 `components/esp_driver_i2s/i2s_common.c` and
  `i2s_std.c`; M5Unified 0.2.19 (vendored copy under
  `firmware/targets/m5sticks3/managed_components/m5stack__m5unified`, verified
  byte-identical to `~/src/github.com/m5stack/M5Unified`); Espressif
  esp_codec_dev / esp-bsp / esp-adf ES8311 drivers and the stackchan
  experiment-02 vendored copy; the ES8311 datasheet Rev 7.0 and User Guide
  Rev 1.11; ffmpeg `libavdevice/avfoundation.m`; Apple AVFoundation/CoreAudio
  documentation (URLs in §5/§11).
- Three prior context documents:
  `audio-streaming-problem-and-evidence-2026-07-30.md`,
  `fable-audio-architecture-alternatives-2026-07-30.md`,
  `fable-audio-review-reconciliation-2026-07-30.md`.

## 2. Source-proven facts (no interpretation)

F1. **Device startup order** (per response generation):
`i2s_new_channel` + `i2s_channel_init_std_mode` (4 descriptors × 320 stereo
frames, 16 kHz Philips 16-bit stereo, `mclk_multiple=128`, MCLK 18 / BCLK 17 /
WS 15 / DOUT 14, DIN unused, `auto_clear_before_cb=true`) →
amplifier **off** → eight ES8311 register writes **while I2S clocks are
stopped** → preload exactly 4 content frames → `i2s_channel_enable()` →
amplifier **on** (M5PM1 @0x6E reg 0x11 bit 3), amp strictly last
(`m5sticks3_direct_audio.cpp:70-99,288-345`;
`esp_idf_direct_i2s_backend.hpp:109-196`).

F2. **The ES8311 ignores the MCLK pin on this board.** The register set
(`0x00=0x80, 0x01=0xB5, 0x02=0x18, 0x0D=0x01, 0x12=0x00, 0x13=0x10, 0x32=0xBF,
0x37=0x08`, `m5sticks3_direct_audio.cpp:319-328`) is byte-identical to
M5Unified's StickS3 speaker-enable sequence
(`m5stack__m5unified/src/M5Unified.cpp:520-529`). `REG01=0xB5` bit 7 selects
**BCLK as the codec clock source** (M5Unified's own comment: `CLOCK_MANAGER/
MCLK=BCLK`), and `REG02=0x18` applies ÷1 × 8 → codec internal master clock =
8 × BCLK = 8 × 32 fs = 4.096 MHz = **256 fs**, satisfying the ES8311's
DAC-clock rule (internal clock : LRCK ≥ 256, integral multiple of 16; User
Guide §8.4–8.5). Consequently `I2S_MCLK_MULTIPLE_128` on GPIO 18 is
electrically present but semantically irrelevant to the codec; there is no
128-vs-256 MCLK mismatch to explain — and a genuinely wrong ratio would
produce _permanent_ silence, not a delayed start.

F3. **The I2S sample clock is exact.** For 16 kHz/16-bit/stereo/128×, IDF
computes MCLK = 160 MHz ÷ 78.125 = 2.048 MHz and BCLK = 512 kHz with a
zero-error fractional divider (`i2s_std.c:38-44`; `hal_utils.c:81-89`;
ESP32-S3 has no APLL option for I2S — `clk_tree_defs.h:300-303`). Residual
error is crystal tolerance (tens of ppm).

F4. **Descriptor math is exact.** `dma_frame_num=320` × 4 bytes/stereo-frame =
1280 bytes = 20.000 ms per descriptor; no rounding or clamping applies below
4092 bytes on S3 (`i2s_common.c:416-451`). `i2s_channel_preload_data` can fill
all four descriptors (5120 bytes; `curr_ptr=desc[3]`, `rw_pos=1280`, queue
empty), and `i2s_channel_enable` starts DMA at `desc[0]` without disturbing
preloaded state (`i2s_common.c:1164-1192,1228-1283`; the TX queue is
deliberately not reset on enable, comment at `i2s_common.c:1212-1213`).

F5. **M5Unified's StickS3 ordering is the reverse of ours and has no
delays:** amp on first (`M5Unified.cpp:533`), then the eight codec registers,
and I2S clocks only start at the first `play()` inside `spk_task`
(`Speaker_Class.cpp:925-927,605`). Sibling boards (StopWatch, ChainCaptain,
PaperColor) insert 5–50 ms settles between rail/codec/PA steps
(`M5Unified.cpp:608,1003,1138`); the StickS3 path has none. M5Unified drives
the codec at 22,050 Hz via hand-written clock registers (256×fs effective,
`Speaker_Class.cpp:382-476`), not at our 16 kHz.

F6. **The StickS3 microphone is the ES8311 ADC on I2S1 sharing MCLK/BCLK/WS
(18/17/15) with the speaker's I2S0, DIN = GPIO 16, both ports configured as
masters, with no arbitration in M5Unified** (`M5Unified.cpp:2215-2226,
2417-2432`). Mic enable writes `REG01=0xBA` (ADC clocks on, DAC clocks off);
mic _disable_ powers the codec down entirely (`0x0D=0xFC, 0x00=0x00`,
`M5Unified.cpp:964-991`). This two-masters-on-shared-pins shape is why the
current firmware deletes the TX channel for capture ownership
(`m5sticks3_direct_audio.cpp:153-157`).

F7. **The tone provider has no envelope.** It renders a constant-amplitude
sine from sample 0 (`deterministic-pcm-tone-provider.ts:41-70`); a 5 s
response is 250 × 320 nonzero samples. No fade-in exists anywhere host-side.

F8. **The recorder used for every retained artifact is ffmpeg's AVFoundation
input** (`macos-pcm16-capture.ts` as of the 20:35/20:40 runs: spawn
`ffmpeg -f avfoundation -i :0 -ac 1 -ar 48000 -f s16le <artifact>`,
stderr-only pipe, direct-to-disk output). Tonight at 21:11–21:17 the working
tree switched the recorder to SoX (`sox -t coreaudio "MacBook Pro Microphone"
-t raw -L -c 1 -r 48000 -b 16 -e signed-integer <artifact>`) and added capture
markers and a live playback-counter policy to `device-e2e.ts`; my confirmation
run (§3, M9–M10) used that new path.

F9. **The analyzer's "inactive windows" and "phase discontinuities" are
coherence-gated, median-baselined measurements against an absolute 997 Hz
reference** (5 ms windows, 2.5 ms hop, active = amplitude ≥128 **and**
coherence ≥0.7; phase steps compared over 5 ms spans against the run's median;
`acoustic-tone-analysis.ts:98-101,480-521,675-707`). `observedStartMs` is the
first stable 2-window active run. Nothing in it can distinguish "device went
quiet" from "recording lost time"; it trusts the file's timeline.

F10. **Apple documents the drop mechanism; ffmpeg's input invites it.**
`AVCaptureAudioDataOutput`: "If the queue is blocked when new samples are
captured, those samples will be automatically dropped when they become
sufficiently late." ffmpeg's `avfoundation.m` capture delegate blocks on a
single-buffer mailbox until `avf_read_packet` consumes the previous buffer,
and the raw `s16le` muxer concatenates payloads with no timestamp gaps — a
dropped buffer becomes an invisible splice. The macOS default HAL I/O buffer
is 512 frames (Apple TN2321), matching the observed 512-sample anomaly
quantization. Microphone modes (Standard / Voice Isolation / Wide Spectrum)
are a feature of the AUVoiceIO voice-processing stack, which an
AVCaptureSession client never opts into — "Standard" mode is therefore _not_
the mechanism (URLs in §5).

F11. **ES8311 power-up duration is undocumented, and the configured register
set cannot ramp.** Neither the datasheet (Rev 7.0) nor the User Guide
(Rev 1.11) gives any millisecond figure for CSM/VMID/reference power-up; the
mainline Linux driver's comment says outright that the delay "is not
documented". Register semantics that matter here: `REG0D=0x01` powers the
analog blocks with `VMIDSEL=01` (normal-speed VMID charge into ~1 µF caps);
`REG37=0x08` sets `DAC_RAMPRATE=0` — **soft-ramp disabled** — so the codec is
incapable of producing a seconds-long volume fade with this configuration.
All Espressif first-party flows start I2S clocks _before_ codec configuration
(the IDF ES8311 example enables channels first; esp-bsp inserts one 20 ms
delay after full reset; esp_codec_dev/ADF drivers contain zero delays);
M5Unified — and this firmware, which copies its register file — writes the
registers clockless and lets the CSM begin when BCLK later appears. Register
contents persist across the clockless period; no re-trigger is required. One
hygiene note: both M5Unified and this firmware write `CSM_ON` (REG00=0x80)
_first_, while the User Guide's own recipe says to set it _last_ (§9.1) —
unorthodox but empirically harmless here (M9).

## 3. Measurements

All numbers reproduced by scripts retained in the job scratch directory
(§11). "Span" = first-to-last stable tone window in file time.

**M1 — Device pacing is wall-true.** The 10 s control run's per-second
detailed metrics (`control-10s-current-order/run.log`) show `completed`
advancing 20 → 70 → 120 → 170 → 220 → 270 → 321 → 371 → 421 → 471 → 500:
**49.92 frames/s over 10.01 s of device time**, zero underruns/overflows,
downlink high-water 2, playback high-water 4, EOS silence descriptors 3. Host
`response.created` → `response.done` spans 9.971 s. Descriptor completion
cadence is therefore 20.03 ms in wall time — DMA carried the full 10.0 s of
content.

**M2 — The span deficit tracks duration at ~20 % in every ffmpeg-based
capture, device or not:**

| capture                   | source                 | expected tone | measured span                 | span/expected               |
| ------------------------- | ---------------------- | ------------- | ----------------------------- | --------------------------- |
| 5x809T (prior run)        | device                 | 5.0 s         | 3.9975 s                      | 0.800                       |
| xQVuWR (the brief's run)  | device                 | 5.0 s         | 3.91 s (analyzer 3.95)        | 0.782                       |
| yIAlXD (10 s control)     | device                 | 10.0 s        | 7.94 s (analyzer 8.00)        | 0.794                       |
| loopback5 (new)           | **Mac speaker**        | 5.0 s         | 3.92 s                        | 0.784                       |
| loopback10 (new)          | **Mac speaker**        | 10.0 s        | 7.895 s                       | 0.790                       |
| avf10 (new, dual)         | **Mac speaker**        | 10.0 s        | 8.325 s                       | 0.833                       |
| rawtap10 (new, dual)      | **Mac speaker**        | 10.0 s        | **10.010 s**                  | **1.001**                   |
| rawtap_device (new)       | device (truncated run) | ~2.1 s        | 1.99 s                        | ≈1.0 (run aborted mid-tone) |
| sox device artifact (new) | device (same event)    | ~2.1 s        | 1.845 s (file ends mid-drain) | clean within window         |

A fixed startup warm-up cannot scale 1.0 s → 2.0 s with response length; a
proportional mechanism upstream of the file can. The Mac-speaker rows remove
the device entirely and reproduce the ratio.

**M3 — The onset is an instant unmute-shaped splice, not a ramp.** In both
device artifacts: 10 %→90 % envelope rise in 1 ms; 997 Hz energy in the
second before onset ≤0.3 amplitude units (−78 dB vs the tone); no pop, no
noise-floor step anywhere earlier (broadband RMS 10–30 across the pre-onset
region). The tone begins mid-waveform at full level. The loopback captures
show the identical shape (2 ms rise, −78 dB before onset).

**M4 — Local pitch is exact; long-window pitch is smeared.** 25 ms windows
track 997.0 Hz throughout all captures; the analyzer's median phase step is
−0.0004 rad/5 ms (−0.012 Hz). But 1 s windows peak at 984–990 Hz with a
secondary blob at ~1008–1014 Hz (spacing ≈ 20 Hz). That pair is the classic
spectrum of a carrier whose phase is periodically stepped — sidebands at the
splice rate (~19–21 events/s), not a real detune. The raw tap of the same
events shows a single clean line at 997.0 Hz.

**M5 — Anomaly positions are quantized to 512 samples @48 kHz (10.67 ms).**
Zero-crossing-interval outliers in the device artifacts recur at spacings that
are integer multiples of ≈10.6–10.7 ms (0.0107/0.0214/0.0315/0.0425/0.0535 s…).
512 samples is the macOS HAL capture buffer, not any device quantum (a device
frame is 960 samples at 48 kHz). The corruption is capture-side by dimension
alone.

**M6 — File time is shorter than wall time in ffmpeg captures.** Raw tap:
768,000 samples in a 16.04 s window (ratio 0.9973 — engine start latency) and
11,520,000 samples in exactly 240.0 s. ffmpeg avf10, same machine, same
minutes: ≈12.43 s of samples across ≈14.9 s of capture wall time (ratio
≈0.83). The harness's ffmpeg captures cannot be anchored more tightly than
±0.3 s from their logs, but the tone-end constraint (audio cannot outlive the
paced content) bounds the 10 s control run's onset delay to ≥1.9 s while its
end aligns with `response.done` within ≈0.2 s — i.e., the file lost ≈2 s that
wall clocks kept.

**M7 — Device-free reproduction (loopback).** With `activeMicrophoneMode =
standard` probed _during_ capture: spans 0.784/0.790 of expected, instant
onsets, −78 dB pre-onset, dominant 987–988 Hz on 1 s windows, ~1,500 (5 s) /
~3,000 (10 s) phase-residual steps >0.1 rad — the full device-artifact
signature with no device in the loop.

**M8 — Dual simultaneous capture separates the paths.** One 10 s tone from
the Mac speaker, two recorders at once:

| metric                              | raw AVAudioEngine tap | ffmpeg AVFoundation |
| ----------------------------------- | --------------------- | ------------------- |
| span/expected                       | **1.001**             | 0.833               |
| fine dominant frequency             | **997.0 Hz**          | 986.9 Hz            |
| positive zero crossings vs 997×span | 9,980 vs 9,980        | 8,351 vs 8,300      |
| phase steps >0.1 rad                | **2**                 | 3,230               |
| p99 abs phase residual              | 0.011 rad             | 1.394 rad           |

Same air, same microphone, same instant. The pipeline, not the room.

**M9 — The device measured raw is clean.** In tonight's live run (§8) the
Stick's tone, seen by the raw tap: onset 210 ms after `response.created`
(proxy reservoir + 4-frame preload + enable + amp accounts for ~150–250 ms by
construction), **997.00 Hz**, 2,012 crossings vs 997×span = 1,984, **2/761**
phase-step hops, end = abort + ~100 ms of ring/DMA drain. This was the _first
response after a fresh flash and boot_ — the worst case for any codec
CSM/VMID power-up theory — and it still bounds every device-side startup
effect at ≈210 ms including host reservoir and 80 ms preload. The device has
no acoustic startup gap at the hundreds-of-milliseconds scale, let alone
1–2 s.

**M10 — The new SoX/CoreAudio recorder measured the same event clean.**
`sox -t coreaudio` artifact (provenance logged by the new harness): 997.00 Hz,
**0/702** phase steps, span limited only by the run abort; capture markers
(`capturedSampleCount`) landed with the 21:17 harness and give sample-domain
anchors for future runs.

**M11 — Why the analyzer said "99 inactive windows / 40 discontinuities".**
Splices leave most 5 ms windows coherent (the analyzer's median-baselined
phase detector only fires when a splice's fractional-period offset is large),
so the artifact shows up as: a shortened span (dominant symptom), a modest
census of low-coherence windows at splice boundaries (99/190), a modest count
of above-threshold phase steps (30–50), and an amplitude coefficient of
variation of ~9 %. My raw census against a fixed 997 Hz reference (no median
rebasing) finds 1,500–3,200 residual steps in the same files — the analyzer's
conservative counting masked the true anomaly rate, which is ≈ one splice per
~48 ms, i.e. ≈20 % of 512-sample buffers dropped.

**M12 — The EOS repair behaves exactly as designed.** Both retained runs show
`endOfStreamMarkersConsumed 1`, `endOfStreamResponses 1`,
`endOfStreamSilenceDescriptors 3` (= `dma_desc_num − 1`, the private
finished-pointer queue depth), zero overflow — and the timing pairs (10 s run:
max EOF→refill 32,982 µs with min reuse lead 27,018 µs; 5 s run: 39,375 µs
with 20,625 µs — each pair summing to exactly 60,000 µs = 3 descriptor
periods) are the signature of a single tight-but-in-budget refill against the
4×20 ms ring, not of any sustained clock skew.

## 4. Hypothesis ledger

Ranked as they stood before the experiments; each with its prediction for the
existing artifact/metrics, the smallest discriminating experiment (with exact
fields), and the outcome.

**H1 — Capture pipeline loses time (CONFIRMED — root cause).**
Predicts: deficit scales with duration; identical signature with any acoustic
source; a wall-clock-honest recorder sees the full tone; device counters clean
throughout. Discriminators: (a) Mac-speaker loopback through the identical
pipeline — fields: `observedSpanMs / expectedDurationMs`, onset rise time,
phase-step census (ran: reproduced, M7); (b) simultaneous second recorder with
no AVCaptureSession — fields: per-recorder span, fine frequency, zero-crossing
census (ran: raw tap clean, ffmpeg corrupt, M8); (c) capture-integrity
invariant `|capturedSampleCount/48000 − (stopWallClock − startWallClock)|`
(ran informally: raw tap ≈0, ffmpeg ≈ −17…−21 %, M6). Mechanism: F10.

**H2 — ES8311/amp startup warm-up or mute (REFUTED at the seconds scale).**
Predicted: constant (duration-independent) missing time; possibly a ramped
onset; possibly low-level tone leakage before onset; a pop at amp-enable
~200 ms after `response.created`. Observed: the deficit doubled with duration
(M2), the onset is instant with zero pre-onset leakage (M3), and — decisive —
the raw-tap measurement of the _first response after a fresh boot_ shows
audible tone 210 ms after `response.created` (M9). Any codec/amp settling on
this board is bounded by ≈150 ms inside that pipeline latency. The codec-side
theory was also structurally weak (F11): the CSM/VMID power-up duration is
undocumented but every documented mechanism that could stretch to seconds
(DAC soft-ramp at rates 5–6 ≈ 1.5–3 s full-scale) is _disabled_ by
`REG37=0x08`, and a ramp would fade in rather than engage at full level.
Smallest further experiment if this ever reopens: timestamp
`configureCodec()` return, `enable()` return, amp-GPIO write return, and
first `on_sent` EOF in the detailed playback metrics, and compare against
raw-capture onset — plus read back `0x37/0x15/0x31/0x32` at fault time to
prove the ramp/mute state.

**H3 — I2S clock-rate error (e.g., 20 kHz playout) (REFUTED).**
Predicted: pitch 1,246 Hz in an honest recording; device consumption at
62.5 frames/s outrunning the host's 50/s pacing → sustained underruns; span
0.8× with the _end_ misaligned. Observed: completion cadence 49.92/s
wall-true with zero underruns (M1), local pitch exactly 997.0 in every
capture (M4), raw-tap pitch 997.00 from the device itself (M9), and IDF's
divider is mathematically exact (F3). Also F2: the codec ignores the MCLK
pin, so the 128× multiple could not have detuned anything, and a genuinely
wrong codec clock ratio produces permanent silence, not a late start.

**H4 — IDF preload/write/descriptor accounting claims content while DMA plays
silence or stale data (EXCLUDED here; real paths exist and deserve pinning).**
The driver source contains five such paths (verified against v5.4.2
`i2s_common.c`): (A) a preload/write that is not a multiple of `buf_size`
leaves `rw_pos` mid-buffer and later bytes land in a descriptor DMA already
passed — `ESP_OK`, no ovf, silent loss (`:1241-1275,1301-1323`); (B)
`auto_clear_before_cb` zeroes a buffer the writer still holds across a full
ring revolution (`:630-632` vs `:656`); (C) the finished-pointer queue
overflow pop happens whether or not `on_send_q_ovf` is registered — silent
descriptor skip if unregistered (`:642-649`); (D) disable→enable without
re-preload replays up to 80 ms of stale audio while writes report timeout
(`:1208-1215` vs `:1177-1181`); (E) a concurrent disable makes a write return
`ESP_OK` short (`:1202,1301`). None applies to this firmware's regime: every
preload/write is an exact 1280-byte multiple with checked results
(`esp_idf_direct_i2s_backend.hpp:145-203`), both callbacks are registered
(`m5sticks3_direct_audio.cpp:52-55,122-129`), and disable is always followed
by delete/create/preload. In the aligned regime the driver's failure mode
_inverts_: it can only insert observable silence, never falsely count content
— so clean counters + clean EOF timing genuinely bound device output, which
the raw tap then confirmed acoustically. Discriminator if ever needed: assert
`bytes_loaded == 5120` after preload and `written == 1280` per frame in a
host regression against the real driver semantics.

**H5 — Host provider/proxy shapes the start (EXCLUDED).**
Predicted: missing or enveloped early frames (provider), or late first sends
(proxy). Observed: the provider renders a constant-amplitude sine from sample
0 (F7) and the brief's run rendered 80,000 nonzero samples; the device
accepted frames at 50/s from `response.created` with downlink high-water 2
and zero partial-prebuffer incidents (M1); `response.done` landed at
+9.971 s. Fields used: `downlinkAccepted` cadence,
`partialPrebufferFramesDropped`, `downlink_high_water`, host
`response.created/done` log timestamps.

**H6 — Destructive-reset thrash / fortress policies eating the start
(EXCLUDED for these runs; REAL as a separate defect).**
Predicted (if cause): nonzero `generationFramesFlushed` / `underrunIncidents`
/ `driverQueueOverflowIncidents` / reconnects during the run. Observed: all
zero in both retained runs — the fortress was quiescent while the "loss" was
recorded. Separately, my own run demonstrated the blast radius when a real
single event does occur (§8).

Independent short gaps / phase discontinuities: same ledger, same outcome —
H1 explains their count, size distribution, 512-sample quantization (M5), and
their reproduction without the device (M7). No device-side hypothesis
survives the dual-capture experiment (M8).

## 5. The capture defect, precisely (deliverable 6)

**Chain:** MacBook mic → CoreAudio HAL (512-frame buffers, Apple TN2321) →
`AVCaptureSession`/`AVCaptureAudioDataOutput` → ffmpeg `avfoundation.m`
single-slot blocking mailbox → raw `s16le` concatenating muxer → artifact.
Apple documents that `AVCaptureAudioDataOutput` **drops late samples when the
delegate queue is blocked**; ffmpeg's delegate blocks by design until the
demux loop consumes the previous buffer; the raw muxer preserves no timestamp
gaps. On this host that combination loses ~17–21 % of buffers under ordinary
load (it did so even with only ffmpeg + one Swift process running, M8), and
the loss rate is signal-independent — the tone merely makes it measurable.

- Not the microphone _mode_: mic modes are an AUVoiceIO-stack feature that an
  AVCaptureSession client never opts into; "Standard" is the no-extra-DSP
  setting, and no documented or community-reported behavior mutes the first
  seconds of a capture and then opens at full level. (Apple WWDC21 10047,
  WWDC23 10235; `AVCaptureDevice.microphoneMode` docs;
  `setSampleBufferDelegate(_:queue:)` docs; TN2321; ffmpeg
  `libavdevice/avfoundation.m`.) Wide Spectrum remains the right acceptance
  posture — the built-in mic has always-on driver-level array processing that
  WS minimizes — but switching modes would **not** have fixed this defect,
  and Standard mode did not cause it.
- Why it looked like _startup_ loss: the analyzer anchors `missingToneMs` to
  `expectedDurationMs` and the runner's tail anchors the end, so uniform
  compression presents as a late start. The 0.5 s tail argument in the brief
  was correct reasoning applied to a corrupted timeline.
- **How to test any capture chain without trusting ears** (all three now
  demonstrated):
  1. _Wall-vs-sample invariant_: record `performance.now()` at recorder start
     and stop and assert
     `|capturedSampleCount / sampleRateHz − wallSeconds| ≤ 0.1 s + 1 %`.
     Fails at −1.3 s to −2.5 s on every ffmpeg artifact examined; passes at
     ≈0 on SoX and the raw tap. Zero extra hardware; it would have failed the
     very first 60 s run (NaZWLD) loudly.
  2. _Loopback control fixture_: before (or after) a device run, `afplay` a
     generated N-second 997 Hz wav through the Mac speaker while the harness
     recorder runs; require span/expected ≥ 0.99, phase-discontinuity count ≤
     a small constant, fine frequency 997 ± 0.5 Hz. Proves the whole
     recorder-analyzer chain per run, in ~N+2 s, with no device.
  3. _Dual-capture differential_ (diagnostic, not per-run): run a second
     independent recorder (AVAudioEngine tap; ~30 lines of Swift, §11) on the
     same event and diff span/frequency/phase censuses.

## 6. Codec / amplifier / clock startup ordering (deliverable 4)

What is documented, and how shipped first-party code behaves:

- **Everest documents no power-up duration.** The ES8311 datasheet and User
  Guide specify the _mechanisms_ (CSM state machine gated on REG00 bit 7;
  VMID charge speed selection in REG0D[1:0]; DAC soft-ramp rates in
  REG37[7:4] from 95 ms to ~26 min full-scale at 16 kHz) but no settle
  times; the mainline Linux driver literally comments that the reset delay is
  undocumented and borrows 5 ms from the es8316. The only delay in any
  first-party driver is esp-bsp's 20 ms after full reset (F11).
- **Espressif flows order clocks first** (I2S channels enabled before codec
  init in the IDF ES8311 example and the BSPs); **M5Unified StickS3 orders
  amp → codec-registers-clockless → clocks-at-first-play with no delays**
  (F5); **this firmware orders codec-clockless → preload → enable → amp
  last** (F1), with the in-source rationale that codec transients and
  uninitialized RAM must never reach the speaker
  (`esp_idf_direct_i2s_backend.hpp:128-135,174-196`). Ours is the strictest
  pop-containment ordering of the three, and it is empirically sound: first
  audible sample ≈210 ms after `response.created` on the first response after
  a fresh boot (M9).
- **Semantically important, keep:** amp strictly after enable;
  preload-before-enable; `auto_clear_before_cb`; writing the codec while
  clocks are stopped is fine (registers persist; the CSM starts when BCLK
  appears — F11) and matches the board vendor's own practice.
  **Semantically unimportant:** the MCLK multiple (the codec clocks from
  BCLK, F2). **Minor hygiene, optional:** the copied register file sets
  `CSM_ON` first where the User Guide's recipe sets it last (F11) — no
  observed consequence; if the register file is ever rebuilt (e.g., for the
  duplex substrate), follow the esp_codec_dev order (clock manager → SDP →
  power → CSM) rather than cargo-culting M5Unified's.
- **Board caution for any create-once design:** M5Unified's mic-disable path
  powers the codec CSM fully down (`0x00=0x00`) and mic/speaker enables write
  conflicting `REG01` values (`0xBA` vs `0xB5`) — a create-once duplex owner
  must own one merged codec state (both ADC and DAC clock chains enabled)
  rather than letting those two register files alternate (F6).
- **Warm-up:** nothing on this board takes seconds. No warm-up compensation,
  pre-roll, or added prebuffer is warranted, and none should be added on the
  strength of ffmpeg-era artifacts.

## 7. Can counters claim content while DMA carries silence? (deliverable 5)

Yes in general — five concrete IDF v5.4.2 paths (H4, A–E) — and no for this
firmware as written, because every one of them requires an entry condition the
current code cannot reach (unaligned writes, unchecked preload results,
unregistered `on_send_q_ovf`, or enable-after-disable without preload). Two
cheap pins make that lastingly true rather than incidentally true:

- a host regression asserting the aligned-write invariant (every
  preload/write a multiple of 1280 with checked `bytes_loaded`/`written`) so
  a refactor cannot regress into paths A/E silently;
- keep `on_send_q_ovf` registration mandatory in the ops contract (it already
  is — `createAndConfigure` rejects a null overflow callback,
  `m5sticks3_direct_audio.cpp:52-55`), and keep the overflow counter in the
  zero-required set.

With those held, the driver can only ever _insert observable silence_, never
fabricate content — which is exactly the property that let the counter
evidence survive tonight's acoustic contradiction and be vindicated by M9.

## 8. Is create/delete-per-response responsible? (deliverable 7)

**For the investigated acoustic loss: no.** The loss reproduces with no
device attached (M7), and the device's own create→configure→preload→enable→
amp sequence delivers audible output 210 ms after `response.created` on the
worst-case first post-boot response (M9). The per-response lifecycle costs
latency in the low hundreds of milliseconds and carries fragility, but it
does not eat seconds of audio.

**For run fragility: yes, and it reproduced live.** My confirmation run
aborted at ≈2.1 s when exactly one downlink frame arrived late (host briefly
loaded): `playback_underrun_incidents 1`, `playback_underrun_frames_flushed
1`, `playback_dma_deadline_miss_incidents 1`,
`playback_driver_queue_overflow_incidents 1` — one 20-ms-class event —
whereupon the (new tonight) zero-delta live counter policy classified the run
dead and the generation was destroyed. A single late frame should be a
bounded silence incident with a counter, not a terminal event; this is
precisely the already-accepted migration direction in the reconciliation
ledger ("treat an ordinary playback underrun as a bounded
silence/resynchronisation incident"), and my run's
`playback_counter_policy_failure` JSON is a ready-made fixture for its red
test. Acceptance-policy implication: `underrun_incidents` and
`dma_deadline_miss_incidents` deltas belong in a _budgeted-nonzero_ class for
endurance runs (paired with silence-frame accounting), while
`driver_failures`, `invalid_frames`, and `state_errors` stay zero-required.

**Simplest create-once alternative that preserves half-duplex microphone pin
ownership:** the reconciliation ledger has already accepted it — one
full-duplex `i2s_std` TX+RX pair on I2S0 created at boot (DIN = GPIO 16, the
pin M5Unified's mic uses), codec programmed once for ADC+DAC (merge the
`0xB5`/`0xBA` clock words into one that leaves both ADC and DAC clock chains
on), PTT as a policy bit, amp GPIO as the only per-session hardware action.
That removes the _reason_ the pin handoff exists: the conflict is not in the
silicon (one codec, one bus) but in M5Unified's two-independent-masters model
(F6). This investigation adds one requirement to that plan — the merged
codec state must also own the mic-disable transition, because M5Unified's
`Mic.end()` register file powers the codec down (F6) — and removes one
motivation that was never real: create-once is **not** needed to fix startup
audio loss, because there isn't any. Do not read this report as new urgency
for the substrate migration; its justification (latency, fragility, AEC
reference, mailbox deletion) is unchanged from the alternatives review.

## 9. Keep / simplify / delete / defer

| Item                                                                                                     | Disposition                              | Why                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Device playback counters + detailed metrics serializer                                                   | **Keep**                                 | They were right when the room recording was wrong; M1/M12 show they bound real output. Add the four startup timestamps from H2 only if a raw-capture run ever contradicts them.                                                      |
| Acoustic-oracle requirement (independent mic proof)                                                      | **Keep**                                 | The concept caught nothing false — the _instrument_ was broken, and the requirement is why we know.                                                                                                                                  |
| SoX/CoreAudio recorder (landed 21:11)                                                                    | **Keep**                                 | Validated tonight against a raw tap on a live device run (M9/M10).                                                                                                                                                                   |
| Capture provenance logging incl. mic mode + sample-count markers (landed 21:17)                          | **Keep**                                 | Right discipline; markers give sample-domain anchors for the integrity invariant.                                                                                                                                                    |
| ffmpeg-AVFoundation as the recorder                                                                      | **Delete** (already replaced)            | F10, M6–M8. Keep ffmpeg only for device _listing_ if convenient.                                                                                                                                                                     |
| "Missing startup audio" as a device defect; any codec warm-up compensation, pre-roll, or added prebuffer | **Delete**                               | M2/M3/M9. The brief's instinct not to blame the EOS repair was right; extend it: don't blame the device at all.                                                                                                                      |
| Analyzer (`acoustic-tone-analysis.ts`)                                                                   | **Simplify/extend, don't rewrite**       | Add recorder start/stop wall clocks as inputs and emit the wall-vs-sample verdict; report a raw fixed-reference phase-step census alongside the median-baselined one (M11) so instrument damage is legible, not just span shortfall. |
| Mic-mode gate (require Wide Spectrum)                                                                    | **Simplify**                             | Keep WS as acceptance posture, but the _binding_ gate should be the capture-integrity pair: wall-vs-sample invariant + loopback control fixture (§5). Mode alone neither caused nor would have fixed this.                           |
| Zero-delta live counter policy for `underrun`/`dma_deadline` (landed 21:17)                              | **Simplify**                             | Reclassify those two as budgeted-nonzero with silence accounting per §8; keep zero-required for driver failures/state errors/invalid frames.                                                                                         |
| Create-once duplex substrate (§6.1 of the alternatives review)                                           | **Defer to its existing plan**           | Unchanged justification; one added requirement (own the merged codec state incl. mic-disable, F6); no new urgency from this defect.                                                                                                  |
| 5/10/20 s duration-scaling ladder, ×3 each, SoX-recorded                                                 | **Defer until after red tests 1–2 land** | Closes the statistics; expected result: span error <200 ms at every duration.                                                                                                                                                        |

## 10. Red-test-first sequence

1. **RED — capture integrity invariant.** Harness records recorder start/stop
   wall clocks and asserts `|samples/rate − wall| ≤ max(0.1 s, 1 %)`.
   Demonstrated failing data for the ffmpeg path (−1.3 s at 5 s scale,
   −2.5 s at 10 s); passes for SoX (the preserved 241,664-byte artifact
   matches its wall window) and the raw tap (768,000 samples in 16.04 s).
   This is the regression that memorializes tonight's root cause.
2. **RED — loopback control fixture.** New harness mode: play a generated
   997 Hz wav through the Mac speaker, capture with the production recorder,
   run the production analyzer; require span ≥ 0.99×, fine frequency
   997 ± 0.5 Hz, phase-discontinuity count ≤ 5. Fails with ffmpeg
   (0.78–0.83×, M7/M8), passes with SoX. Run it before every acceptance
   session so instrument health is proven per-run, not per-epoch.
3. **GREEN — re-run the 5 s and 10 s tone proofs with the SoX recorder.**
   Expected: `observedSpanMs` within 200 ms of expected, `gapCount` 0,
   `phaseDiscontinuityCount` ≤ 5, device counters clean as before —
   converting both retained "failures" into passes and closing the
   investigated defect.
4. **RED — one-late-frame ride-through** (separate, already-accepted
   direction): host regression in which exactly one downlink frame arrives
   ~25 ms late and the expected outcome is one `underrun_incident`, bounded
   silence, _continuing_ playback, and a passing run; today's policy fails it
   by destroying the generation (my run's `playback_counter_policy_failure`
   JSON is the fixture). Land it with the budgeted-nonzero acceptance change
   (§8), not as buffer growth.
5. **Duration-scaling ladder** (5/10/20 s ×3, SoX + control fixture) to
   confirm span error is flat in duration, then proceed to the evidence doc's
   1/2/10-minute endurance ladder unchanged.

## 11. Artifact and tooling provenance

New artifacts (outside the working tree; job scratch
`/Users/jonastemplestein/.claude/jobs/86b7af89/tmp/`):

| artifact                | bytes      | SHA-256                                                            | content                                                                           |
| ----------------------- | ---------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `loopback5.pcm16le`     | 728,064    | `15d67ac921d0602b3aaad86b00828edfe6ea65431f8e00afa28a0931bf6b8883` | ffmpeg-avf capture, Mac speaker 5 s tone                                          |
| `loopback10.pcm16le`    | 1,118,208  | `f1ce93601dc78badfcd4fb51be2225608612557e781b652fc5b037734cbfc4ca` | ffmpeg-avf capture, Mac speaker 10 s tone                                         |
| `avf10.pcm16le`         | 1,192,960  | `b225fcfa10cf01c70d918a932c7c923490f19b37c9ab11c6e95f4a6666968c12` | ffmpeg-avf half of dual capture                                                   |
| `rawtap10.pcm16le`      | 1,536,000  | `a0628bbf5a3432405ba2d4ae6fec616c4a3126a8719b010e297a4aff19475e7e` | raw-tap half of dual capture (768,000 frames = 16.0000 s)                         |
| `rawtap_device.pcm16le` | 23,040,000 | `97bb5beba12162a2f3d85f134f98bccaa70cce90e05ff27c43a5b047eb3c8873` | 240.0 s raw tap spanning the live device run                                      |
| sox device artifact     | 241,664    | `fa8dfe53554227d18a515fceeb5ce1598104d0dea01d21ccccf25b41bacc039d` | harness-preserved `/var/folders/…/iterate-kit-acoustic-4WzQr0/microphone.pcm16le` |

Verified inputs: `iterate-kit-acoustic-xQVuWR/microphone.pcm16le` matches the
brief's SHA-256 (`81404dbf…c53e94`, 752,640 bytes). The live device run used
`doppler run -- pnpm device:e2e -- --port /dev/cu.usbmodem11201
--build-directory firmware/targets/m5sticks3/build --tone-playback-only
--tone-duration-ms 10000 --mount-timeout-ms 120000` against the board
resolved by stable USB serial `70:04:1D:D5:45:88` per
`firmware/docs/connected-device-inventory.md` (port unclaimed by any process
beforehand), reflashing the already-current build; its timestamped log is
`device_run2.log` in the same scratch directory, alongside the analysis
scripts (`analyze_capture.py`, `analyze2.py`, `analyze3.py`,
`analyze_device_tap.py`, `loopback_experiment.sh`, `raw_tap_capture.swift`).
Microphone mode during all new captures: `standard` (probed via
`AVCaptureDevice.activeMicrophoneMode` mid-capture).

Key external references: Apple `AVCaptureAudioDataOutput.setSampleBufferDelegate`
documentation (drop-when-late semantics); Apple TN2321 (512-frame default HAL
I/O buffer); WWDC21 session 10047 and WWDC23 session 10235 (microphone modes
are AUVoiceIO features; Wide Spectrum "minimizes processing… still includes
echo cancellation"); ffmpeg `libavdevice/avfoundation.m` (single-buffer
blocking delegate mailbox); ES8311 datasheet Rev 7.0
(`dl.espressif.com/dl/schematics/Audio_ES8311.pdf`) and User Guide Rev 1.11
(Waveshare mirror) — no power-up duration specified; mainline Linux
`sound/soc/codecs/es8311.c` ("Specific delay is not documented"); esp-bsp
`components/es8311` (20 ms post-reset delay; clocks-before-config);
esp_codec_dev/esp-adf `es8311.c` (zero-delay start sequence, PA before
unmute); ESP-IDF v5.4.2 `components/esp_driver_i2s/` (citations inline in
§2/§7); M5Unified 0.2.19 vendored source (citations in §2/§6/§8).

## 12. What would falsify this report

Run the 10 s tone with the SoX recorder plus the loopback control fixture
green, and find `observedSpanMs` short by more than 200 ms, or more than a
handful of phase discontinuities, while device counters stay clean. That
outcome would reopen the device-side ledger at H2 with the four startup
timestamps named there (codec-config return, enable return, amp-GPIO return,
first EOF) as the next discriminating instrumentation, plus a fault-time
read-back of ES8311 registers `0x31/0x32/0x37/0x15`. Nothing observed tonight
predicts it.
