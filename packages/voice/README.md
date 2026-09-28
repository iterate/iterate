# @iterate-com/voice

A GPT-Live voice conversation on a fresh context per press: every call is an agent of the agents
app (`@iterate-com/agents`, created through `itx.agents`), with this package's relay facet beside
it and the project's `itx.voice` worker answering the press. The relay holds the live model; each
request the live model delegates goes to the agent as a message through the agents app
(`itx.agents.get(path).message(words)`), and the agent's answer goes back to the live model to
speak. One agent loop answers the call: the agents app's, on its model and its sandbox. Userspace:
a project installs this package; the platform ships none of it.

## Install

A project installs voice from a folder of its config repo, beside the agents app's `agents/`:

```text
voice/package.json   { "main": "worker.ts", "dependencies": { "@iterate-com/voice": "https://pkg.pr.new/iterate/iterate/@iterate-com/voice@<sha>" } }
voice/worker.ts      export { default, VoiceAgentDurableObject } from "@iterate-com/voice";
```

`installVoice(itx, await itx.repos.get("/repos/config").modules({ dir: "voice" }))`
(`@iterate-com/voice/install`) mounts that source at `itx.voice`, keeps it in project KV
(`voice/runtime`) for the press's relay facet, and stores the screen font. `ensureVoiceAgent`,
which Kit's Prepare and voice.iterate.com run, also stores the OpenAI key (the live model's) and
commits both folders, in one commit (`commitAppFolders` in `@iterate-com/agents/install`), when the
project has none, then loads both apps at once. To upgrade, pin a newer build and install again.

The backend is the project's normal agent: its system prompt, capability tree and codemode loop.
The press adds [voice-context.md](src/voice-context.md), the instructions for spoken answers, as
a developer message that starts no turn. Keep tool examples in the agents app's prompt; do not
maintain a separate voice API description. Each hand-over carries the words said since the one
before (`Person:` and `Voice:` lines), so the agent's own conversation holds the whole call. The
relay reads the agent's replies with the agents app's codemode parser: a script step's status
reaches the live model as a quiet note, and only the final prose is spoken, for the newest
hand-over the reply's request had read. A reply ending in `HANG_UP` ends the call after the
goodbye, and an agent that pauses says so.

A device with a screen adds [screen-context.md](src/screen-context.md) as an
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
elements. The agent's rendering instructions live in [screen-context.md](src/screen-context.md).

| File                                 | What                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/voice-agent.ts`                 | `VoiceAgentDurableObject`: the GPT-Live relay and the call fold. Dials `wss://api.openai.com/v1/live/sessions` through egress with `getSecret("/secrets/openai")`, forwards `mic-frame`s, appends `speaker-frame`s and transcripts, hands the live model's delegations to the agent on the context, and forwards the agent's replies to the live model to speak. |
| `src/worker.ts`                      | The voice service mounted at `itx.voice`. `setupVoiceAgent({ streamPath, activation })` creates the agent, then ONE append on the fresh context: the relay's subscription row (the installed source, read from project KV), `call-started`, so the relay dials at boot, and the agent's instructions.                                                            |
| `src/install.ts`                     | `voiceFolder`, `installVoice` and `ensureVoiceAgent`: the folder a project installs from, its mount, and the flow Kit and voice.iterate.com run in the browser, preserving existing services and secrets.                                                                                                                                                        |
| `src/screen-font.ts`                 | The screen font's CSS with its font embedded (`assets/`), stored at `voice/screen-font.css`.                                                                                                                                                                                                                                                                     |
| `apps/agents/scripts/voice-call.ts`  | One conversation from Node, making exactly the device's calls; prints the press timeline.                                                                                                                                                                                                                                                                        |
| `apps/agents/scripts/voice-board.ts` | The physical HAVPE proof: remote press, the prompt spoken through the air, transcripts checked.                                                                                                                                                                                                                                                                  |

A conversation's log is `readEvents` on its context, through the CLI (the board's
`health().conversation` names its current one):
`pnpm exec iterate itx run --project <slug> --eval 'return (await itx.cd("<conversation>").readEvents(0, 500)).events'`.

## The device's calls

```ts
const root = session.authenticate(credentials).projects.get("prj-voice");
await root.voice.setupVoiceAgent({ streamPath, activation }); // the press: facet + call-started, one append
const call = root.cd(streamPath);
await call.subscribe({
  // pipelined with the line above
  name: `kit-voice-${activation}`,
  consumes: [
    "events.iterate.com/voice-agent/speaker-frame",
    ".../conversation-accepted",
    ".../call-started",
    ".../call-ended",
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
  type: "events.iterate.com/voice-agent/call-ended",
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

Measured 2026-09-28 on a PR preview with real GPT-Live and the agent's default model, fresh
context per press: `conversation-accepted` 1.5–1.6 s after `call-started`, the hand-over 0.1–0.2 s
after the question's transcript, a question the agent answers without a script ("What is 17 times
3?") spoken 5.4 s after its transcript, and one that needs a script (the time in London) 11–15 s.
The HAVPE proof, measured 2026-09-16: press to active call 1.95–2.06 s, "Banana." and "The result
is 132." spoken back. `--expect` is a case-insensitive regular expression tested
against the spoken transcript; models say numbers as digits or as words, so ask for either:
`--expect "132|thirty-two"`.
