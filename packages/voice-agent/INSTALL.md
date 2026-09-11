# Installing the voice agent in a project

For an agent (or a person) editing a project's config repo — the repo whose
`worker.ts` the platform builds. Three edits, one commit; nothing to deploy,
because commits to main redeploy the project and the guest builds on its
first call.

## 1. `package.json`: two dependency lines

```jsonc
{
  "dependencies": {
    "iterate": "https://pkg.pr.new/iterate/iterate/iterate@main",
    "@iterate-com/voice-agent": "https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@main",
    "zod": "4.5.4",
  },
}
```

`zod` because the SDK's `iterate/processors` entry, which the agent is built
on, leaves it external; use the version the SDK pins (4.5.4 today). Keep any
`zod` the project already declares.

## 2. `voice-agent.ts`: the guest, by name

Create the file at the repo root with exactly this:

```ts
// The voice agent guest worker. The platform builds this file (see
// @iterate-com/voice-agent/INSTALL.md); the agent lives in the package and
// this repo holds its name. Subclass here if the project needs to.
export { default, VoiceAgentFacet } from "@iterate-com/voice-agent/worker";
```

The file name and the two exported names are load-bearing: the worker refs
every client uses name `voice-agent.ts`, the default export (the stateless
entrypoint) and `VoiceAgentFacet` (the stateful facet, one per conversation
stream, durable key `voice-agent-facet`).

If the repo already holds a `voice-agent.ts` of several thousand lines, that
is a copy an older deploy committed; replace it with the four lines above and
delete `face.ts`, `pcm.ts`, `viseme.ts` and `viseme-model.generated.ts`
beside it. The facet's state survives — the durable key is unchanged.

## 3. `worker.ts`: the voice app (optional)

The boards, the voicelab CLI and the mobile app need nothing here. A project
that wants the voice app on an app slug, or wants to start lines itself, adds:

```ts
import { VoiceAgentApp } from "@iterate-com/voice-agent";
import { IterateWorkerEntrypoint } from "iterate/sdk";

export default class extends IterateWorkerEntrypoint {
  #voice = VoiceAgentApp.create(this.env); // { appSlug: "voice" } is the default

  async fetch(req: Request) {
    return (await this.#voice.fetch(req)) ?? new Response("my project");
  }
}
```

`fetch` answers requests for the `voice` app slug (`voice--<project>`) and
returns null for everything else, so the worker's own routing carries on.
`this.#voice.setup({ streamPath, colleaguePath, instructions, tools, … })`
puts the agent on a stream; `this.#voice.remove({ streamPath })` takes it
off. The package README documents every option.

## Before the first call: a provider secret

`setup` refuses to run without the secret its provider will spend —
`/secrets/openai` or `/secrets/xai` — created once by an operator with egress
pinned to the provider:

```ts
await itx.secrets
  .get("/secrets/openai")
  .create({ egress: { urls: ["https://api.openai.com"] }, material: process.env.OPENAI_API_KEY });
```

## Verify

From a checkout of iterate/iterate:

```bash
doppler run --config prd -- pnpm cli voicelab talk --project <slug> --setup-only --provider openai
```

It reports the guest healthy (the cold build happens here), puts the agent on
a fresh stream, and returns. `pnpm cli voicelab deploy --project <slug>` does
steps 1 and 2 for you; `--prune-legacy` does the cleanup in step 2.

## Upgrading

A repo that says `@main` runs whatever build the platform pinned; nothing to
do. To pin, change the spec. Either way a warm facet keeps the bundle it
booted with until it is restarted; restart its parent conversation stream
(and `voicelab talk` does that after a changed install).
