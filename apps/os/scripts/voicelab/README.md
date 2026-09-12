# Voice lab

Instruments for the GPT-Live voice agent (`packages/voice-agent`) over the
streams abstraction: mic and speaker audio as ephemeral stream events and a
durable transcript.

## Topology

```
live-probe   mic ──────────────────────────► GPT-Live WS ──► speaker   (the raw wire, from this Mac)
platform     mic ──► stream (ephemeral) ──► facet ──► GPT-Live WS
                                              │
             speaker ◄── stream (ephemeral) ◄─┘
                                              │
                                  standard Agent processor (same stream)
```

The facet holds the GPT-Live WebSocket in the stream's Durable Object and
relays audio. The standard Agent processor works on that same stream through
durable events. `live-probe` dials the provider directly; `duplex` exercises
the deployed platform from the wire alone.

## Event protocol (one stream per call)

Every type below is prefixed `events.iterate.com/voice-agent/`, elided here
for width. The full contract, with every payload documented, is
`packages/voice-agent/src/voice-agent.ts` (contract 24.0.0). A client's
whole contract: mic frames up, speaker frames down, `keepalive` while its
call UI is open, and `conversation-ended` to end. Capture runs continuously
from call start; a physical mute remains a local hardware control, never a
wire event.

| Event                   | Durability | Payload                                                                                                                      |
| ----------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `configured`            | durable    | the fixed GPT-Live setup: `instructions`, optional `backend.model`, `visemes`; replaced wholesale by every setup run         |
| `mic-frame`             | ephemeral  | `{ activation, pcm }` — base64 PCM16 @ 16 kHz; the first frame opens that client-local activation                            |
| `call-started`          | durable    | `{ activation, conversationId }` — the server assigned the authoritative conversation id                                     |
| `conversation-accepted` | durable    | `{ activation, conversationId, handshakeTookMs, heldMicFrames }` — `session.started` arrived                                 |
| `session-configured`    | durable    | `{ activation, conversationId, instructions }` — what the GPT-Live session was started with                                  |
| `spk-frame`             | ephemeral  | `{ activation, conversationId, deviceSpeakerFrameSeq, pcm, clearSpeakerBufferBeforeFrame?, lastFrameOfAnswer? }` — see below |
| `utterance-transcript`  | durable    | `{ conversationId, text }` — one finished listener turn, grouped from the provider's timeline fragments                      |
| `answer-transcript`     | durable    | `{ conversationId, text }` — one finished spoken answer, in words                                                            |
| `instructions`          | durable    | `{ activation, delegationId, content }` — Agent context for GPT-Live                                                         |
| `thinking`              | durable    | `{ activation, delegationId, content }` — quiet useful facts or progress                                                     |
| `commentary`            | durable    | `{ activation, delegationId, content, hangUp? }` — speakable Agent outcome                                                   |
| `conversation-ended`    | durable    | `{ activation, reason }` — one terminal event, valid before the server assigns a conversation id                             |

The two transcript events are the stream's only readable record of what was
said — `pnpm cli voicelab transcript` prints them — and the fold's bounded
recap of them is seeded as history into every fresh provider session, so the
reconnect the idle deadline manufactures resumes the conversation instead of
greeting the listener as a stranger.

Every completed user and assistant transcript is also projected to the normal
Agent as `agents/context-added` with `dont-trigger-request`: it is context,
not a request. A GPT-Live client delegation is the sole triggering input. It
appends delegation-id metadata with `after-current-request`, so it never
interrupts Agent work already under way. The Agent sends the three events
above; they convey context to GPT-Live without guaranteeing a particular response.

Ephemeral frames are only visible to live `openConnection()` callbacks — never
to durable subscriptions or hosted processors — which is exactly the delivery
contract audio wants (no replay of stale audio after reconnect).

## The speaker frames

**A client's entire buffer policy is three lines.** On a `spk-frame`: if
`clearSpeakerBufferBeforeFrame`, clear the speaker buffer; write `pcm`; if
`lastFrameOfAnswer`, the answer is over. There is nothing else to implement
and deliberately nothing else to get wrong.

GPT-Live's output is a CONTINUOUS stream — one 100 ms delta per 100 ms for
the life of the call, idle silence as digital zero. The facet drops the idle
silence at the door (the downlink carries speech only), treats a run of
audible deltas as an answer, sends up to 700 ms of trailing silence so the
natural tail plays, and marks `lastFrameOfAnswer` once the queue behind that
drains — the provider has no end-of-answer event. The pacer that bounds the
device's backlog (`MAX_DEVICE_SPEAKER_BACKLOG_BYTES`, 4 s, derived from the
firmware's ring) stays, though a provider that hands audio over at play rate
never reaches it.

## Commands

All take `--project <slug>` plus `APP_CONFIG_BASE_URL`/`APP_CONFIG_ADMIN_API_SECRET`
from the Doppler config (local dev server is the fallback).

```bash
# the raw wire, no Iterate infrastructure: cadence, interruption and gaps
doppler run --config dev -- pnpm cli voicelab live-probe --save-wav out.wav
doppler run --config dev -- pnpm cli voicelab live-probe --barge-after-ms 4000 --say2 "Stop. What was the last number?"

# full duplex through the platform, from the wire alone (no microphone): session,
# continuous mic, answers + markers, quiet idle downlink, spoken barge,
# durable transcript, and same-stream Agent commentary
doppler run --config prd -- pnpm cli voicelab duplex --project <slug> --setup

# the task battery: speak real requests to a deployed Agent and read the
# durable commentary plus the voice's answer; --verify checks project state
doppler run --config prd -- pnpm cli voicelab ask --project <slug> --setup \
  --requests '["Create a markdown file called hello dot md in the notes folder of my config repo, containing hello world, and commit it."]' \
  --verify 'return await itx.repo.readFile({ path: "notes/hello.md" })'

# a real conversation from this Mac: capture starts automatically and stays continuous; q hangs up
doppler run --config prd -- pnpm cli voicelab talk --project <slug>

# what a call said, after the fact
doppler run --config prd -- pnpm cli voicelab transcript --project <slug> --stream-path /agents/voice/<name>
```

## Ending a conversation

A conversation is a **session**, not a turn and not an answer: one provider
socket across many turns and several minutes. It ends after sixty seconds with
no device input or keepalive, or when a person or the model hangs up.

There is one terminal event and three things that can decide to end a call.
Whoever decides appends `voice-agent/conversation-ended` with its local
activation and a reason; the facet closes the provider socket. The durable
event makes teardown readable after the fact rather than inferred from silence.

The deadline is kept twice, deliberately. An in-memory countdown ends a call on
a Durable Object that is still up and receives device input — a keepalive-backed
`runInBackground` loop that sleeps exactly as long as the call has left, NOT a
`setTimeout` (one of those, armed from a delivery whose request context has
already ended, silently never fires; measured on preview-3). The same deadline
is also derivable from the fold (`call.lastDeviceInputAtStreamMs`, folded from
every microphone frame and keepalive using their own commit stamps, with no extra
appends), which is the half that survives the eviction the first cannot — and
which is what stops a revived incarnation re-dialling an abandoned call every
ten seconds forever. `voice-agent.ts`'s `idleDeadlinePassed` explains why the
two cannot disagree.

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
