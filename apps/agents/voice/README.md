# Voice agents

A GPT-Live voice conversation as TWO facet processors on a fresh context per press — the relay and
the agent it delegates to — with the project's root worker answering the press. Project code only; no platform deploy.

The backend inherits the same system prompt and codemode parser as a normal
agent in this app (`../runtime/system-prompt.ts` and `codemode-format.ts`), with
additional instructions for spoken answers. Keep tool examples in the shared
prompt; do not maintain a separate voice API description.

A device with a screen adds [screen-context.md](screen-context.md) as an
ordinary developer message when the call starts, with its client name filled
in. The agent retains supplied context messages and passes them to the model
unchanged; it has no screen-specific matching logic. Script calls and results
are retained through the same context events, so a later question can refer to
the exercises or other content already displayed. Its display action is
`itx.cd("/").voice.setImage({ device, image: { html } })`. The renderer uses
`screen.info()` for dimensions and supported monochrome, grayscale or colour
formats. Set `image: null` to restore the normal call-status view.
Capture waits for `<img>` decoding and font readiness, with a five-second
asset wait. A failed image leaves the existing screen intact. Use `<img>`
instead of CSS backgrounds for photos; the readiness check covers image
elements. The agent's rendering instructions live in [screen-context.md](screen-context.md).

| File                                  | What                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voice-agent.ts`                      | `VoiceAgentDurableObject`: the GPT-Live relay and the call fold. Dials `wss://api.openai.com/v1/live/sessions` through egress with `getSecret("/secrets/openai")`, forwards `mic-frame`s, appends `spk-frame`s and transcripts, records the live model's hand-offs as `delegation-requested`, and forwards the agent's `commentary-added` to the live model to speak. |
| `voice-delegate.ts`                   | `VoiceDelegateDurableObject`: the project's agent as a second facet on the same context. Consumes `delegation-requested`, folds it as pending, runs one `delegation-turn` and emits `commentary-added` naming the delegationId. Its own fold makes an eviction mid-turn recoverable.                                                                                  |
| `events.ts`                           | The events both facets declare (`delegation-requested`, `thinking-added`, `commentary-added`) and the delegate's `consumes`, shared by its contract and `worker.ts`'s subscription row.                                                                                                                                                                               |
| `delegation-turn.ts`                  | The backend turn, pure: gpt-6-astra (Responses API, same secret, same egress) with one tool, an `async (itx) => …` script run by `itx.run`.                                                                                                                                                                                                                           |
| `delegation-turn.test.ts`             | Table tests for the turn: plain answer, script step, hang-up token, model failure.                                                                                                                                                                                                                                                                                    |
| `worker.ts`                           | The voice service mounted at `itx.voice` through an explicit worker spec. `setupVoiceAgent({ streamPath, activation })` is ONE append on the fresh context: both facets' subscription rows plus `call-started`, so the relay dials at boot.                                                                                                                           |
| `processor.d.ts`                      | Types for `./processor.js`, the SDK the platform injects next to a loaded facet.                                                                                                                                                                                                                                                                                      |
| `install.ts`                          | `ensureVoiceAgent`: stores the OpenAI key, uploads the install as immutable project KV assets and mounts `itx.voice`, preserving existing services and secrets. voice.iterate.com and Kit both run it in the browser.                                                                                                                                                 |
| `../scripts/build-voice-install.ts`   | Bundles the voice service and the agents runtime into the install each app serves at `/voice-install.json`.                                                                                                                                                                                                                                                           |
| `../scripts/voice-call.ts`            | One conversation from Node, making exactly the device's calls; prints the press timeline.                                                                                                                                                                                                                                                                             |
| `../scripts/voice-board.ts`           | The physical HAVPE proof: remote press, the prompt spoken through the air, transcripts checked.                                                                                                                                                                                                                                                                       |
| `../../os/scripts/inspect-context.ts` | A context's log and subscription rows (the board's `health().conversation` names its current one).                                                                                                                                                                                                                                                                    |

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

Run these commands from `apps/agents`. The installer also installs the agents collection.

```bash
export WORKER_BASE_URL=https://os.iterate.com
# a personal access token for prj-voice (apps/os/docs/credentials.md): the Dash's Sessions page, or
# `pnpm exec iterate --config prd tokens create --name voice-scripts --project prj-voice`
export ITERATE_BEARER_TOKEN=itk_…
export OPENAI_API_KEY=$(doppler secrets get OPENAI_API_KEY --project os --config prd --plain)
# First prepare the project at https://k.iterate.com
say -o ask.wav --data-format LEI16@16000 --channels=1 "What is two plus two?"
PROJECT=prj-voice pnpm exec tsx scripts/voice-call.ts --utterance ask.wav --out answer.wav
PROJECT=prj-voice pnpm exec tsx scripts/voice-board.ts --device home_assistant_voice_preview_edition --expect banana
```

Measured 2026-09-16 on the deployed worker, fresh context per press: setup 0.26–0.38 s with
`call-started` inside it, `conversation-accepted` 1.4–1.65 s from the press, the delegated "Two
plus two is four" spoken from ~9 s. The HAVPE proof: press to active call 1.95–2.06 s, "Banana."
and "The result is 132." spoken back. `--expect` is a case-insensitive regular expression tested
against the spoken transcript; models say numbers as digits or as words, so ask for either:
`--expect "132|thirty-two"`.
