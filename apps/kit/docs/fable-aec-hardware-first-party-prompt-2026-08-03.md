# Fable review: board audio paths and first-party AEC guidance

Act as an independent, max-effort embedded-audio reviewer. This is a bounded,
read-mostly research task. Do not flash, reset, open serial ports, stop live
processes, modify firmware, or touch attached hardware. You may create exactly
one durable output file:

`apps/kit/docs/fable-aec-hardware-first-party-review-2026-08-03.md`

## Objective

Find the shortest technically sound route to the best practical on-device AEC
on both M5Stack CoreS3/StackChan and Home Assistant Voice Preview Edition,
while retaining one shared realtime audio core. Prefer first-party source,
datasheets, ESP-IDF/ESP-SR examples, codec drivers, and measured local prior
art over folklore. Browse official primary sources when the local checkout is
insufficient, and link them in the report.

## Local material to inspect deeply

- `apps/kit/firmware/components/core/`
- `apps/kit/firmware/platforms/iterate_core_s3_audio/`
- `apps/kit/firmware/platforms/iterate_havpe/` (or the actual HAVPE platform
  path found in the tree)
- `apps/kit/firmware/targets/stackchan/`
- `apps/kit/firmware/targets/home_assistant_voice_pe/` (or its actual target)
- `apps/kit/firmware/targets/stackchan/managed_components/espressif__esp-sr/`
- `apps/kit/scripts/prove-production-aec-waveform.ts`
- `apps/kit/src/device/stackchan-aec-assessment.ts`
- `apps/kit/docs/voice-device-adventures-2026-08-02.md`
- `/Users/jonastemplestein/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec/`
- the installed ESP-IDF tree under `/Users/jonastemplestein/esp/esp-idf/`
- checked-out M5Stack and Home Assistant codec/board drivers elsewhere under
  `/Users/jonastemplestein/src/` when relevant

## Known evidence that must be explained, not hand-waved

- StackChan uses synchronized TDM slot 0 as the near microphone and slot 1 as
  an electrical speaker-divider reference. ESP-SR `aec_linear_process()` then
  `aec_nlp_process()` runs on exact 512-sample / 32 ms frames.
- Current mode is `AEC_MODE_FD_HIGH_PERF`, filter length 4, NLP aggressive,
  microphone PGA 24 dB, speaker volume 100, reference PGA 18 dB.
- A newly instrumented physical run measured stage means approximately:
  - far tone: near 4957, reference 1014, linear 197, final 183
  - far PRBS: near 3513, reference 872, linear 3268, final 3174
  - speech: near 7109, reference 711, linear 1267, final 1174
    Thus NLP is adding little; the linear stage cancels a tone well but fails on
    broadband PRBS and only partly cancels speech. Speech also clips at 32768.
- Raising electrical-reference PGA did not materially fix cancellation.
- Older very-aggressive NLP could make a tone look quiet but destroyed nearby
  speech/double-talk; that is not acceptable.
- Audio must remain top priority, bounded, allocation-free in steady state,
  and must not accumulate stale frames. Returned PCM must play ASAP; captured
  PCM must send ASAP. Metrics cannot perturb that path.
- Required acceptance: far-only residual near empty, double-talk preserves the
  nearby source, no delay accumulation, and measured evidence on both boards.

## Questions to answer

1. Draw the actual end-to-end analog/digital signal path on each board: codec,
   ADC/DAC/I2S/TDM routing, sample clocks, gains, reference source, polarity,
   likely group delay, and any hardware mixer/DSP behavior.
2. Is the current reference semantically the correct signal for Espressif's
   AEC? If not, identify the best reference and the smallest clean change.
3. Compare `AEC_MODE_FD_*`, `AEC_MODE_VOIP_*`, ESP AFE `AFE_TYPE_VC`, and other
   first-party choices. State which is intended for full-duplex voice and what
   each wrapper additionally handles (delay, VAD, reference activity,
   nonlinear processing, etc.). Cite source/docs.
4. Identify concrete clock, channel, endian, polarity, gain, saturation,
   sample-format, or fixed-delay mistakes that can produce excellent tonal
   cancellation but terrible broadband cancellation.
5. Determine whether either board has first-party reference/AEC support we are
   bypassing, and whether using it would simplify the shared architecture.
6. Give a ranked sequence of low-risk physical experiments. Each experiment
   must discriminate between hypotheses, name exact measurements, and have a
   stop/rollback criterion.
7. Give explicit CPU, internal-RAM, PSRAM, frame-size, and latency implications
   wherever evidence permits. Do not invent precision unavailable from source.

## Report shape

Separate proven facts, strong inferences, and hypotheses. Include exact local
paths/lines or symbols and primary-source links. Rank recommendations by
expected impact divided by implementation risk. Call out deletions and
simplifications, not only additions. End with a concrete first three changes
and the exact evidence that would justify keeping each one.
