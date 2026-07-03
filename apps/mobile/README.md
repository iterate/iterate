# Iterate Voice (iOS)

Native iOS client for the voice ↔ itx bridge (`apps/os/src/domains/voice/`).
Sign in, pick a project, talk: your turns are transcribed by OpenAI Realtime
over WebRTC and appended to a voice agent stream; the server-side voice
processor forwards them to a worker agent that does real project work; its
reports are spoken back to you.

## Build it onto your phone

Requires a Mac with Xcode (16+) and an iPhone on the same Apple ID.

```bash
cd apps/mobile
pnpm install                      # from repo root is fine too
npx expo run:ios --device         # plug the phone in, pick it from the list
```

That builds the dev client with the native modules (react-native-webrtc,
incall-manager) and installs it. For the iOS Simulator instead:
`npx expo run:ios`. After the first native build, day-to-day JS changes only
need `pnpm start` (Metro) — rebuild only when native deps change.

## Pointing it at a deployment

The sign-in screen has an editable server field with presets. The deployment
must include this branch (the itx `voice` builtin):

- **PR preview** — re-run the Preview workflow on PR #1605 if the lease
  expired, then check the PR's preview comment for the current hostname
  (`os.iterate-preview-N.com`) and type/pick it.
- **Local dev** (simulator only) — `pnpm dev` in `apps/os`, then use
  `http://localhost:<port>`. OAuth still runs against the hosted dev auth
  worker, so sign-in works normally.
- **Production** — works once the voice bridge PRs merge.

Auth is OAuth code + PKCE against the deployment's auth worker (discovered
via RFC 9728 from the OS host), with dynamic client registration. Tokens live
in the keychain; itx rides one capnweb WebSocket authenticated with the
bearer token.

## Layout

| Path                            | What                                                                       |
| ------------------------------- | -------------------------------------------------------------------------- |
| `src/lib/voice/session-core.ts` | Transport-agnostic port of the browser voice client; the state machine     |
| `src/lib/voice/webrtc.ts`       | OpenAI Realtime over react-native-webrtc (SDP exchange, data channel, mic) |
| `src/lib/auth.ts`               | Issuer discovery, dynamic registration, PKCE, rotation-safe token refresh  |
| `src/lib/itx.ts`                | capnweb session cache + the one auth-shaped reconnect seam                 |
| `src/app/`                      | expo-router screens: sign-in → projects → sessions → voice                 |

`pnpm typecheck` / `pnpm test` (vitest over the session core) run in root CI;
the native build does not.
