---
state: doing
priority: high
size: large
tags:
  - voice
  - firmware
  - refactor
---

# One voice path, five boards

Implementation is in progress on `futurehomes-gpt-live`, based on PR #2624 at
`9dd9aea7225cf0818eb508d63736d54fbfb7c8f6`. The original Futurehomes work is
preserved on `backup/futurehomes-before-gpt-live-integration`; unrelated backend
experiments were not carried across. This document describes the final target;
uncompleted acceptance work is listed below.

## The behavior that matters

**Press the button or say the wake word, then speak immediately.** Capture must
already be running. Neither network setup nor OpenAI call acceptance may remove
the opening words, even when the whole request finishes before the call opens.

The path is:

**Local activation → captured PCM → device stream → GPT-Live → speaker queue.**

There is one model, GPT-Live-1, and one voice protocol. A new ESP32 board supplies
hardware facts and callbacks. It does not implement a different conversation,
upload loop, provider adapter, or playback policy.

## Ownership

| Owner | Responsibility |
| --- | --- |
| Board | Pins, codec/DMA, physical mute and volume, AEC/reference, buttons, display and other hardware |
| ESP application loop | Local intent and coordination of its capture/playback tasks |
| Mac CLI | Native audio and transport ownership; the same framing, flush and playout policies |
| Shared C core | Wire contract, microphone flush decision, bounded playout and normalized controls |
| Voice stream processor | Durable conversation state, the OpenAI connection, held input, continuous input clock and delegation |
| Reduced face state | PCM-derived visemes; local playout remains the timing authority |

Keep native queues and task ownership. Do not add a generic uploader, queue
framework, durable audio journal, provider hierarchy, or replay protocol.

## Capture and cancellation

- Capture continuously at the codec; retain only 500 ms of processed local
  history while idle. Upload starts only after activation. Physical mute clears
  history and closes capture without stopping the hardware reference clock.
- Start on the debounced button-down edge or wake detection. Preserve history
  when activation occurs during a microphone read. Chimes cannot block or erase
  this speech; prove the actual board path before enabling audible feedback.
- Give each idle-to-active transition one random activation ID in RAM. A second
  press within the same conversation does not create a new activation.
- Send microphone events as `{ activation, pcm }`. Send one authoritative
  `conversation-ended { activation, reason }`, including before call acceptance.
  Downstream accepted, speaker and terminal events must match the activation.
- Local release drains the captured tail. End and mute discard unsent audio and
  invalidate in-flight capture. Late audio or callbacks from A cannot start or
  alter B. There is no post-hangup time-based suppression.
- Preserve definitely unsent audio through ordinary mounting and backpressure.
  Never reset the FIFO just because a transport mounted or OpenAI accepted.
  Do not claim delivery acknowledgement that the transports do not provide.

## Bounds and latency

| Setting | Final starting budget | Reason |
| --- | --- | --- |
| Device opening | 20 s from activation | One finite attempt, including connection and provider acceptance |
| Backend opening | 15 s from first frame | Includes socket upgrade and `session.started` |
| Held input | 21 s PCM16 mono / 16 kHz = 672,000 bytes per owner | Covers the opening deadline and pre-roll; verify actual PSRAM headroom |
| First device append | Immediately when stream and headroom permit | Never wait for a full batch or provider acceptance |
| Normal partial append | At most 50 ms between flushes | Low latency without 50 individual stream appends per second |
| Catch-up append | At most eight 20 ms frames | Existing transport headroom limits backlog drainage |
| Speaker priming | Existing 300 ms starting value | Lower only with paired latency and underrun evidence |

There are two connection waits, so there are two held-input queues: one local
and one while OpenAI opens. Each has a byte/time bound and one owner. Full queues
fail the activation with a classified reason; neither prefix nor tail is
silently trimmed. Allocation failure must be visible before claiming readiness.

The shared microphone function decides only when and how much to flush. A full
backlog drains on each eligible pass; the final partial batch drains on release.
On `session.started`, the backend forwards its FIFO synchronously and in order,
without waiting for new input or adding a replay timer.

An open GPT-Live session requires continuous input. Keep one dial-owned backend
loop supplying elapsed-time digital silence when device input is quiet. It must
stop with that dial, keep catch-up work finite, and never replace held speech.
Synthetic silence is not device liveness. Send a client heartbeat after 20 seconds
without microphone traffic while the call is intentionally open. Share this
policy between ESP and CLI; do not send redundant heartbeats during capture.
An ambiguous established-session loss is an explicit interrupted conversation;
do not silently replay uncertain speech or actions into a replacement session.

## Delete the obsolete concepts

| Delete | Keep |
| --- | --- |
| Grok, provider URLs/model knobs, provider modes and mode NVS/assets | Fixed OpenAI endpoint/model/voice and injectable test socket |
| Pickup greetings and greeting detection | Responses to actual captured speech |
| Remote PTT, turn commits/cancels, turn sequence IDs and silence padding | Local physical capture/playout constraints |
| No-op start-call RPC, pending call, launch ladder, cooldown/grace state | Local activation, actual transport readiness and provider acceptance |
| Raw provider-event mirror and its background work | Transcripts, session timing, classified errors and speaker telemetry |
| Scheduled callback recycling and dead counters | Registration and proven failure recovery |
| Duplicate board prose, identities and product defaults | One stable board identity and actual hardware facts |
| Duplicate proof scripts and provider matrices | File-backed baseline, host, board and failure proofs |

A field or helper earns its place only if a current caller needs it. Delete
obsolete tests with obsolete behavior; retain regressions for actual failures.
Replace historical comment essays with short descriptions of current invariants.

## The ordinary new-board path

Copy the smallest supported board with the same codec. Four small files are the
normal source/config addition:

1. `devices/<name>/<name>_device.c`: hardware table, necessary callbacks, entry.
2. `devices/<name>/CMakeLists.txt`: source and direct dependencies.
3. `targets/<name>/CMakeLists.txt`: shared build plus this device.
4. `targets/<name>/sdkconfig.defaults`: chip, flash, PSRAM and wake-model facts.

Reuse existing codec, volume, button, LED and face implementations. A BSP-owned
display, servo or shared-clock fence can justify an extra hardware callback.
No edits to the voice loop, GPT-Live processor or wire contract should be needed
for a conventional new board such as a supported stopwatch-style ESP32 device.
Installer publication separately records artifacts and hashes in its catalog.

HAVPE and Satellite1 retain XMOS AEC. StackChan retains its real DSP/reference
path. M5StickS3 retains its shared-clock capture/TX fence; Waveshare retains local
hold-to-talk and playout exclusion until AEC is proven. One fixed hardware fact
replaces selectable turn modes. GPT-Live does not remove acoustic limitations.

## Migration and proof

Update firmware, CLI, mobile, raw wire tools and backend together. This is one
contract change, with no permanent old/new adapter. Install matching artifacts
on an isolated test deployment before touching existing clients. A shared guest
upgrade can affect other streams on their next cold start; a different stream
name alone does not isolate the deployed code.

Face data stays in reduced runtime state. The C client uses direct
`getProcessorRuntimeState`, so the browser LiveState delta change does not require
a second C decoder. Verify monotonic updates and playout-aligned consumption.

Acceptance remains open until these are demonstrated:

- [x] Rebase the selective firmware consolidation onto the latest GPT-Live PR.
- [x] Share first/50 ms/tail microphone flushing between firmware and CLI.
- [x] Preserve a complete pre-mount utterance and fence A → end → B.
- [x] Remove board provider modes while retaining volume and real hardware controls.
- [x] Cover activation during an in-flight capture, mute, opening timeout and overflow.
- [x] Finish provider/config/launch/turn deletions and update every consumer.
- [x] Run focused behavior tests, all host tests and all five fresh ESP builds on the final source.
- [ ] Complete required repository checks and review the final changes with Claude Fable 5.1 xhigh.
- [ ] Deploy an isolated preview; verify coherent state, traces and failure classification.
- [ ] Measure capture-to-first-append, provider-first-output and output-to-playout separately.
- [ ] Prove HAVPE wake and digital audio flow with no speaker output from HAVPE or Mac.
- [ ] Update PR #2624 and resolve CI/review feedback. No merge is requested.

The no-sound constraint applies to every hardware transition, including OTA,
restart and rollback. File-backed tests and passive health inspection are safe.
A silent firmware image alone does not prove that installing it is silent.
Acoustic wake/AEC/audible-quality measurements remain separate from a digital
fixture proof and must not be reported as completed by it.

Historical input snapshots and the initial adversarial review are preserved in
[the source inventory](2026-09-11-gpt-live-simplification-evidence.md) and
[the original review](2026-09-11-gpt-live-simplification-review.md). They explain
prior decisions; current source and fresh verification establish completion.
