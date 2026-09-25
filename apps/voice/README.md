# Voice

A browser phone for a project's voice agent: log in with iterate, pick a project in the sidebar's
switcher, press Call, talk. The page frames itself in packages/ui's `AppShell`, the shell every
OS app shares.
The page is the Kit device in a browser — the same three appends and one subscription the board
makes (`apps/agents/scripts/voice-call.ts`), with the browser's microphone and speaker on either
end and the relay's live state on screen.

## Shape

- `src/server.ts` — the same server entry as Notes and Dash (only the client name and the
  landing-redirect comment differ): `appAuth` (the OAuth client in a
  `BrowserSession` durable object), static assets, then TanStack Start.
- `src/routes/_auth/projects.$slug.tsx` — the one page. `useLiveState` from `iterate/react` subscribes to the
  relay's `voice-agent` live view (phase, answering, transcript, last end) on the call's context.
- `src/call.ts` — one call: `itx.voice.setupVoiceAgent({streamPath, activation})` on a fresh
  context, a subscription for `spk-frame` and the call facts, ephemeral `mic-frame` appends twenty a
  second, a keepalive, and `conversation-ended` on hang up.
- `src/audio.ts` + `public/worklets/*.js` — one 16 kHz `AudioContext`; the capture worklet posts
  50 ms PCM16 frames, the playback worklet drains a queue of answer chunks (cleared when the relay
  says so). Modeled on the recorder and stream player of OpenAI's realtime console.

A project without a voice agent gets **Install voice** in place of Call: an OpenAI key field if the
project has no `/secrets/openai`, then `ensureVoiceAgent` (`@iterate-com/voice/install`, the
installer Kit's Prepare runs too): the config repo gets `agents/` and `voice/` folders pinning the
`@iterate-com/agents` and `@iterate-com/voice` builds of the commit this app was built from (main's
when pkg.pr.new has none), and both are installed from them. It works against any platform the app
connects to, a self-hosted one included.

## Run

```bash
pnpm --filter @iterate-com/voice-app dev      # against APP_CONFIG_URLS__OS in .dev.vars
pnpm --filter @iterate-com/voice-app test     # the PCM helpers
pnpm --dir apps/voice run deploy --env prd
```

Deployment configuration lives in `envs.ts` (`voiceEnvs`), secrets in the Doppler project `voice`.
Production serves `https://voice.iterate.com` through an exact Worker route on the iterate.com zone.
