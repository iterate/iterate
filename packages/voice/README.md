# @iterate-com/voice

A GPT-Live voice conversation as TWO facet processors on a fresh context per press — the relay and
the agent it delegates to — with the project's `itx.voice` worker answering the press. Userspace:
a project installs this package; the platform ships none of it. It runs on the agents app
(`@iterate-com/agents`): every call is an agent, created through `itx.agents`.

## Install

A project installs voice from a folder of its config repo, beside the agents app's `agents/`:

```text
voice/package.json   { "dependencies": { "@iterate-com/voice": "https://pkg.pr.new/iterate/iterate/@iterate-com/voice@<sha>" } }
voice/worker.ts      export { default, VoiceAgentDurableObject, VoiceDelegateDurableObject } from "@iterate-com/voice";
```

`installVoice(itx, await itx.repos.get("/repos/config").modules({ dir: "voice" }))`
(`@iterate-com/voice/install`) mounts that source at `itx.voice`, hands it to the worker as its
props (the press's facets load it), and stores the screen font. The worker serves a caller beneath
the root as that caller (`forCaller`): a jail's or a sandbox's call is created through its own
`itx.agents`, beneath it and linked to it, and its screens are the `itx.clients` it inherits. `ensureVoiceAgent`, which Kit's
Prepare and voice.iterate.com run, also stores the OpenAI key and commits both folders when the
project has none. To upgrade, pin a newer build and install again.

The backend inherits the same system prompt and codemode parser as a normal agent
(`@iterate-com/agents/system-prompt` and `@iterate-com/agents/codemode-format`), with additional
instructions for spoken answers. Keep tool examples in the shared prompt; do not maintain a
separate voice API description.

A device with a screen adds [screen-context.md](src/screen-context.md) as an
ordinary developer message when the call starts, with its client name filled
in. The agent retains supplied context messages and passes them to the model
unchanged; it has no screen-specific matching logic. Script calls and results
are retained through the same context events, so a later question can refer to
the exercises or other content already displayed. Its display action is
`itx.voice.setImage({ device, image: { html } })`, which the agent's sandbox inherits from the
root through its parent links. The renderer uses
`screen.info()` for dimensions and supported monochrome, grayscale or colour
formats. Set `image: null` to restore the normal call-status view.
Capture waits for `<img>` decoding and font readiness, with a five-second
asset wait. A failed image leaves the existing screen intact. Use `<img>`
instead of CSS backgrounds for photos; the readiness check covers image
elements. The agent's rendering instructions live in [screen-context.md](src/screen-context.md).

| File                                 | What                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/voice-agent.ts`                 | `VoiceAgentDurableObject`: the GPT-Live relay and the call fold. Dials `wss://api.openai.com/v1/live/sessions` through egress with `getSecret("/secrets/openai")`, forwards `mic-frame`s, appends `spk-frame`s and transcripts, records the live model's hand-offs as `delegation-requested`, and forwards the agent's `commentary-added` to the live model to speak. |
| `src/voice-delegate.ts`              | `VoiceDelegateDurableObject`: the project's agent as a second facet on the same context. Consumes `delegation-requested`, folds it as pending, runs one `delegation-turn` and emits `commentary-added` naming the delegationId. Its own fold makes an eviction mid-turn recoverable.                                                                                  |
| `src/events.ts`                      | The events both facets declare (`delegation-requested`, `thinking-added`, `commentary-added`) and the delegate's `consumes`, shared by its contract and `worker.ts`'s subscription row.                                                                                                                                                                               |
| `src/delegation-turn.ts`             | The backend turn, pure: gpt-6-astra (Responses API, same secret, same egress) with one tool, an `async (itx) => …` script run by `itx.run`.                                                                                                                                                                                                                           |
| `src/worker.ts`                      | The voice service mounted at `itx.voice`. `setupVoiceAgent({ streamPath, activation })` is ONE append on the fresh context: both facets' subscription rows (the installed source, read from project KV) plus `call-started`, so the relay dials at boot.                                                                                                              |
| `src/install.ts`                     | `voiceFolder`, `installVoice` and `ensureVoiceAgent`: the folder a project installs from, its mount, and the flow Kit and voice.iterate.com run in the browser, preserving existing services and secrets.                                                                                                                                                             |
| `src/screen-font.ts`                 | The screen font's CSS with its font embedded (`assets/`), stored at `voice/screen-font.css`.                                                                                                                                                                                                                                                                          |
| `apps/agents/scripts/voice-call.ts`  | One conversation from Node, making exactly the device's calls; prints the press timeline.                                                                                                                                                                                                                                                                             |
| `apps/agents/scripts/voice-board.ts` | The physical HAVPE proof: remote press, the prompt spoken through the air, transcripts checked.                                                                                                                                                                                                                                                                       |
| `apps/os/scripts/inspect-context.ts` | A context's log and subscription rows (the board's `health().conversation` names its current one).                                                                                                                                                                                                                                                                    |

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

Run these commands from `apps/agents`. The installer also installs the agents app.

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
