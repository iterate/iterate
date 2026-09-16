# Voice agent on os-next

The GPT-Live voice relay and its backend as two facet processors of ONE context per
conversation, installed as project code (no platform deploy). A device presses a button,
a fresh context is born, and the person is talking to the model about a second later.

| File                               | What                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voice-agent.ts`                   | `VoiceAgentDurableObject`: the relay and the durable call fold (ported from `packages/voice-agent`). Dials `wss://api.openai.com/v1/live/sessions` through the context's egress with `getSecret("/secrets/openai")`, forwards `mic-frame`s, appends `spk-frame`s, transcripts, `call-started`/`conversation-accepted`/`conversation-ended`, and records a delegation as `delegation-requested`. |
| `voice-backend.ts`                 | `VoiceBackendDurableObject`: answers a `delegation-requested` with one gpt-6-astra turn (Responses API, same secret, same egress) and one tool, a `async (itx) => …` script run by `itx.run`; replies as `voice-agent/commentary` (`hangUp: true` on a goodbye). Pure processor, table-tested.                                                                                                  |
| `voice-setup.ts`                   | The project's `itx.voice`: `setupVoiceAgent({ streamPath })` enables both facets on `itx.cd(streamPath)` from the sources in the config repo and births the stream. The device's call is unchanged from apps/os.                                                                                                                                                                                |
| `../../scripts/voice-install.ts`   | Bundles the three (esbuild; the SDK stays the injected `./processor.js`), commits them to the project's `config` repo, appends the durable `itx.voice` rewrite rule, sets `/secrets/openai`.                                                                                                                                                                                                    |
| `../../scripts/voice-call.ts`      | One conversation from Node, making exactly the device's calls (below); a WAV in, a WAV out, the timeline printed.                                                                                                                                                                                                                                                                               |
| `../../scripts/inspect-context.ts` | A context's log and subscription rows.                                                                                                                                                                                                                                                                                                                                                          |

## The device's calls

```ts
const root = session.authenticate(credentials).projects.get("prj-voice");
await root.voice.setupVoiceAgent({ streamPath }); // press: both facets on the fresh context
const call = root.cd(streamPath);
await call.subscribe({
  // what the speaker plays
  name: `kit-voice-${activation}`,
  consumes: [
    "events.iterate.com/voice-agent/spk-frame",
    ".../conversation-accepted",
    ".../call-started",
    ".../conversation-ended",
  ],
  target: (events, range) => {
    /* bare function; argument 0 IS the events array */
  },
});
await call.append({
  type: "events.iterate.com/voice-agent/mic-frame",
  ephemeral: true,
  payload: { activation, pcm },
}); // 50 ms PCM16 16 kHz, base64; the first frame mints the call
await call.append({
  type: "events.iterate.com/voice-agent/conversation-ended",
  payload: { activation, reason },
});
```

Facts the platform taught this port: `processors.enable` needs `consumes` naming the ephemeral
types or the facet never sees a microphone frame; the engine's `append` stamps provenance, not the
catalog's `ephemeral` marker, so the facet stamps its speaker frames itself; `provide()` rules are
session-scoped handles (the raw `itx/rewrite-rule-configured` event is the durable rule); a client
push carries every event folded behind it, so one speaker frame per append keeps a push under the
ESP32's 16 KiB inbox slot.

## Install and run against the deployed worker

```bash
export WORKER_BASE_URL=https://os.iterate2.com
export ADMIN_API_SECRET=$(doppler secrets get APP_CONFIG_ADMIN_API_SECRET --project project-worker --config prd --plain)
export OPENAI_API_KEY=$(doppler secrets get OPENAI_API_KEY --project os --config dev --plain)
PROJECT=prj-voice pnpm exec tsx scripts/voice-install.ts
say -o ask.wav --data-format LEI16@16000 --channels=1 "What is two plus two?"
PROJECT=prj-voice pnpm exec tsx scripts/voice-call.ts --utterance ask.wav --out answer.wav
```

Measured on 2026-09-16 (fresh context each time): setup 697–731 ms, `conversation-accepted` at
2.4–3.0 s (the dial itself 1.2–1.8 s from a cold facet), the delegated answer "Two plus two is
four." spoken from 8–10 s.
