# Voice agent on os-next

A GPT-Live voice conversation as ONE facet processor on a fresh context per press, with the
project's root worker answering the press. Project code only; no platform deploy.

| File                               | What                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voice-agent.ts`                   | `VoiceAgentDurableObject`: the relay and the call fold (from `packages/voice-agent`), and the backend turn for the live model's delegations. Dials `wss://api.openai.com/v1/live/sessions` through egress with `getSecret("/secrets/openai")`, forwards `mic-frame`s, appends `spk-frame`s and transcripts, records a delegation as `delegation-requested`, answers it with `commentary`. |
| `delegation-turn.ts`               | The backend turn, pure: gpt-6-astra (Responses API, same secret, same egress) with one tool, a `async (itx) => …` script run by `itx.run`. Table-tested.                                                                                                                                                                                                                                  |
| `worker.ts`                        | The project's root worker (`itx.worker`); `itx.voice` is an alias of it. `setupVoiceAgent({ streamPath, activation })` is ONE append on the fresh context: the facet's subscription row plus `call-started`, so the facet dials at boot.                                                                                                                                                  |
| `../../scripts/voice-install.ts`   | Bundles the two files into the project's KV, appends the two rules, sets the secret.                                                                                                                                                                                                                                                                                                      |
| `../../scripts/voice-call.ts`      | One conversation from Node, making exactly the device's calls; prints the press timeline.                                                                                                                                                                                                                                                                                                 |
| `../../scripts/voice-board.ts`     | The physical HAVPE proof: remote press, the prompt spoken through the air, transcripts checked.                                                                                                                                                                                                                                                                                           |
| `../../scripts/inspect-context.ts` | A context's log and subscription rows.                                                                                                                                                                                                                                                                                                                                                    |

## The device's calls

```ts
const root = session.authenticate(credentials).projects.get("prj-voice");
await root.voice.setupVoiceAgent({ streamPath, activation }); // the press: facet + call-started, one append
const call = root.cd(streamPath);
await call.subscribe({
  // pipelined with the line above
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
}); // 50 ms PCM16 16 kHz, base64
await call.append({
  type: "events.iterate.com/voice-agent/conversation-ended",
  payload: { activation, reason },
});
```

Platform facts this leans on: a processor sees an ephemeral type only when its subscription names
it (`consumes: ["*", mic-frame, keepalive]`); the engine's `append` stamps provenance, not the
catalog's `ephemeral` marker, so the facet stamps its speaker frames; `provide()` rules are
session-scoped handles, the raw `itx/rewrite-rule-configured` event is the durable rule; a client
push carries every event folded behind it, so one speaker frame per append keeps a push under the
ESP32's 16 KiB inbox slot.

## Install, run, prove

```bash
export WORKER_BASE_URL=https://os.iterate2.com
export ADMIN_API_SECRET=$(doppler secrets get APP_CONFIG_ADMIN_API_SECRET --project project-worker --config prd --plain)
export OPENAI_API_KEY=$(doppler secrets get OPENAI_API_KEY --project os --config dev --plain)
PROJECT=prj-voice pnpm exec tsx scripts/voice-install.ts
say -o ask.wav --data-format LEI16@16000 --channels=1 "What is two plus two?"
PROJECT=prj-voice pnpm exec tsx scripts/voice-call.ts --utterance ask.wav --out answer.wav
PROJECT=prj-voice pnpm exec tsx scripts/voice-board.ts --device home_assistant_voice_preview_edition
```

Measured 2026-09-16 on the deployed worker, fresh context per press: setup 0.4–0.5 s (the
context's Durable Object boot is 265–356 ms of it), `conversation-accepted` 1.3–1.6 s, the
delegated "Two plus two is four" spoken from ~8 s. The HAVPE proof passed three times (press to
active call 3.1–3.8 s; "Okay. I've asked for it. 132.").
