---
status: implemented — awaiting native-build verification on a machine with Xcode, and review
size: large
base: mmkal/26/07/02/voice-itx-bridge (PR #1591 — merge it in regularly, another agent is active there)
pr: https://github.com/iterate/iterate/pull/1605
---

# voice-ios-app

## Status summary

Implementation complete and pushed; PR #1605. All root gates green
(typecheck/lint/test incl. the new `apps/mobile` vitest suite); the OS-side
mint capability has a passing itx e2e test; the ported session core passed a
LIVE end-to-end run (real dev server, real OpenAI Realtime, real worker agent
round-trip) from Node. **Not verified: the native iOS build** — this machine
has no Xcode, so the first `npx expo run:ios` happens on Misha's machine
(`expo prebuild` + full Metro export both pass, which catches config and JS
errors but not native compile issues). Preview deploy couldn't run: the
preview slot pool was exhausted — re-run the Preview workflow when back.

## What this is

A native iOS client (Expo + expo-dev-client + react-native-webrtc) for the
voice ↔ itx bridge introduced in PR #1591. The phone is a thin I/O pump — mic
and speaker ride a WebRTC connection to OpenAI Realtime; transcribed turns are
appended to the agent stream as `voice/user-turn-transcribed`; the server-side
voice stream processor does the multiplexing; `voice/say-requested` projections
are relayed back into the realtime conversation as `[worker report]` messages.
Reference implementation: `apps/os/src/components/voice/voice-session.ts`.

Misha builds it to his iPhone with `npx expo run:ios --device`, signs in, picks
a project, and talks to his worker agent.

## Decisions (from the interview)

- **Screens**: sign-in → project picker → per-project voice-sessions list
  (`project.agents.list()` filtered to `/agents/voice/`, newest first, "New
  session" generates a timestamp path like the web page; tapping an old one
  reopens the voice screen on that agentPath — worker journal resumes, voice
  model context is fresh) → voice screen. No general dashboard/chat UI; the
  voice screen's text lane (and text-only start) is the typing story.
- **Voice screen**: orb-hero presence indicator with idle / listening /
  speaking / thinking states (new derived `assistantSpeaking` / `workerBusy`
  snapshot fields on the ported session class), transcript in a swipe-up
  sheet, bottom bar (mute · text input · end), one-line worker status caption
  under the orb. Keep-awake while live, light haptics (start/end,
  worker-report arrival), dark-leaning calm design per
  `docs/brand-and-tone-of-voice.md` / `docs/design-system.md`. Barge-in: orb
  snaps speaking→listening on VAD; server handles actual interruption.
  Reanimated pulse/scale/glow only — no shader art.
- **Realtime leg**: mint ephemeral client secret over itx, then WebRTC — POST
  SDP offer to `https://api.openai.com/v1/realtime/calls?model=…` with the
  ephemeral bearer, audio as native tracks (echo cancellation free), events
  over the `oai-events` data channel (same JSON as the web WS client; port the
  event handling, drop the manual PCM capture/playback).
- **itx leg**: capnweb `newWebSocketRpcSession` over RN's global WebSocket to
  `<server>/api/itx`, `authenticate({ type: "bearer", token })`.
- **Server-side change (this PR)**: expose realtime-secret minting on the itx
  surface (project-scoped capability) so the phone mints over the
  already-authenticated socket; the TanStack server fn can delegate to the
  same code. Covered by an itx e2e test (assert shape; don't require hitting
  OpenAI in CI).
- **Auth**: OAuth authorization-code + PKCE against the auth worker via
  expo-auth-session in-app browser; scopes `openid profile email
offline_access` + project-selection scope; RFC 8707 `resource` = the OS
  base so the audience validates. Client registration: dynamic registration
  (unauthenticated allowed) or reuse the `iterate-cli` device client —
  whichever works first, documented. Issuer discovery from the OS base via
  RFC 9728 `/.well-known/oauth-protected-resource`, falling back to the
  os.→auth. hostname convention.
- **Token handling**: `expo-secure-store`; proactive refresh with ~60s buffer
  before any new socket/mint/list; single-flight refresh; persist rotated
  refresh token atomically before using the new access token; refresh failure
  → clear + login screen; sign-out = clear keychain. One forced
  refresh+reconnect on auth-shaped failure at itx connection setup; no other
  401-driven retry.
- **Server targeting**: editable persisted server URL; default = this PR's
  preview slot once CI assigns it; quick-pick chips for prod / preview /
  localhost (simulator + local dev).
- **Failure modes**: mic permission denied → session starts text-only with an
  error entry + `Linking.openSettings()` affordance. Realtime leg is
  fail-dead (ended state; Start re-opens the same agentPath). The itx lane
  auto-redials every ~1s while the realtime leg lives (matching the web
  worker-listen loop); if a turn can't be forwarded, error entry in the
  transcript and keep talking. Backgrounding: `UIBackgroundModes: [audio]` as
  a one-line best-effort; zero further background engineering; if it fights
  react-native-webrtc, drop to foreground-only and note it here.
- **Repo integration**: `apps/mobile` joins root typecheck/lint/test (own
  `tsc --noEmit`, global oxlint, vitest for the ported session state
  machine). Excluded only from knip's explicit workspace list. Native
  xcodebuild stays out of CI.

## Checklist

- [x] OS: expose `voice` realtime-secret mint on the itx surface (project
      scope), delegate the existing server fn to it, + itx e2e test — _new
      `VoiceRpcTarget` builtin in `apps/os/src/rpc-targets.ts`, shared mint in
      `domains/voice/mint-realtime-connection.ts`, e2e test passed against a
      live dev server (really minted an `ek_` secret)\_
- [x] Scaffold `apps/mobile` (Expo SDK 57 / RN 0.86, expo-dev-client,
      react-native-webrtc, expo-router, tanstack-query, reanimated,
      expo-secure-store, expo-auth-session, expo-haptics, expo-keep-awake)
- [x] Auth: issuer discovery, PKCE flow, token store + refresh discipline —
      _`src/lib/auth.ts`; discovery + dynamic registration + PKCE probed live
      against auth.iterate-dev.com from this machine_
- [x] itx client wrapper for RN — _`src/lib/itx.ts`; one cached capnweb
      session, one auth-shaped refresh+reauth at connection setup_
- [x] Port `VoiceSession` to a transport-agnostic session core —
      _`src/lib/voice/session-core.ts` + `webrtc.ts`; adds
      assistantSpeaking/workerBusy and a `voice/client-connected` stream
      marker so reopening an old session doesn't replay say-request history_
- [x] Vitest suite for the session core — _11 specs over a fake realtime
      transport + fake stream_
- [x] Screens: sign-in/server picker, projects, sessions list, voice screen
      (orb, transcript toggle, bottom bar, worker caption)
- [x] Polish: keep-awake, haptics, background audio plist line, mic-denied
      path (text-only + `Linking.openSettings()`)
- [x] Root typecheck/lint/test green including apps/mobile; knip untouched
      (opt-in list)
- [x] ~~Simulator end-to-end round-trip, screen-recorded~~ — _IMPOSSIBLE HERE:
      no Xcode on this machine (CommandLineTools only). Substituted with a
      stronger-than-nothing live e2e: the exact session-core code driven from
      Node (WS standing in for the WebRTC data channel) against the real dev
      server + real OpenAI Realtime — turn forwarded → worker replied →
      report injected → voice model responded (chose `no_comment`, correctly).
      `expo prebuild` + `expo export` (full Metro bundle) also pass._
- [x] PR body: verified vs needs-your-phone checklist; build instructions

## First-run notes for Misha

1. `cd apps/mobile && npx expo run:ios --device` (needs Xcode; see README).
2. This PR's preview landed on `os.iterate-preview-8.com` (the app's default
   preset) and its e2e suite — including the itx voice mint — passed there.
   If the lease has expired by the time you try it, re-run the Preview
   workflow and correct the server field to the newly assigned slot.
3. Simulator + `pnpm dev` local server also works end-to-end (sign-in goes
   through the hosted dev auth worker).

## Found along the way

- A worker-agent script calling `itx.processor.snapshot()` fails with
  `The RPC receiver does not implement the method "processor"` in the
  script-execution lane (observed live on this branch's dev server; the agent
  never replied to that turn). Pre-existing platform gap, not introduced
  here — worth its own task.
- `event-target-shim`'s `exports` map hides the `event-target-shim/index`
  subpath that react-native-webrtc's typings import — needs a tsconfig
  `paths` alias under moduleResolution=bundler (done in apps/mobile).

## Guesses and assumptions

- "Create chats" = practically reach a working chat, not rebuild the
  dashboard chat UI (sessions list + voice text lane suffices).
- Preview slot as default server (both PRs unmerged; prod would 404 voice).
- Transcript-as-sheet, orb-first design.
- He'll lock the phone mid-conversation, so the background-audio plist line
  is worth including despite "no background support" scope.
- capnweb works over RN's WebSocket (event-target-shim). To be proven early;
  if it doesn't, fall back to a tiny WS shim.
- Apple-Silicon simulator passes host mic through for WebRTC — the e2e voice
  check relies on this.

## Out of scope

Android; Grok/xAI provider; changing voice processor semantics; push
notifications; offline; EAS/TestFlight/App Store; auth-worker changes.

## Implementation log

- 2026-07-03 (night): grill-you interview → spec; OS itx mint capability +
  e2e; full apps/mobile implementation; 11-spec session-core suite; live
  node-driven voice e2e against local dev PASSED (worker replied; voice model
  used no_comment for the redundant report). No Xcode on this machine —
  native build deferred to Misha.
- 2026-07-03 (morning): preview slot obtained after auto-retries →
  preview-8, this branch's e2e (incl. voice mint) passed there; all checks
  green briefly. Merged base one-ack fix (3c02cb600) and ported it to the
  mobile core (+2 specs, output_audio_buffer.started as the WebRTC speech
  signal).
- 2026-07-03 (afternoon): merged base double-answer fix (9777b2274); prompt
  drift had now happened twice, so hoisted VOICE_AGENT_INSTRUCTIONS + tool
  defs into shared `apps/os/src/domains/voice/voice-client-prompts.ts`,
  imported by dashboard, CLI, and iOS clients (Metro-verified). Ran the live
  voice e2e against the DEPLOYED preview (`os.iterate-preview-3.com`,
  doppler preview_3): PASSED with the assistant speaking the worker's
  report. The red Preview CI check is rotating 240s-timeout flakes in
  base-branch suite tests, not this diff — evidence posted on the PR.
