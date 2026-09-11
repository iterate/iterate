# @iterate-com/voice-agent

The server side of an Iterate voice line. Boards, the host CLI, and mobile
clients share one stream with a GPT-Live-1 session. GPT-Live listens and
speaks; it delegates project work to the configured backend model, which has
`exec_typescript` and the setup's `hang_up` tool.

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
  tools: [
    {
      name: "hang_up",
      description: "Say goodbye, then end the call when the conversation is over.",
    },
  ],
});
```

The voice endpoint, model, and voice are fixed: OpenAI GPT-Live-1 at
`https://api.openai.com/v1/live/sessions`, using `marin` at 16 kHz PCM16.
Setup requires `/secrets/openai` with egress for `https://api.openai.com`.

| Setup option   | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `streamPath`   | Absolute conversation stream path; a fresh voice path when omitted.         |
| `instructions` | Voice persona and tone.                                                     |
| `backend`      | Optional backend model, reasoning, service-tier, and instruction overrides. |
| `tools`        | Backend tools. `hang_up` is the only tool the facet implements directly.    |
| `visemes`      | Publish face state for a rendering client.                                  |
| `reinstall`    | Force a new subscription key.                                               |

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

## Durable record

The stream keeps configuration, call lifecycle, transcripts, backend replies,
session configuration, and provider errors/disconnections. Raw provider
traffic and audio are not mirrored. Speaker frames and microphone frames are
ephemeral.

## Verification

```bash
pnpm --dir packages/voice-agent typecheck
pnpm --dir apps/os exec vitest run scripts/voicelab/voice-agent.test.ts
```

For a project integration check:

```bash
doppler run --config prd -- pnpm cli voicelab talk --project <slug> --setup-only
```
