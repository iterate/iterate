# @iterate-com/voice-agent

The realtime voice agent for iterate projects — the server side that the ESP32
boards, the voicelab host CLI, and the mobile app talk to — as an ordinary
package. A project's config repo declares it and re-exports it from a
three-line `voice-agent.ts`; the platform builds that file the way it builds
`worker.ts`. The repo holds the agent's name, not a copy.

- [What it is](#what-it-is)
- [Enabling voice on a project](#enabling-voice-on-a-project)
- [From the project's own worker: `VoiceAgentApp`](#from-the-projects-own-worker-voiceagentapp)
- [Provider secrets](#provider-secrets)
- [What `setup` does, and the colleague](#what-setup-does-and-the-colleague)
- [Talking to a line: the stream protocol](#talking-to-a-line-the-stream-protocol)
- [From anything that holds a project handle: the worker refs](#from-anything-that-holds-a-project-handle-the-worker-refs)
- [The installer](#the-installer)
- [Versions, pinning, upgrading](#versions-pinning-upgrading)
- [Building and testing](#building-and-testing)
- [Troubleshooting](#troubleshooting)

## What it is

A project on iterate is a config repo whose `worker.ts` the platform builds
and runs. The voice agent is a **guest worker** beside it: a second program
in the same repo, `voice-agent.ts`, which the platform builds and runs in the
project's name. The file is a re-export of this package's `./worker` entry,
and that entry has two halves.

- **The stateless entrypoint** (the default export) is what you call:
  `health`, `setupVoiceAgent`, `removeVoiceAgent`. It lives for a request.
- **The stateful facet** (`VoiceAgentFacet`, a Durable Object) is one per
  conversation stream. It holds the provider's WebSocket (Grok or OpenAI
  realtime), paces the answer's audio back at playback rate, keeps the
  transcript, and folds every event on the stream into the state that survives
  a restart. Its durable key is `voice-agent-facet`.

Everything between a client and the facet is **events on one stream**: the
microphone goes up as ephemeral `mic-frame`s, the answer comes down as
ephemeral `spk-frame`s, and the durable events (`configured`, `call-started`,
the transcripts, `conversation-ended`) are the record. That is the whole
architecture, and it is why any client — a board, a phone, a browser tab, a
CLI on a Mac — can join a call by opening the stream.

How the facet gets "installed": `setupVoiceAgent` appends a
`stream/subscription-configured` event to the conversation stream whose
receiver is a facet processor with a **worker ref** — build a stateful worker
from `voice-agent.ts` in the config repo, class `VoiceAgentFacet`, durable key
`voice-agent-facet`, path equals the stream. The first time an event the
contract consumes lands there, the platform builds that worker (installing
the repo's `package.json` dependencies and bundling, cached by build key) and
wakes the facet. Nothing is loaded into `worker.ts`; the subscription carries
the ref, and the platform resolves it lazily.

## Enabling voice on a project

Two dependency lines and one file, in the config repo. [`INSTALL.md`](./INSTALL.md)
is the same thing written for an agent making the edit.

```jsonc
// package.json
{
  "dependencies": {
    "iterate": "https://pkg.pr.new/iterate/iterate/iterate@main",
    "@iterate-com/voice-agent": "https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@main",
    "zod": "4.5.4", // the SDK's processor entry leaves zod external; every template declares it
  },
}
```

```ts
// voice-agent.ts — the file the worker refs name; the platform builds it
export { default, VoiceAgentFacet } from "@iterate-com/voice-agent/worker";
```

Three ways to get them there:

```bash
# 1. The CLI writes both (and --prune-legacy deletes the source files an older deploy committed):
doppler run --config prd -- pnpm cli voicelab deploy --project <slug> --prune-legacy

# 2. Pin a specific build instead of main:
pnpm cli voicelab deploy --project <slug> \
  --spec https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@<sha-or-pr>
```

3. The mobile app writes them itself on a project's first call if they are
   missing, through `installVoiceAgent` below, and never rewrites what is
   already there.

From then on the boards, `voicelab talk`, and the phone address the guest
through the package's worker refs; nothing in the project's `worker.ts` has
to change. `configs/voice-agent` in this repo is the template version of
exactly this: the two files plus a minimal worker.

A project that wants to change the agent subclasses it in the same file
instead of re-exporting — `voice-agent.ts` is the project's, and the platform
builds whatever it exports under those two names.

## From the project's own worker: `VoiceAgentApp`

The packaged-app shape every starter app has: a partial `fetch` for its app
slug, and typed methods on the guest. The worker refs and the handle plumbing
stay inside the package.

```ts
import { VoiceAgentApp } from "@iterate-com/voice-agent";
import { IterateWorkerEntrypoint } from "iterate/sdk";

export default class extends IterateWorkerEntrypoint {
  #voice = VoiceAgentApp.create(this.env); // { appSlug: "voice" } is the default

  async fetch(req: Request): Promise<Response> {
    // Requests for the voice app (voice--<project>) are the app's; anything
    // else returns null and the worker's own routing carries on.
    return (await this.#voice.fetch(req)) ?? new Response("my project");
  }
}
```

The browser client that will answer on that slug is not built yet
(`tasks/2026-09-08-voice-web-chat-app.md`); until it is, the slug answers
501 and says so. The methods work today:

```ts
// Give a chat its own phone line. The chat becomes the call's "colleague":
// the transcript lands on the chat's stream and every message the chat agent
// writes is spoken into the live call.
const line = await this.#voice.setup({
  streamPath: `/agents/voice/chat${chatPath}`,
  colleaguePath: chatPath,
  provider: "openai",
  instructions:
    "You are on a phone call with a colleague who knows you well. Casual, direct, brief.",
  clientTakesTurns: true, // push-to-talk client; omit for an open-mic board
  greeting: true, // speak first when the call connects
  tools: [
    {
      // No expression: a name the agent already knows how to be.
      name: "hang_up",
      description: "End the call when the user says goodbye. Say goodbye BEFORE calling this.",
    },
  ],
});
// → { streamPath, warmMs }

await this.#voice.remove({ streamPath: line.streamPath });

// Have the live call say a line now; with thenHangUp it closes once the
// line has PLAYED, with the reason as the obituary.
await this.#voice.say({
  streamPath: line.streamPath,
  text: "I'm closing this call now; the shop is done.",
  reason: "operator: shop complete",
  thenHangUp: true,
});
```

`create(env)` takes the worker's `this.env` (anything with an `ITX` binding
whose `get()` yields a project handle). Every method opens a project session,
dials the guest, and releases both handles when done, whether the call
returned or threw.

### Tools the model can call

A tool is data on the setup: what the provider shows the model, plus an
**itx expression** — a walk from the project root to a function. The model's
parsed arguments object becomes that function's single argument. The
expression names a capability; authority is re-derived from a fresh project
session on every call, so nothing dangerous is persisted.

```ts
await this.#voice.setup({
  streamPath: "/agents/voice/kitchen",
  tools: [
    {
      name: "search_products",
      description: "Search the grocery catalogue. Returns names, prices and line numbers.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, size: { type: "number" } },
        required: ["query"],
      },
      // itx.worker.grocery.search_products(args) — a method on THIS worker.
      expression: ["worker", "grocery", "search_products"],
    },
    {
      name: "read_todo",
      description: "Read the shared to-do list.",
      // Any walk works: itx.repo.readFile({ path: "TODO.md" }) with the
      // model's arguments as the single argument.
      expression: ["repo", "readFile"],
    },
    { name: "hang_up", description: "End the call when the user says goodbye." },
  ],
});
```

A step is a property name (`"worker"`) or a call with its own arguments
(`["get", "/agents/x"]`); the guest's contract rejects reserved names
(`__proto__`, `constructor`, `prototype`).

### The setup options

| Option             | What it does                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `streamPath`       | The conversation stream. A fresh `/agents/voice/<uuid>` when omitted. Must be absolute.                                                                              |
| `provider`         | `"grok"` (default) or `"openai"`. `providerModel` / `providerVoice` override that provider's defaults.                                                               |
| `instructions`     | What the model is told it is. Empty leaves the provider's own default.                                                                                               |
| `clientTakesTurns` | `true` for a push-to-talk client that sends `ptt-start` / `ptt-end`. Omit for an open microphone, where the provider's VAD decides turns (`turnDetection` tunes it). |
| `greeting`         | Speak first when a call connects — "hi again" on a stream with history, via the recap.                                                                               |
| `colleague`        | On unless `false`: the stream gets a colleague agent (below).                                                                                                        |
| `colleaguePath`    | Make an existing agent (a chat) the colleague instead of the derived one — "call any chat".                                                                          |
| `tools`            | As above.                                                                                                                                                            |
| `visemes`          | Classify the answer into mouth shapes for a face-rendering client (the boards with a display).                                                                       |
| `providerBaseUrl`  | Dial this instead of the provider. Carries no credential and needs no secret — for tests and fakes.                                                                  |
| `reinstall`        | Install the subscription under a fresh key even if an identical one exists.                                                                                          |

Re-running `setup` with identical options appends nothing: the certificate
is content-hashed. Changing the options supersedes the old certificate.

## Provider secrets

`setup` demands the secret its provider will spend, before it writes
anything: `/secrets/openai` for OpenAI, `/secrets/xai` for Grok. A
`providerBaseUrl` pointing at a host that is no known provider's needs no
secret. The secret is a project secret with egress pinned to the provider,
created once by an operator — the key never travels through the worker:

```ts
// From an itx script (the OS MCP server, `pnpm cli itx run`, or a project agent):
await itx.secrets
  .get("/secrets/openai")
  .create({ egress: { urls: ["https://api.openai.com"] }, material: process.env.OPENAI_API_KEY });
```

```bash
# Or let the CLI do it from a Doppler config that carries OPENAI_API_KEY / XAI_API_KEY:
doppler run --config prd -- pnpm cli voicelab talk --project <slug> --setup-only --provider openai
```

Existing material is left alone; a voice command never rotates a running
project's key.

## What `setup` does, and the colleague

`setupVoiceAgent` appends a **birth certificate** to the stream — the
`events.iterate.com/voice-agent/configured` event carrying every option above
— and the subscription that wakes the facet for that stream (the worker ref
above). Then it waits for the facet to fold the certificate (a cold build is
most of the wait; `warmMs` in the result is that clock), so a returned
`setup` means the line is live. Contract version `20.0.0`.

Every stream is born with a **colleague**: a normal text agent
(`/agents/voice-notes/…` by default, or the chat you named in
`colleaguePath`). The call's transcript lands on the colleague's stream as
context, so the backend _reads_ the conversation instead of being briefed
second-hand; the model's `note_to_self` tool writes a `colleague-note` to it;
and everything the colleague says back (`web-message-sent`) is copied onto
the voice stream and spoken into whichever call is live. The colleague's own
status narration (`colleague-status`: "writing code", "running code", a
failed script) is whispered into the session as quiet context. Thinking fast
and slow, on one stream.

## Talking to a line: the stream protocol

A client is anything that can append to the stream and receive its ephemeral
events. Every type below is prefixed `events.iterate.com/voice-agent/`.

| Event                        | Direction | Durable   | Payload                                                                                                         |
| ---------------------------- | --------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `ptt-start`                  | client →  | durable   | `{}` — the user began speaking; opens a call if none is up (push-to-talk clients only)                          |
| `mic-frame`                  | client →  | ephemeral | `{ conversationId, seq, pcm }` — 20 ms of base64 PCM16 mono 16 kHz, numbered by the device                      |
| `ptt-end`                    | client →  | durable   | `{}` — the turn is complete                                                                                     |
| `conversation-end-requested` | either    | durable   | `{ conversationId, reason }` — somebody decided the call is over (the hang-up button, the `hang_up` tool, idle) |
| `call-started`               | ← server  | durable   | `{ conversationId }` — the server opened a call                                                                 |
| `conversation-accepted`      | ← server  | durable   | `{ conversationId, handshakeTookMs, heldMicFrames }` — the provider accepted the session; the call is live      |
| `spk-frame`                  | ← server  | ephemeral | `{ conversationId, deviceSpeakerFrameSeq, pcm, drop?, last? }` — one paced chunk of the answer                  |
| `utterance-transcript`       | ← server  | durable   | `{ conversationId, text }` — the provider's transcription of one finished listener turn                         |
| `answer-transcript`          | ← server  | durable   | `{ conversationId, text, cancelled?, kind? }` — one finished answer, in words                                   |
| `conversation-ended`         | ← server  | durable   | `{ conversationId, reason }` — the call is over                                                                 |
| `colleague-note`             | ← server  | durable   | `{ text }` — one message from the colleague, spoken into the live call                                          |
| `say`                        | either    | durable   | `{ text, reason?, by?, thenHangUp?, conversationId? }` — say a line now; `thenHangUp` ends the call after it    |

**A client's entire speaker policy is three lines.** On a `spk-frame`: if
`drop`, clear the speaker buffer (the listener barged in; discard what has not
played); write `pcm`; if `last`, the answer is over. The server holds the
answer and releases it at playback rate, so a client never buffers more than
a few seconds and never has to number, catch up, or skip. The frame sequence
number is contiguous within a conversation, which is how a client (or the
voicelab report) can prove nothing was lost.

Real clients to copy from: `apps/mobile/src/lib/voice-call.ts` (React
Native, push-to-talk, the marker logic in `voice-setup.ts` that runs `setup`
once per config), `apps/kit/firmware` (the boards, open mic), and
`apps/os/scripts/voicelab/talk.ts` (a Mac). Ephemeral frames are only
visible to a live stream connection, never to a later read; the durable
events are the record, and `pnpm cli voicelab transcript` prints it.

## From anything that holds a project handle: the worker refs

Code that is not the project's worker — the CLI, the phone, an operator
script — dials the guest through its worker refs on a project handle:

```ts
import {
  voiceAgentEntrypointRef,
  voiceAgentFacetRef,
  type VoiceAgentRpc,
} from "@iterate-com/voice-agent";
import { connectItxReady } from "iterate/node";

using session = await connectItxReady({ auth: { type: "admin-secret", secret }, baseUrl });
using itx = session.projects.get("my-project");

// The platform's handle is generic; the guest's methods are this package's
// contract, which the entrypoint class implements.
using guest = itx.workers.get(voiceAgentEntrypointRef) as unknown as VoiceAgentRpc & Disposable;
console.log(await guest.health()); // builds the guest if it is not built yet
const line = await guest.setupVoiceAgent({ streamPath: "/agents/voice/desk", provider: "openai" });

// After upgrading the package: a WARM stateful facet keeps the bundle it
// booted with. Killing the incarnation is the upgrade — the next dispatch
// boots the build the config repo declares now.
using facet = itx.workers.get(voiceAgentFacetRef(line.streamPath)) as unknown as {
  kill(): Promise<void>;
} & Disposable;
await facet.kill().catch(() => {}); // the abort takes the killing RPC down with it: "kill requested" IS success
```

`voiceAgentEntrypointRef` is stateless (path `/`); `voiceAgentFacetRef(streamPath)`
is the stateful facet for one stream, `className: "VoiceAgentFacet"`,
`durableWorkerKey: "voice-agent-facet"` — the same key the committed copies
used, so a project that moves onto the package keeps its facet state. Both
name `voice-agent.ts` in the config repo as the entry point, which is why
that file and its two exported names are load-bearing.

## The installer

The root entry also carries what the CLI and the phone use to write the two
files, so any code with a config-repo handle can enable voice.

```ts
import {
  installVoiceAgent,
  legacyGuestPaths,
  removeLegacyGuest,
  withVoiceAgentDependency,
  withVoiceAgentGuestFile,
  VOICE_AGENT_GUEST_SOURCE,
} from "@iterate-com/voice-agent";

// Declare it and write voice-agent.ts, or upgrade what is there to `spec` (default: @main).
const result = await installVoiceAgent(itx.repo, { existing: "replace" });
// → { changed: true, commitOid: "…", spec: "…@main", changedPaths: ["package.json", "voice-agent.ts"] }

// "Present is enough": fill only the gaps, never move a pin somebody chose or
// overwrite a voice-agent.ts that holds something else — a subclass, or an
// old committed copy (what the mobile app does on a first call).
await installVoiceAgent(itx.repo, { existing: "keep", message: "app: depend on the voice agent" });

// See what a commit would do without making one — pure, on the file contents.
withVoiceAgentDependency(packageJsonText, { existing: "replace" }).changed;
withVoiceAgentGuestFile(currentVoiceAgentTs, "replace").content === VOICE_AGENT_GUEST_SOURCE;

// A repo that predates the package still carries face.ts, pcm.ts, viseme.ts
// and viseme-model.generated.ts beside voice-agent.ts; nothing builds from
// them once voice-agent.ts is the re-export.
await legacyGuestPaths(itx.repo); // → ["face.ts", "pcm.ts", …] or []
await removeLegacyGuest(itx.repo); // one commit deleting them, or null when there are none
```

The installer validates `package.json` with a schema at the boundary and
keeps the file's key order, so a rewrite never reorders a project's manifest.
A repo with no `package.json`, or one whose `dependencies` is not a map of
specs, is refused with the reason rather than guessed at.

## Versions, pinning, upgrading

Every push to `iterate/iterate` main republishes this package to pkg.pr.new
(`.github/workflows/pkg-pr-new.yml`), and `@<sha>` and `@<pr>` refs exist
for every commit and pull request:

```
https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@main
https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@<40-char sha>
https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@<pr number>
```

A deployment **pins** every `pkg.pr.new/iterate/iterate/...` spec to the ref
it was built with (`apps/os/src/pkg-pr-new.ts`), so a config repo that says
`@main` runs the platform's own build of the agent, and a preview runs the
preview's. The `version` field in `package.json` is the package's own number
for people; the ref is what the platform resolves.

Upgrading a project is therefore either nothing (it says `@main` and the
platform moved) or one line (`voicelab deploy --spec …`). Either way a warm
facet keeps its old build until it is restarted — `talk` does that after any
install that changed the repo; the ref example above shows the call.

## Building and testing

```bash
pnpm --dir packages/voice-agent build      # tsdown (two entries, every dependency external) + tsc declarations
pnpm --dir packages/voice-agent typecheck
pnpm --dir packages/voice-agent test       # the installer, the refs, VoiceAgentApp
pnpm --dir apps/os exec vitest run scripts/voicelab/voice-agent.test.ts   # the agent itself, against a fake provider
```

Layout:

- `src/voice-agent.ts` — the agent: the processor contract, the facet, and
  the stateless entrypoint. `src/face.ts`, `src/pcm.ts`, `src/viseme.ts` —
  what it imports. `src/viseme-model.generated.ts` — the HeadAudio viseme
  model (met4citizen/HeadAudio, MIT — see `HEAD_AUDIO_LICENSE.txt`),
  embedded as a module by `viseme-model.codegen.cjs` from
  `viseme-model.bin`; drift is a fixable `codegen/codegen` lint error.
- `src/worker.ts` — the `./worker` entry a config repo's `voice-agent.ts`
  re-exports.
- `src/app.ts`, `src/ref.ts`, `src/install.ts`, `src/setup-options.ts` —
  `VoiceAgentApp`, the worker refs, the installer, and the guest's RPC
  surface as plain types: everything the root entry exports. The root entry
  imports nothing but zod: the SDK's ref types would bring Cloudflare's
  runtime types with them, which a phone does not have, so `ref.ts` spells
  the shapes locally and `ref.test.ts` pins them to the SDK's with
  `satisfies`; `app.ts` types the project handle structurally.
- `tsdown.config.ts` — an ordinary library build: `iterate` is a peer and
  zod a dependency, both external, resolved from the config repo's own
  `package.json` when the platform builds `voice-agent.ts`. Declarations
  come from `tsc -p tsconfig.dts.json` because rolldown-plugin-dts's printer
  crashes on function types inside interfaces.

The agent's behavioural tests live with the lab tooling in
`apps/os/scripts/voicelab/` and import these sources directly.

## Troubleshooting

- **`voice-agent setup requires secret "/secrets/openai" with material`** —
  see [Provider secrets](#provider-secrets). Tests pass a `providerBaseUrl`
  instead.
- **The first call after enabling is slow, or fails with a build error** —
  a dynamic worker builds on the first call into it (npm install of the
  config repo's dependencies plus a bundle). A build error surfaces there,
  naming the module it could not resolve; `Could not resolve "zod"` means
  the dependency line is missing.
- **Setup succeeded but the call behaves like the previous version** — the
  stateful facet is warm and still running the bundle it booted with. Kill
  it (the ref example) and dial again.
- **`Could not resolve @iterate-com/voice-agent@<ref>`** — the ref does not
  exist on pkg.pr.new: the push has not been published yet, or the platform
  is pinned to a commit that predates the package. `@main` is always right
  for a platform that shipped after the package existed.
- **A migrated project still lists `face.ts` and friends** — harmless dead
  weight; `voicelab deploy --prune-legacy` or `removeLegacyGuest` removes
  them.
- **`say` is appended but the call never speaks it** — the stream's facet
  subscription filters on a snapshot of `contract.consumes` taken when setup
  last ran. Re-run `setupVoiceAgent` on that stream (`talk` does, every run).
