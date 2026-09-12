# @iterate-com/voice-agent

The server side of an Iterate voice line. Boards, the host CLI, and mobile
clients share one stream with a GPT-Live-1 session. GPT-Live listens and
speaks; client delegation adds context to the normal OS Agent processor
running on that same stream. The Agent uses its standard capabilities and can
decide to end the call after a short goodbye.

The package runs as a guest worker in a project's config repository. The
stateless entrypoint installs a stream subscription, and one Durable Object
facet per stream holds the live socket and folds the durable call record.

## Install

Add these dependencies and guest file to the config repository:

```jsonc
{
  "dependencies": {
    "iterate": "https://pkg.pr.new/iterate/iterate/iterate@main",
    "@iterate-com/voice-agent": "https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@main",
    "zod": "4.5.4",
  },
}
```

```ts
// voice-agent.ts
export { default, VoiceAgentFacet } from "@iterate-com/voice-agent/worker";
```

`pnpm cli voicelab deploy --project <slug>` makes the same changes. See
[INSTALL.md](./INSTALL.md) for the complete installation note.

## Setup

```ts
import { VoiceAgentApp } from "@iterate-com/voice-agent";

const voice = VoiceAgentApp.create(env);
const line = await voice.setup({
  streamPath: "/agents/voice/kitchen",
  instructions: "You are a concise, helpful home assistant.",
});
```

The voice endpoint, model, and voice are fixed: OpenAI GPT-Live-1 at
`https://api.openai.com/v1/live/sessions`, using `marin` at 16 kHz PCM16.
Setup requires `/secrets/openai` with egress for `https://api.openai.com`.

| Setup option    | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `streamPath`    | Absolute conversation stream path; a fresh voice path when omitted. |
| `instructions`  | Voice persona and tone.                                             |
| `backend.model` | Optional explicit standard-Agent model override.                    |
| `visemes`       | Publish face state for a rendering client.                          |
| `reinstall`     | Force a new subscription key.                                       |

## Stream protocol

Each local call has an opaque `activation`, generated in RAM and kept until
the client ends it. Mic and terminal writes must be serialized by one local
sender. The server owns the `conversationId`.

| Event                   | Direction       | Payload                                                           |
| ----------------------- | --------------- | ----------------------------------------------------------------- |
| `mic-frame`             | client → server | `{ activation, pcm }`                                             |
| `keepalive`             | client → server | `{}` about every 20 seconds while the call UI is open             |
| `conversation-ended`    | either          | `{ activation, reason }`                                          |
| `call-started`          | server → client | `{ activation, conversationId }`                                  |
| `conversation-accepted` | server → client | `{ activation, conversationId, handshakeTookMs, heldMicFrames }`  |
| `spk-frame`             | server → client | `{ activation, conversationId, deviceSpeakerFrameSeq, pcm, ... }` |

Clients discard downlink events whose activation is no longer current. They
play speaker frames in sequence, clear their buffer when requested, and treat
`lastFrameOfAnswer` as an answer boundary.

The opening budget is bounded: the facet holds at most 21 seconds of decoded
microphone audio and the complete socket-plus-session opening has 15 seconds.
Either limit ends the activation with a classified reason; audio is never
silently truncated. A provider disconnection also ends the activation rather
than replaying an uncertain session.

## Same-stream Agent interface

GPT-Live delegates client work to the standard OS Agent on this same stream.
The Agent owns the work, its normal capabilities, and its normal model
configuration. Setup may override that model only with `backend.model`.

The processors communicate through three durable, plain-content events. Agent
LLM work tracks the activation and an applicable delegation id, or `null`.
The ordinary Agent owns expiry and retries; VoiceAgent adds no work deadline
and has no external reply Agent.

There are two separate Agent inputs. Every completed user and assistant
transcript projects as `agents/context-added` with `dont-trigger-request`, so
the Agent has the conversation without treating a transcript as a request.
Human speech remains user context; Live speech is labelled as an observed voice
transcript, so the ordinary Agent does not mistake it for its own output.
Only a GPT-Live client delegation appends its delegation-id metadata as
triggering `context-added`, with `after-current-request`; it does not
interrupt Agent work already in progress.

| Event          | Payload                                          | Voice action                                                             |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `instructions` | `{ activation, delegationId, content }`          | Append the content to GPT-Live session instructions.                     |
| `thinking`     | `{ activation, delegationId, content }`          | Append quiet useful facts or progress.                                   |
| `commentary`   | `{ activation, delegationId, content, hangUp? }` | Append speakable outcome; if `hangUp`, end only after the goodbye plays. |

The voice facet accepts only events for its current activation. These appends
convey information to GPT-Live; they do not guarantee a particular response.
Terminal state fences late events. Capture and playback continue while the
Agent works.

## Durable record

The stream keeps configuration, call lifecycle, transcripts, Agent
instructions/thinking/commentary, session configuration, and provider
errors/disconnections. Raw provider traffic and audio are not mirrored.
Speaker frames and microphone frames are ephemeral.

## Verification

```bash
pnpm --dir packages/voice-agent typecheck
pnpm --dir apps/os exec vitest run scripts/voicelab/voice-agent.test.ts
```

For a project integration check:

```bash
doppler run --config prd -- pnpm cli voicelab talk --project <slug> --setup-only
```
