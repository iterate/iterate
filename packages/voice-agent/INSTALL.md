# Install the voice agent

In the project config repository, add the voice package and `zod`:

```jsonc
{
  "dependencies": {
    "iterate": "https://pkg.pr.new/iterate/iterate/iterate@main",
    "@iterate-com/voice-agent": "https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@main",
    "zod": "4.5.4",
  },
}
```

Create `voice-agent.ts` at the repository root:

```ts
export { default, VoiceAgentFacet } from "@iterate-com/voice-agent/worker";
```

The worker refs require that file name and exports. Existing older committed
voice-agent source can be replaced with this re-export; the durable facet key
does not change.

Create `/secrets/openai` once, with egress restricted to OpenAI:

```ts
await itx.secrets.get("/secrets/openai").create({
  egress: { urls: ["https://api.openai.com"] },
  material: process.env.OPENAI_API_KEY,
});
```

The agent always uses GPT-Live-1, `marin`, and OpenAI's live endpoint. It has
no provider selection, pickup greeting, or push-to-talk protocol.

Clients generate one RAM-only activation per local call, attach it to every
`mic-frame` and `conversation-ended` write, and process only matching
downlink events. `conversation-ended { activation, reason }` is the only
terminal event and may be sent before call acceptance.

Verify from an Iterate checkout:

```bash
doppler run --config prd -- pnpm cli voicelab talk --project <slug> --setup-only
```
