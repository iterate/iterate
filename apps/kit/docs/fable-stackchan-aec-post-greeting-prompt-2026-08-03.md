# Independent StackChan AEC onset review

Work read-only. Do not edit code. Write your final review to
`apps/kit/docs/fable-stackchan-aec-post-greeting-review-2026-08-03.md`.

We have a physical M5Stack CoreS3/StackChan using ESP-IDF and ESP-SR
`AEC_MODE_VOIP_HIGH_PERF`, with an electrical feedback-divider reference from
the AW88298 output. The relevant implementation is:

- `apps/kit/firmware/platforms/iterate_core_s3_audio/core_s3_audio_owner.c`
- `apps/kit/firmware/platforms/iterate_core_s3_audio/core_s3_capture_reserve.c`
- `apps/kit/firmware/platforms/iterate_core_s3_audio/core_s3_playback_reference_reserve.c`
- `apps/kit/firmware/components/core/src/aec_capture_bridge.c`
- `apps/kit/firmware/components/core/src/aec_uplink_selector.c`
- `apps/kit/src/device/aec-waveform-assessment.ts`
- `apps/kit/scripts/prove-production-aec-waveform.ts`

Retained physical evidence says settled far-only cancellation is excellent
(roughly -49 dBFS), double-talk is retained, and playback transport is exact.
But a real provider reply can produce large residual during its first few
hundred milliseconds, causing Grok server-side VAD to see the assistant as the
user. A current real incident also transcribed one nearby “hey pal” as three
turns (`No.`, `No.`, `Out.`) before replying after about five seconds. The
current deterministic oracle has a one-second settling lead and therefore can
pass while the actual conversational onset fails.

Independently inspect the code, local ESP-IDF/ESP-SR source and first-party
examples/docs available under `~/esp`, the local prior-art checkout at
`/Users/jonastemplestein/src/github.com/iterate/stackchan`, relevant M5Stack BSP
and AW88298 configuration, and high-quality third-party embedded AEC designs.
Use web research if it materially helps.

Prioritise:

1. A materially simpler architecture if current DMA pairing, analog-reference
   scaling, raw/processed selection, or test design is tying itself in knots.
2. A falsifiable explanation for strong settled cancellation but bad onset and
   initial near-speech corruption.
3. Exact tests and metrics that distinguish alignment, adaptation warm-up,
   reference scale/clipping, selector transitions, AEC recreation, provider
   semantics, and ambient false triggers.
4. Preserving real double-talk/barge-in. Blanket muting while the speaker is
   active and merely raising provider VAD threshold are not acceptable.
5. CPU/RAM/realtime consequences and any deletions/cleanup that reduce
   time-to-goal.

Separate facts verified from source, inferences, and experiments. Recommend a
short ranked next-action list. Do not call the system fixed from settled-only
measurements.
