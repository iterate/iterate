# Voice agent project configuration

A project that runs the realtime voice agent — the server side the ESP32
boards, the voicelab host CLI, and the mobile app talk to — as a guest worker
beside its own `worker.ts`.

Three files carry it, and they are the whole install for any project:

- `package.json` declares `@iterate-com/voice-agent` (published from
  `packages/voice-agent` in this repo on every push to main) and `zod`, which
  the SDK's processor entry leaves external.
- `voice-agent.ts` re-exports the agent from the package. The platform builds
  this file the way it builds `worker.ts`, so the repo holds the agent's name,
  not a copy. A deployment pins the `@main` ref to its own build
  (`apps/os/src/pkg-pr-new.ts`).
- `worker.ts` is the smallest useful project worker: it lowers the agent
  birth debounce like every template and hands the voice app slug to
  `VoiceAgentApp`.

An existing project gets the same install from
`pnpm cli voicelab deploy --project <slug>`, which writes the first two files
into its config repo (`--prune-legacy` also removes the source files an older
deploy committed there), or from the agent-facing steps in the package's
`INSTALL.md`.

Like every template here, a project can be created from it with a public
GitHub reference such as:

```text
github:iterate/iterate#main&path:configs/voice-agent
```

The agent's sources and tests: `packages/voice-agent/` and
`apps/os/scripts/voicelab/`.
