# StackChan production vertical-slice landing — 2026-08-02

Status: achieved for the production-shaped portability slice. Endurance,
watchdog hardening, and broader product capability coverage remain explicit
follow-ups; this document does not claim those are finished.

## What passed together

The retained manifest is:

`apps/kit/evidence/stackchan-production-grok-20260802-final/2026-08-02T08-54-57-839Z/manifest.json`

It proves one freshly booted CoreS3 StackChan session through the deployed
apps/os userspace worker and real `grok-voice-think-fast-2.0`, rather than a
local bridge or deterministic provider. The session used:

- production project `kit-stackchan-voice-e2e-20260801`
  (`prj_0363ecd53eda492e972b07debd56eb46`);
- worker host `kit--kit-stackchan-voice-e2e-20260801.iterate.app` and `/pcm`;
- capability mount `itx.kit.stackchan` and provider-event stream
  `/devices/stackchan`;
- device MAC/USB serial `68:EE:8F:D8:53:20`, IP `192.168.1.178`, and the
  then-current `/dev/cu.usbmodem11401` port; and
- userspace worker deployment OID
  `b2adb807010199e4dd61e64bfde3c00bcc64cb4c`.

The production session began silent, attached Grok, streamed continuous
full-duplex microphone audio through server VAD, played the returned voice on
the physical StackChan, and accepted a near-end acoustic interruption while
old response audio was still queued. Grok returned:

- `Production audio turn one is clear and audible.` for the normal turn; and
- `Interruption test complete.` for the replacement response.

The nearby Mac microphone independently transcribed the normal reply exactly.
Its response maximum RMS was 13.20 times the baseline maximum, so the audible
result is not inferred merely from digital PCM.

## Exact transport and interruption evidence

The digital assessment passed with no reasons:

- 1,384 clean uplink frames and 365 downlink frames progressed during the
  assessed interval;
- 418,750 downlink bytes were deliberately discarded by interruption and all
  418,750 were classified in the interruption ledger, leaving zero unexplained
  downlink loss;
- all three requested physical playback purges completed, with zero purge
  failures;
- the device downlink ended at depth zero, recorded no drops or failures, and
  reached a 13-frame high-water mark;
- the uplink ended at depth zero with no freshness recovery, socket restart,
  transport restart, or other restart incident; and
- the provider completed three responses with no failures. No cancellation
  was required because xAI completed generation before realtime playout had
  drained; the physical purge and subsequent completed response are the
  relevant race-independent invariants.

All 76 non-PCM Grok events were appended to the Iterate stream with no append
failure, drop, pending tail, or sequence discontinuity. The artifact is
`provider-events.jsonl` beside the manifest and is contiguous from sequence 1
through 76.

Startup ambient audio was handled as an explicit bounded condition: provider
readiness took 1,106 ms, 48 unavailable frames/30,720 bytes were discarded,
and the calculated bound was 58 frames. This is not counted as unexplained
loss.

## AEC, timing, RAM, CPU, and binary size

The hardware-reference AEC assessment passed on the same network-valid run:

- far-end echo suppression: 8.49 dB;
- near-end clean/raw mean-absolute ratio: 0.989;
- 1,061 processed frames;
- zero AEC recreations, recreate failures, capture-reserve drops, capture
  bridge errors, or signal-measurement failures;
- maximum observed capture-to-uplink delay: 32.385 ms; and
- maximum observed AEC processing time: 17.686 ms.

This deliberately records the measured 8.49 dB rather than substituting the
17–21 dB values seen in earlier but network-invalid intervals. It clears the
current measured vertical-slice gate and preserves near-end speech, but longer
double-talk/endurance work remains before calling the DSP product-tuned.

The terminal one-second device sample reported:

- free heap 7,042,512 bytes; minimum since boot 7,018,192 bytes;
- free internal heap 97,603 bytes; minimum 81,307 bytes;
- free PSRAM 6,969,180 bytes;
- task stack high-water remaining 1,892 bytes;
- CPU 452 permille;
- application uplink buffer depth zero, high-water 19,840/20,480 bytes;
- WebSocket transmitter depth zero, high-water 648/910 bytes; and
- no control/PCM WebSocket, Wi-Fi, TLS, protocol, receive, or send failure.

The freshly built firmware binary was 1,148,256 bytes (`0x118560`), leaving
78% of its application partition free. These numbers are retained as a
baseline, not a license to grow them without remeasurement.

## Network-validity evidence

The exact 28.54-second audio interval was automatically classified `valid`:

- device RSSI stayed between -57 and -55 dBm;
- device RTT averaged 5.53 ms and peaked at 11.224 ms;
- router RTT averaged 3.98 ms and peaked at 9.89 ms;
- production worker RTT averaged 14.40 ms and peaked at 19.943 ms;
- DNS took 0.908 ms and the measured TLS connect took 37.935 ms; and
- the PCM socket stayed open with zero reconnect, disconnect, lower-transport
  failure, or transport error.

The detailed attribution is in `network.json` beside the manifest. Earlier
otherwise useful runs remain failures rather than being relabelled:

1. the first run used a stale greeting-wait harness against the intentionally
   silent worker;
2. later runs passed digital/AEC work but were network-invalid because a
   worker RTT exceeded the fixed 100 ms budget;
3. the first network-valid rerun was audio-invalid only because the spoken
   oracle asked a speech model to spell the product name, which Grok rendered
   as `Stack Shannon`; and
4. the final run replaced that provider-dependent phrase with the strict,
   ordinary-language `interruption test complete` oracle and passed every gate.

No transport, frame-conservation, reset, brownout, AEC, or network threshold
was relaxed to obtain the manifest.

## Independent review reconciliation

The bounded Fable Max review is retained in
[`fable-stackchan-interruption-proof-review-2026-08-02.md`](./fable-stackchan-interruption-proof-review-2026-08-02.md).
Its near-term recommendations were reconciled as follows:

- accepted: userspace coalescing of repeated server-VAD speech edges behind
  one physical purge, explicit intentional-discard accounting, a silent-ready
  gate, race-independent interruption completion, and complete provider-event
  snapshot recovery;
- rejected: making the C `interruptPlayback` capability multi-waiter or
  weakening a real purge rejection. The production caller remains
  single-flight and unexpected concurrency remains loud/fail-closed;
- deferred to the next firmware hardening touch: port the armed task watchdog
  and larger internal-TLS reserve, expose device-side interruption counters,
  and add the remaining cross-session/starved-fence host tests; and
- deferred until after the first manifest, now reached: the 1 → 2 → 10 minute
  endurance ladder and any DSP tuning based on longer far-end/double-talk
  measurements.

## Talking-head avatar restoration

The Home Assistant Voice Preview Edition portability slice subsequently
passed, so the deliberately deferred StackChan face was restored without
forking the audio transport. This is a bounded feature proof layered on the
network-valid voice manifest above. It is not a claim that a later
network-invalid combined run somehow supersedes or weakens that manifest.

The reusable, allocation-free C engine now lives in
`firmware/components/avatar`. Four generated sprite atlases share a registry,
keyframe/stage machinery, and a host-testable animator. StackChan contributes
only the hardware sidecar: a speaker-DMA observer publishes the newest
speaker-clocked PCM observation into a one-slot mailbox, and a low-priority
core-1 task performs lossy analysis and direct RGB565 rendering. The mailbox
can overwrite stale observations but cannot queue delayed animation or block
capture, AEC, playback, or PCM networking. Its one permanent 160×120 DMA
framebuffer is 38,400 internal bytes; build-time assertions reject accidental
PSRAM placement because ESP32-S3 SPI DMA cannot use that memory.

The deployed Cap'n Web surface exposes
`itx.kit.stackchan.subscribeToAvatarMetrics(cb)`. A production invocation
received three consecutive one-second callbacks from the physical device.
They reported `ready: true`, an advancing physical speaker sample clock,
advancing analyzer/render/display counters, zero malformed observations,
mailbox failures, snapshot races, render failures, transfer failures, or
transfer timeouts, a 38,400-byte framebuffer, and 2,400 bytes of minimum avatar
task stack headroom. A separate production invocation of
`subscribeToMetrics(cb)` reported 6,959,644 free heap bytes, 46,627 free
internal bytes, 6,937,288 free PSRAM bytes, 1,588 bytes of general task stack
headroom, 276 permille CPU while idle, empty audio queues, and zero audio or
protocol failures.

### Current-source physical and production evidence

The retained combined run is:

`apps/kit/evidence/stackchan-avatar-production-grok/2026-08-02T17-33-11-000Z/failure.json`

Its overall result remains correctly failed: correlated device/router/worker
reachability gaps made the interval `network-invalid`, the independent Mac
transcript ended after `Production audio signal amber is`, and a later
interruption phase timed out. It also recorded 250 intentional uplink freshness
drops and eight bounded in-place freshness recoveries. Those facts are not
relabelled as an audio pass.

Within that failed combined run, however, the separately assessed avatar lane
passed every gate during actual Grok playout:

- 14,310 new speaker-clock observations and 1,831,680 physical playout samples;
- 12,131 analyzed observations, 1,380 rendered/displayed frames, and 121 frames
  with a visibly open mouth;
- 2,180 latest-only mailbox overwrites matched by 2,180 analyzer sequence gaps,
  with no hidden queue and no other loss class;
- zero malformed observations, mailbox failures, snapshot races, render
  failures, transfer failures, or transfer timeouts; and
- maximum handoff/analyzer/render/display times of 8.000/21.221/23.910/28.541
  ms respectively.

The same interval's AEC assessment passed on 75 unique windows with 27.68 dB
far-end suppression, a 1.019 near-end clean/raw ratio, and zero recreation,
capture-reserve, bridge, or signal failures. Grok completed the ordinary
response `Production audio signal amber is clear and audible.` This makes the
mouth progress a speaker-clocked response to current production PCM rather
than an idle animation or retained LCD pixels.

After moving StackChan to a separate USB port, flashing the final build, and
letting it remount in production, Jonas confirmed the physical result
verbatim: “I've plugged him in separately into a different port, and now I can
see the face again.” The flash tool independently resolved and printed MAC
`68:EE:8F:D8:53:20` on `/dev/cu.usbmodem2101`; no port suffix was trusted as
identity.

### Display/Wi-Fi isolation and resource gates

The final BSP override pins only the LCD SPI completion interrupt to core 1,
beside the deliberately lossy avatar task, rather than accepting ESP-IDF's
initializing-core default on Wi-Fi's core 0. The audio I2S interrupt affinity
is unchanged. A generated-source regression first failed on the old build and
now verifies the patched ESP-IDF translation unit itself, so an upstream-source
refresh cannot silently remove the affinity.

The freshly built/flashed binary is 1,257,296 bytes (`0x132f50`), SHA-256
`c9d2ed3edf2c18b4d8288155541272f7845a3a29472a635aeb4eebbbd22a26e9`,
leaving 76% of the five-megabyte application partition free. The realtime ISR
ELF audit and patched-BSP source audit passed. The complete native host suite
passed 67/67 tests, including all six avatar-engine tests and the regression
that rotates a fixed callback budget past a backpressured subscriber. The
avatar/AEC TypeScript assessment suites passed 8/8 tests and the Kit
TypeScript typecheck passed.

The ISR-isolated build improved the immediately preceding StackChan-only ping
loss from 5–8.33% to 1/100 packets. It did not make the following interval a
valid audio oracle: StackChan averaged 15.21 ms and peaked at 92.762 ms while
the router simultaneously averaged 10.55 ms and peaked at 90.587 ms, and the
Cloudflare worker peaked at 287.269 ms. The router lost no packets and the
device remained mounted with RSSI -67 dBm and zero control/PCM/Wi-Fi failure
counters. Because the spikes were correlated outside the device, no repeated
Grok run was spent on that interval and no DSP conclusion was drawn from it.
The stricter next combined acceptance remains one fresh network-valid run; the
avatar restoration itself is physically visible, production-clocked,
capability-observable, resource-bounded, and host-tested.

## Next ordered work

The original Stick → StackChan → Home Assistant Voice Preview Edition hardware
portability order is complete. Remaining work is explicit follow-up rather
than a hidden avatar gate: obtain a fresh network-valid combined avatar/voice
interval when RF conditions return to the earlier -55 to -57 dBm range, then
continue the 1 → 2 → 10 minute endurance ladder and the already-recorded
watchdog/DSP hardening. StackChan follow-up work must not fork a second
transport or queueing model merely to add endurance or product capabilities.

## Backup checkpoint

The complete worktree checkpoint—including every tracked modification and
untracked evidence artifact visible to Git—was committed as
`e4a3f33d29d5cf4d9d16db13fd02f29f4b99aaf8` with message
`backup: checkpoint c-capabilities StackChan avatar 2026-08-02`. It was pushed
without overwriting another branch to
`origin/backup/c-capabilities-stackchan-avatar-20260802-185601`. The remote ref
was independently read back after the push. This is a recovery checkpoint,
not a merge or a claim that the deferred network-valid rerun/endurance work is
finished.
