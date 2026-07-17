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

## Run and screenshot it in a browser

Expo Web renders the same Expo Router screens through React Native Web, so UI
work does not need a phone, Xcode, an iOS simulator, or a new native build:

```sh
pnpm --dir apps/mobile start:web
```

For a repeatable 390×844 Chromium pass, run:

```sh
pnpm spec --project=mobile
```

Playwright starts and stops its own Expo Web server, checks the signed-out
server-picker interaction, and compares the result with the PNGs in
`specs/mobile/screenshots/`. The root `pnpm spec` command runs this alongside
the `web` project; `pnpm spec --project=web` runs only the dashboard specs.
After an intentional UI change, review the new
rendering and refresh those files with
`pnpm spec --project=mobile --update-snapshots`.

This is a fast visual-development and PR-screenshot lane, not an iOS emulator:
platform-native behavior such as the in-app OAuth handoff, Keychain, Face ID,
and push notifications still needs Expo Go or a native build. Authenticated
project/chat screenshot fixtures are follow-up work; this first lane stays
deterministic and credential-free at the signed-out entry point.

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

## Approving held requests

The Approvals screen (per project, from the chat list's header) is a human-
in-the-loop approver for egress requests a project's `hold` rules park —
the same protocol `iterate approve` (`packages/iterate/`) and Jonas's
Secure Enclave menu-bar app (PR #1868) speak. "Enroll this device" generates
a real P-256 keypair (`@noble/curves` — Hermes has no WebCrypto) and stores
the private half in the Keychain behind Face ID (`expo-secure-store`'s
`requireAuthentication`); it's the same "software" key kind
`packages/iterate/src/approval-keys.ts` already uses for CI/non-Mac
machines, not a fake — every grant is a real signature the platform
verifies, just without Secure Enclave hardware isolation. See
`tasks/mobile-approver-upgrades.md` for the gap and what closing it needs
(all three items require leaving Expo Go for a dev build).

## Running examples

The Examples screen (per project, from the chat list's header) lists every
catalogue example that's runnable against a project itx — the same
catalogue that powers the web REPL's Examples panel
(`apps/os/src/itx/examples.ts`), filtered to `context: "project"` entries
whose `runtimes` includes `"run-script"`. Tap Run and it executes via
`capabilityHost.runScript` — no local JS eval on the phone, the same
server-side script isolate agents use — and shows the JSON result inline.
Exists so testing a platform feature never needs a laptop CLI step first:
every mobile feature here is built by agents, so it needs to be fully
testable from the phone alone. See `tasks/mobile-examples-runner.md`.

## Verification

| Lane                                                          | What it proves                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --dir apps/mobile test`                                 | Pure logic: chat reducer, merge, path conventions (runs in root CI)                                                                                                                                                             |
| `pnpm spec --project=mobile`                                  | Real Expo Router + React Native Web rendering at a phone-sized viewport, one visible interaction, and reviewed Playwright screenshot baselines; no Xcode/native build                                                           |
| `doppler run --config dev -- pnpm --dir apps/mobile test:e2e` | Live round-trip from Node through the app's own dial: bearer auth → new mobile chat → real agent reply → live subscription. Point it at a preview by switching the Doppler config. Needs `pnpm dev` running for the dev config. |
| `npx expo export` / `npx expo prebuild`                       | The bundle builds; app config is sane                                                                                                                                                                                           |
| Expo Go on a phone                                            | Native integration: the in-app browser OAuth hop, Keychain/Face ID, and device-specific behavior                                                                                                                                |

## Layout

| Path                       | What                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `src/lib/itx-core.ts`      | The dial: capnweb + bearer + the one auth-shaped retry (Expo-free, e2e-able)            |
| `src/lib/auth.ts`          | Issuer discovery, dynamic registration, PKCE, rotation-safe token refresh               |
| `src/lib/chat.ts`          | Pure: stream events → bubbles + working flag; agent path conventions                    |
| `src/lib/live-thread.ts`   | Live subscription per thread feeding the tanstack-query cache                           |
| `src/lib/approver-core.ts` | Pure P-256 keygen/sign (Expo-free, e2e-able) — the phone's "software" approval key      |
| `src/lib/approver.ts`      | Face-ID-gated Keychain storage binding for approver-core.ts                             |
| `src/lib/approvals.ts`     | Egress-approval protocol: grant/reject/reconcile, ported from the CLI's approve-core.ts |
| `src/lib/examples.ts`      | Filters the shared itx example catalogue to phone-runnable entries                      |
| `src/app/`                 | expo-router screens: sign-in → projects → chat list → thread → approvals → examples     |

`pnpm typecheck` / `pnpm test` run in root CI; nothing native does.
