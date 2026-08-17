# Speaker lane: what is still carrying weight it does not need

Written 2026-08-17, after removing the 640-byte alignment rule from the
`voice-agent2` speaker lane. Findings are ordered by confidence, and each says
what was actually checked, because the point of this document is to be
trustworthy about its own coverage rather than to look thorough.

## The shape to search for

The 640 rule was not dead code. Every line of it ran, every line was tested,
and the tests passed. It was **a constraint invented at one layer and enforced
at every other**: a FreeRTOS queue holds fixed-size items, so `on_speaker_pcm`
required whole frames, so `handle_spk_frame` cut chunks into frames, so an
unaligned chunk became a protocol violation, so the server had to carry a
remainder between deltas and pad every answer's tail with silence — and when it
slipped, 118 chunks were dropped in three turns.

Nothing was wrong at any single site. The cost was in propagating a local fact
across four layers and two languages, where it turned into a wire rule that the
audio source (a provider whose deltas are of no particular length) could not
satisfy.

So the thing to grep for is not unused code. It is **a fact that one layer knows
being enforced somewhere that only inherited it.** Searching for dead symbols
found nothing; every counter checked below is live.

## 1. `enc` is written by both ends and read by neither — VERIFIED

A codec negotiation field for a protocol that now has one codec.

|                 | writes                                             | reads |
| --------------- | -------------------------------------------------- | ----- |
| firmware uplink | `voicelab_stream.c:1036` — `"enc":"p"`             | —     |
| server downlink | `voice-agent2.ts:982, 1336, 1360` — `enc: "pcm16"` | —     |

Checked by grep in both trees: the firmware contains no read of `"enc"` at all,
and `voice-agent2.ts` contains no branch on it. It also occupies two zod schema
entries (`:418` optional on the mic frame, `:474` required on the speaker
frame) and one test assertion.

It had a job until mu-law came out: the server branched on `enc === "u"` to
decide whether to expand the uplink. That branch is gone. What is left is a
string constant travelling in both directions several thousand times a call.

**Cut:** both schema entries, three literals, one printf fragment, one test
assertion.

**Risk: v1 still reads it, and reads it wrong.** `voice-agent.ts:3175` is the
one live reader in either tree:

```ts
call.offer(event.payload.enc === "u" ? mulawToPcm16(bytes) : bytes, this.deps.now());
```

The firmware now sends `"p"`, so this branch already takes its else arm — v1 is
correct today only by accident, and would break the moment anything sent `"u"`
again. That makes the field worse than dead: it is a live conditional on a value
the sender no longer produces.

Removing `enc` from the shared contract is therefore also the v1 cleanup. Since
the two tracks share the contract slug, do them together or not at all.

## 2. The high-water catch-up rule cannot fire — VERIFIED UNREACHABLE

`voice_playback_clock.c:169` drops a frame periodically once the backlog passes
`ITERATE_KIT_VOICE_SPEAKER_HIGH_WATER_MS` (9,000 ms = 288,000 bytes).

`voice-agent2.ts` caps the device at `MAX_DEVICE_SPEAKER_BACKLOG_BYTES` =
128,000 bytes = 4,000 ms. The rule needs the server's model of device memory to
be wrong by more than five seconds before it does anything.

The profile's own comment already says so, and says more than that
(`voice_device_profile.h:135`):

> Backlog beyond which a frame is skipped to catch up — **effectively never, and
> deliberately so.** [...] Lateness is measured against the audio timeline
> instead — see `ITERATE_KIT_VOICE_SPEAKER_LAG_CATCHUP_MS`, **which is the signal
> this one was standing in for and getting wrong.**

So the file states that this mechanism was superseded, names its replacement,
and keeps it. Worse, the two have opposite shapes: the high-water rule drops one
frame every N (gradual trim), and the comment above the lag rule
(`voice_playback_clock.c:135`) argues at length, with measurements, that gradual
trimming is the wrong shape:

> The first version of this dropped one frame in fifty — 20 ms recovered per
> second — which is the right shape for trimming slow clock drift and hopeless
> against a stall. Measured: 3.1 s of lag, three frames dropped, 60 ms
> recovered.

**Cut:** the second branch of `iterate_kit_voice_playback_clock_frame`,
`clock->next_catchup_at_frame`, `ITERATE_KIT_VOICE_SPEAKER_CATCHUP_EVERY`,
`ITERATE_KIT_VOICE_SPEAKER_HIGH_WATER_MS`. **Risk:** it is the only backstop
against the server's memory model being badly wrong, and that model is explicitly
documented as carrying error nobody can measure. Prefer measuring a long call
with the counter instrumented before deleting — if it has never fired on
hardware, it is not a backstop, it is a comment.

## 3. Two device constants are sized against a sender that no longer exists — VERIFIED STALE

`voice_device_profile.h` sizes the speaker ring and the prefill against v1's
pacer, by name and by arithmetic:

- `SPEAKER_BUFFER_BYTES = 320000`: _"the server releases at playback rate with a
  bounded lead (`leadMs`, 3 s — see the speaker lane in the voice-agent config).
  Ten seconds is that lead plus seven of margin."_
- `SPEAKER_PREFILL_BYTES`: _"The facet's pacer releases an opening burst of 150
  frames — three seconds of audio — the instant an answer begins."_

Neither is true of `voice-agent2`. There is no `leadMs`; the budget is
`MAX_DEVICE_SPEAKER_BACKLOG_BYTES` (4 s, not 3), and the opening burst is
whatever fits that budget, not 150 frames. `leadMs: 3_000` was itself part of the
v1 stutter root cause.

The numbers still work — 4 s of lead inside a 10 s ring leaves 6 s of margin
instead of 7 — but the _reasoning_ is load-bearing and now wrong, and one of
these comments is an instruction: **"DO NOT SHRINK THIS BELOW THE SENDER'S
LEAD."** A future reader shrinking the ring will check a lead that no longer
exists.

**Cut:** nothing. **Fix:** re-derive both comments against v2's budget. This is
the cheapest item here and the one most likely to cause a real bug if left,
because it misleads rather than merely costing bytes.

## 4. `ITERATE_KIT_VOICELAB_FRAME_BYTES` now means something narrower — VERIFIED

After the alignment removal it has exactly one non-test use
(`voicelab_stream.c:1008`), a bound check on the **uplink**: a captured mic frame
may not exceed 640 bytes. That is real and correct — it is the microphone capture
size.

But it is still named and documented as the wire frame for both directions, and
it is still the size of `speaker_partial` in `voice_loop.c`, where it means the
speaker queue's item size. Three different facts share one constant: mic capture
length, speaker queue item size, and (historically) the downlink wire unit. The
third is gone; the first two are unrelated to each other and only coincidentally
equal.

**Fix:** let the speaker side use `FRAME_BYTES` from `voice_loop.c` (which it
already has) and leave the voicelab constant to the uplink, with a doc comment
that says uplink.

## 5. Already fixed in this pass, recorded so it is not re-litigated

`spk_frames_received` counted once per 640 bytes, so one `spk-frame` event could
increment it four times. It now counts one per event carrying audio, which is
what the name always claimed. Test expectations moved 8 → 5 accordingly.

## What was checked and found clean

- **Instrumentation counters.** `spk_seq_regressions`, `spk_seq_missing`,
  `spk_decode_failures`, `speaker_bad_frames`, `hold_unavailable`,
  `answers_superseded_midplay`, `speaker_underruns` — all have live non-test
  readers. No dead telemetry.
- **The pacer itself** (`#sendSpeakerAudio`). It already reasoned in bytes and
  needed no change for variable-length frames. The deadline-not-sleep design and
  the clamp-to-now guard both still earn their comments.
- **The clear path.** `voice-agent2.ts:983` appends directly rather than through
  the drain loop, so a barge-in does not wait behind a sleeping pacer. Send-time
  sequence minting plus JS run-to-completion means the clear can never be
  ordered before the audio it cancels — checked against both `await` points in
  the loop.

## Coverage

This looked at the speaker lane specifically: `voicelab_stream.c`,
`voice_playback_clock.c`, the speaker half of `voice_loop.c`,
`voice_device_profile.h`, and `voice-agent2.ts`. It did **not** examine the mic
path, the AEC/VAD chain, the capture bridge, the itx mount, or the host CLI's
recording and fault-injection harnesses. The `enc` finding suggests the mic path
is worth the same treatment.
