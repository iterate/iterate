# Fable Max review: HAVPE XMOS AGC vs NS for production server VAD

You are an independent read-mostly reviewer in:

`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`

Write your final report only to:

`apps/kit/docs/fable-havpe-agc-ns-aec-review-2026-08-02.md`

Do not edit any other file, flash hardware, deploy, commit, push, or run a
physical proof. Use max effort. Inspect source rather than guessing, including:

- the current uncommitted HAVPE firmware and userspace worker under `apps/kit`;
- retained runs under
  `apps/kit/evidence/home-assistant-voice-preview-edition-production-grok-*`;
- the first-party XMOS checkout at
  `/Users/jonastemplestein/src/github.com/esphome/voice-kit-xmos-firmware`;
- the first-party HAVPE and ESPHome checkouts under
  `/Users/jonastemplestein/src/github.com/esphome`;
- the local ESP-IDF source at `/Users/jonastemplestein/esp/esp-idf`; and
- official first-party documentation where it materially resolves a question.

Current measured problem: a network-valid production run using XMOS channel 0
at `PIPELINE_STAGE_AGC` and channel 1 at `PIPELINE_STAGE_NONE` transported
1,553 uplink frames and 413 downlink frames with no runtime transport loss.
The normal output transcript was `Production audio turn one is clear and
audible.` and a deliberate barge-in replaced a long story with `Interruption
test complete.`. Yet the provider journal then recorded another
`speech_started` whose input transcript was the device's own spoken
`Interruption test complete.`. During speaker-active one-second windows,
channel 1/NONE raw peaks were usually only 182-269 and raw mean absolute was
7-32, while channel 0/AGC peaks were commonly 9,000-29,000 and mean absolute
1,000-4,300. A playback-quiet near-end window had raw mean 82 and AGC mean
8,497. Thus AGC appears to amplify far-end residual enough to retrigger xAI
server VAD even when the original-mic electrical measurement is quiet. The
current xAI VAD profile uses threshold 0.85, prefix 400 ms, silence 1,000 ms.
The physical Mac capture was contaminated by nearby speech, so do not infer
AEC quality from its failed energy gate. The exact artifact is:

`apps/kit/evidence/home-assistant-voice-preview-edition-production-grok-xmos-vad/2026-08-02T14-17-40-785Z/failure.json`

The immediately proposed experiment is to configure channel 0 as
`PIPELINE_STAGE_NS` (AEC + IC + NS, omitting final AGC), retain channel 1 NONE
for diagnostics, keep VAD threshold 0.85 initially, reflash once, and rerun.

Answer, with line-level source citations and explicit confirmed/measured/
inferred labels:

1. Is NS-without-AGC the smallest technically sound next experiment, or does
   the source/evidence point to a more likely root cause such as I2S reference
   format/amplitude, the fixed 40 ms mic delay, wrong channel interpretation,
   speaker routing/volume, or AEC adaptation state?
2. What exact signal metric can honestly prove AEC with the unequal-gain AGC
   channel, and what should replace it if channel 0 uses NS? Identify any
   current assessment threshold that selects near-end double-talk rather than
   a true far-end-only window.
3. Which deterministic no-network or production-shaped experiment will
   distinguish the competing causes with the fewest flashes and runs?
4. What VAD threshold/profile change, if any, should accompany NS? Avoid
   speculative tuning; give a measured ladder and stop conditions.
5. Identify defects, unsafe claims, missing tests, unnecessary abstractions,
   and the shortest actionable cleanup. Prioritize time-to-clean physical
   proof and do not broaden into a platform redesign.
6. Audit CPU/RAM/realtime impact of the recommendation.

End with a ranked go/no-go checklist. Be willing to reject the proposed NS
change. Preserve the distinction between an intentional harness barge-in and
an unrequested echo-triggered VAD turn.
