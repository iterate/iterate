# Fable Max review: StackChan reference calibration and simplest robust AEC

You are an independent Claude Fable Max reviewer working in:

`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`

Do not edit production code. You may write exactly one deliverable:

`apps/kit/docs/fable-stackchan-reference-calibration-review-2026-08-03.md`

The immediate goal is a production-shaped, full-duplex StackChan voice path
whose on-device AEC suppresses speaker-only audio while preserving nearby
speech during double talk. The transport is already frame-exact and
network-valid. Do not broaden this into a redesign of Iterate's transport or
capability system.

Please independently inspect all of the following, including their relevant
git history/diffs and first-party dependencies:

- `apps/kit/firmware/platforms/iterate_core_s3_audio/`
- `apps/kit/firmware/platforms/iterate_esp_idf/idf_overrides/espressif__m5stack_core_s3/`
- `apps/kit/firmware/targets/stackchan/`
- `apps/kit/src/device/firmware-architecture.test.ts`
- `apps/kit/docs/fable-stackchan-aec-signal-review-2026-08-01.md`
- `apps/kit/docs/voice-device-adventures-2026-08-02.md`
- `apps/kit/evidence/stackchan-production-aec-waveform/2026-08-03T05-25-53-664Z/`
- `apps/kit/evidence/stackchan-production-aec-waveform/2026-08-03T05-41-26-716Z/`
- `/Users/jonastemplestein/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec/`
- `/Users/jonastemplestein/esp/esp-idf/examples/peripherals/i2s/i2s_codec/i2s_es7210_tdm/`
- the vendored `esp_codec_dev` ES7210 source and ESP-SR headers/libraries used
  by the StackChan target

Known evidence you must reconcile rather than merely repeat:

- TDM slot 0 is the near microphone and slot 1 is a synchronous electrical
  speaker reference by physical interval telemetry. Slot 2 is another acoustic
  microphone and slot 3 is dead.
- The physical ES7210 input identity behind slot 1 was never proven. Existing
  prose calls it MIC3, but first-party TDM ordering and the selected
  MIC1|MIC2|MIC3 set make that claim suspect.
- With reference PGA at its prior setting, AGGR NLP had poor broadband
  far-only suppression. VERYAGGR suppressed far-only audio but also destroyed
  moderate double-talk speech.
- A trial setting `reference_gain_db = 18` was applied only to codec mask 2.
  The next network-valid run raised slot-1 reference amplitude by only about
  7--8 dB and still failed badly on PRBS, speech, and double talk.
- The current code uses ESP-SR's standalone full-duplex high-performance AEC:
  one 512-sample linear call followed by one NLP call, filter length 4.

Answer, with file/line and first-party source citations where possible:

1. What is the actual ES7210 physical-input-to-TDM-slot order for this selected
   three-input configuration? Distinguish code/doc proof from inference and
   measurement.
2. Is applying the same reference PGA to both non-near selected ES7210 inputs a
   safe short-term way to calibrate measured slot 1, or is there a cleaner
   minimal method?
3. What single discriminating measurement should run next, and what numeric
   result would falsify the proposed fix?
4. Why does the current linear+NLP path appear unstable on broadband/double
   talk? Rank reference scale, polarity, delay/phase, filter length, adaptation
   mode, and NLP policy using the evidence.
5. Propose at least three materially different routes, including the smallest
   patch, a software-playback-reference route, and an Espressif first-party
   AFE/capture route. State time-to-working-proof, RAM/CPU implications, and
   failure risks.
6. Identify deletions or simplifications that reduce time-to-goal. Explicitly
   call out any local maximum in the current architecture.

Keep the report bounded and decision-oriented. End with a short recommended
next sequence of at most five actions. Write the requested report file, then
stop.
