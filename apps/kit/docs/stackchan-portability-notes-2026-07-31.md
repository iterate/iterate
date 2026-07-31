# StackChan portability notes — 2026-07-31

Status: implementation input for the post-M5StickS3 hardware slice. This is
not evidence that the Iterate firmware has run on StackChan yet.

## Source boundary

The prior-art checkout was inspected read-only at:

`/Users/jonastemplestein/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec`

Its repository HEAD is `2a7aec9`, but the relevant `firmware-ws/`, tools, and
several documents are untracked or modified worktree state. Those files belong
to another active worker. Kit must not edit or silently depend on that
worktree; facts adopted below have to be copied deliberately into this repo and
covered here by tests.

## Adopt: board and DSP facts

1. CoreS3 has a real hardware echo reference. ES7210 MIC1 is the near
   microphone and MIC3 is wired through an analogue divider across the speaker
   output. Four-slot TDM capture presents those signals at slots 0 and 1. This
   clock-synchronous reference is preferable to reconstructing playback in
   software.
2. The AW88298 must be switched to 64-BCLK-per-frame mode while standard TX
   shares clocks with four-slot TDM RX. The proven operation is a
   read/modify/write/verify of register `0x06`, mask `0x30`, value `0x20`.
3. Use completed TX and RX DMA buffers as the timing authority. Pair
   sequence-numbered 128-sample chunks and skip the older side on mismatch.
   Task wake-up order and blocking codec-call completion are not valid AEC
   alignment clocks.
4. Query the ESP-SR frame size. For standalone `FD_LOW_COST` today it is 512
   samples (32 ms), but the platform contract must not bake that number in.
   Buffers passed to ESP-SR are 16-byte aligned.
5. Start with standalone ESP-SR `FD_LOW_COST`, filter length 4, NLP `AGGR`.
   The full AFE and VC profiles spend RAM/CPU on features this slice does not
   need. Tune NLP only from measured far-end and double-talk evidence.
6. Preserve the synchronized three-channel diagnostic record: raw near mic,
   the actual hardware reference, and AEC-clean output from the same DSP frame.
   The acceptance harness must self-test known-good and known-bad fixtures
   before trusting device ERLE results.
7. Preserve timing and resource observability: last/max/average frame and AEC
   stage time, over-budget frames, TX/RX DMA events and overflow, sequence
   resyncs, task stack minima, internal/PSRAM heap, and every freshness drop.

These facts are supported by the current StackChan `audio_pipeline.c`, its
patched CoreS3 BSP, `docs/aec-validation.md`, and the independently reconciled
reviews in `fable-v2-plan/exploration/stackchan-autopsy.md` and
`fable-v2-plan/exploration/afe-profile-decision.md`.

## Adapt: fit beneath the shared Kit lane

- Add a CoreS3 full-duplex audio owner behind the same platform-facing
  operations the Stick target uses: bind the shared PCM lane, wake on downlink,
  expose capture frames, acknowledge generation fences, and snapshot metrics.
- Keep one owner per clock domain. The highest-priority audio-I/O path only
  services DMA and publishes fixed-size completed chunks. One DSP owner pairs
  chunks, assembles exactly one processor frame, runs AEC, and publishes only
  current clean PCM. Network and Cap'n Web work stay off both paths.
- Convert between the 320-sample PCM-v1 wire frame and the processor's reported
  frame size in fixed caller-owned storage. Reframing is not a history queue:
  incomplete capture/processor frames are discarded and counted across a
  socket epoch, generation fence, or alignment loss.
- Full-duplex capture remains running during speaker output and interruption.
  Interruption cancels and generation-fences provider output without stopping
  the mic/reference clock. This is the existing
  `ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC` policy, not a second StackChan state
  machine.
- Downlink remains the existing 20 ms PCM-v1 lane and direct, device-clocked
  playout. AEC's 32 ms frame does not justify 32/100 ms WebSocket packets.
- Diagnostics use bounded caller-owned sinks. A live metrics callback is the
  normal surface; a synchronized capture may use bounded PSRAM and be pulled
  by a test capability. SD-card persistence remains an outer policy and is not
  part of the audio owner.

## Reject: prior transport and queueing behavior

Do not migrate any of the old provider client or its buffering:

- the 12-second provider output StreamBuffer plus four-second playback FIFO;
- 100 ms uplink/playout chunks;
- tail-drop that preserves stale speech;
- zero-fill without a catch-up/reset policy;
- blocking five-second WebSocket sends on a task that also handles control;
- shared-lock provider TX/RX, per-frame allocation, grow-only event buffers;
- flushes implemented as unchecked `xStreamBufferReset()` calls;
- buffer-empty polling as response lifecycle;
- inflated TCP windows used to conceal application backpressure.

The shared Kit PCM transport already supplies 20 ms frames, separate socket
ownership, generation fences, fixed storage, exact played/flushed/dropped
accounting, age/depth metrics, and reconnect purge. StackChan must use those
properties unchanged.

## Physical acceptance order

1. Flash a fresh Iterate StackChan image without modifying the prior-art
   checkout.
2. Prove TDM slot mapping and 64-BCLK speaker operation from synchronized raw
   captures.
3. Prove deterministic full-duplex loopback through the same local userspace
   `/pcm` bridge used by M5StickS3, with exact frame conservation and automatic
   network-validity classification.
4. Run far-end-only, near-end-only, and double-talk AEC captures. Initial
   gates: far-end ERLE at least 12 dB after 750 ms, reference-correlation and
   transfer-gain reduction at least 6 dB, near-end attenuation no worse than
   8 dB, raw/clean near-end similarity at least 0.80, clipping at most 0.1%.
   The product follow-up tightens near-end damage toward 3 dB.
5. Run real Grok full-duplex conversation and remote interruption. Require
   audible replies, successful spoken barge-in, bounded generation flush, no
   accumulating delay, no unexplained DMA/heap/frame drift, and a
   network-valid evidence interval.
6. Only after this slice is retained, proceed to Home Assistant Voice Preview
   Edition. Face/avatar work remains deferred.
