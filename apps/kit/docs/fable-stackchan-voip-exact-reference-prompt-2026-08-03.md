# Fable Max: StackChan VOIP AEC with exact TX reference

Work read-only in `/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`.
Write exactly one report:
`apps/kit/docs/fable-stackchan-voip-exact-reference-review-2026-08-03.md`.
Do not edit code, flash hardware, deploy, or run audible experiments.

Review the current StackChan audio implementation after the exact completed-TX
DMA reference change and one-shot paired-reset fix. Inspect the current diff,
`apps/kit/firmware/platforms/iterate_core_s3_audio/`, ESP-SR 2.4.7 headers and
libraries, the vendored BSP/I2S implementation, first-party ESP-IDF/ESP-SR
examples, and prior art at
`/Users/jonastemplestein/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec/`.
Use first-party web sources only if local sources do not settle a question.

The latest retained physical run is:
`apps/kit/evidence/stackchan-exact-tx-reference-reset-fix-20260803/2026-08-03T15-21-34-016Z/`.
It proves 11,585 paired chunks, one bounded startup reset, maximum callback-time
pair skew 1.428 ms, no capture loss, and frame conservation. It is network-invalid
because router RTT crossed the fixture gate. Speech-shaped far-only output passed;
pure tone, PRBS by 0.19 dB, and double-talk failed acoustic gates. The current AEC
is `AEC_MODE_VOIP_HIGH_PERF`, 256 samples, filter length 4, AGGR NLP, exact TX PCM
reference, with no speaker-active energy gate.

The non-negotiable semantic invariant is: speaker-only playback must yield zero
Grok server-VAD speech edges and zero input transcription, while unrelated near
speech—including during playback—must survive and trigger VAD promptly.

Answer decisively:

1. Is the current pairing semantically correct, or must TX/RX be aligned by DMA
   sequence rather than callback timestamps? Cite exact BSP sequence semantics.
2. Does VOIP AEC expect a deliberate reference delay/lead, scale, polarity, or
   different frame/filter settings? Distinguish documented facts from inference.
3. Why can tone remain at -20.77 dBFS post-worker while speech-shaped passes, and
   what one measurement best attributes it without another tuning maze?
4. Does VOIP mode actually provide DTD/TDE in this build and preserve double-talk?
5. Recommend the smallest next patch/run. Explicitly propose deletions and identify
   any local maximum. Do not suggest a scalar energy gate that erases double-talk.

End with at most five ordered actions and numeric falsifiers.
