# Iterate (iOS)

The iterate mobile app: sign in, pick a project, chat with its agents — the
phone equivalent of the dashboard's "new chat", against any deployment.
Chat is the trunk; native features (voice — see PR #1605, whose plumbing this
app shares — push, widgets) graft on later.

## Run it on your phone

Iterate uses its own development client so phone development exercises the
same bundle identity, app scheme, Keychain, Face ID, and APNs entitlement as
the native app. Expo Go is not a supported runtime.

Building for a physical iPhone requires an Expo login, a paid Apple Developer
membership, and that phone's registered UDID:

```sh
pnpm --dir apps/mobile dlx eas-cli@21.0.1 login
pnpm --dir apps/mobile dlx eas-cli@21.0.1 device:create
pnpm --dir apps/mobile build:development:ios
pnpm --dir apps/mobile start
```

Use `build:simulator:ios` for an EAS simulator binary or `build:preview:ios`
for a production-like internal build without the development launcher. EAS
performs the native build in the cloud, so local Xcode is not required. After
installing a development build, enable iOS Developer Mode and use the normal
`start` command for Metro. Day-to-day JavaScript changes then hot-reload into
that installed client.

When `apps/mobile/package.json` gains a native module, the already-installed
client cannot load it from Metro. Build and install a new development client
before testing that change. The repo workspace's native Markdown renderer is
one such module; a client built before it landed will fail when opening chat or
a Markdown preview.

This repository does not contain Apple or Expo credentials. The first signed
physical-device development build completed through the linked
`@mishanustom/iterate` EAS project on 2026-07-17; subsequent builds reuse its
EAS-managed Apple credentials and registered devices. Install a build from its
EAS dashboard link on a provisioned phone before starting Metro.

The `development` build is ad-hoc internal distribution: only provisioned
devices can install it, and it contains the development launcher. `preview`
is the production-like internal lane without that launcher. TestFlight and App
Store releases use the `production` profile, store distribution signing, and a
separate EAS Submit/App Store Connect step; a successful development build is
not silently treated as a releasable binary.

## Dev ↔ preview: two builds, one phone

Both builds share the bundle ID, so installing one replaces the other —
deliberate: the keychain survives, sign-in persists, and switching is just
opening the other build's EAS install page and tapping Install. Bookmark both
install pages ([EAS builds list](https://expo.dev/accounts/mishanustom/projects/iterate/builds)).

- **Dev**: the development client + `pnpm --dir apps/mobile start`. Metro
  hot-reload; JS comes from your laptop.
- **Preview**: standalone, JS bundled in, laptop off. It tracks main by
  itself: every merge, CI publishes the JS bundle to the EAS Update `preview`
  channel (`.depot/workflows/mobile-eas-update.yml` →
  `scripts/ci/publish-mobile-update.ts`) and the installed app pulls it on
  next launch. The drawer's **Build info** screen shows what's running
  (branch, commit, who built it, update channel/time) and has a
  check-for-update-now button.

The runtime version uses the fingerprint policy: a merge that changes native
code (new native module, Expo upgrade) produces updates old binaries ignore.
CI notices there's no preview build for the new fingerprint and triggers one
automatically — install that from its EAS page once, then OTA resumes. The
same merges are the ones that need a manual dev-client rebuild
(`build:development:ios`), as above.

`eas update` publishes stamp `src/build-info.json` via
`scripts/write-build-info.mjs` (EAS native builds run it through the
`eas-build-pre-install` hook). The checked-in file is an all-empty
placeholder — don't commit a stamped one. Manual publish to the shared
main channel (rare — see per-PR channels below):
`pnpm --dir apps/mobile update:preview`.

### Per-PR channels

The `preview` channel is main-only; publishing PR work to it would be
last-write-wins chaos. PRs touching `apps/mobile/**` get their own channel
named after the branch: CI (`.depot/workflows/mobile-pr-preview.yml` →
`scripts/ci/publish-mobile-pr-preview.ts`) publishes on every push and
maintains a PR-body section with two tappable QR codes — an
`iterate://preview-channel/<channel>` deep link that switches the installed
app to the PR's channel (confirm screen, then fetch + reload), and the
matching build's install page for when the runtime differs or the app isn't
installed. Whichever the fingerprint heuristic says you need is expanded.
The switch persists across restarts; get back with **Build info → Reset to
default channel**.

Lifecycle: closing a PR deletes its channel, update branch, and QR assets
(`.depot/workflows/mobile-pr-preview-cleanup.yml`). In the app, the drawer's
**Preview channels** screen lists active channels (via
`Session.mobilePreviewChannels` — OS proxies the EAS API with its server-side
Expo token) with tap-through to the same switch-confirm screen the QRs use.

## Run and test it in a browser

Expo Web renders the same Expo Router screens through React Native Web, so UI
work does not need a phone, Xcode, an iOS simulator, or a new native build:

```sh
pnpm --dir apps/mobile start:web
```

For a repeatable 390×844 Chromium test, run:

```sh
pnpm spec --project=mobile
```

Playwright starts and stops its own Expo Web server, checks the signed-out
server-picker interaction, and exits. The root `pnpm spec` command runs this
alongside the `web` project; `pnpm spec --project=web` runs only the dashboard
specs.

This is a fast browser-test lane, not an iOS emulator:
platform-native behavior such as the in-app OAuth handoff, Keychain, Face ID,
and push notifications still needs the Iterate development build.
Authenticated project/chat fixtures are follow-up work; this first lane stays
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
owned by the shared `iterate/sdk/itx/react` keeper and typed from its public contract).
A chat is an agent stream: "new chat"
mints `/agents/mobile/<timestamp>` and the first `message()` call creates it
(same lazy-seeding contract as the dashboard). The chat list is the unfiltered
`/agents` catalogue, so web/Slack-started chats open and continue here too.
The thread screen renders only visible messages plus a "working…" row derived
from in-flight activity (`src/lib/chat.ts`); `useStreamConnection` pushes live
events into the same TanStack Query cache as the initial read
(`src/lib/use-live-events.ts`). Assistant messages are rendered as selectable
Markdown; user messages remain literal text.

## Editing repositories

`/repos` is the first project destination in the drawer. It lists the repos
exposed by `project.repos`, with `/repos/config` first, and opens a native file
workspace backed by `Repo.listFiles()`, `readFile()`, and `commitFiles()`.
Edits, new files, and deletes stay in a local working tree until they are
committed together. If the remote head changes while local edits exist, commit
is blocked until the user deliberately reloads.

Markdown files have Preview and Source modes. Preview and assistant chat use
`react-native-enriched-markdown`; Source uses the bundled CodeMirror editor and
is canonical. The rich Markdown input is intentionally not used because it
cannot losslessly represent every repo Markdown block construct.

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
`tasks/mobile-native-followups.md` for the remaining gap and what closing it
needs (these capabilities require the native development build).

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
testable from the phone alone. The runner shipped in PR #2059.

## Verification

| Lane                                                          | What it proves                                                                                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --dir apps/mobile test`                                 | Pure logic: chat reducer, merge, path conventions (runs in root CI)                                                                                                                                             |
| `pnpm spec --project=mobile`                                  | Real Expo Router + React Native Web behavior at a phone-sized viewport and one visible interaction; no Xcode/native build                                                                                       |
| `doppler run --config dev -- pnpm --dir apps/mobile test:e2e` | Live round-trip through `iterate/node`: bearer auth → new mobile chat → real agent reply → live connection. Point it at a preview by switching the Doppler config. Needs `pnpm dev` running for the dev config. |
| `npx expo export` / `npx expo prebuild`                       | The bundle builds; app config is sane                                                                                                                                                                           |
| Iterate development build on a phone                          | Native integration: the in-app browser OAuth hop, Keychain/Face ID, APNs enrollment, and device-specific behavior                                                                                               |

## Layout

| Path                           | What                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `src/lib/itx.ts`               | Mobile deployment/OAuth binding for the shared `iterate/sdk/itx/react` keeper           |
| `src/lib/auth.ts`              | Issuer discovery, dynamic registration, PKCE, rotation-safe token refresh               |
| `src/lib/chat.ts`              | Pure: stream events → bubbles + working flag; agent path conventions                    |
| `src/lib/use-live-events.ts`   | Initial stream reads + shared subscription hook feeding the TanStack Query cache        |
| `src/lib/repo-working-tree.ts` | Local source-preserving edits and explicit batch commit state                           |
| `src/lib/approver-core.ts`     | Pure P-256 keygen/sign (Expo-free, e2e-able) — the phone's "software" approval key      |
| `src/lib/approver.ts`          | Face-ID-gated Keychain storage binding for approver-core.ts                             |
| `src/lib/approvals.ts`         | Egress-approval protocol: grant/reject/reconcile, ported from the CLI's approve-core.ts |
| `src/lib/examples.ts`          | Filters the shared itx example catalogue to phone-runnable entries                      |
| `src/app/`                     | expo-router screens: sign-in → projects → chat list → thread, approvals, examples       |

`pnpm typecheck` / `pnpm test` run in root CI; nothing native does.
