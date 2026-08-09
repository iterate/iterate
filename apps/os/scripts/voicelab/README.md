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

Every type below is prefixed `events.iterate.com/voice-agent/`, elided here
for width.

| Event                    | Durability | Payload                                                                    |
| ------------------------ | ---------- | -------------------------------------------------------------------------- |
| `conversation-requested` | durable    | `{ conversationId, model?, voice?, effort }` — client opens a conversation |
| `conversation-accepted`  | durable    | `{ conversationId, bridge, model }` — bridge's Grok session is ready       |
| `conversation-ended`     | durable    | `{ conversationId, reason }`                                               |
| `mic-frame`              | ephemeral  | `{ conversationId, seq, t, pcm }` — 20ms base64 PCM16 @16kHz               |
| `spk-frame`              | ephemeral  | `{ conversationId, seq, t, tGrok, pcm }`                                   |
| `grok-event`             | ephemeral  | `{ conversationId, t, event }` — VAD/transcript/response lifecycle subset  |
| `ping` / `pong`          | ephemeral  | RTT + clock-offset probe                                                   |
| `bench-frame`            | ephemeral  | transport bench traffic                                                    |

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

# Literal no-cloud proof: loopback fake provider, synthetic mic, accounted speaker
pnpm cli voicelab local --project voice-test --say "Prove the local audio path."

# transport-only bench: floods PCM-sized ephemeral events at voice cadence,
# measures one-way latency / loss / dupes / stalls / per-connection ceilings
pnpm cli voicelab bench --project prj_… --seconds 120 --rate 50
```

Every command prints a JSON summary with nearest-rank percentiles; `client`
and `direct` share a summary shape so overhead subtracts cleanly.

## Against a real device

Ask the board; do not wait to be told. Every number a device has is served on
demand by its `health()` capability —

```bash
doppler run --config prd -- pnpm cli voicelab device --action health
```

— and that is deliberately the ONLY way to get one. The boards used to append
`voice-agent/dev-stats` to the call's stream every five seconds whether anyone
was listening or not, which kept four stream Durable Objects awake around the
clock to publish counters nobody was reading. Nothing on a device is pushed on
a timer now. `health()` is pure and does not renew the liveness lease, so poll
it at turn boundaries — a poll loop rebuilds the wakeup cost the heartbeat was
deleted for.

`soak`, `stress` and `sessions` — three endurance harnesses that sampled that
heartbeat — went with it. They were bridge-era: each subscribed to
`voice-agent/bridge-redialling` and `voice-agent/conversation-requested`, both
retired with the worker bridge, and `sessions` additionally drove the device's
client-callable RPC surface, which is gone too. Re-pointing them at `health()`
would have left three harnesses whose remaining subscriptions match nothing.
What they measured — many turns, long unbroken answers, repeated
setup/call/teardown boundaries — is worth rebuilding against the facet when
there is a board to prove it on; it is not worth pretending it still runs.

What survives drives real hardware and reads `health()` directly:

```bash
# the journey from the power button: reboot, press, speak, require AUDIO PLAYED
doppler run --config preview_3 -- pnpm cli voicelab reliability \
  --project prj_… --attempts 10

# every connected board, out loud, through real air (Mac speaker -> board mic)
doppler run --config prd -- pnpm cli voicelab boards --project voice-test

# the whole capability surface, through a real deployed agent's own turns
doppler run --config prd -- pnpm cli voicelab prove --project voice-test
```

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
