# Home Assistant Voice Preview Edition vertical-slice landing — 2026-08-02

Status: the earlier narrow production hardware portability slice is retained,
but the current HAVPE landing is **not complete**. A subsequent physical
count-to-100 request exposed a reproducible class of long-downlink failure:
Grok generated the complete response, while the 32-slot device receive lane
reached its bound and the `/pcm` generation disappeared after about 30.68
seconds. The exact incident and ongoing correction are recorded in
[`voice-device-adventures-2026-08-02.md`](./voice-device-adventures-2026-08-02.md).
No short smoke below should be read as overriding that failed endurance gate.

## Current firmware: ring UI and physical call/reset control

The current build uses nine of the first-party HAVPE's twelve addressable ring
pixels as three independent status sectors:

- pixels 0–2 show connectivity and network quality: red while Wi-Fi is absent,
  amber while Wi-Fi is present but the Cap'n Web control mount is not ready,
  then one to three red/amber/green RSSI bars once mounted;
- pixels 3–5 are a blue speaker-output amplitude meter. Both audio sectors are
  amber while `/pcm` connects and red if the PCM transport fails;
- pixels 6–8 show microphone state: one dim green pixel means the continuous
  AEC-clean capture path is listening, and one to three brighter green pixels
  show microphone amplitude;
- pixels 9–11 are deliberately dark and reserved rather than being given an
  ambiguous fourth meaning.

The status renderer runs only in the low-priority cooperative owner, at a 20 Hz
ceiling, and samples RSSI at 1 Hz. It stages all twelve pixels before one RMT
refresh and skips equal frames. The realtime microphone owner reuses the peak
already computed by its AEC observation; the realtime speaker owner inspects
one in eight native 16 kHz samples, or 2,000 comparisons per second. Each only
raises an atomic scalar peak. Neither audio owner touches LEDs, allocates,
logs, waits for the UI, or queues UI history. The UI destructively takes both
peak holds each interval, so pausing it cannot replay old activity. A remote
`leds.set` or `leds.fill` capability remains visible for three seconds before
status rendering retakes the ring.

The current build owns the centre button on active-low GPIO0. A short press
toggles the full-duplex server-VAD conversation on **release** through the same
portable voice-satellite event owner used by remote RPC. Holding for three
seconds arms a whole-ring magenta reboot indicator; releasing then calls
`esp_restart()`. Reboot waits for the debounced release because GPIO0 is an
ESP32-S3 boot strap: restarting while it remains low can enter the ROM
downloader. This is an application reboot, not a factory reset, so Wi-Fi and
project provisioning remain intact. A button held during boot is treated as
baseline and does nothing until released.

`iterate-kit-havpe-ui-test` pins sector ownership, RSSI boundaries, silent
listening, speaker/microphone levels, PCM failure, reboot-arm precedence,
short-press exclusivity, boot-held suppression, release-before-reboot, and
clock rollback. `iterate-kit-debounced-button-test` separately preserves the
electrical bounce and timing contract. Both pass under the host build; the
ESP-IDF target builds with warnings as errors.

The exact current image was freshly built and flashed to stable USB identity
`D8:3B:DA:46:20:34`, preserving the existing production and Wi-Fi
configuration. Esptool identified that MAC and hash-verified every written
region. The padded application is 1,073,520 bytes (`0x106170`, SHA-256
`99b5d2b3c312d99a9a482a2f8ce055a1bb0a36f431de27e912f04937b822a40e`);
the logical image is 1,073,406 bytes. DIRAM is 210,019 bytes with 131,741
remaining. Separately reported IRAM remains 16,383 of 16,384 bytes, so the
existing one-byte hardening risk has not been concealed.

The finite post-flash production smoke is retained at
`apps/kit/evidence/home-assistant-voice-preview-edition-ring-ui/2026-08-02T19-34-37-000Z/manifest.json`.
Through `os.iterate.com` and
`itx.kit.homeAssistantVoicePreviewEdition`, one real-Grok conversation made
exactly one `/pcm` connection and the remote hang-up made exactly one
disconnect. A Mac-spoken prompt produced 1,198 clean capture publications,
1,166 WebSocket uplink frames, and 136 received downlink frames. RSSI was -39
to -45 dBm. There were zero Wi-Fi disconnects, control/PCM WebSocket errors,
raw-write failures, transport incidents, protocol failures, downlink drops,
audio failures, or freshness restarts. The production `leds.fill` capability
also acknowledged a green frame, after which the bounded status-UI override
expired.

This short smoke intentionally does not replace the acoustic/AEC acceptance
run below. It observed 164 producer-backpressure drops and then discarded the
remaining 31-frame uplink tail at lifecycle shutdown (`195 - 164`), the
existing bounded freshness policy rather than a retry queue. Because this
smoke did not retain interval snapshots around those lifecycle edges, it is
not promoted as a new frame-conservation acceptance run. The mechanical
button and long-hold reboot are host-modelled and flashed but were not
physically actuated by the unattended proof.

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

Three current-source revalidation runs after the retained acceptance were also
kept rather than thresholded into passes. All three reached real Grok, produced
the exact expected provider turns with no self-echo turn, conserved every
clean-capture frame, and reported zero provider, PCM, reconnect, or AEC
failure. They measured 14.383 dB (1,904/1,904 frames), 19.282 dB
(1,852/1,852), and 25.152 dB (1,801/1,801) of far-end suppression. The first
failed independent Mac transcription; the second combined an unrelated
acoustic prefix with a 163.222 ms worker RTT; the third captured unrelated
ambient speech (`No, no`) and a 112.372 ms device RTT. They remain rejected at
`home-assistant-voice-preview-edition-current-valid`,
`home-assistant-voice-preview-edition-current-rerun-valid`, and
`home-assistant-voice-preview-edition-current-final-valid`. Their clean digital
and AEC evidence strengthens the implementation diagnosis without weakening
the acoustic or network-validity gates.

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
- Retain a mechanical centre-button/manual user-flow provenance run separately
  from the now-green shared debounce/event-owner and remote production smoke.
- Continue with the already recorded final ordering: restore the StackChan
  talking-head sprite renderer through the shared normalized renderer seam;
  do not couple sprites back into either realtime audio owner.
