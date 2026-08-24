# Voice agent project configuration

The realtime voice agent facet that the ESP32 boards and the voicelab host CLI
talk to. `voice-agent.ts` is the entry point; it imports `face.ts`, `pcm.ts`,
`viseme.ts`, and `viseme-model.generated.ts`, so the template is
self-contained. It deliberately does not replace a project's own `worker.ts` —
it runs alongside it as a guest worker.

How it is installed today: `apps/os/scripts/voicelab/deploy.ts`
(`pnpm cli voicelab deploy`) commits these files into a project's config repo,
walking the entry point's own relative imports to decide what travels. The
config repo is flat, so every file here sits beside the entry point. The
`.bin`/`.codegen.cjs` pair regenerates `viseme-model.generated.ts` (a fixable
`codegen/codegen` lint error keeps them in sync); the model asset is from
met4citizen/HeadAudio (MIT) — see `HEAD_AUDIO_LICENSE.txt`.

Like every template here, a project can also be created from it with a public
GitHub reference such as:

```text
github:iterate/iterate#main&path:configs/voice-agent
```

The tests live with the rest of the lab tooling in
`apps/os/scripts/voicelab/` and import these files across the repo root.
