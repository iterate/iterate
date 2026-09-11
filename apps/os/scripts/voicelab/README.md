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

| Event                    | Durability | Payload                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation-requested` | durable    | `{ conversationId, model?, voice?, effort }` — client opens a conversation                                                                                                                                                                                                                                                          |
| `conversation-accepted`  | durable    | `{ conversationId, bridge, model }` — bridge's Grok session is ready                                                                                                                                                                                                                                                                |
| `conversation-ended`     | durable    | `{ conversationId, reason }`                                                                                                                                                                                                                                                                                                        |
| `mic-frame`              | ephemeral  | `{ conversationId, seq, t, pcm }` — 20ms base64 PCM16 @16kHz                                                                                                                                                                                                                                                                        |
| `spk-frame`              | ephemeral  | `{ conversationId, pcm, drop?, last? }` — see below                                                                                                                                                                                                                                                                                 |
| `grok-event`             | ephemeral  | `{ conversationId, t, event }` — the provider's own lane, verbatim, for observability only. No client subscribes to it: the two bits a board ever needed off it (`speech_started`, `response.done`) now ride the audio as `drop` and `last`.                                                                                        |
| `bench-frame`            | ephemeral  | transport bench traffic                                                                                                                                                                                                                                                                                                             |
| `utterance-transcript`   | durable    | `{ conversationId, text }` — the provider's transcription of one finished listener turn                                                                                                                                                                                                                                             |
| `answer-transcript`      | durable    | `{ conversationId, text, cancelled? }` — one finished answer, in words; `cancelled` marks a barged answer whose text was generated but not necessarily heard                                                                                                                                                                        |
| `colleague-status`       | durable    | `{ activity?, title?, waitingFor?, phase?, failure? }` — the colleague's narration plus its model/script lifecycle ("writing code", "running code", failed scripts with their error), forwarded by a copy-to-stream subscription its mint installs; whispered to the live session as quiet context, folded into the reconnect brief |
| `colleague-note`         | durable    | `{ text }` — one chat message from the colleague, copied from its `web-message-sent` feed: THE reply lane (durable, uncorrelated, no deadline), read into whichever call is live and folded (bounded) for the reconnect brief                                                                                                       |

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
ninety-second answer in a few seconds; the agent (now `packages/voice-agent/src/voice-agent.ts`
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

`DEFAULT_SPEAKER_LIMITS` in the agent (now `packages/voice-agent/src/voice-agent.ts`). **None of these moves
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

# live: the Mac as a client — real mic + speaker, against the deployed agent
pnpm cli voicelab talk --project <slug>

# (the old headless `client --say` command is gone; `boards` is the headless
# proof now: it speaks through the Mac speaker at every connected board)

# Literal no-cloud proof: loopback fake provider, synthetic mic, accounted speaker
pnpm cli voicelab local --project voice-test --say "Prove the local audio path."

# transport-only bench: floods PCM-sized ephemeral events at voice cadence,
# measures one-way latency / loss / dupes / stalls / per-connection ceilings
pnpm cli voicelab bench --project prj_… --seconds 120 --rate 50
```

Every command prints a JSON summary with nearest-rank percentiles; `client`
and `direct` share a summary shape so overhead subtracts cleanly.

## Matched latency benchmark

Use this when comparing the direct Node floor, the Mac C client, and a board.
The three runs must use the same OpenAI provider-session snapshot, the same
16 kHz fixture/utterance, 500 ms server VAD, and one fresh connection that
stays open for the full ten minutes. Do not compare a newly configured stream
with a reused one.

Before any spoken wake word, park every non-target MCU in its bootloader using
its MAC-resolved port and retain the confirmation. Another board can wake and
answer the same prompts even while its own probe is idle. Restore those boards
after the isolated run. A valid recording clock alone does not prove acoustic
isolation; any overlapping board call invalidates the room and AEC evidence.

```bash
# terminal A: one room recording for the board run; it validates its own clock
uv run --with sounddevice --with numpy python record-room.py \
  --out /tmp/room.wav --seconds 660

# direct Node floor: the captured fixture + provider-session snapshot
pnpm cli voicelab direct --provider openai \
  --fixture <fixture.wav> --session-snapshot <session.json> \
  --duration-ms 600000 --gap-ms 500 --output-path /tmp/direct.jsonl

# Mac C client: reuse the exact stream configuration; do not reconfigure it
pnpm cli voicelab talk --project <slug> --stream-path <stream> \
  --reuse-config --open-mic --converse 10 --utterance-dir <fixture-dir>

# ESP32 board: persistent ten-minute stream proof and observer evidence
pnpm cli voicelab latency-board --project <slug> --board <board> \
  --minutes 10 --gap-ms 500 --out /tmp/board.json

# acoustic endpoint: use only a room recording whose clock/drop validation passed
uv run --with numpy --with matplotlib python analyze-room.py \
  --wav /tmp/room.wav --probe /tmp/board.json --out /tmp/acoustic

# known-waveform checks: quiet reply, noise alone, short click, late reply
uv run --with numpy --with matplotlib python analyze-room.test.py
```

Report two endpoints for every turn: speech-end → first audio packet received,
and speech-end → first audible sample actually played. `latency-board` health
sampling is an upper bound, not the acoustic endpoint. Compare the first and
last thirds of each persistent run for drift; a short run or a reconnect cannot
establish that latency stays flat over time. These commands describe the method,
not a passing benchmark result.

The board probe defaults to a 3,000 ms response budget and 250 ms maximum
increase in the last-third median. It completes functionally sound late turns
to retain drift evidence, then fails the run if any turn misses its budget.
The acoustic analyzer also requires every turn to be measurable, the room
clock to be valid, and the board probe to pass. A delivery callback refresh
after the configured batch budget is recorded separately; a WebSocket
replacement, board reboot, or unexpected callback refresh fails continuity.
Each turn must have exactly one VAD start, one VAD stop, one input transcript,
and the correct answer. The transcript's prompt-keyword match is recorded
separately: an ASR word mismatch is not classified as self-interruption.
An incorrect answer still fails the run, but does not stop otherwise valid
latency measurements before the ten-minute drift window completes.

Acoustic thresholds use each turn's median pre-prompt RMS plus one, two, and
three times `max(50, pre-prompt p95 RMS - median RMS)`. The onset must begin
50 ms of continuous above-threshold activity; its first bin is the reported
time. The artifact retains all three measurements, including their sensitivity
to the threshold. Known-waveform regressions reject a 30 ms noise click that
previously moved the reported onset 200 ms early, while preserving the onset
of a quiet response and failing an actual four-second response.

### Current findings — acceptance remains open

The Mac C ten-minute run completed 102 turns. Its first-packet latency was
p50 1,593 ms, p90 1,984 ms, and max 5,943 ms. In the same run, first non-quiet
audio played measured p50 1,653 ms, p90 2,053 ms, and max 16,559 ms; the room path reported 189
starved-buffer events and nine underruns, despite zero wire gaps and no
reconnect. During the worst turn, the speaker ring was empty when the first
packet arrived, and that packet contained silence. These results do not
establish a local playout fault; backend append stalls overlapped the delay.
The run fails latency acceptance.
Its first- and last-third medians were nearly identical: first packet increased
by 7 ms and first non-quiet playback decreased by 7 ms. The large tails remain
failures despite that stable median.

HAVPE's first ten-minute run failed at turn 20 after 19 clean turns: it kept
the same connection, but recorded one sequence gap/regression and a superseded
response. An actual acoustic delay of 13,020 ms was confirmed. The direct Node
runner was corrected to continuously send zero PCM while waiting for a reply;
its completed ten-minute run then delivered 160 turns over one connection,
with p50 1,428 ms, p90 1,543 ms, and max 1,689 ms to first non-quiet received
audio. The last-third median was 114 ms above the first third. This endpoint
does not include physical speaker playback.

The next HAVPE run captured provider receipt and audio-boundary timestamps.
It reached 52 turns before the probe rejected a delivery callback refresh.
That refresh was subsequently verified as the expected batch-budget renewal,
with the same WebSocket, board uptime, and provider session. The board then
rebooted under the PONG-only watchdog despite inbound traffic. Its 49
measurable acoustic turns had a 1,970 ms median and 3,080 ms maximum; three
weak replies were unmeasurable, so this run still fails acceptance.

The watchdog fix renews liveness on complete inbound frames and sends periodic
PINGs during inbound silence, even if microphone transmission continues.
Deterministic tests reproduce both old failures and pass with the fix. All
five firmware targets build, and the flashed HAVPE survived over twelve
minutes of unpolled idle time with seven PONGs and no reboot.

With that firmware, a third HAVPE run recorded a 10,110 ms acoustic stall and
then lost its WebSocket after 37 turns. Cloudflare recorded an abnormal close
and a subsequent Durable Object storage reset; the initiating cause remains
unproven. A second direct Node run, using that HAVPE session snapshot, completed
173 turns in ten minutes: median 1,381 ms, maximum 1,798 ms, and a 136 ms
increase between first- and last-third medians. The matched raw Node run with
Satellite's DTO production session snapshot (SHA `e4f72dc…c97`) completed 169
turns: received non-quiet p50 1,377.5 ms, p90 1,523.4 ms, p99 1,966 ms, max
1,988.9 ms, and +89.8 ms first-to-last-third drift
(`/tmp/futurehomes-direct-openai-satellite-dto-matched-10m.jsonl`). Neither is
a physical-playback measure. Backend latency and disconnect acceptance remain
open. Backend changes require a minimal failing reproduction of the observed
symptom before promotion.

A Satellite run was discarded from acoustic/AEC acceptance after serial logs
proved the non-target HAVPE also woke and answered. Satellite's own observer
recorded a 9,099 ms playback bound during that run, so it remains useful as
transport evidence. The isolated ten-minute run must be repeated.

In the new isolated attempt at 2026-09-10T09:06:58.588, a prompt received no
VAD or response for 45 s. Room level was unchanged, with 651 native appends,
zero errors, read-only trace proof, and no reset. Two subsequent three-turn
runs passed with PCM tap evidence: 1,100 frames across 22 s, three VAD pairs,
peak 2,333, and estimated board-send-to-tap median/max 92.5/465.5 ms. This is
not ten-minute acceptance. The subsequent isolated Satellite ten-minute run completed
96 correct turns over one WebSocket and provider session, with one VAD pair,
response, and audio-done each and zero runtime faults
(`/tmp/futurehomes-satellite1-dto-prd-10m.json`). It fails latency acceptance:
turn 3's playback bound was 9,197 ms and turn 41's 3,211 ms; first-/last-third
medians were 1,838/1,825 ms (−13 ms). HAVPE was parked throughout and then
restored to normal RUN health (`/tmp/futurehomes-havpe-dto-prd-restored-ready2.json`).
The room clock was valid to 10.34 ms with zero drops. After the known-waveform
measurement fixes, the analyzer reports 94 of 96 turns, median 1,870 ms and
first-to-last-third change +30 ms. Turns 38 and 82 remain unmeasurable at the
highest threshold. This is incomplete acoustic acceptance; each threshold
sweep remains available for inspection. The reviewed failures remain 9,200 ms
at turn 3 and 3,230 ms at turn 41
(`/tmp/futurehomes-satellite1-dto-prd-acoustic-confirmed.json` and `.png`).

A plain DTO RPC leak retained objects in both inner and outer layers until
session cleanup; a primitive control released per call. The shared helper's
native-object path is 100/100 green on preview `85151b9c` (activation 29–48
ms; invocation 36–57 ms). Nested callable functionality is 8/8 green, while
native lifetime through session cleanup remains unresolved. The DTO fix deployed
to production as `dfe1177a-157c-4039-878b-c656cff30330`; standard deploy and
smokes pass. Temporary `/repros` diagnostics were stripped from production
only; full route/schema/template/typecheck validation and 23 focused tests
pass. The production native guard is now 100/100 Satellite `health()` calls at
09:18:24.508–09:18:34.980, activation 47–108 ms and invocation 56–143 ms,
released per call before two seconds of idle cleanup
(`/tmp/production-satellite1-health-100-proof.json`,
`/tmp/100-activateLiveCapability.json`,
`/tmp/100-invokeLiveCapability.json`). The current minimal backend probes
falsify a strong mutation-only attribution: read vs append reached max
465/2,417 ms and empty append vs ephemeral 1,812/502 ms, with zero
subscriptions and all 60,000 events settled. The exact correlated 30,000-event
ten-minute probe had zero errors and max 1,601 ms; its worst tagged event had
native body 0 ms, native wall 80 ms, and CPU 0. Missing parent-call propagation
prevents an upstream exact join; the next preview probe adds the probe ID to
the ingress span. No storage optimization has been implemented.

The correlated append run had 22,150 successful paired appends before a `1006`
at 09:57:36.059Z. Its owning root `GET /api` request exceeded the 32,000 ms CPU
limit at 09:57:35.554Z (445,429 ms wall), 505 ms earlier, which explains that
peer close (`/tmp/futurehomes-correlated-close-full.json`). The earlier
defaults connection has the same CPU-limit shape
(`/tmp/futurehomes-defaults-close-discover.json`). This does not explain the
HAVPE capability-pager close: its socket turn was 47 ms / 0 CPU, with a
separate later retryable dispose error and storage reset
(`/tmp/futurehomes-havpe-close-root-audit.json`).

A candidate is now deploying to preview: move `/api` WebSocket Cap'n Web
handling into one `ItxSessionDurableObject` per connection, accept it normally,
and forward from the root. Its deployment log is
`/tmp/futurehomes-itx-session-do-preview-deploy.log`. There is no green
long-run proof. This candidate neither explains nor resolves the audio-latency
stalls or the HAVPE pager close; original acceptance remains unmet.

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
doppler run --config prd -- pnpm cli voicelab device --project <slug> --name havpe --action health
```

— and that is deliberately the ONLY way to get one. The boards used to append
`voice-agent/dev-stats` to the call's stream every five seconds whether anyone
was listening or not, which kept four stream Durable Objects awake around the
clock to publish counters nobody was reading. Nothing on a device is pushed on
a timer now. Poll `health()` at turn boundaries for ordinary checks: a poll
loop rebuilds the wakeup cost the heartbeat was deleted for. Its returned
WebSocket traffic also proves transport liveness, so an idle keepalive test
must leave the device unpolled for the interval it is testing.

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

# every connected board, out loud, through real air (Mac speaker -> board mic);
# --only takes a board name or its alias (havpe, satellite1), --barge speaks a
# second time over the answer and requires the device to react
doppler run --config prd -- pnpm cli voicelab boards --project templestein --only satellite1 --barge

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
