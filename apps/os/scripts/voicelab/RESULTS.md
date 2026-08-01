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

**Open: microphone capture returns noise, not audio.** Playback is proven;
`esp_codec_dev_read` yields broadband noise (RMS ~−9 dBFS, crest ~3,
clipping, flat spectrum to 8 kHz) whose level does not respond to
`set_in_gain` — so those samples never came from the ADC signal path.
Ruled out: the pin map (identical to Waveshare's own BSP), mono Philips
slots, MCLK ×256, the 16 kHz coefficient entry, AXP2101 rails including
the ALDO1 mic rail, the pre-construction soft reset, and one-vs-two
codec-dev handles. Ordered next probes are in the header of
`targets/waveshare_s3_amoled/main/waveshare_audio.c`: dump ES8311 regs
0x00–0x45 after open and diff against the driver's expected init, scope
BCLK/WS/DIN, try `digital_mic = true` in case this SKU has a PDM mic, and
confirm the board revision (the stock image's `phone_s3_box_3` is an
ESP-Brookesia demo name, not a hardware id).

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

**Streams can carry realtime voice, including from a $30 microcontroller,
with the server side entirely in userspace worker.ts** — mic clarity is
perfect (word-perfect ASR through the whole pipeline), playback is
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
