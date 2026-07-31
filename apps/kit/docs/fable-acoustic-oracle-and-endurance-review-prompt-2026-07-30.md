# Independent acoustic-oracle and playback-endurance review

You are an independent Claude Fable Max reviewer working in:

`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`

Do not edit production code or tests. Write your completed report only to:

`apps/kit/docs/fable-acoustic-oracle-and-endurance-review-2026-07-30.md`

The main implementation agent will reconcile your proposals against source,
tests, and new physical evidence; do not assume your recommendations will be
accepted.

## Required context

Read these first:

- `apps/kit/docs/physical-device-voice-goal.md`
- `apps/kit/docs/audio-streaming-problem-and-evidence-2026-07-30.md`
- `apps/kit/docs/fable-audio-architecture-alternatives-2026-07-30.md`
- `apps/kit/docs/fable-audio-review-reconciliation-2026-07-30.md`
- `apps/kit/docs/fable-m5sticks3-acoustic-startup-investigation-2026-07-30.md`
- `apps/kit/firmware/AGENTS.md`
- `apps/kit/firmware/docs/reasoning-comments.md`

Then inspect at least:

- `apps/kit/src/device/acoustic-tone-analysis.ts`
- `apps/kit/src/device/acoustic-tone-analysis.test.ts`
- `apps/kit/src/device/macos-pcm16-capture.ts`
- `apps/kit/src/device/playback-endurance-*.ts`
- `apps/kit/src/device/m5sticks3-playback-endurance-*.ts`
- `apps/kit/scripts/device-e2e.ts`
- `apps/kit/src/voice/deterministic-pcm-tone-provider.ts`
- `apps/kit/src/voice/device-pcm-proxy.ts`
- `apps/kit/src/device/local-fetch-websocket-server.ts`
- the portable and ESP-IDF playback code under
  `apps/kit/firmware/platforms/`
- relevant ESP-IDF I2S, CoreAudio/SoX, signal-analysis, and M5StickS3 source.

The user has also explicitly allowed inspiration from the current
`/Users/jonastemplestein/src/github.com/iterate/stackchan` voice pipeline.
Inspect its current source, but treat its known worsening delay and buffering
over time as a defect to avoid rather than prior art to copy.

## Current physical result

The exact M5StickS3 is USB serial/MAC `70:04:1D:D5:45:88`. A direct-LAN,
10-second, 997 Hz run completed all 500 20 ms frames. Device and proxy
diagnostics report:

- 500 accepted, submitted, and completed content frames;
- zero underruns, recovery silence, late drops, DMA deadline incidents,
  freshness drops, queue overflows, driver failures, transport backpressure,
  reconnects, or resets;
- playback queue high-water four descriptors and downlink high-water one frame;
- maximum EOF-to-successful-refill 21,232 us;
- minimum successful descriptor-reuse lead 38,768 us;
- maximum driver write duration 97 us;
- approximately 303–306 permille device CPU during playback;
- minimum internal/DMA heap 130,931 bytes.

The authoritative run log and raw Mac-microphone capture are:

- `apps/kit/evidence/m5sticks3-playback/direct-lan-tone-10s-hardware-reserve-retry-20260730-2302/run.log`
- `apps/kit/evidence/m5sticks3-playback/direct-lan-tone-10s-hardware-reserve-retry-20260730-2302/iterate-kit-acoustic-2OXLQp/microphone.pcm16le`

The raw capture is 48 kHz mono PCM16LE. The analyzer reports, contradictorily:

- `observedStartMs: 0`, even though capture was running before the provider
  request and real playback could not start at sample zero;
- `observedSpanMs: 10670` for a 10,000 ms source;
- `longestInternalGapMs: 635`;
- `gapCount: 2`;
- `missingToneMs: 0`;
- 16 phase discontinuities, maximum phase-step error 0.346 rad;
- maximum amplitude step 1.626 dB;
- failure of the strict acoustic gate.

The capture/process markers in the log indicate the provider request occurred
after about 16,384 captured samples (roughly 341 ms), provider completion after
about 495,616 samples, playback completion after about 548,864 samples, and the
quiet-tail marker after about 573,440 samples. One current hypothesis is that a
short false-positive 997 Hz/noise fragment at capture start is merged with the
real contiguous tone, turning the pre-playback quiet period into an “internal”
gap and biasing duration. That hypothesis is not yet proven.

A prior physical attempt reset with the explicit ESP32 brownout detector. Do
not hide or disable that detector; classify it separately from audio
continuity.

## Questions and deliverable

Produce a source-cited report that:

1. independently replays and inspects the raw artifact and shows the exact
   active/inactive component timeline, not merely the existing aggregate;
2. ranks at least three falsifiable explanations for every remaining acoustic
   failure (duration, 635 ms gap, amplitude step, and phase errors);
3. determines whether the current analyzer's “first active to last active”
   aggregation can misclassify pre/post-roll false positives, and proposes the
   smallest public-contract correction plus a red regression waveform;
4. explains how to select the intended playback episode without tuning the
   oracle to this one artifact or masking a real mid-stream gap;
5. distinguishes device-I2S discontinuity, codec/amplifier behavior,
   Mac-recorder discontinuity, environmental interference from adjacent
   devices, and analyzer error using exact experiments and metrics;
6. critiques the current four-descriptor hardware-reserve playback policy and
   says whether retaining completed descriptors until their measured reuse
   deadline is sound, simpler than alternatives, and correctly instrumented;
7. proposes the cleanest 1-minute, 2-minute, and 10-minute acoustic endurance
   protocol, including non-periodic challenge audio, controlled load,
   sample-clock drift, recorder integrity, memory/CPU/stack gates, and exact
   stop conditions;
8. inspects the current StackChan voice pipeline for useful capture/playback,
   sprite/viseme, and device abstraction ideas, while naming any buffering,
   blocking, copying, or ownership design that must not migrate;
9. gives explicit keep/simplify/delete/defer recommendations and a
   red-test-first sequence.

Separate source-proven facts, artifact measurements, and hypotheses. Prefer
architectural simplifications. Do not recommend larger queues as a substitute
for real-time freshness. Do not claim the physical audio is gapless merely
because digital counters are clean, and do not call a real gap merely because
the current analyzer says so.
