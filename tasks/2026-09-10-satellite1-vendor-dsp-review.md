# Satellite1 vendor XMOS DSP review

Reviewed 2026-09-10 against the primary source checkout
`/Users/jonastemplestein/src/github.com/FutureProofHomes/Satellite1-XMOS`.

The installed board is reported as vendor release **v1.0.3**, commit
`a2fe0aff72ee2bf57a944ea9bd2cd16e0b544cbe` (2025-08-06), and was not
reflashed. The vendor checkout's current `develop` is
`5be99cc7d4f7ecce8c02c951b008989b6cd79358` / `v1.0.4-alpha.8`.
Consequently, v1.0.3 is the hardware truth; current vendor source is only a
source of possible changes.

## Decision

Keep the current Iterate Satellite1 audio shape for the release blocker:

- 48 kHz, stereo, 32-bit I2S TX remains continuously clocked on GPIO9 as the
  XMOS AEC reference.
- Receive slot 1 remains the `AEC + IC + NS` plane, with the measured fixed
  gain of 32 applied before Q31-to-PCM16 quantisation.
- The speaker remains capped at 60 (TAS DVC 80 / -40 dB).
- Do not add an arbitrary static reference or microphone delay, alter the
  chosen slot, enable host-side wake gating, or reflash XMOS based on this
  review.

This preserves the latest long-AEC result (59.48 s with zero self-barge) and
the physical-barge PASS while keeping speech-end to first actual board audio
as the governing latency measure.

## What the vendor firmware actually does

### Reference path and delay: already adopted; no hidden calibration to copy

The Satellite target builds its normal pipeline at 48 kHz I2S and calls the
pipeline `fixed_delay` ([`satellite1.cmake:5-20`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/satellite1.cmake#L5-L20)).
That name is misleading in this release: the configured delay is **zero**
milliseconds ([`app_conf.h:35-39`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/src/app_conf.h#L35-L39)), so the static-delay stage does nothing when the compile-time value is zero
([`fixed_delay/audio_pipeline_t1.c:65-108`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/audio_pipelines/reference/fixed_delay/audio_pipeline_t1.c#L65-L108)).

Its useful design is that the XMOS preserves the *actual transmitted* stereo
speaker samples as the AEC reference: it writes the two I2S samples to the DAC,
FIR-downsamples that same frame from 48 kHz to 16 kHz, then places it on the
reference queue ([`main.c:76-115`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/src/main.c#L76-L115)). The microphone side takes that queue and the next PDM microphone frame together
([`main.c:123-168`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/src/main.c#L123-L168)). The fixed-delay AEC consumes that paired reference/mic data ([`fixed_delay/audio_pipeline_t1.c:110-129`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/audio_pipelines/reference/fixed_delay/audio_pipeline_t1.c#L110-L129)).

Iterate already preserves the important external contract. Satellite1 is a
48 kHz stereo slave I2S endpoint, with GPIO9 as TX/AEC reference
([`satellite1_device.c:159-180`](../apps/kit/firmware/devices/satellite1/satellite1_device.c#L159-L180)). Its TX ring is preloaded with silence before enable so the XMOS never sees uninitialised reference samples
([`i2s_codec.c:508-530`](../apps/kit/firmware/platforms/iterate_esp_idf/components/board/i2s_codec.c#L508-L530)); it is then fully primed and continuously zero-filled while idle so the reference never stops
([`i2s_codec.c:246-359`](../apps/kit/firmware/platforms/iterate_esp_idf/components/board/i2s_codec.c#L246-L359)).

**Classification:** adopted. A static-delay change is unproven and not a
release candidate without a measured offset. The
vendor supports delaying microphone for positive values and reference for
negative values, but that is a tuning mechanism, not a board constant
([`fixed_delay/audio_pipeline_dsp.h:82-93`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/audio_pipelines/reference/fixed_delay/audio_pipeline_dsp.h#L82-L93)).

### DSP plane: selected correctly; AGC is intentionally excluded

The vendor emits two 48 kHz channels: channel 0 is `AEC+IC+NS+AGC`, while
channel 1 is `AEC+IC+NS`; the latter is stored from pipeline index 3
([`main.c:180-221`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/src/main.c#L180-L221)). Iterate explicitly maps slot 1 and documents the matching v1.0.3 interpretation
([`satellite1_device.c:175-179`](../apps/kit/firmware/devices/satellite1/satellite1_device.c#L175-L179)).

The vendor's AGC is an ASR profile whose metadata includes VNR, AEC reference
power, and AEC correlation ([`fixed_delay/audio_pipeline_t0.c:118-146`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/audio_pipelines/reference/fixed_delay/audio_pipeline_t0.c#L118-L146)); IC runs before NS, and NS output is separately retained
([`fixed_delay/audio_pipeline_t0.c:75-115`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/audio_pipelines/reference/fixed_delay/audio_pipeline_t0.c#L75-L115)). Therefore channel 0 is not a benign level-adjusted version of channel 1. It may alter VAD, onset timing, double-talk, and residual-echo behaviour. Iterate's memoryless fixed gain before PCM16 conversion is a deliberately different, latency-safe calibration
([`pcm_format.c:171-196`](../apps/kit/firmware/components/audio/src/pcm_format.c#L171-L196)).

**Classification:** adopted for AEC/IC/NS; slot 0 AGC/VNR is an unproven
alternative. Do not switch to it as a loudness fix; compare it only in a
controlled long-AEC and physical-barge bench.

### Frame and buffering: a bounded latency experiment, not a release change

The XMOS DSP operates on 240 samples at 16 kHz: 15 ms
([`SATELLITE1.cmake:54-60`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/bsp_config/SATELLITE1/SATELLITE1.cmake#L54-L60), [`app_conf.h:24-33`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/src/app_conf.h#L24-L33)). The vendor starts I2S with roughly 2.2 input frames and 1.2 output frames of buffering
([`platform_start.c:76-89`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/bsp_config/SATELLITE1/platform/platform_start.c#L76-L89)). Iterate feeds its common voice path in 320-sample / 20 ms frames and Satellite1 uses a 480-sample x 6 descriptor 48 kHz ring (60 ms)
([`i2s_codec.c:18-22`](../apps/kit/firmware/platforms/iterate_esp_idf/components/board/i2s_codec.c#L18-L22), [`satellite1_device.c:161-179`](../apps/kit/firmware/devices/satellite1/satellite1_device.c#L161-L179)).

The raw frame-period difference is 5 ms; scheduler and phase behaviour prevent
this source review from bounding an end-to-end benefit. A 15 ms board-only frame would require
careful compatibility work through the shared voice source and might increase
DMA wakeups or disrupt reference continuity.

**Classification:** worthwhile only as a separate, reversible bench branch
after release-quality self-barge is retained.

### Warm-up, reset, and wake word

The vendor drains stale microphone frames once at startup before accepting its
first complete frame ([`main.c:131-145`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/src/main.c#L131-L145)). Iterate achieves the same operational objective with explicitly classified warm-up overwrites, complete silence preload, and full TX-ring priming
([`i2s_codec.c:28-36`](../apps/kit/firmware/platforms/iterate_esp_idf/components/board/i2s_codec.c#L28-L36), [`i2s_codec.c:450-490`](../apps/kit/firmware/platforms/iterate_esp_idf/components/board/i2s_codec.c#L450-L490), [`i2s_codec.c:508-530`](../apps/kit/firmware/platforms/iterate_esp_idf/components/board/i2s_codec.c#L508-L530)).

The vendor source does not expose an XMOS VNR/wake signal to ESP32; VNR merely
feeds XMOS AGC metadata ([`fixed_delay/audio_pipeline_t0.c:85-91`](https://github.com/FutureProofHomes/Satellite1-XMOS/blob/v1.0.3/satellite-xmos-firmware/audio_pipelines/reference/fixed_delay/audio_pipeline_t0.c#L85-L91)). It offers no vendor-side wake trick to steal. Iterate feeds its own wake detector from the already-selected processed capture plane
([`i2s_codec.c:215-243`](../apps/kit/firmware/platforms/iterate_esp_idf/components/board/i2s_codec.c#L215-L243)).

**Classification:** warm-up/reference-continuity adopted; vendor VNR/wake is
not an available board control surface.

## v1.0.3 versus vendor current

The fixed-delay and speaker-pipeline source directories have no diff from
v1.0.3 to current `develop`. The relevant current-tree changes are removal of
USB audio/control variants and watchdog/debug adjustments, not changes to AEC,
IC, NS, AGC, reference routing, or Satellite1 DSP latency. The direct diff is
`a2fe0aff72ee2bf57a944ea9bd2cd16e0b544cbe..5be99cc7d4f7ecce8c02c951b008989b6cd79358`;
the vendor source at the v1.0.3 tag is pinned above; the comparison was made
locally with `git diff --name-only` on that commit range.

There is therefore no upstream DSP patch to adopt or reason to reflash a board
that reports v1.0.3.

## If residual self-barge returns: one bounded bench

1. Keep the existing v1.0.3 board firmware, slot 1, gain 32, DVC 80, and
   continuous reference as the control. Capture the normal long-AEC and
   physical-barge runs, recording ERLE/echo telemetry, self-barge count, and
   speech-end to first actual board audio.
2. Produce a single impulse/correlation trace between the known GPIO9 TX
   waveform and the returned slot-1 capture. If it shows a stable, material
   offset, test only the corresponding signed fixed-delay value in a separate
   vendor-XMOS build/board. Sweep a small range around that measured value;
   never guess a delay.
3. Accept a setting only if it preserves zero self-barge across the long AEC
   run and physical barge PASS, improves residual echo, and does not worsen the
   primary latency metric. Otherwise retain zero delay.
4. Only after that passes, test a Satellite1-only 15 ms host framing branch
   against the same controls. Reject it for any TX underrun/reference
   discontinuity, wake regression, self-barge, or latency non-improvement.

No firmware, deployment, hardware, or source change was made by this review.
