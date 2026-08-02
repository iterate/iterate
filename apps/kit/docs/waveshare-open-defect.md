# The Waveshare device: one open defect, with its measurement

Everything else in the voice path measures zero. This does not.

## What it is: STARVATION, not loss

One journey, current firmware:

```
spkPlayed 90   spkConceal 75   spkDiscarded 1   spkOverflow 0
spkSeqGaps 0   spkBadFrames 0  spkCatchup 0     spkDebtPaid 0
```

90 + 75 + 1 = 166. **The accounting balances.** Nothing is silently lost:
the device receives every frame the sender numbers, accepts them all, and
plays every one it has. It simply does not have them in time, so 45% of its
playback is silence it inserted itself.

That is what a listener hears as janky, and it is a THROUGHPUT problem. The
CLI, running the same `audio_playout`, the same `voice_playback_clock` and
the same bounded ring, measures zero concealment on the same conversation.
The difference is the downlink into an ESP32 over Wi-Fi and TLS versus a
socket on a Mac — not any decision in the shared logic.

## The wrong turn, recorded so nobody repeats it

This was read for several hours as "608 frames disappear with no counter
explaining them", which produced two confident and wrong mechanisms (a FIFO
race in the barge-in discard; a tool call bumping the answer number
mid-utterance). Both were disproved.

The reading itself was the error. `spkFrames` is
`voicelab.spk_frames_received`, which RESETS on every voicelab remount.
`spkPlayed` is `runtime.speaker_frames_played`, which never resets.
Subtracting one from the other is subtracting a per-session number from a
since-boot number, and the difference is not missing audio — it is two
different clocks.

Two counters in the same JSON with different lifetimes and no way to tell
them apart is a trap. Either give them the same reset point or say so at
each name.

## What to measure next

Frames arriving per second against the 50/s that realtime needs, over one
answer, from the device pulse:

```
pulse ... batches=N rx=N gaps=0 played=N conceal=N ringMs=N
```

`ringMs` is the tell: it sits at 0 through the whole answer, so the ring
never gets ahead. If `rx` per second is below 50 the downlink cannot keep
up and the fix is upstream (batch size, event size, mu-law on the downlink
as the uplink already uses). If it is above 50, the frames are arriving and
the reader is not keeping up, which is a different fix entirely.

Serial is `/dev/cu.usbmodem11201` — resolve by serial number
`1C:DB:D4:7A:16:C8`, never by port name.
