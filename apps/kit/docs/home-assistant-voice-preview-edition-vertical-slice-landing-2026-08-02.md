# Home Assistant Voice Preview Edition vertical-slice landing — 2026-08-02

Status: the narrow production hardware portability slice is achieved. Longer
endurance and a dedicated long-playback echo census remain follow-up gates;
this document does not claim those are complete.

## Retained acceptance run

The authoritative manifest is:

`apps/kit/evidence/home-assistant-voice-preview-edition-production-grok-schema3-valid/2026-08-02T15-21-56-690Z/manifest.json`

It records a freshly flashed physical Home Assistant Voice Preview Edition
(`D8:3B:DA:46:20:34`) using the deployed production userspace worker in project
`kit-havpe-voice-e2e-20260802`, capability
`itx.kit.homeAssistantVoicePreviewEdition`, production `/pcm`, and real
`grok-voice-think-fast-2.0`. The run passed all of the following together:

- server VAD over continuous full-duplex PCM and the board's local XMOS
  AEC/IC/NS pipeline;
- one ordinary speech turn and one deliberate barge-in phase, with exactly
  three provider speech starts, stops, completed responses, interruption
  requests, and interruption completions;
- no provider disconnect, provider send failure, PCM socket error, protocol
  failure, runtime uplink/drop/restart, downlink drop, or clipped uplink sample;
- 1,732 accepted uplink frames and 432 downlink frames during the digital
  acceptance interval;
- exact provider input transcripts for the normal prompt, long-story prompt,
  and interruption prompt, with no unexpected fourth VAD turn during the
  five-second post-playback echo guard;
- 83 non-PCM provider events durably read back from
  `/devices/home-assistant-voice-preview-edition`, contiguous from sequence
  one with no append failure, stream drop, or pending event;
- independent Mac-microphone transcription exactly matching Grok's spoken
  `Production audio signal amber is clear and audible.` The causal response
  was 77.51 times the ambient maximum RMS and passed the preserved provisional
  acoustic gate without changing its stricter follow-up threshold;
- an automatically `valid` network interval: all 36 device, current-router,
  and worker reachability probes replied, RSSI stayed between -62 and -60 dBm,
  DNS completed in 2.09 ms, TLS/connect in 39.60 ms, and there were no link,
  Wi-Fi reconnect, socket, or diagnostics gaps;
- exact schema-v3 AEC accounting over explicitly phase-labelled windows. Three
  playback-quiet live-microphone windows measured a processed/raw ratio of
  1.0887. Two settled speaker-only windows measured 0.2003, producing 14.71 dB
  gain-normalized suppression. Across the acceptance interval, all 1,753
  captured frames produced 1,753 clean frames with zero drop or measurement
  failure; maximum observed capture-to-uplink handoff was 102 microseconds.

The story audibly ending shortly after “once upon a time” was intentional. The
harness waits for two settled speaker-only metric windows and then injects the
near-end interruption. It is the barge-in oracle, not evidence of an underrun.
The replacement reply `Interruption test complete.` was subsequently audible
and independently transcribed.

## Resource evidence

The flashed application binary was 1,069,792 bytes (`0x1052e0`), leaving 80%
of the smallest 5 MiB application partition free. ESP-IDF's post-run size
report measured 1,069,674 logical image bytes, 209,915 bytes of DIRAM
(61.42%, 131,845 bytes remaining), and 16,383 of the separately reported
16,384 IRAM bytes. That one-byte reported IRAM margin is a real compile-time
hardening risk and must not be hidden by the otherwise generous flash margin.

Runtime general metrics moved from 7,236,232 to 7,240,964 free heap bytes over
the acceptance interval rather than drifting downward. Minimum observed free
heap was 7,215,176 bytes, minimum free internal heap was 66,815 bytes, free
PSRAM ended at 7,181,236 bytes, task stack high-water headroom was 1,828 bytes,
and the terminal CPU sample was 114 permille. The uplink transport accepted
frames at most one millisecond old during the run and ended with zero queued
frames. Lifetime queue high-water values include deliberate pre-session
startup capture and are not presented as runtime backlog.

## Rejected runs retained on purpose

Two immediately preceding physical runs remain evidence rather than being
deleted:

1. `...production-grok-schema3-exact/2026-08-02T15-13-53-078Z/failure.json`
   completed both Grok phases, but the original assessor circularly required
   the processed NS channel to exceed an arbitrary peak even though the
   original-mic tap and exact provider transcription proved near-end speech.
   A red regression now proves that the original XMOS tap owns physical-speech
   selection. Reassessment of its exact sums yields 21.57 dB suppression. The
   interval was independently network-invalid due to simultaneous router and
   device probe timeouts plus 143 ms worker RTT, so it is not promoted to a
   pass.
2. `...production-grok-schema3-exact-rerun/2026-08-02T15-18-03-485Z/failure.json`
   measured 21.58 dB suppression but encountered a 119 ms worker RTT spike.
   The device's bounded freshness policy then discarded 31 queued mic frames
   rather than replaying audio whose oldest frame had reached 621 ms. That is
   the desired recovery shape under a bad interval, but it is still a rejected
   acceptance run: one clean-capture publication was lost, the digital drop
   and restart counters changed, and the network classifier marked it invalid.

These failures demonstrate the intended attribution rule: network trouble can
explain a rejected audio interval, but cannot make it pass. The separate clean
run above is the acceptance authority.

## Scorer and review reconciliation

Metrics schema v3 exposes the exact raw and clean absolute sums that firmware
already accumulated, avoiding multi-decibel verdict changes caused by rounded
one-second means. The harness labels near-end-only and settled far-end-only
sequences, aggregates exact sums only within those phases, requires exact
provider turn counts and input transcripts, and watches five seconds after
playback for self-echo VAD. It still requires at least 3 dB suppression and
does not relax frame conservation, network validity, reconnect, reset,
brownout, clipping, or interruption gates.

The bounded Fable review is retained at
[`fable-havpe-agc-ns-aec-review-2026-08-02.md`](./fable-havpe-agc-ns-aec-review-2026-08-02.md).
Its near-term recommendations to keep fixed userspace gain, exclude deliberate
double-talk from the far-end score, aggregate windows, count unexpected VAD
turns exactly, retain transcript purity, and add a post-playback echo guard are
implemented. Its broader provenance and long-playback census suggestions are
not silently treated as complete.

## Remaining gates

- Run a dedicated longer speaker-only echo census, followed by the agreed
  one-minute then two-minute endurance ladder. Do not reinterpret this short
  vertical proof as endurance.
- Reduce or rigorously account for the reported one-byte IRAM margin before
  broad feature growth.
- Retain physical-button and manual user-flow provenance separately from the
  remote capability-driven unattended harness.
- Continue with the already recorded final ordering: restore the StackChan
  talking-head sprite renderer through the shared normalized renderer seam;
  do not couple sprites back into either realtime audio owner.
