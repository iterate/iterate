# The Waveshare device: one open defect, with its measurement

Everything else in the voice path measures zero. This does not.

## What was measured

One cold journey, current firmware, device pulse over serial
(`/dev/cu.usbmodem11201` — resolve by serial number `1C:DB:D4:7A:16:C8`,
not by port name):

```
batches=79 rx=758 gaps=0 played=150 conceal=31 under=3 ringMs=0
```

758 frames arrived. 150 were played. The ring is EMPTY. And every counter
that is supposed to explain a missing frame reads zero:

| counter        | value | meaning if non-zero                           |
| -------------- | ----- | --------------------------------------------- |
| `spkSeqGaps`   | 0     | frames the sender numbered that never arrived |
| `spkBadFrames` | 0     | rejected for length or identity               |
| `spkOverflow`  | 0     | refused for want of room                      |
| `spkDebtPaid`  | 0     | dropped to repay concealment                  |
| `spkCatchup`   | 0-1   | dropped to bound backlog                      |

608 frames were accepted by the playout (zero gaps proves `classify`
returned APPEND for all of them), written to the ring, and never came out.

## Where it must be

The only path that removes audio without incrementing anything is the
barge-in discard: `runtime.speaker_discard_bytes`, set by the writer when
`iterate_kit_playout_classify` returns REPLACE, consumed by the reader with
a bare `continue`.

Two explanations were considered and REJECTED, recorded so nobody spends
time on them again:

- _A race between the snapshot and the reader._ No: `StreamBuffer` is FIFO,
  so the old answer's bytes are at the front and skipping N bytes from the
  front removes exactly the old answer, whatever arrives afterwards.
- _A tool call creating a second `response.created` mid-utterance, bumping
  the answer number and superseding the answer being spoken._ Plausible, but
  a stream watcher counted 17 answers across 17 turns with five back-office
  consultations among them — the numbers do not multiply.

## What to measure next

Count REPLACE decisions per turn on the device. `iterate_kit_playout` already
records `replaced`; it is not currently exported in `health`. If it is 1 per
answer the discard is innocent and the loss is in the reader; if it is more,
the writer is discarding audio it should be keeping.

The whole question is answerable on the CLI in seconds — it runs the same
`audio_playout` and the same discard-free reader — which is the point of
having the CLI at all.
