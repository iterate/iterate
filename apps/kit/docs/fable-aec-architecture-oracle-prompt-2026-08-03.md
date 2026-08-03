# Fable review: shared AEC architecture and physical oracle

Act as an independent, max-effort realtime-audio architect and adversarial test
designer. This is a bounded, read-mostly task. Do not flash, reset, open serial
ports, stop live processes, modify firmware, or touch attached hardware. You
may create exactly one durable output file:

`apps/kit/docs/fable-aec-architecture-oracle-review-2026-08-03.md`

## Objective

Propose materially different, simpler ways to get excellent full-duplex AEC
on StackChan and Home Assistant Voice Preview Edition without tying the shared
firmware into device-specific knots. Design a high-fidelity, repeatable oracle
that can tell whether AEC works before a Grok conversation is trusted. The
answer must fit a realtime embedded system: audio has priority, all queues are
bounded, stale speech is discarded observably, steady state does not allocate,
and diagnostics cannot cause the fault they measure.

## Inspect

- `apps/kit/firmware/components/core/`
- `apps/kit/firmware/components/capabilities/`
- all audio platform adapters under `apps/kit/firmware/platforms/`
- StackChan and HAVPE targets under `apps/kit/firmware/targets/`
- native/simulator tests under `apps/kit/firmware/tests/` and `apps/kit/test/`
- `apps/kit/scripts/prove-production-aec-waveform.ts`
- `apps/kit/src/device/stackchan-aec-assessment.ts`
- `apps/kit/docs/voice-device-adventures-2026-08-02.md`
- `/Users/jonastemplestein/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec/`
- ESP-IDF and ESP-SR source under `/Users/jonastemplestein/esp/` and the managed
  ESP-SR component in this worktree
- relevant official source/docs and respected embedded-audio prior art online

## Current measured problem

The current StackChan linear AEC cancels a deterministic far-end tone strongly
but barely cancels broadband PRBS, and only partly cancels speech. The final NLP
stage adds less than about 1 dB in those measured windows. Speech-shaped output
can clip the raw microphone before AEC. Raising the electrical reference gain
did not fix it. Very-aggressive NLP once made tonal residuals small by erasing
near speech too. A recent production physical run was correctly classified
network-invalid when worker RTT/reachability deteriorated; transport-invalid
evidence must never be used to pass audio.

The shared window now records aligned near/reference/linear/final peak and mean
statistics, but low-rate aggregates cannot determine reference lag, polarity,
clock slip, transfer function, or nonlinear distortion. We need the smallest
bounded remote diagnostic that can.

## Produce at least four genuinely different designs

Examples may include, but are not limited to:

- direct low-level ESP AEC with calibrated reference delay/gain;
- ESP AFE voice-communication mode owning the interleaved microphone/reference;
- exact digital speaker PCM as the reference plus a bounded delay line;
- electrical post-codec reference with an explicit measured transfer model;
- a board-native/codec-supported path;
- a different open or first-party AEC implementation if it is realistically
  supportable on ESP32-S3.

For each design explain cancellation quality risks, double-talk behavior,
nonlinear speaker/codec effects, clock-domain assumptions, latency, CPU,
internal RAM, PSRAM, ownership/concurrency, and how it ports across the two
boards. Reject designs that merely hide echo with a gate or destroy near-end
speech.

## Oracle requirements

Design one shared automated test sequence for both boards:

1. ambient baseline;
2. far-only tone (sanity, not acceptance);
3. far-only broadband PRBS or shaped noise;
4. far-only speech;
5. near-only Mac speech;
6. controlled double-talk;
7. long playback/capture under CPU/network load.

It must persist synchronized raw microphone, reference, linear output, and
final output (or justify a smaller sufficient set); estimate delay/polarity,
ERLE by band and over time, residual coherence, clipping, double-talk near-end
preservation, drift, gaps, resets, heap/stack, buffer depths, and realtime cost.
Specify a bounded capture mechanism exposed through an ordinary device
capability—not USB serial—and explain how to store it without internal-RAM or
realtime-path damage. Account for Mac `say` timing and acoustic capture. Make
network validity an interval-aligned independent gate.

## Deliverable

Write `apps/kit/docs/fable-aec-architecture-oracle-review-2026-08-03.md` with:

- an evidence map with exact paths/symbols and primary-source links;
- a comparison table of the designs;
- a recommended simplest architecture and one fallback;
- explicit deletions/refactors that reduce moving parts;
- a red-test-first implementation sequence;
- quantitative acceptance thresholds, marking estimates versus first-party
  limits versus values that must be calibrated physically;
- the fastest next experiment that can falsify the recommendation.

Do not merely endorse the current design. Look deliberately for a better local
maximum, and separate proven facts from inferences and open questions.
