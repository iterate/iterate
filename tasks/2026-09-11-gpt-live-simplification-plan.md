---
state: done
priority: high
size: large
tags: [voice, firmware, gpt-live]
---

# One GPT-Live voice path, five boards

This final design replaces provider selection, remote push-to-talk policy, turn
commits, and the old launch ladder with one continuous GPT-Live path. The full
planning/review chronology is preserved at
[`backup/futurehomes-gpt-live-reviewed-20260912`](https://github.com/iterate/iterate/tree/backup/futurehomes-gpt-live-reviewed-20260912)
(`192b779c`).

## Product behaviour

A wake or local start begins capture immediately, including while stream and
provider are opening. The board retains its bounded processed pre-roll and
opening FIFO, then sends it once the call is ready. GPT-Live receives 16 kHz
mono PCM continuously for the call. Backend elapsed-time digital silence is
required by the WebSocket path; deleted code was client turn padding, commits,
response-create choreography, greeting and launch state.

Local end, remote end and mute fence the current activation, clear its queued
speaker audio/capture as explicitly classified, and prevent old callbacks or
audio from starting a later call. Physical mute and codec/reference clocking
remain hardware facts. PTT is not product state on any board.

## Ownership

| Layer | Owns |
| --- | --- |
| Board | Pins, codec/I2C setup, I2S format/clocks, PA/mute, wake hardware, controls and display facts. |
| Shared firmware | Activation fencing, opening buffering, PCM framing, speaker queue/prefill and health counters. |
| VoiceAgent | One GPT-Live connection per call, continuous audio bridge, transcripts and call lifecycle. |
| Ordinary Agent | Project work and durable results on that same voice stream. |

Boards do not choose a provider, model, PTT policy or product conversation
mode. A new board adds fixed facts and codec setup, then uses the shared call
loop; it needs no model/voice edit.

## Required invariants

- Each activation fences microphone, accepted-call, speaker, terminal and
  Agent-update events.
- Capture never waits for mount, acceptance or Agent work. Only a real end
  discards unsent opening audio.
- Pre-roll/opening queues are byte-bounded. Overflow ends the activation with
  a durable reason; it never silently loses a speech prefix.
- Provider pacing and the local speaker queue own output timing. Device
  playout, not a server frame, is the local delivery boundary.
- Ending a call does not infer cancellation of independent Agent work.

## Hardware facts retained

| Board family | Constraint |
| --- | --- |
| HAVPE | Keep XMOS/reference routing, PA/mute ordering and WakeNet handoff. |
| Satellite1 | Keep its XMOS 48 kHz physical/DSP plane; no second AEC. |
| M5StickS3 | One shared duplex I2S owner and compatible codec clocks. |
| StackChan/Waveshare | DMA colour buffers remain owned until completion; display failure cannot reuse them or stall audio. |
| All | Speaker playback never replaces microphone capture; physical mute is authoritative. |

## Deliberate deletions

Provider mode persistence and wheel selection; hold-to-talk posture,
PTT grammar/actions/events; remote turn commits; client-generated turn silence;
M5’s competing clock handoff; separate Agent runners/child streams/result-order
matchers/artificial completion and timer-generated progress speech.

## Maintainer checks

When changing this path, inspect the complete activation rather than a healthy
request in isolation:

1. Verify the event carries the active activation and cannot be delivered to a
   successor call.
2. Classify every discarded PCM frame as mute/end/stale/overflow; no generic
   drop counter is an acceptable explanation.
3. Keep board-specific I2S, DMA and amplifier ordering at the hardware edge.
4. Exercise a long output and an immediate new wake after terminal delivery.
5. Build every registered target after shared firmware or board-table edits.

## Acceptance boundary

Prove the stream contract, activation fences, opening prefix, terminal
handling, speaker queue and every target build. A digital fixture proves its
code path, not room acoustics; a build proves integration, not a physical
board. Final evidence and limits are in
[implementation evidence](2026-09-11-gpt-live-implementation-evidence.md).
