# Voice lab

Experiments answering one question: **can realtime voice (Grok Voice Agent,
16kHz PCM16 both directions) ride the streams abstraction** — mic and speaker
audio as ephemeral stream events — **and what does that cost against a plain
WebSocket proxy?**

## Topology under test

```
direct     mic ──────────────────────────► Grok WS ──► speaker        (latency floor)
streams    mic ──► stream (ephemeral) ──► bridge ──► Grok WS
                                            │
           speaker ◄── stream (ephemeral) ◄─┘
```

The bridge is the "server side": it holds the Grok WebSocket and relays both
directions through the stream. It exists in two variants with identical
protocol: a **node process** (`voicelab bridge`, isolates stream-transport cost
from Cloudflare execution) and a **userspace worker** in a project's config
repo (the real deployment shape).

## Event protocol (one stream per call)

| Event                             | Durability | Payload                                                           |
| --------------------------------- | ---------- | ----------------------------------------------------------------- |
| `voicelab/call-requested`         | durable    | `{ callId, model?, voice?, effort }` — client opens a call        |
| `voicelab/call-accepted`          | durable    | `{ callId, bridge, model }` — bridge's Grok session is ready      |
| `voicelab/call-ended`             | durable    | `{ callId, reason }`                                              |
| `voicelab/mic-frame`              | ephemeral  | `{ callId, seq, t, pcm }` — 20ms base64 PCM16 @16kHz              |
| `voicelab/spk-frame`              | ephemeral  | `{ callId, seq, t, tGrok, pcm }`                                  |
| `voicelab/grok-event`             | ephemeral  | `{ callId, t, event }` — VAD/transcript/response lifecycle subset |
| `voicelab/ping` / `voicelab/pong` | ephemeral  | RTT + clock-offset probe                                          |
| `voicelab/bench-frame`            | ephemeral  | transport bench traffic                                           |

Ephemeral frames are only visible to live `openConnection()` callbacks — never
to durable subscriptions or hosted processors — which is exactly the delivery
contract audio wants (no replay of stale audio after reconnect). Barge-in:
the bridge forwards Grok's `input_audio_buffer.speech_started` and the client
clears its playout buffer.

## Commands

All take `--project prj_…` plus `APP_CONFIG_BASE_URL`/`APP_CONFIG_ADMIN_API_SECRET`
from the Doppler config (local dev server is the fallback).

```bash
# latency floor: no iterate infra in the path
XAI_API_KEY=… pnpm cli voicelab direct --say "What is the capital of France?"

# server side, terminal A (holds the Grok socket)
XAI_API_KEY=… pnpm cli voicelab bridge --project prj_… --path /voicelab/call-1 --once

# client, terminal B — headless synthetic utterance (macOS `say`), prints summary JSON
pnpm cli voicelab client --project prj_… --path /voicelab/call-1

# live: real mic + speaker, space = push-to-talk mute toggle, q quits
pnpm cli voicelab client --project prj_… --path /voicelab/call-1 --mic --device

# transport-only bench: floods PCM-sized ephemeral events at voice cadence,
# measures one-way latency / loss / dupes / stalls / per-connection ceilings
pnpm cli voicelab bench --project prj_… --seconds 120 --rate 50
```

Every command prints a JSON summary with nearest-rank percentiles; `client`
and `direct` share a summary shape so overhead subtracts cleanly.

## What to look at

- `utteranceEndToFirstSpkFrameMs` — the human-felt answer delay.
- `spkOneWayMs` / `micOneWayMs` — stream transport cost per direction
  (same-machine clocks for the node bridge; use `estimatedClockOffsetMs` from
  ping/pong when the bridge runs elsewhere).
- `playout.underruns` — audible gaps. The playout buffer paces PCM at exactly
  realtime in 20ms ticks; an empty queue mid-response is a counted underrun.
- bench `oneWayMsByTenSeconds` + `stalls` — degradation over a connection's
  lifetime (the suspected ~1000-push per-WS-connection ceiling would appear
  here as a cliff; see `apps/streams-example-app/scripts/bench/README.md`).
