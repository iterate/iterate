# Voice

A browser phone for a project's voice agent: log in with iterate, pick a project in the sidebar's
switcher, press Call, talk. The page frames itself in packages/ui's `AppShell`, the shell every
OS app shares.
The page is the Kit device in a browser — the call client `@iterate-com/voice/call` makes the
board's appends and subscription (`packages/agents-app/scripts/voice-call.ts` runs the same client from
Node), with the browser's microphone and speaker on either end and the relay's live state on screen.

## Shape

- `src/server.ts` — `appServerEntry` (`packages/ui/src/apps/server.ts`), every app's Worker
  entry, with Voice's client name and home.
- `src/routes/_auth/projects.$slug.tsx` — the one page. `useLiveState` from `iterate/react` subscribes to the
  relay's `voice-agent` live view (phase, answering, transcript, last end) on the call's context.
- `src/call.ts` — one call: `itx.voice.health()`, then `startVoiceCall` (`@iterate-com/voice/call`:
  the press on a fresh `/agents/voice/web/…` context, the subscription, the `mic-frame` appends, the
  keepalive and `call-ended` on hang up) wired to the worklets: the capture's frames go up, the
  answer's frames go to the playback queue.
- `src/audio.ts` + `public/worklets/*.js` — one 16 kHz `AudioContext`; the capture worklet posts
  50 ms PCM16 frames, the playback worklet drains a queue of answer chunks (cleared when the relay
  says so). Modeled on the recorder and stream player of OpenAI's realtime console.

The project's config repo installs voice, as configs/voice does. A project whose voice cannot
take a call yet gets **Set up voice** in place of Call: an OpenAI key field if the project has no
`/secrets/openai`, then `ensureVoiceAgent` (`@iterate-com/voice/install`, what Kit's Prepare runs
too), which stores the key, waits for `itx.voice` and refuses a project whose config installs no
voice. It works against any platform the app connects to, a self-hosted one included.

Under Call, **Voice build** shows the build the project runs and, when main has published
a newer one, **Upgrade to the newest**: `upgradeVoice` (`@iterate-com/voice/install`) commits that
pin and waits for its publication. The agents app keeps its build; the Agents app upgrades it.

## Run

```bash
pnpm --filter @iterate-com/voice-app dev      # against APP_CONFIG_URLS__OS in .dev.vars
pnpm --filter @iterate-com/voice-app test     # the PCM helpers
pnpm --dir packages/voice-app run deploy --env prd
```

Deployment configuration lives in `envs.ts` (`voiceEnvs`), secrets in the Doppler project `voice`.
Production serves `https://voice.iterate.com` through an exact Worker route on the iterate.com zone.
