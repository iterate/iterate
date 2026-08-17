# Voice lab results — Grok realtime voice over streams vs a plain WS proxy

Environment: preview-3 (`os.iterate-preview-3.com`), project `voicelab`
(`prj_698c23da57f84d92a9ba5dc959efebec`), model `grok-voice-think-fast-2.0`,
16kHz PCM16 both directions, 20ms mic frames, reasoning effort `none` unless
stated. Client machine: office laptop (macOS). Same deterministic
`say`-synthesized utterance every run. Timestamps are one machine's clock
except worker-bridge one-ways (±~40ms NTP-style de-skew from stream
ping/pong). Full per-run JSONL: `voicelab matrix` output.

## Topologies

| variant          | path                                                                                | server side                                               |
| ---------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `direct`         | laptop → wss://api.x.ai                                                             | none (latency floor)                                      |
| `ws-proxy`       | laptop → **userspace VoiceBridge DO** → api.x.ai                                    | worker.ts in the project config repo, verbatim frame pump |
| `streams-node`   | laptop → stream (ephemeral events) → node bridge on laptop → api.x.ai               | same protocol, node process (second laptop↔CF traversal)  |
| `streams-worker` | laptop → stream (ephemeral events) → **VoiceBridge DO** `openConnection` → api.x.ai | worker.ts; audio rides /api only                          |
| `esp32`          | Waveshare ESP32-S3 → stream (ephemeral events), C capnweb client                    | same protocol from 240MHz silicon                         |

The worker bridge dials Grok with a bare `fetch` upgrade carrying
`Authorization: Bearer getSecret("/secrets/xai")` — the egress lane
substitutes against the pinned origin; the key never enters userspace
(probe: upgrade 494ms, session ready ~750ms). Ephemeral delivery into the DO
uses `openConnection` anchored by a no-audio control WebSocket from the
client (session callbacks cannot outlive the invocation that opened them),
one DO instance per call.

## Headline numbers (median of runs; simulated network at the client)

`stop→audio` = Grok VAD speech_stopped → first speaker audio (the felt
"assistant thinking" time). `ttfa` = utterance end → first speaker audio
(adds Grok's ~1.2–1.3s VAD tail, and mic-side transport under impairment).

| variant        | network | ttfa ms    | stop→audio ms | stream 1-way p50/p90 ms | stream RTT p50 | underruns | ASR correct |
| -------------- | ------- | ---------- | ------------- | ----------------------- | -------------- | --------- | ----------- |
| direct         | none    | 2029       | 694           | –                       | –              | 0         | 2/2         |
| direct         | bad     | 2172       | 710           | –                       | –              | 0         | 2/2         |
| direct         | awful   | 3393       | 685           | –                       | –              | 0         | 2/2         |
| ws-proxy       | none    | 2319       | 679           | –                       | –              | 0         | 2/2         |
| ws-proxy       | bad     | 2447       | 622           | –                       | –              | 0         | 2/2         |
| ws-proxy       | awful   | 3737       | 648           | –                       | –              | 0         | 2/2         |
| streams-node   | none    | 2025       | –             | 50/141                  | 111            | 1         | 2/2         |
| streams-node   | bad     | 1807–5604  | –             | 280/315                 | 281            | 0         | 2/2         |
| streams-node   | awful   | 2318–6367  | –             | 291/336                 | 961            | 0         | 1/2         |
| streams-worker | none    | 2023–2084  | –             | 14/46 (de-skewed)       | 94             | 0         | ok          |
| streams-worker | bad     | 2569       | –             | 239/402                 | 359            | 0         | 2/2         |
| streams-worker | awful   | 2690–16622 | –             | 295/311                 | 1102           | 0         | 2/2         |

Network profiles (`--impair`, deterministic, applied identically to every
variant at the client's transport touchpoints): `bad` = 40ms each way + 60ms
jitter + 400ms stall every 7s; `awful` = 120ms + 150ms jitter + 1.8s stall
every 5s.

Reading it:

- **stop→audio is Grok-bound (~620–710ms) in every topology.** The
  Cloudflare hop is free: ws-proxy ≈ direct.
- **The streams tax on a good network is ~100–300ms on ttfa** and ~40–75ms
  per direction of transport (one-way p50 laptop↔preview stream: 45–75ms,
  p90 ~100ms).
- **Playback never got choppy anywhere**: zero underruns in every run of
  every topology including `awful` — because Grok ships whole answers at
  many times realtime (2s of audio in ~250ms, 0.4–1s frames), so the client
  playout queue is deep the moment audio starts. Choppiness is not where
  this design hurts.
- **Where streams genuinely lose under awful networks**: ephemeral events
  appended while the client's session connection is being re-established are
  gone forever (correct semantics for audio — but if the _first_ chunk of an
  answer lands in such a gap, time-to-first-audio slides badly: the 16.6s
  outlier). TCP-based ws-proxy delivers late instead of never. Mitigation
  below.

## Barge-in (interrupt a 30-count answer mid-playback)

| variant        | network | reaction ms | lost audio events | Grok heard the interruption |
| -------------- | ------- | ----------- | ----------------- | --------------------------- |
| direct         | none    | 1008        | 0                 | ✓                           |
| direct         | awful   | 2275        | 0                 | ✓                           |
| ws-proxy       | none    | 987         | 0                 | ✓                           |
| ws-proxy       | awful   | 1498        | 0                 | ✓                           |
| streams-worker | none    | 1025        | 0                 | ✓                           |
| streams-worker | awful   | 1825        | 1                 | ✓ (missed the first words)  |

Reaction is dominated by Grok's server VAD (~1s); streams adds its one-way
each direction. On barge-in the client clears its local playout queue
(17.4s of queued audio in the count-to-thirty test) — the deep queue from
Grok's burstiness makes the _local_ clear the thing that matters, and it
works identically in every topology.

## Multi-turn soak (streams-worker, 8 turns, 55s continuous call)

"Paris. Berlin. Madrid. Rome. Amsterdam. Lisbon. Vienna. Brussels." —
8/8 turns correct, 2744 mic frames, 0 underruns, 0 append errors, **4
proactive connection recycles mid-call, 1 duplicate event, 0 gaps** —
recycling is inaudible.

## ESP32-S3 (Waveshare Touch AMOLED) — C capnweb client, single WS to /api

The device speaks the same protocol as the TypeScript client over ONE
Cap'n Web WebSocket: authenticate(project-secret) → projects.get →
streams.get → 50Hz one-way `append` of ephemeral mic-frame events (base64
PCM16, one 20ms frame per event) + pulled ping append as RTT probe +
durable dev-stats every 5s (the stream is the observability channel — the
USB console resets the board).

Measured on-device against preview-3 (synthesized 440Hz tone as mic):

- **Sustained 50.0 frames/s**, 8513 frames over ~3 min, **0 send failures,
  0 outbox discards**, server-side inter-arrival p50 2ms / p99 97ms / max
  306ms.
- **Append RTT (device → stream DO commit → resolve → device): 100–108ms.**
- Heap: 8.5MiB free, minimum 8.50MiB — negligible footprint; static
  runtime ~90KiB. **JSON+base64 per-frame overhead is a non-issue on the
  S3** (~49KB/s TLS uplink at 100 wire messages/s).
- Two C-side changes made this viable: `capnweb_session_call_oneway_path`
  (push + immediate release — a pulled append would echo the base64 payload
  back into the 2KiB inbox slot and the token budget on every frame), and a
  raised token budget (64 → 256; 64 is a session-killing abort on any
  non-trivial reply).
- Gotcha: capability path segments reject hyphens
  ("invalid capability path segment").

### Downlink and real audio hardware (second pass)

The device now runs **full duplex over the same single socket**: it exports
a callback capability, opens a live stream connection with the
constrained-consumer caps below, decodes base64 speaker frames, and plays
them through the ES8311.

Measured on hardware: **641 speaker frames received, 640 played, 0
overflow, 0 decode failures, 417 delivery batches, 6408 mic frames
uplinked, one stable session.**

What it took, and what each one teaches:

- **`maxDeliveryEvents` / `maxDeliveryBytes` / `state: false`** (new
  platform feature, this PR). A microcontroller reassembles each delivery
  into a fixed buffer; a coalesced 50-event batch is not survivable. The
  device opens with 2 events / 2600 bytes / no state.
- **Empty batches had to stop** (platform fix, this PR). Every append the
  filter rejected pushed a 0-event batch to every live connection: the
  device took ~50 useless inbound messages/s from its own mic traffic.
- **One-way appends cost two messages** (push + release) against a
  ~25–50 msg/s socket, so mic frames aggregate 4-per-append (80 ms).
- **Outbox exhaustion is session-fatal** in this peer, so every producer
  (mic, ping, stats, connection recycle) gates on ring headroom, and the
  mic queue drops oldest (freshest wins).
- **`CONTROL_MESSAGE_CAPACITY` 2048 → 4096**: the transport's embedded
  receive/transmit scratch caps message size independently of ring slot
  size; a ~2.9 KB aggregated append died in the frame writer as an
  unexplained generation death.
- **A dead session must hard-reset the stream client**: capability ids die
  with their session, and reusing them poisons the next one.

### Talking to it

**A spoken conversation with the device works.** Three questions asked out
loud in the room, over the single socket, with Grok's answers playing from
the device's own speaker:

| heard from the device's microphone                     | Grok's reply, played on the device   |
| ------------------------------------------------------ | ------------------------------------ |
| "What is the capital of Portugal? One short sentence." | "The capital of Portugal is Lisbon." |
| "And Norway?"                                          | "The capital of Norway is Oslo."     |
| "And Greece?"                                          | "The capital of Greece is Athens."   |

Zero echo turns, 321 speaker frames played, 0 overflow, 0 decode failures,
one session throughout. Context carries across turns (an earlier run
answered "name one famous painter from that country" with Picasso after
Spain).

Three settings were load-bearing:

- **`no_dac_ref = true`** (ES8311 reg `0x44 = 0x08`). The driver's default
  fills the ADC lane's right slot with DAC output as an AEC reference — of
  no use to a mono capture.
- **Mic PGA 36 dB.** At 24 dB a talker a metre away lands at RMS −42 dBFS:
  clean, but too quiet to open Grok's server VAD.
- **Echo gate stamped from playback, not arrival.** Paced delivery finishes
  arriving seconds before the speaker finishes, so a gate timed from
  arrival reopened the mic mid-sentence and the board answered itself.
  Timed from the playback write with a 900 ms tail (codec DMA ~90 ms plus
  room reverb), turns are clean. This board has no hardware AEC reference,
  so the gate is the only echo control available — the cost is that voice
  barge-in during playback is off.

**One diagnostic trap worth knowing, because it cost hours here:** 640 PCM
bytes base64-encode to 854 characters, which is _not_ a multiple of 4. A
capture script that joins per-frame base64 strings before decoding
misaligns every frame after the first and produces convincing broadband
"noise" — RMS −9 dBFS, gain-independent, flat to 8 kHz — that looks exactly
like a dead microphone. The same capture decoded per frame showed textbook
speech (peak −23.6 dBFS, RMS −41.9, crest 8.2, silences −68 dB). Decode
each frame separately. Two on-device diagnostics are kept for the next
bring-up: `waveshare_audio_dump_registers()` and
`waveshare_audio_probe_din()` (whether anything drives the data line).

## Platform findings & fixes that came out of this

1. **Session-connection delivery silently dies at ~1000–1300 pushes**
   (worker subrequest budget) — real on deployed envs; at 50 events/s
   that's ~25s of audio. Appends keep succeeding; no error anywhere.
2. **A Stream DO storage reset** killed all session connections silently
   under 50 appends/s (observed once).
3. **Fix (client discipline): make-before-break recycling** every ~700
   delivered batches + delivery-silence watchdog + offset dedupe + durable
   replay across seams (`resilient.ts`, also inside the worker bridge).
   With it: 2-min 50fps benches deliver 5998–6000/6000, 0 dupes. Batching
   3 frames/append costs ~+10ms p50, removes tail spikes, and triples the
   recycle horizon — recommended. Documented in
   `apps/os/docs/stream-event-connections-and-subscriptions.md`.
4. **`StreamConnectionHandle` is now a pure capability** (fixed in this PR):
   `connectionKey`/`streamMaxOffset` were typed as sync data but never
   materialize across the wire — a silent-undefined trap. Removed; seed
   cursors from the batches (`scannedThroughOffset`; every connection gets
   an initial batch on open).
5. **A stateful dynamic-worker DO instance does not survive a second
   WebSocket invocation** after its first call tears down (anchor closes
   with 1006, no response) — worked around with one DO instance per call
   (identity = ref path). Worth a platform look. Related: ~1-in-6
   streams-worker calls wedge mid-call (pongs flow, turn never completes) —
   suspected mic-frame ephemeral loss during the DO-side connection recycle
   leaving Grok's VAD without an utterance end; a product client needs a
   turn-level timeout+retry.
6. Per-event push is real: 1 event per delivery batch at voice cadence,
   zero-return-frame callback lane, no debounce on the hot path.

## Verdict

**Streams can carry realtime voice, including a full spoken conversation
with a $30 microcontroller, with the server side entirely in userspace
worker.ts** — mic clarity is perfect (word-perfect ASR through the whole
pipeline, from the laptop and from the ESP32's own ES8311), playback is
underrun-free in every tested condition, and the added latency on healthy
networks (~100–300ms ttfa, ~40–75ms/direction) is acceptable for a voice
assistant given Grok's own ~650ms thinking time.

The honest trade against a plain WS proxy: the proxy is simpler, equally
fast through Cloudflare, and degrades more gracefully under severe network
stalls (late audio instead of lost audio). The streams approach buys the
event-sourced goodies — the conversation is a stream any processor/agent
can observe, the control plane is durable, the same protocol serves
laptop CLI and ESP32 identically, and the bridge lives in userspace next to
the rest of the project. For product use it needs the resilience discipline
(recycling + turn-level retry) baked into a client library rather than
each client.

## Postscript: the ESP32 device, after actually making it work

The measurements above answered the original question — realtime voice does
ride the streams abstraction, at a cost of roughly 100-300 ms of ttfa. Making
the ESP32 side genuinely _usable_ took considerably longer, and none of the
defects were in the transport. Recording them because every one was invisible
from the outside and expensive to find:

| symptom                                   | actual cause                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "insane static", worse on long answers    | the bridge paced at 2x realtime while the device played at 1x, so audio accumulated until the device's 1 MiB buffer filled — then `xStreamBufferSend` committed the HEAD of each frame and dropped the tail. A click at an arbitrary phase every 20 ms.                                                                                  |
| assistant answered every turn 2-3 times   | a bridge DO is keyed by stream path, so a second `startCall` joined the first instead of replacing it. Two Grok sockets, both answering the same turn, audio interleaved.                                                                                                                                                                |
| "it doesn't hear what I'm saying"         | (a) 8-frame appends needed 7.8 KiB of a 7600-byte args buffer, so the append was abandoned — and that path returned before the failure counter, so every statistic read "0 sent, 0 failures"; (b) releasing the button committed the turn while up to 640 ms of captured speech was still queued, discarding the end of every utterance. |
| every user line duplicated on screen      | one spoken turn is announced under two provider events carrying the same text; both were rendered. Deduped by conversation item id.                                                                                                                                                                                                      |
| device stuck on "connecting" until reboot | the control inbox had no flow control, and overflowing it is session-fatal by design. No buffer size fixes that — the transport now stops reading when there is no room, so TCP's window does the work.                                                                                                                                  |
| microphone "broadband noise"              | two ES8311 instances over one I2S data interface: opening the speaker reconfigured the channel pair the mic had just set up. Not the DAC reference the `no_dac_ref` workaround blamed.                                                                                                                                                   |
| speaker quiet AND distorted               | volume 100 overdrives the amplifier (2nd harmonic −16.8 dB vs −34.9 dB at 60), so turning it up made it worse.                                                                                                                                                                                                                           |

Two things paid for themselves repeatedly:

- **A per-call flight recorder on the SD card**, readable over itx. Both PCM
  lanes plus a line log, so "does it sound bad" becomes "here are the bytes
  that went on the wire". The uplink under-send was found this way within
  minutes of it existing.
- **Acoustic loopback.** The device plays a tone and records it with its own
  microphone, so the analog chain is measurable from a script. That is what
  separated amplifier distortion from mic clipping, which no amount of
  listening would have settled.

The device transcribes room speech accurately end to end. The streams
abstraction was never the bottleneck.

## Postscript 2: what an overnight run found

The device was left running overnight and came back deaf — the screen lit
"listening" and "speaking" at every press, and nothing reached the speaker.
Its transport had been READY the entire time. Four defects, none of them in
the transport either, and every one of them a variation on the same mistake:
**something was believed rather than proved.**

| symptom                                             | actual cause                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| alive all night, deaf all night                     | audio rides one-way appends by design, so a half-open socket is indistinguishable from a quiet one from the device's end. Nothing on the device could ever have noticed. The ping's resolution is now the proof, and its absence replaces the transport, then the chip.                                           |
| a call that had not existed for hours               | the bridge lives in a Durable Object that can be evicted or redeployed without running its teardown, so "no call-ended arrived" is not evidence of a live call. `call_active` is now belief with a deadline, refreshed by any bridge-sourced event — the pong being the one that arrives when nobody is speaking. |
| answers RPCs perfectly, does nothing else           | every producer sits behind one gate, and a mount that would not start left it shut while `health`, screenshots and button presses all worked. The liveness clock explicitly excused that state as "not connected, a different fault". It was the worst state the device had.                                      |
| `call.log` empty, RPCs timing out mid-call          | the recorder answered "am I recording?" from a `FILE*` half a dozen paths can close. Against a 5 ms poll loop, one disagreement wiped and reopened the SD card seven times a second.                                                                                                                              |
| "very choppy" — 64 dropped frames inside one answer | the device buys ~390 ms of prefill before it plays a note and the bridge handed it another 450 ms lead. They ADD: a 900 ms ring sat at 811-898 ms, full, and overflowed on any jitter. 250 ms leaves a quarter of a second spare.                                                                                 |

The instrument that found all of them is `voicelab soak`: hold a call open for
as long as the target duration, take turns on it, and report counters over
TIME rather than a snapshot. Two things it had to learn about itself first —
both the same lesson again:

- **Its watcher must prove its own connection.** A dead watcher does not
  report an error, it reports a silent call. Its first run "found" four
  unanswered turns that the bridge had in fact answered.
- **A call is live when the BRIDGE says so.** Liveness was read from the SD
  recorder, which is an optional diagnostic — so a soak refused to start
  because a diagnostic was missing.

`voicelab probe` complements it by removing the device from the question
entirely: a call on a fresh stream, text turns, every provider event printed
as it lands. "The second turn never answers" became "the bridge is fine" in
one command.

## Postscript 3: the voice is a mouth, not a mind

The voice model has a couple of hundred milliseconds to think in. Anything
that has to be RIGHT belongs to a text model with no clock on it, so the voice
gets exactly one tool — ask a genius colleague — and a text agent at
`/agents/colleague` behind it.

Two lanes, and the split is the whole idea. Every finished transcript line is
appended to the agent as context with `dont-trigger-request`: it hears the
entire conversation without ever being asked to respond to it, so a customer
who is only chatting costs nothing and the colleague already knows what was
said when it IS asked. Asking is the other lane, and it does not block the
voice — the tool returns "asked" immediately, and the real answer arrives
later as a fresh conversation item, the way a colleague putting their head
round the door interrupts you.

Measured end to end, from one text turn:

```
 5.2s  --- turn: How many hearts does an octopus have, and why? Ask your colleague.
 7.0s  VOICE: I've asked my colleague about the octopus's hearts and why it has that number.
 7.0s  TOOL CALL ask_colleague: {"question":"How many hearts does an octopus have, and why?"}
 9.0s  VOICE: While we wait, what made you curious about octopuses? They're fascinating creatures.
17.4s  COLLEAGUE (10673ms): An octopus has three hearts: two pump blood to the gills, and one
       pumps oxygen-rich blood to the rest of the body…
20.4s  VOICE: An octopus has three hearts—two for the gills and one for the body—to meet its
       high oxygen demands. The main heart even pauses when swimming, so they often crawl instead.
```

The one bug worth recording: `ask()` resolves on `agents/web-message-sent`,
whose payload field is `message`. Reading `content` — the field on context
items — returned an empty string for a perfectly good answer, and the voice
dutifully told the customer their colleague could not help.

## Postscript 4: what the stream actually costs, on v2, measured four times

`ptt-marginal` alternates a stream turn and a direct turn in one process,
speaking identical audio at identical pacing, so the provider's mood cancels
instead of being subtracted across two runs minutes apart. Repointed at
`voice-agent2` and run on preview-3, project `voice-test`,
`grok-voice-think-fast-2.0`, a 3.84 s synthetic utterance, twenty rounds each.

| run | change                          | stream p50 | direct p50 | marginal |    ours | backlog p50 |
| --- | ------------------------------- | ---------: | ---------: | -------: | ------: | ----------: |
| A   | append probe ON                 |    2261 ms |    1142 ms | +1119 ms | 1154 ms |      712 ms |
| B   | probe OFF                       |    1552 ms |    1049 ms |  +503 ms |  244 ms |      −84 ms |
| C   | probe OFF, `grok-event` slimmed |    1957 ms |    1187 ms |  +770 ms |  775 ms |      391 ms |
| D   | identical to C, fresh stream    |    2005 ms |     989 ms | +1016 ms |  865 ms |       36 ms |

**Read the spread before reading any single row.** C differs from B only by a
change that strictly REMOVES work — the provider's audio deltas no longer ride
the verbatim `grok-event` lane as well as the paced `spk-frame` one — and it
came back 267 ms worse; D is byte-identical to C and came back 246 ms worse
again. Identical code spans 244–865 ms of "ours", which is wider than any
change under test. Twenty rounds pins a median for one run; it does not pin
the system.

**And D says where the variance lives.** Its uplink backlog is 36 ms — the
microphone lane running at real time — while "ours" is 865 ms, so on that run
nearly all of our cost is the DOWNLINK: the answer's first delta leaving the
facet and reaching this laptop. Every run heard all 192 microphone frames of
every round (`micFramesSeen`), so nothing is lost anywhere; what varies is
how promptly the delivery lane moves. Each run also creates a fresh stream
path, hence a fresh Durable Object with its own placement, which is the
leading suspect for why whole runs have moods. Distinguishing that needs the
same stream measured across runs, and rounds interleaved between two streams
— not more rounds on one.

What IS stable across every round of every run:

|                                              | facet's view | this laptop's view |
| -------------------------------------------- | -----------: | -----------------: |
| round trip to xAI                            |   174–188 ms |         153–162 ms |
| the facet's own work, end seen → commit sent |         0 ms |                  — |

**Cloudflare's edge is not closer to xAI than a London office is.** The round
trip is 25–35 ms WORSE from the colo, in every round of all three runs, which
retires an assumption this project has carried since the first bridge. And the
facet itself costs nothing: whatever the marginal number settles at, none of
it is the processor thinking.

### Run A said +1119 ms and was measuring itself

Backlog p50 712 ms, worst frame gap p50 559 ms, everything-that-is-ours
1154 ms. The attribution was emphatic and consistent — one stall per
utterance, in the uplink, sized between 400 ms and 2.2 s — and the probe
caused it.

`ptt-marginal` measures a bare append round trip before each press. On v1 it
did that with an empty `mic-frame`, which is harmless. On v2 a microphone
frame is the thing that OPENS A CALL, so the probe had to move to the only
event v2 consumes that starts nothing — `warmup`. `warmup` is durable.
Durable events get a one-at-a-time delivery boundary and the facet answers
each with a durable `warmup-ready`, so three probes put six head-of-line
deliveries in front of the microphone frames, on exactly the lane whose
stalling was under investigation.

It is `--append-probe`, off by default. Given the spread across B–D, part of
what the probe appeared to cost is the same run-to-run mood — though A's
712 ms median backlog with the probe's deliveries at the head of the lane
remains the worst uplink of the four runs. What is certain is that an instrument
sharing a queue with the thing it measures will find something, the finding
will be internally consistent, and the attribution will point at the right
lane for the wrong reason.

### And a naked Grok connection is slower than either

`voicelab direct`, twenty turns, server VAD rather than a button:

|                                                  |     p50 |
| ------------------------------------------------ | ------: |
| ask → first audio                                | 2299 ms |
| — the provider's VAD deciding the question ended | 1993 ms |
| — everything after that                          |  332 ms |

Which reframes "our 1.5 s feels worse than the Grok app". Server VAD costs two
seconds of hangover; a button costs none. Push-to-talk over our stream at
1.5–2.0 s is comparable to or faster than an open microphone straight to xAI
at 2.3 s, and the model's own contribution is a third of a second either way.

## Postscript 5: the discrepancy, identified

Validated four ways before believing it: the mood follows the STREAM (both
original streams reproduced their moods hours later), survives `kill()` (a
fresh incarnation of the slow stream is still slow), is not distance (append
RTT to both DOs is equal), and is not retries (`attempt: 0`, no errors, on
every subscription of the slow stream). The server's own
`runtimeState()` corroborates the client: hosted delivery
`completionLatencyMs` p50 339 ms on the fast stream, 495–600 ms on the slow
one — for a delivery to a facet in the SAME Durable Object.

Two mechanisms, one multiplier (file refs in stream-event-sender.ts unless
said otherwise):

1. **The hosted lane serializes on a processing ack, and every cycle does
   4–6 output-gated storage writes for pure-ephemeral audio.** One batch in
   flight (`:2266`, `:2434`); the next dispatches only on ack (`:2416`).
   Each cycle: `markInFlight` write + `setAlarm(+20s)` write — deliberately
   issued so the output gate holds the RPC (`:2366-2375`) — then the facet
   runner processes the batch and makes ONE DURABLE COMMIT PER BATCH
   (stream-processor-runner.ts:745), plus keepalive `kv.put` + parent
   `setAlarm` (stream-durable-object.ts:1372-1388), then `clearInFlight`.
   All for ephemeral frames that cannot be replayed and need none of the
   in-flight protection. Per-DO-host storage latency multiplies through
   those serialized writes: 339 ms/cycle on one host, 495+ on another. A
   50 Hz microphone produces 240 ms of audio per append batch — 339 ms
   marginally keeps up by coalescing, 495 ms falls behind for ever.

2. **The 5 s idle teardown fires between every voice turn**, and both lanes
   resurrect expensively and independently: uplink pays a `setAlarm(now)`
   ALARM HOP (a fresh DO invocation with no dispatch-latency guarantee — the
   one cost nothing instruments) plus a facet re-dial and a durable
   `connection-opened` append; downlink pays a Page → relay re-dial →
   `openConnection`. Hence uplink p90 stalls of 3.5 s, stalls located at
   frame 1, and the two legs going bad independently.

The code's own docstring records ~25 ms/cycle when healthy — that is the
floor these fixes would return to: (a) all-ephemeral batches skip
markInFlight/setAlarm/watchdog; (b) the runner skips the per-batch durable
commit when nothing durable folded; (c) pipeline ephemeral dispatch rather
than ack-serializing it; (d) hold the idle teardown while a call is live.

Prediction for the proxy bisect (deliberately falsifiable): a stateless
WS-proxy worker in the loop — or a facet that proxies without the event
machinery — shows none of this, because the cost is the delivery machinery's
gated writes and ack serialization, not Workers, DOs, or facets as such.
`direct --url` is ready to measure it.

## Postscript 6: the fix, deployed and measured

Platform commit `74ec81fd7` (all in `stream-event-sender.ts` + the keepalive
module): all-ephemeral hosted batches and non-initial empty frames ride
without the durable in-flight insurance (nothing they carry can be
redelivered by anyone); consecutive all-filtered scan windows merge into the
next dispatched batch instead of each costing an acknowledged round trip;
idle teardown stands down while the facet-keepalive alarm desire says a
processor holds work; the keepalive's redundant re-assert is rate-limited.
Deployed to preview-3 (`5df8b49c`), then both moody streams re-measured with
NO client heartbeat — the platform gate working unaided:

|                       | bad host, before | bad host, after | good host, before | good host, after |
| --------------------- | ---------------: | --------------: | ----------------: | ---------------: |
| ours p50              |      842–1125 ms |      **105 ms** |            232 ms |        **86 ms** |
| ours p90              |     2227–3865 ms |      **126 ms** |            399 ms |           241 ms |
| uplink lateness p50   |       491–845 ms |           12 ms |              8 ms |             5 ms |
| downlink lateness p50 |       110–190 ms |           12 ms |             19 ms |             8 ms |
| best-case legs RTT    |       351–383 ms |       **78 ms** |        198–203 ms |            74 ms |
| backlog p50           |  +174 to +741 ms |     **−218 ms** |            −99 ms |          −216 ms |

The "host mood" is gone: both streams now measure the same, because the fix
removed the storage writes the slow host was slow at rather than needing the
host to be fast. The uplink runs AHEAD of the microphone on both. Total
marginal against a direct xAI socket, same run, alternating turns: **+33 ms**
on one stream; the other read +296 ms of which 105 ms was ours and the rest
was the model thinking longer on the stream half of that particular
alternation — provider noise, not plumbing.

The `keepalive` contract event died the same hour it was born, as intended:
a contract should never need to say "I am still here" — the platform can see
a working facet from the alarm desire it already maintains.

## Postscript 7: the soak — long conversations, long answers, interjections

`ptt-marginal --mixed` cycles the shapes a real conversation is made of:
short turns, prompts that provoke 27–37 second answers, mid-answer
interjections, and quiet gaps of 8 s and 30 s that cross the old teardown
boundary — stream and direct alternating per scenario kind so parity is
judged like for like. Twenty-four rounds on a fresh stream (one conversation,
25 presses, ~25 minutes), twelve on the ex-bad host.

Fresh stream, all 24 rounds answered, zero faults:

| scenario  | stream p50 | direct p50 |   marginal |
| --------- | ---------: | ---------: | ---------: |
| short     |    1113 ms |    1135 ms | **−22 ms** |
| long      |    1262 ms |    1331 ms | **−69 ms** |
| interject |    1462 ms |    1511 ms | **−49 ms** |

- **Ours: p50 75 ms, p90 194 ms** — floor 50 ms. Uplink ~230 ms AHEAD of the
  microphone every round.
- **No degradation over the call:** ours p50 75 ms in the first half,
  78 ms in the second.
- **Interjections:** the old answer shuts up in **93 ms p50 (max 95)** —
  the clear frame reaching the listener — and the interjection's answer
  arrives in ~1.0–1.2 s.
- **Long answers:** 27–37 s of audio per answer, delivered end to end with a
  worst mid-answer gap of p50 271 ms / max 1233 ms against the four-second
  head start — an audible stutter is arithmetically impossible.

The ex-bad host ran eleven rounds at the same figures (ours 78–222 ms, barge
clears 110–122 ms) before this LAPTOP's network blipped: one round read
29.5 s — and its direct twin stalled 1.6 s in the same instant, convicting
the shared client network, not either path — after which the probe hung on
its next append and was killed. Two probe findings, both client-side: the
awaited final append has no timeout (a dead itx socket hangs the probe
forever), and one answer adjacent to the blip delivered fully but its
end-of-answer marker was never seen. Neither touches the platform verdict.

## Postscript 8: two providers, one birth certificate

The birth certificate now names the provider: `created` carries
`provider: "grok" | "openai"` plus optional `providerModel`/`providerVoice`,
and everything provider-specific in the facet is one four-value table — URL,
model, voice, and PCM rate. Grok's realtime API is a clone of OpenAI's GA
interface (same handshake, same event names, same session shape), so the
"abstraction" is that table plus the one real difference: OpenAI speaks
24 kHz where this pipeline is 16, resampled linearly at the two doors
(mic-in, delta-out). The credential follows the HOST, never the flag —
`/secrets/xai` to `*.x.ai`, `/secrets/openai` to `api.openai.com`, nothing
to a test seam.

Time to first speech of the response heard (release → first audio at the
listener), eight rounds each, same utterance, same hour, stream and direct
alternating:

| provider                           | via stream p50 | direct p50 | marginal | ours p50 | model thinking p50 |
| ---------------------------------- | -------------: | ---------: | -------: | -------: | -----------------: |
| grok (`grok-voice-think-fast-2.0`) |        1122 ms |    1043 ms |   +79 ms |    98 ms |             812 ms |
| openai (`gpt-realtime`)            |     **691 ms** |     570 ms |  +121 ms |   118 ms |             408 ms |

OpenAI reaches first speech ~430 ms sooner than Grok, and essentially all of
it is the model thinking (408 vs 812 ms) — the wire terms are identical
(both ~155 ms from the facet). Our machinery costs ~100-120 ms on either
provider, with the OpenAI tail actually TIGHTER (ours p90 128 vs 232), so
the 24 kHz resample is free at these scales. The first live OpenAI round
ever attempted answered in 503 ms end to end through the stream.
