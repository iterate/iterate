# @iterate-com/voice-agent

The realtime voice agent for iterate projects — the server side that the ESP32
boards, the voicelab host CLI, and the mobile app talk to — packaged so a
project pulls it in instead of carrying a copy.

## Using it from a project

Declare it in the config repo's `package.json`:

```json
{
  "dependencies": {
    "iterate": "https://pkg.pr.new/iterate/iterate/iterate@main",
    "@iterate-com/voice-agent": "https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@main"
  }
}
```

That is the whole install. The agent runs as a guest worker beside the
project's own `worker.ts`: the platform's dynamic worker host installs the
config repo's dependencies and builds the guest from
`node_modules/@iterate-com/voice-agent/dist/configured-worker.mjs` on the
first call into it. The boards, the voicelab CLI and the mobile app address
the guest directly. A project's own worker gets the guest's methods, typed,
from `VoiceAgentApp`:

```ts
import { VoiceAgentApp } from "@iterate-com/voice-agent";
import { IterateWorkerEntrypoint } from "iterate/sdk";

export default class extends IterateWorkerEntrypoint {
  #voice = VoiceAgentApp.create(this.env);

  async fetch(req: Request) {
    if (new URL(req.url).pathname === "/voice/health") {
      return Response.json(await this.#voice.health()); // builds the guest on first call
    }
    // this.#voice.setup({ streamPath, instructions, provider: "openai", ... })
    // this.#voice.remove({ streamPath })
    return new Response("voice project");
  }
}
```

`voiceAgentEntrypointRef` and `voiceAgentFacetRef` are the worker refs
underneath, for code that dials the guest through a project handle of its
own (the CLI and the phone do).

`pnpm cli voicelab deploy --project <slug>` writes the dependency for you, and
`installVoiceAgent` from the root entry does the same from any code that
holds a config repo handle (the mobile app uses it on the first call).

## Versions

Every push to `iterate/iterate` main republishes this package to pkg.pr.new
(`.github/workflows/pkg-pr-new.yml`); `@<sha>` and `@<pr>` refs exist for
every commit and pull request. A deployment pins every `pkg.pr.new/iterate/iterate/...`
spec to the ref it was built with (`apps/os/src/pkg-pr-new.ts`), so a config
repo that says `@main` runs the platform's own build of the agent. The
`version` field is the package's own number for people; the ref is what the
platform resolves.

## Layout

- `src/voice-agent.ts` — the agent: the processor contract, the facet, and
  the stateless entrypoint (`health`, `setupVoiceAgent`, `removeVoiceAgent`).
- `src/face.ts`, `src/pcm.ts`, `src/viseme.ts` — what it imports.
- `src/viseme-model.generated.ts` — the HeadAudio viseme model
  (met4citizen/HeadAudio, MIT — see `HEAD_AUDIO_LICENSE.txt`), embedded as a
  module by `viseme-model.codegen.cjs` from `viseme-model.bin`; drift is a
  fixable `codegen/codegen` lint error.
- `src/configured-worker.ts` — the build entry the worker refs name. The
  built file carries its whole runtime graph (the SDK's processor machinery
  included), because the platform installs only what a config repo's own
  package.json declares.
- `src/app.ts`, `src/ref.ts`, `src/install.ts`, `src/setup-options.ts` —
  `VoiceAgentApp` for project workers, the worker refs, the installer, and
  the guest's RPC surface as plain types: everything the root entry exports.
  It imports nothing but zod (bundled), so a phone or a browser can hold the
  refs and call the installer.

The agent's behavioural tests live with the lab tooling in
`apps/os/scripts/voicelab/` and import these sources directly.
