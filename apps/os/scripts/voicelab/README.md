# Voice lab

Instruments for the GPT-Live voice agent (`packages/voice-agent`) over the
streams abstraction: mic and speaker audio as ephemeral stream events and a
durable transcript.

## Topology

```
live-probe   mic ──────────────────────────► GPT-Live WS ──► speaker   (the raw wire, from this Mac)
platform     mic ──► stream (ephemeral) ──► facet ──► GPT-Live WS
                                              │            └─► backend model (gpt-6-astra) ──► exec_typescript on the project
             speaker ◄── stream (ephemeral) ◄─┘
```

The facet is the server side: it holds the GPT-Live WebSocket in the
stream's own Durable Object, relays both directions through the stream, and
answers the backend model's function calls. `live-probe` dials the provider
directly with no iterate infrastructure in the path — the measurements every
design decision in the facet rests on; `duplex` proves the same things
through a deployed platform from the wire alone, no microphone anywhere.

## Event protocol (one stream per call)

Every type below is prefixed `events.iterate.com/voice-agent/`, elided here
for width. The full contract, with every payload documented, is
`packages/voice-agent/src/voice-agent.ts` (contract 23.0.0). A client's
whole contract: mic frames up, speaker frames down, `keepalive` while its
call UI is open, and `conversation-ended` to end. Capture runs continuously
from call start; a physical mute remains a local hardware control, never a
wire event.

| Event                   | Durability | Payload                                                                                                                      |
| ----------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `configured`            | durable    | the fixed GPT-Live setup: `instructions`, backend overrides, `tools`, `visemes`; replaced wholesale by every setup run       |
| `mic-frame`             | ephemeral  | `{ activation, pcm }` — base64 PCM16 @ 16 kHz; the first frame opens that client-local activation                            |
| `call-started`          | durable    | `{ activation, conversationId }` — the server assigned the authoritative conversation id                                     |
| `conversation-accepted` | durable    | `{ activation, conversationId, handshakeTookMs, heldMicFrames }` — `session.started` arrived                                 |
| `session-configured`    | durable    | `{ activation, conversationId, instructions, backendModel, tools }` — what the GPT-Live session was started with             |
| `spk-frame`             | ephemeral  | `{ activation, conversationId, deviceSpeakerFrameSeq, pcm, clearSpeakerBufferBeforeFrame?, lastFrameOfAnswer? }` — see below |
| `utterance-transcript`  | durable    | `{ conversationId, text }` — one finished listener turn, grouped from the provider's timeline fragments                      |
| `answer-transcript`     | durable    | `{ conversationId, text }` — one finished spoken answer, in words                                                            |
| `backend-reply`         | durable    | `{ conversationId, text }` — the backend model's final text for one delegation                                               |
| `conversation-ended`    | durable    | `{ activation, reason }` — one terminal event, valid before the server assigns a conversation id                             |

The two transcript events are the stream's only readable record of what was
said — `pnpm cli voicelab transcript` prints them — and the fold's bounded
recap of them is seeded as history into every fresh provider session, so the
reconnect the idle deadline manufactures resumes the conversation instead of
greeting the listener as a stranger.

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
# the raw wire, no iterate infra: cadence, interrupt, gaps, mute, delegation
doppler run --config dev -- pnpm cli voicelab live-probe --save-wav out.wav
doppler run --config dev -- pnpm cli voicelab live-probe --barge-after-ms 4000 --say2 "Stop. What was the last number?"
doppler run --config prd -- pnpm cli voicelab live-probe --delegation responses --exec --project templestein
# ...a second request while the backend works (delegations serialize), progress
# notes into the voice per backend step, late speech forwarded to the backend
doppler run --config prd -- pnpm cli voicelab live-probe --delegation responses --exec --project <slug> \
  --say2 "How is it going?" --say2-after-delegation-ms 9000 --progress-thinking
doppler run --config prd -- pnpm cli voicelab live-probe --delegation responses --exec --allow-writes --project <slug> \
  --say2 "Oh, and put purple elephant in it." --say2-after-delegation-ms 300 --forward-transcript

# full duplex through the platform, from the wire alone (no microphone): session,
# continuous mic, answers + markers, quiet idle downlink, spoken barge,
# durable transcript, the Astra delegation round trip
doppler run --config prd -- pnpm cli voicelab duplex --project <slug> --setup

# the task battery: speak real requests to a deployed agent and read back the
# delegation (and how much of the request it carried), every backend script
# and its result, the backend's text, the voice's words; --verify checks the
# project's actual state afterwards with an itx script body
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
