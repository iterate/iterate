# Iterate (iOS)

The iterate mobile app: sign in, pick a project, chat with its agents — the
phone equivalent of the dashboard's "new chat", against any deployment.
Chat is the trunk; native features (voice — see PR #1605, whose plumbing this
app shares — push, widgets) graft on later.

## Run it on your phone

v1 is a plain Expo Go app — no custom native modules, no Xcode, no Apple
Developer account:

1. Install **Expo Go** from the App Store.
2. `pnpm --dir apps/mobile start` (repo root) and scan the QR code.

Day-to-day JS changes hot-reload through Metro. (A dev-client/native build
only becomes necessary when a native module lands — e.g. push notifications.)

**The Expo SDK is deliberately pinned to 54**, not latest: the App Store's
Expo Go (54.0.2, unchanged since 2025-09) only runs SDK 54 projects — newer
SDKs error with "Project is incompatible with this version of Expo Go".
Before bumping `expo`, check what the store actually ships
(`curl -s "https://itunes.apple.com/lookup?bundleId=host.exp.Exponent" | jq -r '.results[0].version'`);
if it's still 54.x, a bump means abandoning Expo Go for dev builds (EAS or
local Xcode).

## Pointing it at a deployment

The sign-in screen has an editable server field with one-tap presets:
**Production** (`os.iterate.com`, default) and every preview slot
(`os.iterate-preview-N.com`). Anything else — a captun tunnel, a teammate's
box — gets typed in and remembered as a recent.

- **Local dev from the phone**: the phone can't see `localhost`, so publish
  your dev server through captun — `CAPTUN_TUNNEL_NAME=<name> pnpm dev` —
  and use `https://<name>.tunnels.iterate.com` as the server
  (docs/dev-environments.md "Tunnels and webhooks").
- Auth is OAuth code + PKCE against the deployment's auth worker (discovered
  via RFC 9728 from the OS host) with dynamic client registration; refresh
  tokens live in the keychain. Zero-org users get funneled through org/project
  creation inside the sign-in browser (the `project` scope does this) — the
  app has no org UI on purpose.

## How chat works

One capnweb WebSocket to `<server>/api` (`authenticate({type:"bearer"})` —
the same itx surface every other client programs against,
`apps/os/src/itx-api.generated.ts`). A chat is an agent stream: "new chat"
mints `/agents/mobile/<timestamp>` and the first `message()` call creates it
(same lazy-seeding contract as the dashboard). The chat list is the unfiltered
`/agents` catalogue, so web/Slack-started chats open and continue here too.
The thread screen renders only visible messages plus a "working…" row derived
from in-flight activity (`src/lib/chat.ts`); a live stream subscription pushes
updates into the query cache (`src/lib/live-thread.ts`).

## Verification

| Lane                                                          | What it proves                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --dir apps/mobile test`                                 | Pure logic: chat reducer, merge, path conventions (runs in root CI)                                                                                                                                                             |
| `doppler run --config dev -- pnpm --dir apps/mobile test:e2e` | Live round-trip from Node through the app's own dial: bearer auth → new mobile chat → real agent reply → live subscription. Point it at a preview by switching the Doppler config. Needs `pnpm dev` running for the dev config. |
| `npx expo export` / `npx expo prebuild`                       | The bundle builds; app config is sane                                                                                                                                                                                           |
| Expo Go on a phone                                            | The only lane that proves the in-app browser OAuth hop and the rendered UI                                                                                                                                                      |

## Layout

| Path                     | What                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| `src/lib/itx-core.ts`    | The dial: capnweb + bearer + the one auth-shaped retry (Expo-free, e2e-able) |
| `src/lib/auth.ts`        | Issuer discovery, dynamic registration, PKCE, rotation-safe token refresh    |
| `src/lib/chat.ts`        | Pure: stream events → bubbles + working flag; agent path conventions         |
| `src/lib/live-thread.ts` | Live subscription per thread feeding the tanstack-query cache                |
| `src/app/`               | expo-router screens: sign-in → projects → chat list → thread                 |

`pnpm typecheck` / `pnpm test` run in root CI; nothing native does.
