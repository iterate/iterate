# Fable review: StackChan PTT/audio publication boundary

Date: 2026-08-01

Reviewer: independent Claude Fable Max background session

`5869114d-a931-41a7-a50b-b2ea38ced6a1`

Reviewed prompt:
`fable-stackchan-ptt-gate-review-prompt-2026-08-01.md`

This is the durable rendering of the background review and our reconciliation.
The raw Claude session remains in the local Claude session store; decisions
below are repository-owned and do not depend on that store remaining present.

## Verdict

Keep the ordered `pcm_capture_turn` design. It is not a local maximum that
needs replacement. The fixed four-edge SPSC command queue makes a successful
start/stop pair observable even when both edges arrive inside one audio wake,
and keeping the AEC task as the sole uplink-ring producer makes
frame-before-marker order structural.

The reviewer required four classes of follow-up before target wiring:

1. Make StackChan's uplink ring agree with the transport freshness policy.
2. Pin the one-control-producer and rejected-stop retry contracts.
3. Correct the stale protocol comment that described zero-length markers as
   downlink-only.
4. Add composed pressure/order tests, including the userspace empty-turn case.

## Findings

### High: StackChan's former eight-frame uplink ring was too small

The M5Stick uses 32 frames (640 ms) and statically ties that capacity to
`ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS`. Eight frames would convert an
ordinary one-RTO network stall into a destructive epoch reset, even though the
shared sender is explicitly designed to survive that interval. StackChan must
use the same 32-frame policy unless measured memory evidence justifies a
different freshness budget. This costs about 15.6 KiB more than eight slots;
the decision must remain visible in its RAM ledger and compile-time assertion.

### Medium: SPSC means one control owner

`iterate_kit_pcm_capture_turn_request()` is not a multi-producer API. Physical
and remote control edges must converge on one cooperative device-event owner.
The owner API must say so. A `BACKPRESSURE` stop was not accepted and must be
retried; conversation teardown must not report success while capture remains
requested. An already-failed AEC task must reject new edges rather than accept
work which can never run.

### Medium: marker-loss recovery needs composition evidence

The intended chain is: marker backpressure requests an uplink epoch reset, the
sender returns restart, the transport replaces its socket generation, and the
userspace marker fence times out rather than waiting forever. Each mechanism
had isolated tests, but a future fault-harness test should exercise the full
chain with `pcm_capture_turn` as producer and prove the next turn contains no
stale items.

### Medium: empty turns must not become empty Grok commits

The edge FIFO deliberately preserves a rapid start/stop as a marker-only turn.
That is a valid capability action, but providers may reject an empty input
buffer commit. Userspace must classify and absorb the empty turn without
creating a response or disconnecting the conversation.

### Low: stale wire comment

`pcm_websocket.h` described the zero-length marker as server-to-device only,
although PCM v1 uses it in both directions. The comment must describe both the
manual-capture boundary and response boundary.

### Adjacent, deferred

The reviewer noticed plain cross-core 64-bit/RMW state in the Waveshare echo
gate (`speaker_last_write_ms`, `speaker_discard_bytes`). That is a separate
target defect and is not a reason to delay the Stick or StackChan vertical
slice, but it must be tracked and repaired before calling the Waveshare audio
path race-free.

## Alternatives considered

- **Keep the four-edge SPSC FIFO (chosen).** Fixed storage, explicit pressure,
  preserves real turn identity, reuses the tested ring primitive.
- **One atomic desired-state word.** Smaller, but it silently coalesces a quick
  press/release and makes a successful RPC scheduler-dependent. Adding a turn
  counter recreates a novel FIFO with a harder proof.
- **Let the control task write the marker.** Rejected: it becomes a second
  uplink-ring producer and can overtake the AEC task's final frame.
- **Gate capture/AEC itself.** Rejected: the filter must remain adapted, and
  per-turn recreation adds allocations and echo-contaminated turn openings.
- **Publish silence while idle.** Rejected: it wastes about 256 kbit/s per idle
  device and can leak silence into the next manually committed turn.

## Reconciliation and actions

Accepted immediately:

- corrected the bidirectional zero-marker comment;
- documented one control owner and mandatory rejected-stop retry at the
  CoreS3 owner API;
- reject PTT requests once the capture owner has failed;
- added a host regression proving a backpressured stop can be retried and
  closes the gate with exact markers;
- added a red-then-green userspace regression that records and absorbs empty
  turns rather than sending `input_audio_buffer.commit`;
- added the physical playback-generation fence so the PCM transport cannot
  admit a new socket generation before the audio owner has purged retained
  samples and the downlink lane;
- StackChan target wiring will use 32 uplink/downlink slots and a compile-time
  equality check against the 640 ms sender freshness budget.

Accepted but deliberately after the first physical StackChan conversation:

- a three-owner pthread grammar stress test;
- the full marker-backpressure → sender restart → generation replacement →
  clean-next-turn fault-harness composition.

Rejected:

- replacing the FIFO with a desired-state bit;
- adding another audio queue or moving markers to the control owner;
- widening this work into the unrelated Waveshare race before the ordered
  Stick → StackChan → Home Assistant landing path.
