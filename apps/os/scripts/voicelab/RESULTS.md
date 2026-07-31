# Voice lab results — Grok realtime voice over streams vs a plain WS proxy

Environment: preview-3 (`os.iterate-preview-3.com`), project `voicelab`
(`prj_698c23da57f84d92a9ba5dc959efebec`), model `grok-voice-think-fast-2.0`,
16kHz PCM16 both directions, 20ms mic frames, reasoning effort `none` unless
stated. Client machine: Jonas's laptop (macOS) on the office network. All
timestamps `Date.now()` on one machine except worker-bridge one-ways, which
carry ~±40ms NTP-style de-skew from stream ping/pong.

## Topologies

| variant          | path                                                                                | server side                                                                      |
| ---------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `direct`         | laptop → wss://api.x.ai                                                             | none (latency floor)                                                             |
| `ws-proxy`       | laptop → **userspace VoiceBridge DO** → api.x.ai                                    | worker.ts in the project config repo, verbatim frame pump                        |
| `streams-node`   | laptop → stream (ephemeral events) → node bridge on laptop → api.x.ai               | same protocol as worker bridge, node process (adds a second laptop↔CF traversal) |
| `streams-worker` | laptop → stream (ephemeral events) → **VoiceBridge DO** `openConnection` → api.x.ai | worker.ts; audio never touches a client socket other than /api                   |

The worker bridge dials Grok with a bare `fetch` upgrade carrying
`Authorization: Bearer getSecret("/secrets/xai")` — substitution happens in
the egress lane against the pinned origin; the key never enters userspace
(probe: upgrade 494ms, session ready 753ms). Ephemeral event delivery to the
DO uses `openConnection` anchored by a no-audio control WebSocket from the
client (session callbacks cannot outlive the invocation that opened them).

## Headline numbers

(filled from `voicelab matrix` runs; per-run JSONL in the PR discussion)

<!-- MATRIX-TABLE -->

Interpretation notes:

- **stop→audio** (speech_stopped → first speaker frame) is the honest
  "assistant thinking" latency and is ~600–700ms for every topology — it is
  Grok-bound, not transport-bound.
- **ttfa** (utterance end → first speaker frame) additionally contains
  Grok's server VAD tail (~1.2–1.3s at threshold 0.5 / 500ms silence) and,
  under impairment, the mic-side transport delay.
- Grok returns full answers at many times realtime (2s of audio in ~250ms,
  ~0.4–1s binary frames), so the client playout queue absorbs nearly the
  whole response the moment it starts — playback is extremely robust to
  network jitter in every topology (zero underruns even under `awful`), and
  the flip side is that barge-in must clear a deep local queue (works: local
  `clear()` on forwarded `speech_started`).

## Streams-specific findings (the real story)

1. **Session-connection delivery silently dies at ~1300 pushes** (~27s of
   audio at 50 events/s): the per-WS-connection worker subrequest budget from
   `apps/streams-example-app/scripts/bench/README.md` is real on deployed
   envs. Appends keep succeeding; the subscriber hears nothing; no error
   anywhere. A voice client MUST recycle connections.
2. **A Stream DO storage reset** ("Internal error in Durable Object storage
   caused object to be reset") occurred once under 50 ephemeral appends/s,
   killing the session connection with it (session connections are
   deliberately non-durable).
3. **Mitigation implemented** (`resilient.ts`, also inside the worker
   bridge): make-before-break recycling every ~700 delivered batches +
   delivery-silence watchdog + offset dedupe + durable-event replay across
   gaps. With it: 2-minute 50fps benches deliver **5998–6000/6000** frames,
   0 dupes, recycle seams invisible.
4. **Transport cost** (laptop ↔ preview stream, per direction): one-way
   p50 ~45–75ms, p90 ~100ms, p99 ~330–390ms. Batching 3 frames/append
   (60ms cadence) costs ~+10ms p50 and removes the tail's worst spikes,
   and triples the recycle horizon. Recommended for voice.
5. **`openConnection` handle's `streamMaxOffset` is typed but does not
   materialize over the wire** (arrives undefined) — trap for anyone
   seeding an offset cursor from it.
6. Per-event push is real: 1 event per delivery batch at voice cadence
   (no platform batching/debounce on the hot path), zero-return-frame
   callback lane confirmed by the sender code.

## Barge-in

<!-- BARGE-TABLE -->

Reaction is dominated by Grok's server VAD detecting the interrupting
speech; the transport contribution is the mic one-way. On barge-in the
client drops its queued audio locally (`playout.clear()`); the worker
bridge forwards `speech_started` as an ephemeral event for exactly this.

## Multi-turn soak

<!-- SOAK-NOTES -->

## Verdict

<!-- VERDICT -->
