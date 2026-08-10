---
status: in-progress
size: medium
branch: qr-scan-freshness
---

# Mobile QR scan: always fetch latest + state-mismatch switching

Misha's ask (verbatim): "scanning the QR code should always check for updates
(safe to assume I want the *latest* version of the JS bundle I'm scanning) and
also should check my login/backend/project state and if it differs from the QR
code recommendation it should show an on-screen option to switch."

## Status summary

Implemented and verified (typecheck, lint, knip, format, mobile vitest, web
specs all green). Main pieces: automatic latest-update pull on scan when the
channel already matches, and a backend/identity mismatch card with a one-tap
switch action on the preview-channel screen. Not covered: on-device OTA
freshness (needs a phone scan) and the OAuth tap itself in the web lane.

## Background

PR-preview QRs deep-link to `iterate://preview-channel/<channel>?env=<slot>&email=<pr+test@nustom.com>`
(`apps/mobile/src/app/preview-channel/[channel].tsx`). Two gaps:

1. **Staleness**: if the phone is ALREADY on the QR's channel, the screen just
   shows "Continue" — it never checks for updates. Scanning the same PR's QR
   after CI publishes a newer bundle does nothing until next launch. (The
   switch path is fine: `switchChannelAndReload` already does
   check → fetch → reload, which pulls the channel's latest.)
2. **State mismatch**: `env`/`email` ride along as hints ferried to the
   sign-in screen, but when the phone is already signed in on the same server
   the sign-in screen fast-forwards to the remembered project and the identity
   hint is silently dropped. Nothing ever COMPARES phone state to the QR's
   recommendation or offers to fix a difference.

## Decisions

- **Freshness is automatic, switching is not.** Fetching the latest bundle of
  the channel you're already pointed at is not a repoint — the scan itself is
  the intent ("I want what this QR shows"). So on open, when the channel
  already matches and OTA is enabled, auto check → fetch → reload with a
  visible status line. Channel *switching* keeps its explicit confirm (a stray
  link tap must not repoint the app), and backend/identity switching is
  strictly tap-to-act — mismatches are shown, never auto-fixed.
- **Identity = the `email` claim of the access token** for the current server
  (the app requests the `email` scope; claim shape:
  `apps/auth/src/lib/session.ts` AccessTokenClaims). Decoded client-side by a
  pure Expo-free helper so it's node-testable. Getting a token may cost one
  refresh round-trip on this screen; acceptable for a scan flow. If the
  refresh fails or there's no sign-in, identity is "not signed in".
- **One-tap actions, picked by what differs** (pure planner, unit-tested):
  - backend differs + already signed in on the recommended server → "Use
    <label>" (just repoint + reconnect, no OAuth);
  - backend differs otherwise → "Sign in on <label>" (as the test identity
    when the QR carries one — login_hint rides the OAuth flow and the
    non-prod test OTP makes it near-zero-touch);
  - backend matches but identity differs from the QR's test identity →
    "Sign in as <email>" on the current server.
- **Project state: out of scope** *(guess, flagged)*. The QR carries no
  project recommendation — CI can't know one at publish time (the per-PR test
  identity's project doesn't exist until its first sign-in). Backend + identity
  are what the QR actually recommends. The remembered-project-per-server logic
  already routes correctly after a backend switch.
- **Mismatch card lives on the preview-channel screen** (not the sign-in
  screen) so one scan shows channel + backend + identity in one place. When
  hints are present and nothing differs, a small "matches" reassurance line
  renders instead — silence would look like the hints were dropped.

## Checklist

- [x] `lib/preview-channel.ts`: `fetchLatestUpdateAndReload()` — the
      check/fetch/reload dance minus the override write; reuse it from
      build-info.tsx's check button _(switchChannelAndReload now delegates to
      it too; build-info.tsx maps its statuses onto the helper)_
- [x] `[channel].tsx`: auto-run freshness check (tanstack `useQuery`, no
      useEffect) when already on the target channel and OTA enabled; status
      line for checking / up-to-date / restarting / error; Continue stays
      tappable throughout _(query `["qr-channel-freshness", channel]`; gated
      on `Updates.isEnabled && !__DEV__` — expo web dev reports isEnabled true
      but checkForUpdateAsync throws in dev mode)_
- [x] `lib/jwt-claims.ts` (Expo-free): decode a JWT payload, expose
      `emailFromJwt` + unit test (null on anything malformed, never throws)
      _(atob + JSON.parse; jwt-claims.test.ts)_
- [x] `lib/auth.ts`: `getSignedInEmail(baseUrl)` — stored auth → access token
      → email claim, null on any failure _(next to hasSignIn; swallows
      SignInRequiredError/refresh failures by design)_
- [x] `lib/deep-link-hints.ts` (Expo-free): `recommendationMismatches(phone, qr)`
      + a switch planner returning the one-tap action; unit tests including
      `testEmailFromHint` backfill _(recommendationSwitchPlan; identity is
      compared against where the switch LANDS — the recommended server's
      sign-in — so an already-parked test sign-in makes it a pure repoint)_
- [x] `[channel].tsx`: phone-state query (server, signed-in email, sign-in on
      recommended server), mismatch card with rows + one-tap buttons, matches
      reassurance line; actions mirror index.tsx's login mutation
      _(`["qr-phone-state", recommendedBaseUrl]`; applyPlan mutation:
      setServerBaseUrl → optional signIn with login_hint →
      reconnectItxSession → queryClient.clear() → router.replace("/"))_
- [x] Web-lane spec: seed `iterate.secure-store.iterate.server` via
      localStorage (web SecureStore shim) and assert the mismatch card +
      action button render for a signed-out phone pointed at prd scanning a
      preview_N QR _(specs/mobile/preview-deeplink-mismatch.spec.ts — also
      asserts the dev-bundle OTA note and the all-matches reassurance line)_
- [x] Verify: typecheck, lint, knip, format, mobile vitest,
      `pnpm spec --project=mobile` _(all green locally; on-device OTA paths
      need a phone scan — flagged in the PR body)_

## Implementation notes

- `switchChannelAndReload` already fetches the channel's latest on switch;
  the only staleness gap was the already-on-channel path. expo-updates
  `checkForUpdateAsync` compares the channel's latest against the *running*
  update, so post-reload re-entry of the deep link finds nothing new and the
  auto-check terminates instead of looping.
- Freshness auto-reload via a `useQuery` whose queryFn side-effects a reload
  is deliberate: the scan is the user intent, queries are the app's
  no-useEffect idiom for run-on-mount work, and `staleTime: Infinity` +
  `retry: false` keep it single-shot per scan.
- Web lane can't exercise real OTA (`Updates.isEnabled` is false in Metro/web
  bundles) — the spec asserts the explanatory note instead. Native freshness
  path is device-verified only.
- Bugbot round (all three accepted, commit 843580a21): freshness re-checks
  per mount (`refetchOnMount: "always"`) not per process; the mismatch
  card/plan render only once the channel matches (pre-switch, a plan tap
  abandoned the channel change); the plan button is held while a freshness
  reload could fire mid-OAuth (`reloadImminent` guard).
