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

## Next ordered work

The next hardware portability proof is Home Assistant Voice Preview Edition
through the same userspace, PCM, capability, provider-event, metrics, and
network-evidence architecture. Face/avatar rendering remains deferred until
that audio/capability path works. StackChan follow-up work must not fork a
second transport or queueing model merely to add endurance or product
capabilities.
