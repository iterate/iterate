# Voice agent project configuration

A project that runs the realtime voice agent — the server side the ESP32
boards, the voicelab host CLI, and the mobile app talk to — as a guest worker
beside its own `worker.ts`.

The agent is not in this template. `package.json` declares
`@iterate-com/voice-agent` (published from `packages/voice-agent` in this
repo on every push to main), and the platform's dynamic worker host installs
that dependency and builds the guest from `node_modules` on the first call
into it. A deployment pins the `@main` ref to its own build
(`apps/os/src/pkg-pr-new.ts`). `worker.ts` here is the smallest useful
project worker: it lowers the agent birth debounce like every template, and
`GET /voice/health` builds and probes the guest so a broken build shows up on
a request rather than mid-conversation.

An existing project gets the same one-line install from
`pnpm cli voicelab deploy --project <slug>`, which writes the dependency into
its config repo's `package.json`; `--prune-legacy` also removes the source
files an older deploy committed there.

Like every template here, a project can be created from it with a public
GitHub reference such as:

```text
github:iterate/iterate#main&path:configs/voice-agent
```

The agent's sources and tests: `packages/voice-agent/` and
`apps/os/scripts/voicelab/`.
