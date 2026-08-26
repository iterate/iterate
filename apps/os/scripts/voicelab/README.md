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

| Event                    | Durability | Payload                                                                                                                                                                                                                                      |
| ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation-requested` | durable    | `{ conversationId, model?, voice?, effort }` — client opens a conversation                                                                                                                                                                   |
| `conversation-accepted`  | durable    | `{ conversationId, bridge, model }` — bridge's Grok session is ready                                                                                                                                                                         |
| `conversation-ended`     | durable    | `{ conversationId, reason }`                                                                                                                                                                                                                 |
| `mic-frame`              | ephemeral  | `{ conversationId, seq, t, pcm }` — 20ms base64 PCM16 @16kHz                                                                                                                                                                                 |
| `spk-frame`              | ephemeral  | `{ conversationId, pcm, drop?, last? }` — see below                                                                                                                                                                                          |
| `grok-event`             | ephemeral  | `{ conversationId, t, event }` — the provider's own lane, verbatim, for observability only. No client subscribes to it: the two bits a board ever needed off it (`speech_started`, `response.done`) now ride the audio as `drop` and `last`. |
| `bench-frame`            | ephemeral  | transport bench traffic                                                                                                                                                                                                                      |
| `utterance-transcript`   | durable    | `{ conversationId, text }` — the provider's transcription of one finished listener turn                                                                                                                                                      |
| `answer-transcript`      | durable    | `{ conversationId, text, cancelled? }` — one finished answer, in words; `cancelled` marks a barged answer whose text was generated but not necessarily heard                                                                                 |

The two transcript events (contract 13.0.0) are the stream's only readable
record of what was said — `pnpm cli voicelab transcript` prints them — and
the fold's bounded recap of them briefs every fresh provider session, so the
reconnect the idle deadline manufactures resumes the conversation instead of
greeting the listener as a stranger.

Ephemeral frames are only visible to live `openConnection()` callbacks — never
to durable subscriptions or hosted processors — which is exactly the delivery
contract audio wants (no replay of stale audio after reconnect).

## The speaker lane

**A client's entire buffer policy is three lines.** On a `spk-frame`: if
`drop`, clear the speaker buffer; write `pcm`; if `last`, the answer is over
and the half-duplex fence can be released. There is nothing else to implement
and deliberately nothing else to get wrong.

That is possible because **the server holds the answer**. The provider emits a
ninety-second answer in a few seconds; the agent (now `configs/voice-agent/voice-agent.ts`
at the repo root, which folded in the former `speaker.ts`) buffers it and
releases it at playback rate, never running more than `leadMs` ahead of the
listener. It is a pure reducer — no clock, no timer, no I/O — so the whole
policy is unit-tested in `speaker.test.ts`, and `voice-agent.count-to-100.test.ts`
drives the real facet against a simulated board with the board's real bounds.

It used to be the other way round: the device's ring was grown to thirty
seconds and described in its own comment as "the answer" rather than a
cushion, with catch-up, high-water and lag-skip machinery around it all
compensating for a sender that would not wait. `drop`/`last` replaced
`audio_playout.c`, 230 lines of answer numbering whose latches could silence a
board permanently.

### Knobs, and what each is coupled to

`DEFAULT_SPEAKER_LIMITS` in the agent (now `configs/voice-agent/voice-agent.ts`). **None of these moves
alone** — each has a counterpart in the firmware, and the failure when they
disagree is silent from the server's side.

| Knob         | Default | Moves with                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leadMs`     | 3000    | `ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES` (10 s). The ring must exceed the lead with margin for jitter, or the board refuses audio at the door — and a frame refused on arrival was never a frame that went missing, so the loss counters stay innocent while whole seconds vanish.                                                                                                                                            |
| `maxChunkMs` | 300     | `ITERATE_KIT_VOICELAB_B64_CAPACITY` and `ITERATE_KIT_VOICELAB_CHUNK_MULAW_BYTES`, and the 16 KiB `ITERATE_KIT_VOICE_CONTROL_INBOX_SLOT_CAPACITY`. An oversized `pcm` string is dropped **silently**; an oversized **message** is **terminal** and latches the socket generation. The device cannot defend itself here: it asks for `maxDeliveryBytes: 13000`, but `capSessionDelivery` always ships at least one event whole. |
| `minChunkMs` | 100     | nothing — pure event-count/latency trade. Not applied to an answer's opening chunk, which always goes immediately.                                                                                                                                                                                                                                                                                                            |
| `frameMs`    | 20      | `ITERATE_KIT_VOICELAB_FRAME_BYTES` (640). Both device consumers reject any other length outright, so chunks are a whole number of frames and an answer's tail is padded with silence rather than truncated.                                                                                                                                                                                                                   |

Raising `maxChunkMs` toward "one event per answer" is the obvious win for
device CPU and needs three firmware buffers and a PSRAM budget raised first.

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

## Ending a conversation

A conversation is a **session**, not a press and not an answer: one provider
socket across many presses and several minutes. It ends when nobody has spoken
in EITHER direction for sixty seconds, or when a person or the model hangs up.

There is one way to end a call and three things that can decide to. Whoever
decides appends `voice-agent/conversation-end-requested` with a reason; the
facet consumes it on its ordinary delivery lane, lets the provider socket go,
and appends `voice-agent/conversation-ended`. Both are on the stream, so a
teardown is readable after the fact rather than inferred from silence.

The deadline is kept twice, deliberately. An in-memory countdown ends a call on
a Durable Object that is still up and sees both directions — a keepalive-backed
`runInBackground` loop that sleeps exactly as long as the call has left, NOT a
`setTimeout` (one of those, armed from a delivery whose request context has
already ended, silently never fires; measured on preview-3). The same deadline
is also derivable from the fold (`call.lastHeardAtMs`, folded from the press
verbs and every microphone frame using their own commit stamps, with no extra
appends), which is the half that survives the eviction the first cannot — and
which is what stops a revived incarnation re-dialling an abandoned call every
ten seconds forever. `voice-agent.ts`'s `idleDeadlinePassed` explains why the
two cannot disagree.

Proving it takes a real deployment and real silence, because the interesting
case is the Durable Object being evicted underneath the call:

```bash
# one press, then 150s of nobody saying anything: expect the request and the end
doppler run --config preview_3 -- pnpm cli voicelab teardown \
  --project marginal-1 --stream-path /agents/voice/teardown-1

# the negative: four presses 45s apart stay on ONE call, and only then end
doppler run --config preview_3 -- pnpm cli voicelab teardown \
  --project marginal-1 --stream-path /agents/voice/teardown-2 \
  --presses 4 --gap-ms 45000
```

The quiet phase drops the itx connection entirely rather than polling — a poll
every few seconds keeps the object awake and proves the easy half.

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
