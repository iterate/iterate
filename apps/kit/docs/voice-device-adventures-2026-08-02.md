# Voice-device build log — 2026-08-02

Newest entries are prepended. This is an evidence ledger, not a declaration
that the three-device goal is complete.

## 21:36 — One semantic presence frame, several physical renderers

The cross-device UI contract is now deliberately narrower than a shared
drawing API. A standalone, host-testable C producer will emit one immutable
semantic **presence frame** from the whole conversation state and the latest
PCM-derived expression state. At minimum that frame carries control-plane and
call connectivity, call phase, network quality/fault state, conversation
elapsed time, recent audio level, and the existing viseme/mouth controls. It
must not know about sockets, displays, LED drivers, sprite atlases, or a target's
pixel geometry.

Thin physical adapters consume exactly that frame. HAVPE maps it to its twelve
LEDs; small-screen targets render the same recognisable ring structure as a
tiny pixel grid alongside their device-specific instructions and avatar; and
StackChan can map it to both of its LED arrays as well as its face. This lets
the same conversational expression drive pixels or LEDs without forcing an
LED target through a framebuffer abstraction. Adapters may choose geometry and
brightness, but they may not independently reinterpret transport or call
state. The existing avatar pose/viseme types will be inspected and extended or
wrapped rather than duplicated.

This refactor follows the current HAVPE long-response landing gate: the physical
count-to-100 disconnect is still the first blocker, so the semantic model will
not be allowed to conceal or postpone that measured transport failure.

## 21:28 — Shared glanceable UI and final physical acceptance contract

The device UI now has one additional cross-target requirement: every target
must render the same recognisable call-state ring model. HAVPE renders it on
its physical twelve-pixel ring; StackChan and M5StickS3 must render a tiny
pixel-grid version on their screens next to device-specific control
instructions. The shared semantic states are at least control-plane connected,
idle/no call, call connecting, listening/PTT capture, provider speaking,
degraded network, and fault. Physical drawing remains target IO; the state
model and colour/segment meaning belong in shared, host-testable code.

Before the three-device goal may be called complete, each device must be cold
restarted and exercised physically. The harness—not a human—must invoke the
same call-toggle and restart paths exposed by the real button state machine;
for the Stick it must also invoke press-and-hold PTT. It must speak through the
adjacent Mac using `say`, allowing for command-to-acoustic onset delay, record
the actual device speaker through the Mac microphone, and retain aligned
provider, device, worker, acoustic, and network evidence. A counter or provider
transcript without an audible physical conversation is not acceptance.

## 21:27 — HAVPE count-to-100 failure localised below Grok

The user asked the physical Home Assistant Voice Preview Edition to count to 100. It became inaudible after roughly 37 and the call could not continue.
The failed production session was:

`prj_4f76ffe131f1495981afd65619f57914:home-assistant-voice-preview-edition:d2a15a10-58c7-475b-9738-52b2df0ede86`

This was not an xAI generation crash. The durable provider stream contains a
complete output transcript through 100, and `response.done` reports
75.4176666666667 seconds of generated audio. The provider emitted that future
audio in roughly 11.5 seconds. The production worker then realtime-paced only
1,534 20-ms frames (about 30.68 seconds) before the device-originated `/pcm`
generation disappeared with close code 1011 and reason `WebSocket disconnected
without sending Close frame.` The worker's response reservoir consequently
reached 2,042,196 bytes and discarded 1,498,196 bytes after its physical
downstream vanished.

The first post-failure device snapshot reported cumulative downlink received
3,230, dropped 1, depth 0, high-water 32, and receive failures 1. The firmware
downlink SPSC ring has exactly 32 slots. In the current transport source, one
`ITERATE_KIT_BACKPRESSURE` while publishing a consumed WebSocket item increments
exactly the drop/failure counters above, records `ESP_ERR_NO_MEM`, and retires
the PCM socket generation. This is a strong source-and-counter match, but the
snapshot was not sampled at the exact failure edge, so the next reproduction
must retain aligned one-second depth, failure, playback-owner, worker pacing,
provider, and network observations before promoting the attribution from
inference to measured causal proof.

The most important harness blind spot is now explicit: the userspace unit tests
model a WebSocket peer that accepts every frame immediately. They verify a
72-second response reservoir and a 12-frame startup lead, but do not model a
separate hardware playback clock, TCP/TLS delivery bunching, or a finite
32-frame device receive ring. A red host model for those independent clocks is
the next implementation gate.

Network probes immediately after the incident were clean, but no probe series
covered its exact interval. The historical run is therefore network-unknown,
not network-valid and not proof of an audio-clock defect. A clean subsequent
count-to-100 run remains mandatory.

## 21:27 — HAVPE endpointing shortened, applied value acknowledged

The deployed xAI session now sends `silence_duration_ms: 500` for the named
HAVPE `xmos-aec-ns` profile; StackChan remains at 1,000 ms pending its separate
pause/AEC calibration. A live `session.updated` event acknowledged exactly:

```json
{
  "type": "server_vad",
  "threshold": 0.1,
  "silence_duration_ms": 500,
  "prefix_padding_ms": 400
}
```

xAI's official Voice Agent documentation publishes a range of 0–10,000 ms for
`silence_duration_ms` but does not publish its omitted default. It does publish
the server-VAD threshold default as 0.85 and prefix-padding default as 333 ms.
An authenticated direct `grok-voice-think-fast-2.0` probe also could not
materialise the missing default: `session.created` returned only `type: null`,
and after updating with only `{ type: "server_vad" }`, `session.updated` echoed
only that type rather than expanding silence, threshold, or prefix values.
Thus 500 ms is the app's explicit HAVPE setting (the previous app setting was
1,000 ms), not a claimed provider default.
The current threshold 0.1 is an explicit measured override, not a provider
default. Two low-level ambient bursts of 84–554 ms already triggered it in one
live silent interval, so faster endpointing and that unusually sensitive
threshold must be calibrated together rather than treating “500 ms” alone as
latency improvement.

## Background independent review

Claude Fable Max background session `114ea3be` is reading the worker scheduler,
ESP-IDF transport/I2S source, HAVPE driver path, retained evidence, and
first-party guidance. Its bounded report target is
`fable-havpe-long-response-downlink-review-2026-08-02.md`; implementation is not
blocked on it and its recommendations will be reconciled against tests and
physical evidence rather than accepted automatically.
