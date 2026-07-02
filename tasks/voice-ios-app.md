---
status: ready
size: large
base: mmkal/26/07/02/voice-itx-bridge (PR #1591 — merge it in regularly, another agent is active there)
pr: https://github.com/iterate/iterate/pull/1605
---

# voice-ios-app

## Status summary

Spec complete (grill-you interview in `voice-ios-app.interview.md`).
Implementation not started. Main pieces: new Expo app `apps/mobile/`, a small
OS-side addition (realtime-secret mint on the itx surface + its e2e test), and
a simulator-verified end-to-end voice round-trip.

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

- [ ] OS: expose `voice` realtime-secret mint on the itx surface (project
      scope), delegate the existing server fn to it, + itx e2e test
- [ ] Scaffold `apps/mobile` (Expo, TS, expo-dev-client, react-native-webrtc,
      expo-router, tanstack-query, reanimated, expo-secure-store,
      expo-auth-session, expo-haptics, expo-keep-awake)
- [ ] Auth: issuer discovery, PKCE flow, token store + refresh discipline
- [ ] itx client wrapper for RN (connect, authenticate bearer, forced-refresh
      reconnect seam)
- [ ] Port `VoiceSession` to a transport-agnostic session core with WebRTC
      data-channel transport + derived assistantSpeaking/workerBusy
- [ ] Vitest suite for the session core (fake data channel, recorded events)
- [ ] Screens: sign-in, server picker, projects, sessions list, voice screen
      (orb, transcript sheet, bottom bar, worker caption)
- [ ] Polish: keep-awake, haptics, background audio plist line, mic-denied
      path
- [ ] Root typecheck/lint/test green including apps/mobile; knip exclusion
- [ ] Simulator end-to-end round-trip against a live deployment,
      screen-recorded into the PR body
- [ ] PR body: verified-in-simulator vs needs-your-phone checklist; build
      instructions (`npx expo run:ios --device`)

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

(append as work happens)
