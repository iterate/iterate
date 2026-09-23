# Voice

A browser phone for a project's voice agent: log in with iterate, pick a project in the sidebar's
switcher, press Call, talk. The page frames itself in packages/ui's `AppShell`, the shell every
OS app shares.
The page is the Kit device in a browser — the same three appends and one subscription the board
makes (`apps/agents/scripts/voice-call.ts`), with the browser's microphone and speaker on either
end and the relay's live state on screen.

## Shape

- `src/worker.ts` — the Notes app's worker verbatim: `appAuth` (the OAuth client in a `BrowserSession`
  durable object), static assets, the server entry.
- `src/routes/_auth/projects.$slug.tsx` — the one page. `useLiveState` from `iterate/next/react` subscribes to the
  relay's `voice-agent` live view (phase, answering, transcript, last end) on the call's context.
- `src/call.ts` — one call: `itx.voice.setupVoiceAgent({streamPath, activation})` on a fresh
  context, a subscription for `spk-frame` and the call facts, ephemeral `mic-frame` appends twenty a
  second, a keepalive, and `conversation-ended` on hang up.
- `src/audio.ts` + `public/worklets/*.js` — one 16 kHz `AudioContext`; the capture worklet posts
  50 ms PCM16 frames, the playback worklet drains a queue of answer chunks (cleared when the relay
  says so). Modeled on the recorder and stream player of OpenAI's realtime console.

The project needs the voice agent installed (prepare the project at [Kit](https://k.iterate.com)); the page says
so if it is not.

## Run

```bash
pnpm --filter @iterate-com/voice dev          # against ITERATE_ORIGIN in .dev.vars
pnpm --filter @iterate-com/voice test         # the PCM helpers
pnpm --filter @iterate-com/voice deploy -- --env prd
```

Deployment configuration lives in `envs.ts` (`voiceEnvs`), secrets in the Doppler project `voice`.
Production serves `https://voice.iterate.com` through an exact Worker route on the iterate.com zone.
