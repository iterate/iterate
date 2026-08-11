---
status: in-progress
size: medium
branch: mobile-expected-backend-in-bundle
---

# Mobile: bake the expected backend into the JS bundle, not the QR

## Status summary

Implementation done: stamp extended, CI publishers pass the env vars, QR/deep
links are channel-only again, interstitial back to a bare prd bounce, app
reads the running bundle's expectation (confirm screen post-switch + sign-in
screen, gated once-per-bundle). Tests/lint/typecheck/knip green. Remaining:
real-device verification once CI publishes a stamped bundle for this PR.

## Motivation

Today the "Recommended backend" (`env`) and per-PR test login (`email`) ride
the preview QR / deep link as query params
(`iterate://preview-channel/<channel>?env=preview_3&email=pr2429+test@nustom.com`),
added in #2429 and consumed by the confirm + sign-in screens (#2465). That
design has holes:

- **Native EAS builds don't get the hints** — installing a build and launching
  it never passes through the deep link, so the app has no idea which backend
  the embedded JS expects.
- **Switching back to main keeps stale hints** — the hints belong to the URL
  you scanned, not the bundle you're running. Scan a PR QR, later switch back
  to the `preview` (main) channel, and nothing tells the app "no
  recommendation anymore".
- **Param plumbing is invasive** — the interstitial must whitelist-forward the
  query, expo-router double-decodes `+` (the space-normalization hack in
  `deep-link-hints.ts`), the interstitial has to be served from the leased
  slot's OS deployment (prd might run older code that drops params), and the
  hints get ferried between screens via router params.

The fix: the hints describe *the JS bundle*, so stamp them into the bundle —
exactly like `apps/mobile/src/build-info.json` already stamps commit/branch.
Whatever loads a bundle (OTA switch, auto-pull on the default channel, native
install's embedded bundle) automatically carries its own expectation. Main
bundles stamp nothing → no recommendation, by design. QR codes/deep links go
back to carrying just the channel.

## Checklist

- [x] Extend the build-info stamp with `expectedBackendEnv` and
      `testLoginEmail` (empty string = none, matching the existing
      placeholder convention; exposed as `string | null` from
      `lib/build-info.ts`). `scripts/write-build-info.mjs` reads them from
      env vars (`MOBILE_EXPECTED_BACKEND_ENV`, `MOBILE_TEST_LOGIN_EMAIL`),
      defaulting to none.
- [x] `scripts/ci/publish-mobile-pr-preview.ts`: set those env vars when
      running the stamp (leased slot from the PR body via
      `leasedPreviewSlotFromBody`, `pr<N>+test@nustom.com`), so `eas update`
      publishes a self-describing bundle. No slot leased → stamp nothing.
- [x] `scripts/ci/publish-mobile-update.ts` (main): stamp nothing — main
      bundles recommend nothing, phones default to prd.
- [x] Strip `DeepLinkParams` out of `scripts/ci/mobile-preview.ts`: QR
      content and interstitial URL carry the channel only; interstitial host
      goes back to always-prd (slot-hosted interstitials existed only to
      forward params). Simplify QR asset naming (no `-<env>` suffix needed).
- [x] `apps/os/src/routes/m.preview-channel.$channel.ts`: drop the
      query-forwarding block — back to the bare channel bounce.
- [x] App: new tiny module (e.g. `lib/expected-backend.ts`) deriving the
      `Recommendation` (`deep-link-hints.ts` type) from `buildInfo` —
      `expectedBackendEnv` resolved via `serverPresetForEnvKey` (still
      preset-list-only, so a poisoned stamp can't name an arbitrary server),
      email still validated by `testEmailFromHint`.
- [x] `preview-channel/[channel].tsx`: stop reading `env`/`email` params.
      Post-switch (the reload re-opens the screen in the NEW bundle), the
      mismatch card + one-tap plan read from the running bundle's
      expectation. Pre-switch "Recommended backend" row goes away — the old
      bundle can't know the target bundle's backend, and that's honest.
- [x] `index.tsx` (sign-in): stop reading hint params; read the running
      bundle's expectation directly. No more hint-ferrying via router params
      on Continue.
- [x] New-bundle hook: on launch, compare the running update
      (`Updates.updateId` / `buildInfo.commit`) against a stored last-seen
      value; when the bundle changed and its expectation mismatches phone
      state (`recommendationMismatches`), surface the existing mismatch
      card/plan (reuse the pure logic + UI from the confirm screen) outside
      the QR flow too — covers auto-pulled OTA updates and fresh native
      installs. Dismissible, never auto-applies.
- [x] Tests: update `scripts/ci/mobile-preview.test.ts` (no more params in
      URLs/QR content), `deep-link-hints.test.ts` (logic unchanged, feeding
      changes), add coverage for the stamp env vars and the
      bundle-expectation module.
- [x] Docs: `apps/mobile/README.md` preview section + any doc mentioning the
      `?env=&email=` params.

## Assumptions (made while AFK)

1. **Field names/convention**: `expectedBackendEnv` (an envs.ts doppler
   config key like `preview_3`) + `testLoginEmail`, empty-string placeholder
   like the other build-info fields, normalized to `null` at the lib
   boundary. Nullable per Misha's instruction — main/local bundles carry no
   recommendation.
2. **Native EAS builds get best-effort stamping.** The `eas-build-pre-install`
   hook runs on EAS machines where the PR/slot is unknowable, so
   PR-triggered native builds stamp none for now. This still beats today
   (nothing at all rides an install), and the first OTA pull on the PR
   channel delivers a fully-stamped bundle. If EAS's project archive turns
   out to include the CI checkout's already-stamped file, make the hook
   preserve existing expected-backend values instead of blanking them —
   investigate during implementation, don't block on it.
3. **Old QRs keep working.** Existing PR bodies have `?env=&email=` links;
   the app just ignores the now-unread params. No migration needed —
   republish on next push refreshes the section.
4. **The mismatch offer stays suggest-only** (one-tap apply, never silent),
   matching #2465's security posture.

## Round 2 — Misha's nits (2026-08-10)

- [x] Native installs overpower the OTA override: first boot of a new binary
      (version/build/runtime changed) force-clears a pre-existing channel
      override with an Alert + optional "Pull latest now"
      (`lib/native-install-guard.ts`, wired in `_layout.tsx` so it beats any
      deliberate same-session switch). Plus: the EAS pre-install hook now
      KEEPS an already-stamped build-info.json (CI stamps before triggering
      `eas build`, and eas-cli uploads the working tree), so PR install
      builds embed the PR's branch + expected backend instead of blanks.
- [x] Confirm screen: the fix is a default-checked checkbox riding Continue
      ("Sign in on preview 5 as pr…") — buttons are just Continue/Cancel.
- [x] Build info screen shows Expected backend + Test login rows (Bundle
      section).
- [x] "Check for update" and "Reset to default channel" now sit together
      under the Updates card; App section moved below them.
- [x] Sign-in quick-select chips cut to Production + the bundle's expected
      backend; recents chips and their storage helpers removed (free-text
      field covers everything else). `SERVER_PRESETS` stays as the
      validation list for stamp resolution.

## Round 3 — simplify after Misha's device test (2026-08-11)

Misha's native install showed none of the machinery — root cause: the
install build was a REUSED compatible binary (built from a main-ish commit),
embedding channel `preview`, so first launch OTA-pulled MAIN's JS — which
doesn't contain this PR's code at all. The PR's behavior can only run once
its JS runs (post-channel-switch today; from boot once merged to main).
The QR flow did work end-to-end (checkbox appeared post-switch), but the
"You're already on this channel" framing made it read as a no-op.

Simplifications:

- [x] Removed the first-boot forced interrupt entirely (`new-bundle-boot.ts`,
      the `newBundle` bootstrap gate, "Keep current setup") — it was the
      twice-Bugbot-flagged complexity and its trigger conditions are rare.
      The QR confirm screen is now the ONE surface that acts on the stamp;
      the sign-in screen (signed out) and Build info only display/suggest.
- [x] Confirm screen: post-switch heading is "You're on this channel" (a
      calm arrival state, not "already"), and the pre-switch state says the
      backend/test-login offer comes after the reload — so its absence
      pre-switch reads as sequencing, not a bug.
- [x] PR-body install section now says installing gets a compatible binary
      on the default channel and the OTA link is what switches it to the
      PR's JS — the two-QR dance is explicit.
- Kept: the stamp, the checkbox-on-Continue fix, the native-install override
  guard (dormant until this merges — the guard runs in whatever JS the
  binary boots, which is main's until then), and the EAS hook stamp
  preservation (only helps fresh PR-triggered builds; reused builds embed
  whatever they were built from, which is fine — the QR flow recovers).

## Implementation log

- Folded `deep-link-hints.ts` into `expected-backend.ts` (everything in it is
  now about the bundle's expectation, not deep links); `testEmailFromHint` →
  `validatedTestEmail`, dropping the expo-router `+`→space corruption hack —
  nothing rides URLs anymore. Test file renamed to `expected-backend.test.ts`.
- `claimNewBundleBoot` lives in its own `new-bundle-boot.ts` because
  AsyncStorage drags react-native into what must stay a pure node-lane module.
- The once-per-bundle gate: the expectation is permanent for a bundle's life
  (unlike a one-time deep link), so the sign-in screen's forced-show only
  fires on the first boot after new JS loads — otherwise "no thanks, keep me
  on prd" would nag on every launch. The QR flow is unaffected: the confirm
  screen's mismatch card renders whenever the channel matches.
- publish-mobile-pr-preview now reads the PR body BEFORE `eas update` (the
  leased slot feeds the stamp), and re-fetches it just before the body write.
- Deviation from spec: normalization to null happens in
  `expected-backend.ts`, not `build-info.ts` — the raw JSON import stays
  untyped-strings like the other fields.
