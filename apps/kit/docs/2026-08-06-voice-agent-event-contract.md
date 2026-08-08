# The voice-agent event contract, as it actually is

A map of every event on a voice stream: who writes it, whether it survives, and
how audio and mouth shapes travel. Written for feedback — the last section is
the list of things I think are wrong.

Everything below was read out of the source today. Where I could not verify a
claim I say so inline rather than rounding it up.

---

## 1. The naming is inconsistent, and you spotted it

You expected `events.iterate.com/voice-agent/…`. Exactly **one** event uses that
prefix:

```
events.iterate.com/voice-agent/created
```

Every other voice event is bare — `voice-agent/call-requested`,
`voice-agent/spk-frame`, `voice-agent/viseme`, and so on. Meanwhile the platform's
own events on the same stream are fully qualified:

```
events.iterate.com/stream/created
events.iterate.com/stream/subscription-configured
events.iterate.com/agents/context-added
events.iterate.com/capability-host/script-run-settled
```

So a single stream carries two naming schemes, and the split does not follow
"platform vs application" — it follows _who happened to write the line_. The one
qualified voice event is the guest-lifecycle one; the seven the processor
declares itself are bare.

**This is worth fixing and it is not free.** Devices match some of these strings
in C, so a rename is a fleet reflash unless the bridge dual-emits for a window.

---

## 2. What the processor contract is

`VoiceAgentProcessorContract` (`apps/os/scripts/voicelab/config-repo/voice-agent.ts`)
is a `defineProcessorContract` with three parts:

| Part               | Contents                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `slug` / `version` | `1.0.0`, "Starts bounded voice bridges from fresh call requests on one configured stream." |
| `stateSchema`      | `birthCertificate`, `briefCurrent`, `pendingCall` — the durable state the processor folds  |
| `events`           | **8 declared types**                                                                       |

Declared events:

```
events.iterate.com/voice-agent/created
voice-agent/call-requested
voice-agent/call-accepted
voice-agent/call-failed
voice-agent/brief-current
voice-agent/warmup
voice-agent/warmup-ready
voice-agent/warmup-unresolved
```

Subscribed events (what wakes the processor) are a subset of six:
`created`, `call-requested`, `call-accepted`, `call-failed`, `warmup`,
`brief-current`.

### The structural fact worth arguing about

**There are three writers on this stream and the contract describes one of them.**

- The **processor** declares and writes the eight above.
- The **bridge** — a Durable Object, deliberately not a processor, because hosted
  processors never receive ephemeral events — writes `spk-frame`, `grok-event`,
  `viseme`, `pong`, `call-accepted`, `call-ended`, `bridge-redialling`.
- The **device** (or the TS client) writes `mic-frame`, `turn`, `ping`,
  `dev-stats`, `call-requested`, `call-ended`.

Roughly twenty `voice-agent/*` types exist; eight are in the contract. The rest
are real, load-bearing, and undeclared — there is no schema, no description, and
nothing that fails when one changes shape.

---

## 3. Ephemeral vs durable

**Ephemerality is a per-append boolean, not a property of the type.** Each append
carries `ephemeral: true` or omits it:

```ts
{ type: "voice-agent/spk-frame", ephemeral: true, payload: { … } }
{ type: "voice-agent/call-ended",                 payload: { … } }
```

The consequence, which has cost this project several wrong conclusions: **an
ephemeral event only reaches connections that already existed when it was
appended.** Read the stream afterwards and it was never there. A test that opens
its instrument after the turn sees an empty transcript and reports a device that
said nothing.

| Event                                    | Direction       | Durable?                                   | Notes                             |
| ---------------------------------------- | --------------- | ------------------------------------------ | --------------------------------- |
| `events.iterate.com/voice-agent/created` | platform        | durable                                    | guest exists                      |
| `voice-agent/call-requested`             | device →        | durable                                    | opens the obligation              |
| `voice-agent/call-accepted`              | bridge →        | durable                                    | closes it; provider accepted      |
| `voice-agent/call-failed`                | processor →     | durable                                    | closes it; says why               |
| `voice-agent/call-ended`                 | either →        | durable                                    | verified: appended with no flag   |
| `voice-agent/turn`                       | device →        | durable                                    | `{callId, action: start\|commit}` |
| `voice-agent/brief-current`              | setup →         | durable                                    | which brief is at the head        |
| `voice-agent/warmup*`                    | setup ↔         | durable                                    | token in, same token out          |
| `voice-agent/mic-frame`                  | device →        | **ephemeral**                              | 20 ms of microphone               |
| `voice-agent/spk-frame`                  | bridge →        | **ephemeral**                              | 20 ms of answer                   |
| `voice-agent/grok-event`                 | bridge →        | **ephemeral**                              | raw provider event                |
| `voice-agent/viseme`                     | bridge →        | **ephemeral**                              | mouth shape                       |
| `voice-agent/ping` / `pong`              | device ↔ bridge | **ephemeral**                              | liveness                          |
| `voice-agent/dev-stats`                  | device →        | ephemeral _(believed; not verified today)_ | the health document               |

The rule underneath: **audio and anything at audio rate is ephemeral; anything
that decides what happens next is durable.** The obligation pattern depends on
it — a request opens an obligation and only a durable accept/fail closes it, so
an evicted processor can pick the obligation back up.

---

## 4. How audio travels

One socket, one stream, no side channel. Both directions are 20 ms of 16 kHz
mono PCM16 — 640 bytes — mu-law companded and base64'd into JSON.

**Downlink** (`voice-agent/spk-frame`, ephemeral):

```ts
payload: {
  callId,          // which call
  answer,          // which answer within it
  frame,           // which 20 ms within that answer
  seq,             // monotonic across the connection, for gap detection
  t, tGrok,        // stamps
  enc: "u",        // mu-law
  pcm: "<base64>",
}
```

`(callId, answer, frame)` is the **identity triple** and it is the whole
interruption design: there is no server-side pacing, the listener owns the
clock, and a frame that belongs to a superseded answer is discarded by identity
rather than by timing. A whole answer leaves as fast as the wire takes it into a
30-second ring on the device.

**Uplink** (`voice-agent/mic-frame`, ephemeral): the same shape in reverse, four
frames per append — measured, not chosen; the socket sustains ~25–50 messages/s
and four frames is 25/s.

---

## 5. How mouth shapes travel

Visemes are computed **server-side** and sent as their own sparse ephemeral
event — no device fallback, because the device-side version measured badly.

```ts
{ type: "voice-agent/viseme", ephemeral: true, payload: {
    callId,
    answer,          // which answer — same numbering as spk-frame
    playoutSamples,  // 16 kHz samples from that answer's FIRST sample
    viseme,          // firmware id 0–14; 14 (SIL) closes the mouth
    confidence,
} }
```

The important bit is `playoutSamples`. The mouth is not driven by arrival time —
it is placed on the **answer's own sample timeline**, and the device matches it
against PCM that has actually completed speaker DMA. Drive it from the WebSocket
callback instead and the mouth leads by however much the speaker buffer holds.

---

## 6. The vocabulary leak

The device does **not** only consume the neutral events above. It parses seven of
the provider's own event names, verbatim, in `voicelab_stream.c`:

```
input_audio_buffer.speech_started
conversation.item.input_audio_transcription.completed
conversation.item.added
response.created
response.done
response.output_audio_transcript.delta
response.output_audio_transcript.done
```

They collapse into a four-value control enum on the device —
`SPEECH_STARTED`, `RESPONSE_DONE`, `CALL_ACCEPTED`, `CALL_ENDED` — plus a
transcript callback.

The bridge already translates for audio and for visemes. It does not translate
for control, so **a provider rename is a fleet reflash**, on boards where opening
the console reboots them and one CoreS3 has already dropped off the USB tree
mid-flash. This is the single strongest argument for the direction you are
pushing.

One caveat learned today: `response.done` says _generation_ finished, not
_speaking_. It is a small text event racing hundreds of audio events and it
routinely wins. A device that treats it as "stopped talking" blanks its face
mid-sentence — which is what happened.

---

## 7. What I think is wrong

1. **Two naming schemes on one stream**, split by author rather than by meaning.
   Either everything voice is `events.iterate.com/voice-agent/…` or the platform
   prefix means something specific that should be written down.
2. **Twelve or so undeclared event types.** The contract describes the
   processor's eight; the bridge's and the device's are schema-less. They are the
   ones carrying all the audio.
3. **Ephemerality is invisible at the type level.** It is decided per append, so
   the same type could in principle be written both ways, and nothing tells a
   reader which types are unreadable after the fact.
4. **Provider vocabulary is compiled into firmware** (§6).
5. **No event describes device state.** The lights, the face and the status word
   are computed on-device from scraped locals. If device state were a projection
   of this stream, the ring would be assertable in a host test and changeable
   without a reflash — which is the thing you actually asked for.

## 8. What I could not verify today

- Whether `dev-stats` is appended ephemerally everywhere (believed yes).
- The full payload schemas of the undeclared events — they have none to read.
- Whether any consumer other than the bridge and the devices reads `grok-event`.
