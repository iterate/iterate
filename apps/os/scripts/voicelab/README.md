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

## Endurance, against a real device

Both drive one call on one stream and never restart it, take turns as text so
nobody has to be in the room, and read the device's own `voicelab/dev-stats`
(every 5s) rather than trusting a snapshot.

```bash
# survival: one call held open, a short question every 45s
doppler run --config preview_3 -- pnpm cli voicelab soak \
  --project prj_… --path /agents/voice/dev-… --minutes 60 --out /tmp/soak.json

# endurance under load: 100+ turns, 90+ minutes, and long answers in the mix
doppler run --config preview_3 -- pnpm cli voicelab stress \
  --project prj_… --path /agents/voice/dev-… --out /tmp/stress.json
```

`soak` answers "does the call survive?". `stress` answers the harder question:
every 20 turns it asks 11 short questions, 6 for a paragraph and 3 for minutes
of unbroken audio ("count from one to a hundred"), waits for the SPEAKER to go
quiet rather than for `response.done`, and reports latency, audio delivered vs
audio played, and the heap trend per prompt class — so a failure can be pinned
on the long turns if that is where it lives. It fails on a miss, on any counter
a healthy call never moves, on a session change, on a heap slope, and on a run
that never actually produced long audio.

## Repeatability, against a real device

`soak` and `stress` both cross the interesting boundaries exactly once, at the
top of the run: setting the project up, getting a call live, the first answer on
a playout that has never opened, hanging up, and coming back to a warm mount.
`sessions` crosses them ten times instead.

```bash
# ten independent ~3-minute sessions, each: setup → call → turns → teardown → remount
doppler run --config preview_3 -- pnpm cli voicelab sessions \
  --project prj_… --path /agents/voice/dev-… --sessions 10 --out /tmp/sessions.json
```

Each session runs the same fixed plan of SHORT and MEDIUM turns — more
transitions, not more speech: a turn asked the instant the call goes live,
back-to-back turns with no settle, a one-word prompt, a blank prompt the bridge
must drop, a barge-in over an answer that is still playing, a turn after half a
minute of silence, and a hang-up mid-sentence; plus `conversation.start()` on a
live call and `hangUp()` twice, which must both be no-ops. Between sessions it
remounts (`--remount server|device|both|none`): `server` kills the bridge and
processor DOs and removes the stream's subscription so the next session's setup
must install it again, `device` reboots the board.

The bar is 10/10 and there is no tolerated bucket: every clean turn must have
`sent == played` (zero lost frames, not a low percentage), no counter in the
never-moves tier may move anywhere — `spkOverflow` above all, the ring-overflow
defect that cost one 90-minute run 30% of its audio — and the two cases that
cancel an answer on purpose declare exactly which counters that licenses, with
their movement attributed to the case by name in the report. Latency limits
(`--first-audio-ms`, `--done-short-ms`, `--done-medium-ms`) come from the
measured short-turn baseline and are options, not opinions.

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
