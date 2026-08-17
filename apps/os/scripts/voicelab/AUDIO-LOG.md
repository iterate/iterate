# Audio lane work log

Running record of what was changed, what broke, and what proved it. Newest last.
Every entry names the test that would have caught the thing, because "fixed" with
no failing test first is a guess that happened to work.

---

## 2026-08-10 — the buffer was on the wrong side

**Symptom.** "I just asked HAVPE to count to 100 and it went terribly. It's mega
buggy." Speech chopped, sped up, then silence.

**Root arrangement.** The device's ring had been grown to 30 s / 960 KB, with a
comment arguing the case honestly: the sender did not pace, so "the ring is not a
cushion any more — it IS the answer". A microcontroller had become the buffer for
a server that would not wait, and the catch-up / high-water / lag-skip machinery
around it was all compensation for that one missing wait.

**Change.** The buffer moved to the server as a pure reducer plus a release
schedule (`config-repo/speaker.ts`): no clock, no timer, no I/O, no codec, every
function takes `now`. The facet runs one drain loop that sleeps exactly
`nextWakeMs`. The device's whole policy became: clear on `drop`, write the audio,
release the fence on `last`.

**Deleted.** `audio_playout.c` — 230 lines of answer numbering, high-water marks,
abandoned-answer latches and restart detection, three of whose bugs had silenced
a board permanently. The wire payload went from
`{conversationId, answer, frame, seq, t, enc, drop, last, pcm}` to
`{conversationId, pcm, drop?, last?}`. Events fell from 50/s to ~3/s.

### Bugs found, each with the test that names it

| #   | Bug                                                                                                                                                                                                                                                                                                                                                                                                                                           | Caught by                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | **The 60-second guillotine.** The idle deadline measured "somebody spoke" from provider traffic. The provider dumps a 90 s answer in a few seconds then goes quiet, so the countdown ran unopposed and ended the call _mid-sentence_. Measured: **63 s of 90 s delivered**, then `conversation-ended: no utterance from either side for 60s`. A count to 100 could never have finished. Pre-dated the redesign; pacing made it deterministic. | `count-to-100.test.ts` → "is not guillotined by the idle deadline while it is still speaking" |
| 2   | **An answer whose tail was a fraction of a millisecond could never close.** `floor(0.875) * 16 == 0`, so `pendingBytes` never reached zero, so the completion branch never fired, so `last` was never sent — a device waiting forever on an end already decided. Introduced by this change; caught by an existing test.                                                                                                                       | `speaker.test.ts` → "closes an answer whose tail is a fraction of a millisecond"              |
| 3   | **A bare closing chunk carried `drop`.** A response created that produces no audio (tool-only or aborted turn) told the device to clear the _previous_ answer's unplayed tail.                                                                                                                                                                                                                                                                | `speaker.test.ts` → "does not tell the device to clear when an answer produced no audio"      |
| 4   | **Chunks were not whole wire frames.** Both device consumers reject any PCM length but 640, so a 21 ms chunk left a millisecond the board could not place. Chunks are now quantised and an answer's tail is **padded with silence**, never truncated.                                                                                                                                                                                         | `count-to-100.test.ts` → "hands over ninety seconds of speech without losing a word"          |

### Also

- `HOSTED_EPHEMERAL_EVENT_LIMIT` deleted. Ten was "a fifth of a second of audio",
  a number about a lane that no longer exists, and a count is the wrong unit;
  `DELIVERY_BATCH_BYTE_LIMIT` bounds a batch in bytes and was doing the work.
  **Correction to an earlier claim of mine:** it never throttled the boards. It
  governs hosted _facet_ callbacks; devices are session connections.
- Device ring 960000 → 320000 bytes. Two tests refused to be lied to about that
  and were right to — the CLI profile test ("never edit the assertion: the rig
  must follow the board") and the playback clock's deep-queue case, whose
  twenty-second premise was the old arrangement written down.

### Verified

apps/os 2983 passed / 278 files · firmware 61/61 (chunk fan-out mutation-checked)
· lint and typecheck clean. **No hardware** — proven by deterministic simulation
against a modelled board with the board's real bounds (a ring that refuses writes
when full and counts drains that found it dry, because a file sink accepts
everything and makes a run that lost a second sound perfect).

---

## 2026-08-11 — a provider a test can control

**Why.** A real provider is a bad oracle. Its answers vary in length, its deltas
land wherever they land, and "count to one hundred" costs ninety seconds of wall
clock per run. Every audio question worth asking — did anything stutter, overrun,
underrun or speed up — is arithmetic if and only if the provider says exactly
what the test asked for, for exactly as long.

**Change.** `events.iterate.com/voice-agent/created` — the birth certificate —
gains an optional `providerBaseUrl`, folded into `birthCertificate` state and
read at the dial. `setupVoiceAgent({ providerBaseUrl })` sets it.

Chosen over a per-call option deliberately: it is appended once, folded, and
therefore survives the eviction that a per-call option would not. The dial also
reads it from the FOLD rather than a field, because a field would be empty in
exactly the incarnation that needs it — the revived one dialling from the at-head
pass — and that call would silently go to x.ai instead of the mock.

**Safety.** The URL was pinned precisely because a caller-chosen one is a bearer
token waiting to follow it somewhere it should not go. That risk is real and the
answer is not "trust whoever wrote the event": the `Authorization` header is
attached **only when the host is x.ai**. Anything else gets the dial and no
credential. A mock never needed the key, so the seam costs nothing, and the worst
an attacker can do by writing this field is talk to their own empty socket.

**Tests.** `voice-agent.provider-url.test.ts`, 7 cases. Four are about the
credential and assert on the OUTGOING REQUEST, not the returned socket — a test
that checked only the socket would pass just as happily while the key went to
the attacker's host. One of them walks hosts that merely _look_ like x.ai
(`api.x.ai.evil.com`, `x.ai.attacker.test`, `evil.com/?a=api.x.ai`). Mutation-
checked by replacing the host equality test with `url.includes("x.ai")` and
watching it fail with `leaked to https://api.x.ai.evil.com/v1/realtime`.

**Verified.** config-repo 158 passed · lint 0 · typecheck clean.

### Next, and why it stopped here

The seam is in but nothing uses it yet. The intended rig, in order:

1. **In-process, no tunnel.** `fake-grok.ts` already speaks the protocol and
   already has the two knobs that matter — `answerSeconds` and `burst`, i.e.
   exactly the count-to-100 shape. Its request handler is currently a closure
   inside `startFakeGrok`, built for captun. Lifting it out so a test can call
   it directly and hand `response.webSocket` to an injected `dialGrok` gives a
   real facet talking the real provider protocol over a real socket, with no
   deployment and no hardware. That is the next commit.
2. **Deployed, through captun.** `startFakeGrok()` publishes at
   `https://<name>.tunnels.iterate.com`; `setupVoiceAgent({ providerBaseUrl })`
   points a preview at it. Same assertions, now across the real network.
3. **The four boards**, against that same mock, so "stutter" is a counter
   rather than an impression.

Assertions are the same at every level, and they are the ones a listener would
make: every byte arrived, in order; nothing was refused at the device's door;
no drain found the ring dry after playback began; and handing the answer over
took as long as saying it. The device model in `voice-agent.count-to-100.test.ts`
already computes all four — a file sink cannot, because it accepts everything
and makes a run that lost a second sound perfect.

---

## 2026-08-11 — the same proof, with the network put back

**Why.** Every assertion the count-to-100 test makes is made in one process
against an injected socket. Between that and a listener there is a deployed
worker, a Durable Object, an ephemeral delivery lane and a WebSocket across the
Atlantic, and each of them is somewhere the pacing could be undone with no test
noticing: delivery could coalesce a paced answer back into a burst, the object
could evict mid-answer, the client's socket could hold frames and hand them
over in a lump. So: step 2 of the rig in the entry above — deployed, through
captun.

**What runs.** `paced.ts`, a new voicelab command. It publishes `fake-grok` on
a captun URL, points a preview's facet at it with
`setupVoiceAgent({ providerBaseUrl })`, presses the button, and records every
`spk-frame` with its **arrival wall-clock time** and decoded mu-law length.
That trace is then replayed through the same modelled board — ten-second ring
that refuses writes when full, counts drains that found it dry.

Replayed rather than driven live, deliberately: a 20 ms ticker in a Node
process that is also decoding base64 and servicing a WebSocket measures Node's
timer jitter as well as the server's pacing.

```
doppler run --config preview_3 -- pnpm cli voicelab paced \
  --project marginal-1 --answer-seconds 90
doppler run --config preview_3 -- pnpm cli voicelab paced \
  --project marginal-1 --answer-seconds 10 --turns 4
```

### The bug it found on its very first run

| #   | Bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Caught by                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 5   | **The deployed guest could not be built at all.** `installVoiceAgent` carried a HAND-WRITTEN list of the modules to commit beside `voice-agent.ts`. The speaker rewrite extracted `speaker.ts`; nobody added it. Every project deployed since has answered `Failed to resolve './speaker.ts' from voice-agent.ts: file does not exist` at its cold start. A second copy of a list the source already contains — the exact drift `voice-agent.ts` warns about for the subscription filter and `consumes`. | `deploy.test.ts` → "carries every module voice-agent.ts imports at runtime" |

Fixed by deriving it: `voiceAgentSources` walks relative imports transitively
from the entry point, so adding an import is the whole change. The test asserts
the committed set is CLOSED under relative imports rather than that it contains
`speaker.ts` — one bug named, the class of bug fenced. Mutation-checked by
dropping the transitive step and watching it report
`viseme.ts imports ./viseme-model.generated.ts`.

The test lives beside `deploy.ts` and not in `config-repo/` because the
in-process harness structurally cannot see this: it imports `speaker.ts` off
the filesystem, so it is green on a repo that could never build.

### Measured on preview_3 (`af61eebf`, project `marginal-1`)

Ninety seconds, one turn — four runs, all four assertions clean:

|                                | run 1       | run 2       | run 3       | run 4       |
| ------------------------------ | ----------- | ----------- | ----------- | ----------- |
| mu-law delivered               | 90.000 s    | 90.000 s    | 90.000 s    | 90.000 s    |
| spread, first frame to last    | **86.87 s** | **86.85 s** | **86.90 s** | **86.80 s** |
| refused at the board's door    | 0 B         | 0 B         | 0 B         | 0 B         |
| underruns after playback began | 0           | 0           | 0           | 0           |
| events                         | 317         | 317         | 318         | 318         |
| peak board occupancy           | 3140 ms     | 2780 ms     | 3300 ms     | 2840 ms     |
| `drop` / `last`                | 1 / 1       | 1 / 1       | 1 / 1       | 1 / 1       |
| first frame after the press    | 1161 ms     | 1125 ms     | 1246 ms     | 1238 ms     |

The provider handed the whole answer over in **0.7 s** (`session 1 open` at
7.3 s, `answer 1 done` at 8.0 s) and the server spent **86.9 s** giving it to
the listener. That ratio — 124× — is the entire claim, and it is the one number
no recording can show: all the bytes arrive either way.

3.2 events/s against the old lane's 50. Peak occupancy sits on the 3000 ms lead
plus delivery jitter, comfortably inside a 10 s ring.

Four turns of ten seconds, one call:

| turn | events | audio   | spread | first frame | peak held | refused | underruns |
| ---- | ------ | ------- | ------ | ----------- | --------- | ------- | --------- |
| 1    | 39     | 10.00 s | 6.67 s | 1313 ms     | 3320 ms   | 0       | 0         |
| 2    | 39     | 10.00 s | 6.93 s | 454 ms      | 3080 ms   | 0       | 0         |
| 3    | 39     | 10.00 s | 6.78 s | 679 ms      | 3220 ms   | 0       | 0         |
| 4    | 39     | 10.00 s | 6.95 s | 418 ms      | 3040 ms   | 0       | 0         |

ONE `call-started` (`4ea54ac8`), ONE provider socket, four commits, four
answers, 40.00 s spoken and 40.00 s heard. The conversation did not re-dial
between turns, and turns 2-4 answer in under 700 ms because the handshake is
already behind them.

### Bug 11 — `conversation.hangUp()` is not a method any board has

Two voicelab scripts called it. The firmware mounts `{"conversation","start"}`
and `{"conversation","end"}` (`components/capabilities/src/conversation.c`),
so every hang-up either of them ever sent came back as `unknown device
capability` — which reads exactly like an unplugged board, and in `paced` was
swallowed by the `.catch` that keeps a teardown from failing a run. Every run
of `boards`, `device --action hangup`, `device --action journey` and `paced`
left its call up to age out on the idle deadline instead. `boards.ts` had it
right all along, which is how it was spotted.

No test names this one: it is a string in a hand-written interface against a
surface that lives in C, and the only thing that can catch it is asking a
board. Both scripts now say `end`, and all three boards hung up when asked.

### One thing left open

The FIRST 90 s run reported **two** provider sessions for one `call-started`,
with the second never committed to and never spoken on — 90.00 s still arrived
whole. All three subsequent runs saw exactly one. The likely shape is the at-head
pass re-dialling a call the fold says is open (which appends no second
`call-started` by design), i.e. eviction recovery doing its job. It is
unexplained rather than explained away: `paced` now prints a per-session line
from the provider's own record, so the next occurrence has a timeline.

**Verified.** `deploy.test.ts` 4 passed (red first, on the real bug) · voicelab
script tests 76 passed / 6 files · typecheck clean · lint 0.

---

## 2026-08-11 — the fake provider, in-process, and the three things it caught

**Why.** Step 1 of the rig two entries up, and the reason it is worth doing
even though step 2 exists: `fake-grok.ts` speaks the realtime protocol, and
every other provider in these suites is a fake written in the test file
alongside the implementation. A double written that way can only ever agree
with the code it was written next to — it sends the events the switch already
handles, because that is what made the test pass the day it was written. All
three bugs below are disagreements about the PROTOCOL, and all three were
invisible to 249 passing tests.

**Change.** `createFakeGrokHandler(options)` returns `{ handler, sessions, log,
note, poke, close }`; `startFakeGrok` is now that plus a captun tunnel and is
otherwise unchanged (same signature, same public behaviour, `paced.ts` keeps
working). The handler takes a `Request` and returns a Response whose
`webSocket` is the client end — precisely what `dialGrokSocket` consumes, which
is what makes it injectable. New file
`config-repo/voice-agent.fake-grok.e2e.test.ts`: the REAL facet, the REAL
provider protocol, a real socket pair, and the count-to-100 board model on the
other end. 15 cases, no network, no deployment, ~8 s.

### Bugs found, each with the test that names it

| #   | Bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Caught by                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 6   | **The answer never ended.** The facet completed an answer only on `response.output_audio.done` — a name that appears NOWHERE else in this repository. The end of a turn as this codebase has always observed it is `response.done`: the retired bridge freed the floor on it, `direct.ts` counts turns with it against the real xAI endpoint, and it is what `fake-grok.ts` sends. So `speakerComplete` never ran, no chunk was ever marked `last`, the device's fence was never released and the mouth stayed open on its last shape — a reply that plays and then a board that has gone deaf. Both existing facet suites send the event the implementation handles, so both were green. | `voice-agent.fake-grok.e2e.test.ts` → "is \`response.done\`, whatever else the provider does or does not send"  |
| 7   | **A refused upgrade was reported as a TypeError.** `dialGrokSocket` tested `response.webSocket === null`, which is true of a platform Response and not of one whose runtime has no WebSockets in it at all — there the property is simply absent, `undefined === null` is false, and the next line threw. `conversation-failed` still landed, carrying `TypeError: Cannot set properties of undefined (setting 'binaryType')` where the reason belongs. Now `?? null`.                                                                                                                                                                                                                    | `voice-agent.fake-grok.e2e.test.ts` → "says so on the stream when the provider shuts the door"                  |
| 8   | **The fake's headline instrument read zero.** It counted mic bytes only from BINARY frames. The retired bridge asked the session for `transport: "binary"`; the facet does not ask at all and therefore speaks json, sending capture as base64 `input_audio_buffer.append`. So against today's bridge every `micBytes` this double reported was 0 — and "the customer heard nothing" becoming "the provider was handed 0 bytes" is the entire reason it exists. It was saying that about a bridge that had handed over every frame.                                                                                                                                                       | `voice-agent.fake-grok.e2e.test.ts` → "holds every invariant on all four turns, on one dial" (`micBytesByTurn`) |

Bug 6's fix is id-aware rather than a second `case` label: `response.created`
records the provider's response id and a completion only closes the answer it
names. xAI OVERLAPS responses rather than erroring (measured, and why the
retired bridge tracked a SET of live ids), so completing on the first
`response.done` to arrive would mark a chunk `last` in the middle of the reply
the listener is actually hearing — and close the speaker, holding every
remaining delta for ever. An unnamed completion still counts: a provider that
names neither cannot be disambiguated, and an answer left open for ever is the
worse of the two failures.

### The provider is now drivable entirely from the URL

Everything above rides `providerBaseUrl` on `voice-agent/created`, so a
deployed facet can be pointed at a misbehaviour without redeploying anything.
Verified rather than assumed — `dialGrokSocket` re-parses that URL to add
`model`, and a re-parse is exactly where a query string gets dropped ("survives
the real dial, which adds a model and changes nothing else": the fake is put
behind `fetch` and the REAL dial makes the trip).

What was missing was the connection layer — the upgrade was instantaneous, so
"slow to connect" could not be expressed at all, only "connects and then
misbehaves". New knobs, each with a test that drives it through the query
string:

| Knob                | What it does                                                                   |
| ------------------- | ------------------------------------------------------------------------------ |
| `upgradeDelayMs`    | hold the upgrade itself before answering it                                    |
| `refuseUpgrade`     | answer with a plain HTTP response and no socket                                |
| `upgradeStatus`     | the status of that refusal (inert on its own — the trap is written next to it) |
| `firstDeltaDelayMs` | time to first token, with `response.created` left on time                      |
| `deltaGapMs`        | spacing between deltas in paced mode, including slower than realtime           |

`firstDeltaDelayMs` is not a synonym for `answerDelayMs`: that one delays
`response.created` too, which is silence with no acknowledgement in it, and not
what a slow model looks like. `deltaGapMs` parameterises a gap that was already
there but derived — 90% of each chunk's own playback time, i.e. always a shade
FASTER than speech, which is why nothing before this could simulate a provider
the listener outruns.

Presets: `slow-connect` (8 s, inside the bridge's handshake deadline),
`dead-connect` (12 s, past it), `refused`, `slow-first-token`, `slow-speech`.
`GROK_HANDSHAKE_DEADLINE_MS` is now exported and the preset test asserts the
two straddle it, so the pair cannot quietly stop meaning anything the day that
number moves. The session record carries the resolved `behaviour`, which is how
a test asserts what `dead-connect` WILL do without sitting through twelve
seconds of it, and `close()` releases any upgrade still being held.

**A knob whose scenario is supposed to fail:** `slow-speech` produces six
seconds of audio in nine, and nothing can pace its way out of that. An underrun
there is the scenario working. Every "no underruns" assertion elsewhere assumes
a provider at least as fast as speech.

### Two things that are NOT product bugs, written down so nobody re-finds them

- **The in-memory pair has no `readyState`.** captun's `WebSocketPair` says so
  itself ("not every WebSocket property"). The facet asks for it on every press
  — deliberately, because a close listener can be missed and a corpse must not
  look alive — so left undefined the second press of a conversation declares
  the socket gone and re-dials, one provider session per press. The double is
  completed in the test (`withReadyState`); teaching the product to do without
  the check would be deleting a real guard to satisfy a fake. Worth knowing
  that the multi-turn test detects exactly this shape of failure.
- **A provider that greets in the same tick as the upgrade loses its
  greeting.** The pair queues what is sent before `accept()` and flushes it in
  a microtask scheduled BEFORE the dial's own continuation, where the facet
  attaches its listener. This is the platform's ordering, not the fake's —
  which is why the fake's `sessionCreatedDelayMs` defaults to 400 and has a
  `greet-instantly` script for proving it. Every test here uses 1 ms.

### On reconciling the two clocks

The facet paces on the harness's VIRTUAL clock and the fake's timers are real.
They are never made to agree: the fake is configured to have essentially no
timers (greet in 1 ms, answer immediately, one burst), every wait in the test
is on a FACT — "the session was accepted", "the provider finished the answer" —
and the deadline tests cross ten seconds on the virtual clock while the real
upgrade is still pending a few hundred milliseconds away. Nothing in the file
waits for a duration; `settleUntil` names what never happened.

**Verified.** `scripts/voicelab/` 249 passed / 15 files (15 new) · `tsc
--noEmit` clean · `oxlint --deny-warnings` 0 · config-repo template typecheck
ok. Each of bugs 6-8 was watched failing first, on the assertion named above.

---

## 2026-08-11 — four boards, and the counter that says the lane is real

**Why.** Step 3 of the rig two entries up: the same four assertions, made by
the HARDWARE. Everything before this was measured on a modelled board fed from
a trace taken in a Node process on a laptop, and everything between that laptop
and a converter is untested by it — the device's delivery lane, its inbox slot,
its base64 decode, its ring, its I2S clock. All four have broken before.

**What runs.** `paced --board <name>` presses the board's OWN button (probing
for it: two of the four have none — the module is mounted only where the
microphone is not open all call), drives the board's OWN stream
(`health().conversation`), and diffs the board's own census across the turn.
`--real` skips the mock and dials x.ai; `--say` speaks the prompt out of the
Mac's speaker, so nothing is injected past the hardware; `--expect` holds the
transcript to a word.

```bash
doppler run --config preview_3 -- pnpm cli voicelab paced \
  --project prj_… --board waveshare --answer-seconds 90
doppler run --config preview_3 -- pnpm cli voicelab paced \
  --project prj_… --board waveshare --real --answer-seconds 120 \
  --say "Count out loud from one to one hundred. Say every number." --expect hundred
```

The four assertions are now made twice — once on the arrival trace, once on the
board — and the board's are the ones that cannot be wrong: `spkFrames` × 20 ms
is what it received, `spkOverflow` is what its ring refused, `spkSoftDryRefills`
and `spkStarvedMs` are the gaps, and health polled every 2.5 s through the
answer gives a spread with nothing of this laptop's clock in it.

**And every frame has to be somewhere.** `spkFrames == spkPlayed + spkCatchup +
spkDiscarded + spkWriteFailures + spkBadFrames` is checked as an identity,
because the bug below hides in exactly the term nobody was reading.

### The fake provider, ninety seconds, one turn, on each board

`--answer-seconds 90 --burst`, so the provider hands ninety seconds over in
under a second and the server has to hold the difference.

| board            | sent     | the board received | it played | refused | underruns | starved | lane spread | board spread | events |
| ---------------- | -------- | ------------------ | --------- | ------- | --------- | ------- | ----------- | ------------ | ------ |
| Waveshare AMOLED | 90.000 s | **90.00 s**        | 90.00 s   | 0       | 0         | 0 ms    | 87.0 s      | 102 s        | 320    |
| StackChan CoreS3 | 90.000 s | **90.00 s**        | 90.00 s   | 0       | 0         | 0 ms    | 86.9 s      | 90.2 s       | 312    |
| M5Stick S3       | 90.000 s | **90.00 s**        | 90.00 s   | 0       | 0         | 0 ms    | 86.9 s      | 90.0 s       | 318    |
| HA Voice PE      | 90.000 s | **90.00 s**        | 90.00 s   | 0       | 0         | 0 ms    | 87.0 s      | 90.4 s       | 319    |

Four for four, on every assertion, with the board as the witness. The provider
finished sending in under a second; the boards took ninety to hear it.

### And the real one, counting to a hundred

Spoken out of the Mac's speaker, heard by the board's own microphone, and the
answer checked against the word `hundred`.

| board            | heard the prompt | counted to  | audio   | board received | it played   | refused | starved | lane spread |
| ---------------- | ---------------- | ----------- | ------- | -------------- | ----------- | ------- | ------- | ----------- |
| Waveshare AMOLED | verbatim         | one hundred | 76.64 s | **76.64 s**    | **76.64 s** | 0       | 0 ms    | 73.6 s      |
| M5Stick S3       | verbatim         | one hundred | 77.28 s | **77.28 s**    | **77.28 s** | 0       | 0 ms    | 74.2 s      |
| StackChan CoreS3 | verbatim         | one hundred | 72.32 s | 72.32 s        | **20.52 s** | 0       | 0 ms    | 69.5 s      |
| HA Voice PE      | verbatim         | one hundred | 70.88 s | 70.88 s        | **23.58 s** | 0       | 0 ms    | 68.0 s      |

The two push-to-talk boards are clean end to end: the count that has failed
every previous attempt is heard whole, at speaking speed, with nothing refused
and nothing starved. The M5Stick logged one `spkSoftDryRefills` in 77 seconds
— one 20 ms software-dry tick with `spkStarvedMs` still 0, which is the
firmware's own distinction between lateness the hardware ring absorbed and a
gap a listener heard.

The two open-mic boards are the exception, and they fail the same way for the
same reason: the next section.

### Four turns of ten seconds, on the mock

| board            | turns clean | received / played per turn | refused | starved | `spkCatchup` |
| ---------------- | ----------- | -------------------------- | ------- | ------- | ------------ |
| Waveshare AMOLED | 4 / 4       | 10.00 s / 9.64–10.00 s     | 0       | 0 ms    | 13–18        |
| M5Stick S3       | 2 / 4       | 10.00 s / 10.00 s          | 0       | 0 ms    | 0            |
| StackChan CoreS3 | 1 / 4       | 10.00 s / 2.08–10.00 s     | 0       | 0 ms    | 0–396        |
| HA Voice PE      | 1 / 4       | 10.00 s / 2.50–10.00 s     | 0       | 0 ms    | 0–375        |

The open-mic columns are bug 9 below. The M5Stick's two lost turns are NOT:
its provider socket closed mid-answer (`conversation-ended — provider socket
closed`, then `provider handshake never completed`), and this run had all four
boards going at once through four separate captun tunnels off one laptop, two
of them streaming continuous open-mic audio into it. Run the open-mic boards
one at a time; the parallel arrangement is measuring the rig.

### Bug 9 — the answer's clock is thrown away with the barge-in nobody believed

**Symptom, on the real provider.** StackChan was handed the whole count to one
hundred — 3616 frames, 72.32 s, nothing refused at its door — and played
**1026 of them**. The listener heard about a fifth of the answer, in pieces.
Every other counter reads perfect: the model said "one hundred", the lane paced
it over 69.5 s, `spkOverflow` 0, `spkStarvedMs` 0.

The frame that closes it is `spkCatchup`: **2590 frames skipped**, with
`spkLagMaxMs` at **643,208** — the device believed it was ten minutes behind.

**Mechanism.** `drop` rides the first chunk of every answer and reaches the
device as `SPEECH_STARTED`. That control does two unrelated things in one
branch of `on_control` (`components/voice/src/voice_loop.c`):

1. throws away whatever is queued (`abandon_speaker_audio`), and
2. **restarts the answer's playout timeline** — `answer_started_ms` and
   `answer_emitted_ms` back to zero.

On an OPEN-MIC board the whole branch sits behind `iterate_kit_barge_in_admit`,
and rightly so for (1): the provider's VAD hears the echo of its own answer,
fires, and an ungated flush stops the reply mid-word (`barge_in.h` has the
measurements). But the gate believes a barge-in only if the microphone was
above 300 within the last **600 ms** — and the first chunk of an answer arrives
one to two seconds after the person stopped talking, so it is refused, every
time, on every ordinary turn.

(2) goes with it. The next answer is then measured against the PREVIOUS
answer's clock: `lag = now - (started + emitted)` is however long ago that
answer ended, the catch-up rule fires on every frame that has audio behind it,
and it "recovers" by deleting the answer.

**The correlation, across every answer measured on the two open-mic boards.**
It is exact — `spkAnswerStarts` moving is the gate admitting:

| `spkAnswerStarts` moved? | answers | `spkCatchup` | `spkLagMaxMs`   | played of what arrived |
| ------------------------ | ------- | ------------ | --------------- | ---------------------- |
| yes (admitted)           | 3       | 0            | 0               | all of it              |
| no (refused)             | 8       | 363 – 2590   | 1,333 – 796,181 | 21 % – 33 %            |

And the push-to-talk boards, which are never gated, skipped nothing on any
answer in any run.

**Why this is the bug behind "it's mega buggy".** The FIRST answer of a session
plays perfectly — `answer_started_ms` is zero, so the lag is zero — and every
answer after it is shredded. That is exactly the shape people report.

**The fix, and why it is not in this commit.** The timeline belongs to the
ANSWER, not to the flush: a new answer restarts its clock whether or not the
device is willing to throw away what is queued. Moving those two stores out of
the gated branch is the whole change, and resetting to zero (rather than to
`now`) is what keeps it correct in the case the gate exists for — the origin is
then taken from the next frame that actually plays.

It is not applied here because it is FIRMWARE: verifying it means flashing four
boards, and there is no host test that can fail on it first — `on_control` is
static, reachable only through a delivered `spk-frame` batch, and the
`voice_loop` host harness (`tests/voice_loop_intent_test.c`) has no way to
deliver one yet. The honest next step is that harness capability, then the test
("a refused barge-in still restarts the answer's clock"), then the fix, then
these same runs again. Everything needed to write it is above: the exact
counters, the exact branch, and a reproduction that is one `paced --board
stackchan --answer-seconds 10 --turns 4` away.

### Four exchanges, one call, on the real provider

Spoken aloud, one prompt per turn, ending with a question only a conversation
can answer: _"What did I ask you about first?"_

| board            | heard all four | answered all four | remembered turn 1 | new calls | frames received vs played |
| ---------------- | -------------- | ----------------- | ----------------- | --------- | ------------------------- |
| Waveshare AMOLED | verbatim       | yes               | **yes**           | 0         | 448 / 443 (5 clipped, t4) |
| M5Stick S3       | verbatim       | yes               | **yes**           | 0         | 444 / 444                 |

> _"You first asked about the color of the sky on a clear day."_ — both boards,
> turn 3, unprompted.

ZERO `call-started` across four turns is the strongest form of the one-call
claim available here, not a missing event: the board was already holding the
call from the previous run and kept it, which is what a conversation is to the
person in the room. `paced` now treats more than one as the failure.

**A rig limitation worth writing down.** On answers of a couple of seconds the
MODELLED board reports dry drains the hardware does not — 3 and 16 against the
Waveshare's own 1 soft refill and 0 starved milliseconds. The model has no
prefill and the board waits 150 ms before its converter takes anything, which
is exactly the ragged opening of a short answer the provider is still
generating. With `--board`, believe the board; the note is in `judge`.

### The open-mic boards, on the same four exchanges

Both hold the CONVERSATION and neither can play it. The HA Voice PE heard all
four prompts verbatim, answered all four correctly — including _"You first
asked about the color of the sky on a clear day"_ — on ONE call, and played:

| turn | frames received | played | skipped to catch up | `spkLagMaxMs` |
| ---- | --------------- | ------ | ------------------- | ------------- |
| 1    | 136             | 136    | 0                   | 0             |
| 2    | 108             | **16** | 92                  | 10,625        |
| 3    | 176             | **29** | 147                 | 27,299        |
| 4    | 36              | **7**  | 29                  | 22,510        |

The first answer of a session plays whole and every answer after it is deleted
as the device tries to catch up with a clock that stopped belonging to it. That
is bug 9, and it is what "mega buggy" sounds like.

StackChan answered turn 1 correctly ("The sky is blue on a clear day") and
played **0.34 s of the 2.24 s** it received — bug 9 again, 95
frames skipped — and then RESTARTED ITSELF during turn 2:

```
resetReason  software
restartNote  hop dead on a ready transport
```

Every counter went to zero mid-run, which is how it was noticed at all: the
census delta read "-160.98s received". `paced` now says THE BOARD RESTARTED
rather than doing arithmetic across two lives. Turns 2, 3 and 4 got nothing;
the call had gone with the reboot and this harness does not re-open one
mid-conversation.

That is a SECOND failure on that board, separate from bug 9 and not explained
by it. `hop dead on a ready transport` is the device's own liveness watchdog
deciding no inbound dispatch had arrived on a socket that still looked up,
which is exactly what turn 2 receiving nothing would produce — so cause and
effect are not separable from one occurrence.

**And it did not recur.** The same four exchanges, run again on StackChan
immediately afterwards, held one call for all four turns with no restart, and
reproduced bug 9 in HA Voice PE's exact shape:

| turn | frames received | played | skipped | `spkLagMaxMs` |
| ---- | --------------- | ------ | ------- | ------------- |
| 1    | 276             | 276    | 0       | 0             |
| 2    | 104             | **13** | 91      | 9,330         |
| 3    | 184             | **30** | 154     | 25,535        |
| 4    | 36              | **5**  | 31      | 23,382        |

Both open-mic boards, twice each, first answer whole and every later answer
deleted. The restart is a separate open question; bug 9 is not.

Worth one more line: by the end of the session BOTH open-mic boards showed
`resetReason software` / `restartNote hop dead on a ready transport` with
uptimes of ten and eight minutes, and both push-to-talk boards were still on
their original `usb` boot after seventy. Whatever that watchdog is reacting to,
it is not reacting to them.

### Bug 10 — a stream cannot be pointed BACK at a provider it has used before

Found while building this rig, and it would have made every measurement above
a lie by lunchtime. `setupVoiceAgent` appended the birth certificate under an
idempotency key derived from its own CONTENT, and the platform deduplicates on
that. A morning of runs alternates mock, real, another mock, real — and by the
second `real` the `{}` key was already taken, so nothing was appended, the
newest `created` the fold could see still named the FIRST mock, and the facet
dialled a captun tunnel that had closed an hour earlier. Silent: the call
simply does not answer.

This is the brief's own bug one field over — `ensureVoiceAgent`'s comment
already describes it ("a prompt that changed and then changed BACK did not
reinstall") — and it takes the same fix: an occurrence per setup, keyed on the
setup's own identity.

| #   | Bug                                                                         | Caught by                                                                                                     |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 10  | The provider a stream dials, changed and changed back, did not change back. | `voice-agent.provider-url.test.ts` → "is a change, not a no-op: every setup writes its own birth certificate" |

Watched failing first, on the real sequence: keys 2 and 4 of `[mock, real,
mock, real]` came out identical.

### One thing left open

On the mock, turns after the first sometimes see the `drop` arrive **two chunks
into the answer it clears** — 400 ms of the new answer already delivered, and
on one occasion 100 ms of it thrown away by the clear when it landed. It is
reported by `judge` now (`the clear arrived N chunks late`) rather than
inferred, because `speakerRelease` puts `drop` on the first chunk it releases
after `speakerReplace` and there should be nothing in front of it. Never seen
on turn 1, never on the real provider, no audio lost on two of the three
occurrences. Unexplained rather than explained away.

### Verified

`scripts/voicelab/` 252 passed / 15 files (3 new) · firmware host tests 61/61 ·
`tsc --noEmit` clean · `oxlint --deny-warnings` 0. Hardware: four boards on
preview-3 (`prj_ef7f3f82…`), every number above measured on the board's own
counters over its own capability, not inferred from the stream.

---

## 2026-08-11 — the answer's clock, and the harness that can fail on it

**Why.** Bug 9 in the entry above was diagnosed and deliberately not fixed:
`on_control` is `static` in `voice_loop.c` and reachable only by delivering a
`spk-frame` batch, and no host test could deliver one. So the honest order was
the harness first, then a RED test, then the fix. That is this entry.

### The harness: the loop, driven from the AUDIO side

`tests/voice_loop_answer_clock_test.c` — a second host executable, because the
loop is a PROGRAM (one file-static, brought up once), so a board that takes
turns differently is a different process. It is `TURNS_SERVER_VAD` with no
capture op, which is exactly an open-mic board one second after the person
stopped talking, and it delivers speaker audio the way the stream does: a
`["push",["pipeline",…]]` at the `processEventBatch` capability THE LOOP
EXPORTED, whose id is parsed out of the `openConnection` the device itself
sent rather than assumed. The witness is `codec_write`.

Getting there needed one honest repair to the pretend ESP-IDF:
`xQueueReceive` charged its whole timeout on EVERY receive, including the ones
that found a frame. That made the modelled speaker spend 40 ms of clock per
20 ms frame — half realtime — so playback accumulated lag it could never have
on a board and the catch-up rule deleted frames to pay for the fake's own
arithmetic. A receive that finds a frame returns at once on hardware, and does
now. (The fakes' README already says to fix the fake rather than reach around
it; this is that.)

### Bug 9, fixed in three places, because it was in three places

| #   | Bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Caught by                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 9a  | **A server-sent `drop` was gated behind a LOCAL barge-in window.** `iterate_kit_barge_in_admit` believes an interruption only if the microphone was above 300 within 600 ms; an answer's first chunk arrives one to two SECONDS after the person stopped talking, so on open-mic boards the whole branch was refused on every ordinary turn — including the timeline reset inside it. The next answer was then measured against the previous answer's clock and the catch-up rule deleted it. | `voice_loop_answer_clock_test.c` → "a later answer plays whole too" |
| 9b  | **Only one of the flush funnel's four callers restarted the clock.** A new CALL emptied the ring and kept the last call's timeline, so the first audio of a new call was measured against an answer minutes old.                                                                                                                                                                                                                                                                              | → "a live answer superseded after a stall"                          |
| 9c  | **Nothing restarted the clock when no `drop` arrived at all.** Measured, not hypothetical: 800 ms of a new answer was delivered ahead of the clear that was supposed to precede it (bug 12 below).                                                                                                                                                                                                                                                                                            | → "audio with no clear at all still plays"                          |

**Why ungating is right, and not merely convenient.** The gate was written for a
`speech_started` that arrived on the provider's OWN event lane, where it really
was a VAD firing on echo the canceller missed. That lane is gone. `drop` is
armed by the SENDER at `response.created` (`beginAnswer` → `speakerReplace`) and
rides the first chunk of the audio it invalidates, so it does not mean "somebody
interrupted", it means "the answer you are holding has been superseded" — and
`speakerReplace` has already destroyed that audio at the source, so refusing the
flush cannot save it. It can only leave a dead answer's tail in the ring in
front of the live one.

9b's fix is the reset moved INTO `abandon_speaker_audio`, which is where the
funnel's own comment says such things belong. 9c's is the device's own local
proof: a ring that has gone dry and settled back to priming is playback standing
at the live edge, so nothing is late — the same argument the catch-up rule
already makes when it refuses to skip into an empty ring.

`bargeIns` and `bargeInsRejected` went with the gate, along with
`runtime.barge_in` and the capture-path observation that fed it. `bargeIns`
counted the `drop` that STARTS an answer, so it moved once per reply whether or
not anything was interrupted — the same fact `spkAnswerStarts` already carried.
`boards.ts`, `paced.ts` and `timeline.ts` read the honest pair instead
(`spkSupersededMidplay` and `spkAnswerStarts`). The `barge_in` module STAYS: the
HA Voice PE's uplink mute (`devices/havpe/havpe_audio.c`) is a live caller and a
sound use — a device must not send its own echo to a provider whose VAD will
read it as an interruption.

**Mutation-checked, one component at a time.** Each of the four moving parts was
reverted separately and each failed on a different assertion: reinstating the
gate → "the answer's number did not advance"; removing the funnel reset → the
superseded answer is deleted; removing the idle reset → the answer with no clear
is deleted; removing the flush → nothing was abandoned.

### On the hardware: the HA Voice PE, which played a fifth of every answer

Flashed with `idf.py flash` (bootloader, partition table and app only — the
provisioning partition is untouched, and these boards are already provisioned
for preview-3). The two push-to-talk boards were deliberately NOT reflashed, so
they are the control.

**The mock, ninety seconds, one turn** (`--answer-seconds 90`, `burst=1`):

| board            | sent | received    | played      | catchup | `spkLagMaxMs` | refused | starved | lane spread | board spread |
| ---------------- | ---- | ----------- | ----------- | ------- | ------------- | ------- | ------- | ----------- | ------------ |
| HA Voice PE      | 90 s | **90.00 s** | **90.00 s** | **0**   | **0**         | 0       | 0 ms    | 87.1 s      | 90.2 s       |
| Waveshare AMOLED | 90 s | 90.00 s     | 90.00 s     | 0       | 0             | 0       | 0 ms    | 86.9 s      | 90.3 s       |
| M5Stick S3       | 90 s | 90.00 s     | 90.00 s     | 0       | 0             | 0       | 0 ms    | 86.9 s      | 90.1 s       |

`problems: []` on all three. The HA Voice PE's previous best on this run was
90.00 s received and 20-30 % played.

**The real one, counting to a hundred**, spoken out of the Mac's speaker into
the board's own microphone:

|               | before (2026-08-11) | after               |
| ------------- | ------------------- | ------------------- |
| received      | 70.88 s             | 76.64 s             |
| **played**    | **23.58 s (33 %)**  | **76.64 s (100 %)** |
| `spkCatchup`  | 2590 – 363          | **0**               |
| `spkLagMaxMs` | 643,208             | **303**             |
| counted to    | one hundred         | one hundred         |

3832 frames received, 3832 played, 0 refused, 0 starved milliseconds, one
`spkSoftDryRefills` in 77 seconds — the same single soft-dry tick the M5Stick
logs on a clean run, which is lateness the 90 ms hardware ring absorbed rather
than a gap a listener heard. `spkLagMaxMs` peaked at 303 ms, comfortably under
the 500 ms at which the catch-up rule would fire: the mechanism is still armed
and simply never had cause.

**Four real exchanges, one call**, ending with a question only a conversation
can answer:

| turn | prompt                                   | received | played      | catchup | discarded | lag |
| ---- | ---------------------------------------- | -------- | ----------- | ------- | --------- | --- |
| 1    | "What colour is the sky on a clear day?" | 13.90 s  | **13.90 s** | 0       | 0         | 0   |
| 2    | "Name three fruits."                     | 4.24 s   | **4.24 s**  | 0       | 0         | 0   |
| 3    | "What did I ask you about first?"        | 5.84 s   | **5.84 s**  | 0       | 0         | 0   |
| 4    | "Thank you, that is all."                | 4.56 s   | **4.56 s**  | 0       | 0         | 0   |

> _"You first asked what color the sky is on a clear day. It was a lovely way to
> start our chat."_ — turn 3, on ONE `call-started`.

The same four turns, before: 136/136, then **16** of 108, **29** of 176, **7**
of 36. That table is what "it's mega buggy" was.

### Bug 12 — the clear is appended LAST, and only from turn two onwards

The four-turn MOCK run is clean on every clock counter (`spkCatchup` 0,
`spkLagMaxMs` 0, `spkStarvedMs` 0 on all four turns) and still loses audio on
two of them — but to a different mechanism, which is why bug 9's fix does not
touch it:

| turn | received | played      | `spkDiscarded` | judge                                      |
| ---- | -------- | ----------- | -------------- | ------------------------------------------ |
| 1    | 10.00 s  | **10.00 s** | 0              | —                                          |
| 2    | 10.00 s  | 9.34 s      | 33             | the clear arrived 4 chunks late (800 ms)   |
| 3    | 10.00 s  | **10.00 s** | 0              | —                                          |
| 4    | 10.00 s  | 8.02 s      | 99             | the clear arrived 11 chunks late (2200 ms) |

This is the "one thing left open" from the entry above, now with a mechanism.
`#drainSpeaker` appends from TWO places and only one of them is ordered:

```ts
void append(...first.chunks.map(…));        // synchronous entry, NOT awaited
if (first.nextWakeMs === null || call.pacerRunning) return;
…
await append(...release.chunks.map(…));     // the pacer loop, awaited
```

From turn two onwards the pacer loop from the PREVIOUS answer is still alive —
it exits only when `nextWakeMs` is null — so the new answer's first chunk, the
one carrying `drop`, is appended un-awaited by the delta handler while the loop
concurrently awaits its own. The un-awaited one can lose, and the clear lands
behind audio it then throws away.

Two things make this a diagnosis rather than a guess. It has **never** been seen
on turn 1, which is exactly the turn with no loop already running. And the
device's offset dedupe proves the inversion is in the APPEND and not in
delivery: an event arriving with an offset it has already passed is skipped
outright, so a `drop` that acted (`spkSupersededMidplay` +1) must have carried
the HIGHEST offset of its group — it really was appended last.

**Not fixed here, deliberately.** The race is between two real promises against
a real Durable Object; the in-process harness resolves `append` synchronously
and cannot reproduce it, so there is no way to watch a test fail on it first.
It also did not appear in any of the REAL-provider runs above — a provider that
produces audio at roughly speech rate gives the pacer almost no lead, and the
mock's `burst=1` is what makes the overlap wide. The fix is an append order
per call that both sites go through.

### Two things this run could not answer

- **The StackChan disappeared.** It answered `boards` and reached
  `transport=ready voicelab=ready gateOpen=true` on the new firmware, then went
  off the USB bus entirely mid-answer and has not come back — `ioreg` shows the
  other three boards and not it, so this is power or a cable and not something
  reachable from here. Its proofs are therefore MISSING; every "after" number
  above is the HA Voice PE's. It is the same board that restarted itself twice
  in the previous session.
- **A mount that vanished for more than twelve seconds.** Two `paced` runs died
  on `stream-subscription-unconfigured: subscription "capability-host" does not
exist` at the FIRST health poll, before anything was pressed, while `boards`
  succeeded against the same board a minute later. `boardHealth` already retries
  twelve times over twelve seconds, so the gap was longer than that. Unexplained.
  (A third failure with the same shape was my own error — the HA Voice PE's
  capability name is `home-assistant-voice-preview-edition`, not `havpe`, and
  asking for a board that does not exist reports it exactly this way.)

### Verified

`scripts/voicelab/` 252 passed / 15 files · firmware host tests **62/62** (one
new, `iterate-kit-voice-loop-answer-clock-test`, watched RED first on
`board.last_admitted_answer > answer_one_number` and mutation-checked in four
places) · `tsc --noEmit` clean · `oxlint --deny-warnings` 0. Hardware: three
boards on preview-3 (`prj_ef7f3f82…`), every number on the board's own counters,
with the frame identity `spkFrames == spkPlayed + spkCatchup + spkDiscarded +
spkWriteFailures + spkBadFrames` checked on every turn.

---

## 2026-08-11 — one append order, and the harness that can lose a race

**Why.** Bug 12 in the entry above was diagnosed and deliberately not fixed,
for the same reason bug 9 was not: no test could fail on it first. The
in-memory stream committed an append inside `append`'s own SYNCHRONOUS body —
it is declared `async`, but nothing in it awaits, so the events are published
and their offsets taken before the returned promise is handed back. Two call
sites therefore commit in the order they CALLED, whoever awaited and whoever
did not, and the entire class of "the un-awaited append lost" was structurally
unreachable. So: the harness capability first, then a RED test, then the fix.

### The harness: an append that commits later, opt-in

`MemoryStream.holdAppend` (`packages/iterate/src/processors/testing.ts`) is a
hook awaited before an append validates anything or takes an offset, so offsets
are assigned at COMMIT the way the Durable Object assigns them. Undefined — the
default — is exactly today's behaviour, and the `undefined` check keeps the
default path free of an await entirely: with no hook installed the method still
commits inside its synchronous body, byte for byte the same as before.

Opt-in per instance rather than a mode, because this harness backs 281 test
files in apps/os alone and silently making every append async would be the
largest blast radius in the repository. Verified as inert rather than assumed:
apps/os 3013 passed / 281 files and `packages/iterate` 365 passed / 37 files,
with only the one new test setting the field.

**A test is expected to DECIDE which append wins**, and the hook is shaped for
that: a race whose loser cannot be pinned is a flake, not a test. Whatever it
waits on must be BOUNDED, because the fix for a bug of this shape is to make
the overtake impossible — and a hook that waits for one forever hangs the suite
that proves it. `makeTheClearLoseItsRace` holds the batch carrying `drop` until
any other speaker frame commits ahead of it, or 200 ticks, whichever comes
first. Broken, it is overtaken at once. Fixed, it is held and still first.

### Bug 12, fixed

| #   | Bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Caught by                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 12  | **The speaker lane had two appenders and one order.** `#drainSpeaker` appends un-awaited from the provider's delta handler and awaited from the pacer's drain loop. Both are RPCs to the Stream DO, and one is always in flight, because a conversation is ONE call across many answers and the previous answer's loop is still alive when the next begins. `speakerReplace` arms `drop` on the first chunk of the new answer, so an inverted append lands the CLEAR behind audio it then discards. | `voice-agent.fake-grok.e2e.test.ts` → "is appended ahead of every chunk of the answer it clears for" |

The test states the invariant in the units of the bug. Answer 2 is exactly six
seconds and exactly one of its chunks carries `drop`, so every millisecond of
it has to be at or after that chunk; anything missing from the run that starts
there was committed AHEAD of the clear. RED it read **2600 ms of the new answer
appended before its clear**. It also asserts its own premise — answer 1 still
part-delivered when answer 2 begins — so it cannot pass on a call that never
had two appenders in it.

**The fix is one FIFO, on the call, and it has to be there** rather than at the
call sites, because the two sites disagree about awaiting BY DESIGN: the delta
handler must not block the delivery lane, and the pacer's await is its
backpressure. Enqueuing is the only thing they can both do.
`GrokCall.inSpeakerOrder` chains both, advancing the tail through a derivative
that cannot reject so a failed append cannot wedge the lane.

**Mutation-checked one site at a time**, and both are load-bearing:

| reverted                | ms of the new answer committed ahead of its clear |
| ----------------------- | ------------------------------------------------- |
| the delta handler alone | 2600                                              |
| the pacer loop alone    | **300** — exactly one chunk overtaking            |
| the harness hook itself | none: the test PASSES with the bug fully restored |

That last row is the claim "no test could fail on this before", measured.

**What it costs the number everybody notices.** Press-to-audio was the one
thing this fix could plausibly regress, so it was measured in the same
configuration the baseline was taken in (`marginal-1`, no board):

|                   | before (2026-08-11)          | after                         |
| ----------------- | ---------------------------- | ----------------------------- |
| 90 s, one turn    | 1161 / 1125 / 1246 / 1238 ms | **1098 / 1200 / 1254 ms**     |
| four turns of ten | 1313 / 454 / 679 / 418 ms    | **1091 / 346 / 442 / 323 ms** |

Idle, the chain costs one microtask; busy, it costs the one append already in
flight into the stream this facet is hosted IN. Neither is visible here.

### A correction to bug 12's own reasoning

"Never on turn 1 — the only turn with no pacer loop running" was half right.
The reproduction shows the DELTA LANE alone inverts without any pacer, on turn
1 as readily as on turn 4. What makes turn 1 harmless is the other half: the
device's ring is empty, so a clear that arrives four chunks late has nothing to
throw away. The pacer is what widens the window, not what opens it.

### StackChan, back on the bus, with the numbers it owed

Replugged, reflashed at HEAD with `idf.py flash` (bootloader, partition table
and app only — the provisioning partition untouched), `resetReason usb`, every
counter at zero. It is the SECOND open-mic witness for bug 9 and the first
hardware witness for bug 12.

**The mock, ninety seconds, one turn** (`--answer-seconds 90`, `burst=1`):

| board            | sent | received    | played      | catchup | `spkLagMaxMs` | discarded | refused | starved | lane spread | board spread |
| ---------------- | ---- | ----------- | ----------- | ------- | ------------- | --------- | ------- | ------- | ----------- | ------------ |
| StackChan CoreS3 | 90 s | **90.00 s** | **90.00 s** | **0**   | **0**         | **0**     | 0       | 0 ms    | 87.1 s      | 90.1 s       |

316 events, first frame 546 ms, peak 3160 ms held, `problems: []`.

**The real one, counting to a hundred**, spoken out of the Mac's speaker into
the board's own microphone:

|                | before (2026-08-11) | after               |
| -------------- | ------------------- | ------------------- |
| received       | 72.32 s             | 77.04 s             |
| **played**     | **20.52 s (28 %)**  | **77.04 s (100 %)** |
| `spkCatchup`   | 2590                | **0**               |
| `spkLagMaxMs`  | 643,208             | **105**             |
| `spkDiscarded` | 0                   | 0                   |
| counted to     | one hundred         | one hundred         |

3852 frames received, 3852 played, 0 refused, 0 starved milliseconds, one
`spkSoftDryRefills` in 77 seconds — the same single soft-dry tick the M5Stick
and the HA Voice PE log on their clean runs, which is lateness the hardware
ring absorbed rather than a gap a listener heard. It is also the only reason
the run reports `ok: false`.

**Four turns of ten seconds on the mock — bug 12's own scenario**, run twice:

| turn | received | played      | `spkDiscarded` | `spkCatchup` | first frame | judge |
| ---- | -------- | ----------- | -------------- | ------------ | ----------- | ----- |
| 1    | 10.00 s  | **10.00 s** | **0**          | 0            | 424 ms      | —     |
| 2    | 10.00 s  | **10.00 s** | **0**          | 0            | 391 ms      | —     |
| 3    | 10.00 s  | **10.00 s** | **0**          | 0            | 427 ms      | —     |
| 4    | 10.00 s  | **10.00 s** | **0**          | 0            | 763 ms      | —     |

One `call-started`, `problems: []`, and not one "the clear arrived N chunks
late" in either run. The same four turns before the fix: 10.00 s / **9.34 s**
(33 discarded, clear 4 chunks late) and 10.00 s / **8.02 s** (99 discarded,
clear 11 chunks late).

**Four real exchanges, one call** (`e338d1f4`):

| turn | prompt                                   | received | played      | catchup | discarded | lag |
| ---- | ---------------------------------------- | -------- | ----------- | ------- | --------- | --- |
| 1    | "What colour is the sky on a clear day?" | 14.80 s  | **14.80 s** | 0       | 0         | 0   |
| 2    | "Name three fruits."                     | 3.76 s   | **3.76 s**  | 0       | 0         | 0   |
| 3    | "What did I ask you about first?"        | 9.04 s   | **9.04 s**  | 0       | 0         | 0   |
| 4    | "Thank you, that is all."                | 7.28 s   | **7.28 s**  | 0       | 0         | 0   |

> _"You asked me about the color of the sky on a clear day, and then to name
> three fruits."_ — turn 3, on ONE `call-started`, unprompted.

The same four turns before: 276/276, then **13** of 104, **30** of 184, **5**
of 36. And no restart: the board that rebooted itself twice in the previous
session held one call through all four turns, twice over, with
`resetReason usb` throughout.

### The push-to-talk controls, after

Deliberately NOT reflashed — they are still on pre-bug-9 firmware, so anything
that moved here is the SERVER side.

| board            | 90 s mock             | count to 100          | four turns of ten        |
| ---------------- | --------------------- | --------------------- | ------------------------ |
| Waveshare AMOLED | 90.00 s / **90.00 s** | 74.16 s / **74.16 s** | 4 / 4, 10.00 s / 10.00 s |
| M5Stick S3       | 90.00 s / **90.00 s** | 73.76 s / **73.76 s** | 4 / 4, 10.00 s / 10.00 s |

Both counted to one hundred verbatim, both `spkCatchup` 0 and `spkDiscarded` 0
on every run. The M5Stick logged 2 `spkSoftDryRefills` in 74 seconds with
`spkStarvedMs` still 0 (its only `problems` entry); everything else reported
`problems: []`.

Worth ONE caution against reading the Waveshare's four-turn line as a fix: it
was 9.64–10.00 s played with `spkCatchup` 13–18 in the previous session, and it
is 10.00 s with nothing skipped now — but that earlier run had all four boards
going at once through four separate captun tunnels off one laptop, which the
log itself already flagged as measuring the rig. These were run one board at a
time. Not attributable.

### Two things still open, and one that did not recur

- **`hop dead on a ready transport` did not happen once** across six StackChan
  runs and about twenty minutes of call time. That is absence of evidence, not
  a diagnosis; the watchdog is unchanged and so is whatever it was reacting to.
- **The vanishing `capability-host` mount** did not recur either. Also
  unexplained.
- The open-mic transcripts still show each prompt TWICE ("What color is the sky
  on a clear day?What color is the sky on a clear day?") — the provider
  segmenting one utterance into two on the open-mic lane. Cosmetic here, since
  the answers are right, but it is the microphone lane and nobody has looked.

### Verified

`scripts/voicelab/` **253 passed / 15 files** (one new) · apps/os in full
**3013 passed / 281 files** (the shared-harness blast-radius check) ·
`packages/iterate` **365 passed / 37 files** · firmware host tests **62/62** ·
`tsc --noEmit` clean · `oxlint --deny-warnings` 0 · `oxfmt` clean. Hardware:
three boards on preview-3 (`prj_ef7f3f82…`), every number on the board's own
counters over its own capability, with the frame identity `spkFrames ==
spkPlayed + spkCatchup + spkDiscarded + spkWriteFailures + spkBadFrames`
checked on every turn.

---

## 2026-08-11 — the echo canceller, measured instead of argued about

Jonas: _"stackchan counting to 100 works but interrupting is super poorly
calibrated… i had to practically shout at it to stop it"_, and then a goal in
three steps — prove the canceller works with no Grok in the loop, calibrate the
interruption, and only then let a real provider's VAD near it.

### The instrument: `voicelab aec`

New command. It puts a known sentence through the board's own speaker from the
FAKE provider (`?speech=<words>`, rendered by this Mac's `say` and cached under
a content hash, so the far-end waveform is byte-identical between runs and
between boards) and records what the board's own microphone sent back up the
same call. Four windows per turn, all from the same minute:

| window   | what is happening                          |
| -------- | ------------------------------------------ |
| `quiet`  | nothing at all — the room floor            |
| `voice`  | the Mac speaks, board silent — the CONTROL |
| `echo`   | the board speaks — the residual            |
| `double` | both at once — the interruption            |

`voice` is the window that makes the rest mean anything. "The residual is -41
dBFS" is not a verdict until there is a number for the customer's own voice
through the same microphone at the same distance, because the question is never
how quiet the echo is, it is how far the voice sits ABOVE it.

Levels alone are not enough either, so every window is also transcribed
(whisper base.en). A canceller can leave a residual that is quiet and perfectly
intelligible, and a transcript is the only instrument that says so.

### Step one: does the canceller work? Yes, on the criterion that was being

### asked, and that turned out not to be the criterion that matters

Across every volume and every turn, whisper read **nothing** of the pangrams
out of the microphone during playback (`[Inaudible]`, `[BLANK_AUDIO]`). No word
of the assistant's own voice ever reached the uplink. On its own that reads as
a pass.

The level says something else. With the room floor at **-70 dBFS rms**, the
microphone during playback sits at **-41 dBFS rms / -31 dBFS peak** — and a
person speaking into the same microphone with the board silent measures **-31
dBFS peak**. The echo residual and the customer arrive at _the same level_.

### Step two: the interruption, and the only table that matters

Same words, same distance, same microphone:

| the board is… | what whisper reads from the uplink       |
| ------------- | ---------------------------------------- |
| silent        | _"Stop talking right now, please stop."_ |
| playing       | _(nothing)_                              |

The spectrograms say what the levels cannot. Alone, the voice is clean harmonic
stacks with silence between syllables. Over the answer, the same syllables are
still faintly there, but the 2.5–3.5 kHz formants have holes punched through
them and the gaps are smeared full of residual. The energy survives; the
intelligibility does not. **No server-side VAD can rescue this — there is
nothing recognisable arriving for it to fire on.**

### What it actually is: the canceller stops converging above volume ~60

The half-second trace of the echo window, which is the whole finding:

```
volume 100   ▃▄▄▃▂▄▃▄▃▂▃▂     never settles
volume  80   ▃▄▄▂▄▄▄▄▄▂▂▃     never settles   ← THE SHIPPED DEFAULT
volume  70   ▃▄▃▂▁▂▁▂▃▁▁      never settles
volume  60   ▃▂▁▁▁▁▁▁▁ ▁      converges after ~1.5 s
volume  50   ▂▁▁▁▁▁▁▁▁▁▁      converges, residual -58.7 dBFS rms
```

and what that does to the interruption:

| volume | echo residual | voice stands above it | whisper, voice over the answer |
| ------ | ------------- | --------------------- | ------------------------------ |
| 100    | -32.0 peak    | +5.5 dB               | _(nothing)_                    |
| 70     | -30.1 peak    | +0.3 dB               | _(nothing)_                    |
| 50     | -46.8 peak    | **+14.4 dB**          | _"…to be right now…"_          |
| 30     | -40.6 peak    | +8.3 dB               | _"…to be right now…"_          |

`stackchan_audio.c:66` ships `SPEAKER_VOLUME_PERCENT = 80` — inside the band
where the filter never converges.

This lines up with a measurement already in this repo from the other side:
`loudness.ts` recorded second-harmonic distortion at **-34.9 dB at volume 60**
and **-16.8 dB at volume 100**. Above ~60 the speaker stops being a linear
device, the echo stops being a linear function of the reference, and no linear
adaptive filter can cancel what it cannot model. Two independent instruments,
same knee.

### One hypothesis killed on the way, cheaply

The first guess was the reference: StackChan feeds its AEC an analogue divider
scaled digitally by 8 (`stackchan_processor.c:34`), and a saturating scale
would hand the filter a lie about what the speaker emitted — which produces
exactly this non-convergence. So the firmware's own counter went into the
report. **`CLIP reference 0 uplink 0` at every volume, every turn.** Not the
reference. Not clipping anywhere: peak sample across all captures is -10 dBFS.

### Bugs in the harness, each one caught by the measurement disagreeing

1. **A "quiet" window that was not quiet.** The first run read the floor at -22
   dBFS and whisper hallucinated "(screaming)" into it. The previous answer was
   still leaving the speaker — the device holds up to the server's lead, so the
   WIRE going quiet is not the ROOM going quiet. Every window now waits for six
   seconds of no speaker frames first, and counts any that arrive inside it.
2. **The barge check read the wrong window.** It looked for the interruption in
   the echo transcript — which has the interruption's own seconds cut out of it
   by construction, so the answer was always "did NOT survive" whatever the
   canceller did. It reads the double-talk window now, with voice-alone printed
   beside it as the control that decides what the answer means.
3. **`--no-transcribe` never arrived.** Commander gives `--no-<name>` its own
   meaning, so the flag landed under a different key and the transcript half of
   the measurement quietly did not run. Renamed `--levels-only`.
4. **A board mid-remount read as dead hardware.** Ending a call takes the
   capability host away for 40–60 s and it comes back on its own — polled once
   a second, uptime runs unbroken through the gap. A twenty-second retry turned
   that recovery into "the board stopped answering", and re-resolving mattered
   too: the stub resolved before the remount stays broken however long it is
   retried. Every board call goes through `onBoard` now.

### Not done

HAVPE is **offline** — its `capability-host` subscription is gone from the
project on both preview-3 and prd, under every name tried. Only StackChan and
Waveshare are answering, so none of the above has been measured on the board
with the XMOS hardware canceller, which is the one that would say whether this
knee is StackChan's amplifier or something shared.

### The change, and what it actually bought

`SPEAKER_VOLUME_PERCENT` 80 → 60, flashed to the StackChan, then measured again
at the shipped default with no override — three turns:

| turn | echo residual | the voice stands | whisper, voice over the answer |
| ---- | ------------- | ---------------- | ------------------------------ |
| 1    | -43 peak      | +11.7 dB         | _(nothing)_                    |
| 2    | -42.7 peak    | +10.4 dB         | _"…right now, please…"_        |
| 3    | -39.8 peak    | +7.5 dB          | _(nothing)_                    |

Against +1.8 to +3.9 dB at volume 80, that is a real improvement and words now
get through on some turns. **It is not a fix.** One turn in three passes the
transcript test, and the honest reading is that the margin moved from "buried"
to "thin".

Whisper is a harsher judge than a voice activity detector, though — a VAD needs
energy in the right band, not intelligibility — so "thin" may still be enough
for the provider. That is what step three is for, and it is the measurement
this entry does not yet have.

### Step three, against the real provider: it does not cancel

`voicelab aec --real --barge`, StackChan at the new default. The command now
prints the only number that is about what the FAR END did rather than what
reached it — how long the answer ran on past the interruption.

```
turn 1   STOP  the answer ran on 6009ms past the interruption  ← NOT cancelled
         BARGE voice stands +2.6 dB above the echo residual    ← BURIED
```

Turns 2 and 3 produced no answer to interrupt (echo window -70 dBFS, i.e.
silence), so this is one clean data point, not three. But that one point agrees
with everything above: at +2.6 dB of margin the provider's detector has two
voices at the same level and does not fire.

Note the margin is WORSE here (+2.6 dB) than against the fake at the same
volume (+7.5 to +11.7 dB). The fake says a fixed sentence rendered by `say`;
Grok's voice is a different signal at a different level, so the echo it leaves
is different. **The fake is the right instrument for comparing two firmware
builds and the wrong one for predicting the real margin.** Any claim about the
real provider has to be measured against the real provider.

### Where this leaves it

- Volume 80 → 60 is a real, committed improvement, and not sufficient.
- The remaining gap is the canceller's double-talk behaviour, not its level:
  esp-sr's `AEC_MODE_VOIP_HIGH_PERF` brings its own NLP, which is what is
  punching holes in the near-end speech. `nlp_level` is documented inert in
  that mode, so the next thing to try is a different mode, and that is a
  firmware change with a measurement already waiting for it.
- **HAVPE is half-connected**, which is why it appeared dead all evening. Its
  serial console shows the voicelab lane reaching `state=ready` and then
  cycling — _"nothing has called this device in a while — re-registering"_,
  `session-ended` with every error counter at zero — while its
  `capability-host` subscription never exists at all. Provisioning is correct
  (preview-3, right project, current key, read back off the flash), it is
  reflashed at HEAD, and it still never mounts. Nothing here has been measured
  on it.

## 2026-08-11 (later) — HAVPE, and why it looked dead all evening

**It was never offline.** Its firmware registers
`/clients/home-assistant-voice-preview-edition`
(`devices/havpe/havpe_device.c:292`); every probe all evening asked for
`/clients/havpe`, which fails as _"subscription capability-host does not
exist"_ — a message indistinguishable from an unplugged board. The board was
sitting there healthy with a 200-second uptime the whole time. `havpe` is now
an alias in `deviceClientPath`, so the name people use is the name that works.

### Its double-talk failure is not StackChan's

First measurement, two turns:

```
double  -120.0 dBFS rms   (3.4s window, and NOT ONE MICROPHONE FRAME IN IT)
ORACLE  raw 485 → clean 372 (-2.3 dB of cancellation), REFUSED 405 frames as echo
```

Two facts, and both matter more than any level in the table:

1. **The XMOS canceller is achieving about 2 dB.** Its own oracle — raw and
   cancelled taps, measured while the speaker was running — says 485 → 372.
   That is not echo cancellation, it is rounding.
2. **The firmware mutes the uplink instead.** 405 and 438 frames refused as
   echo across the two turns, and the double-talk window contains _nothing_ —
   not quiet audio, no audio. The board did not attenuate the interruption; it
   declined to send it.

So HAVPE passes "never picks up its own speaker" perfectly and for the worst
possible reason. A muted uplink cannot carry an interruption either, and the
gate cannot tell the difference between the assistant's echo and somebody
talking over it because with 2 dB of cancellation there is no difference left
to see.

StackChan's problem is a suppressor mangling the near end. HAVPE's is a gate
deleting it. They need different fixes and neither is a threshold.

### The full-duplex mode does not exist here

esp-sr's `AEC_MODE_FD_*` is built for exactly this case and nobody had tried
it. It will not create on this silicon; neither will `SR_HIGH_PERF`. The board
reports `aecMode: 4` — VOIP_HIGH_PERF, where it started.

Finding that out cost two lessons worth keeping:

- **Failing closed bricked the board.** `create_engine` correctly refused an
  engine it could not build, and the consequence was a device that mounted
  nothing at all — and StackChan's USB console prints nothing, so there was no
  way to see why from outside. A reflash recovered it. Failing closed is right
  for the frame cadence; it is wrong for "this mode is unavailable".
- **The probe became the bug.** Walking three absent modes on every
  `processor_reset` kept the capture path missing deadlines: **307 recreates
  against 306 capture-epoch resets in 37 seconds**, where the same board had
  managed 2 recreates in three hours. An adaptive filter thrown away eight
  times a second cannot converge at any volume. Counters are back to 2 and 1.

### Why HAVPE cannot be interrupted, in three constants

`havpe_audio.c`, all in the same capture loop:

```c
CAPTURE_MAKEUP_GAIN              = 16   /* normally */
CAPTURE_MAKEUP_GAIN_WHILE_PLAYING = 1   /* the instant the speaker starts */

if (speaker_is_playing() && !barge_in_admit(&capture_gate, now)) {
  memset(frame.samples, 0, sizeof(frame.samples));   /* the frame is DELETED */
  ++capture_echo_frames_muted;
}
```

with `ITERATE_KIT_BARGE_IN_FLOOR = 300` — an ABSOLUTE peak, in the same int16
units the gain was just taken out of.

Do the arithmetic on the measurement. A person talking to this board reads
**-35.8 dBFS peak200** with the microphone at gain 16. Playback drops the gain
to 1, which is **-24 dB**, so the same voice arrives at about -60 dBFS — a peak
near **33**. The gate wants **300**.

**It is not a calibration problem. It is not marginal. Interrupting HAVPE is
arithmetically impossible**, by roughly 19 dB, and no threshold tuning inside
that structure can fix it — the gain cut and the absolute floor are fighting
each other, and the floor is measured after the cut.

That also explains the -2.3 dB "cancellation" the board's own oracle reports:
raw 485 → clean 372 is being measured on a plane that has already had 24 dB
taken out of it, so both taps are small and their ratio says almost nothing
about the XMOS filter. **The oracle needs re-reading at unity gain before
anyone concludes the hardware canceller is weak.**

The shape of the fix, for whoever picks this up:

1. **Stop cutting capture gain during playback.** It attenuates the echo and
   the customer identically, so it buys nothing against echo and costs
   everything against an interruption. If headroom is the worry, cut less and
   measure.
2. **Make the gate relative, not absolute.** The question is never "is this
   frame louder than 300", it is "is this frame louder than the echo we are
   currently emitting". The board already publishes both taps; the estimate is
   there.
3. **Do not `memset` the frame.** A deleted frame and a cancelled one are
   indistinguishable downstream, which is exactly why this hid for so long —
   every level in every report reads "beautifully quiet".
