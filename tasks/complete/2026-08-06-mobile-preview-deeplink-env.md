---
status: done
size: medium
branch: mobile-preview-deeplink-env
base: mobile-reply-push (PR #2422 — stacked)
---

# Preview QR deep links: recommended backend + test auto-login

Scanning a PR's mobile QR today switches the OTA channel only — the client then talks to whatever backend it was last on, which breaks when the PR needs its own apps/os APIs (e.g. #2422 needs preview-12). Fix: the deep link also carries the PR's leased preview env and a per-PR test login, so one scan + one confirm = right JS, right backend, signed in.

## Status summary

Implementation complete; typecheck/lint/knip/format green, full test suite running.

- Done: CI slot→deep-link plumbing, interstitial param forwarding, mobile confirm screen (backend + sign-in rows), auth login page prefill + auto test OTP.
- Missing: nothing known; live end-to-end validation needs a real PR QR (this PR's own, once it has a preview slot).

## Decisions (settled)

1. **Deep link gains `env` + `email` params**: `iterate://preview-channel/<channel>?env=preview_12&email=pr2422+test@nustom.com`, carried through the https interstitial (`/m/preview-channel/<channel>?env=…&email=…`). Main-commit QRs stay bare (prd backend, no login).
2. **`env` is a preset slug, never a raw URL.** The app resolves it against `SERVER_PRESETS` (built from `envs.ts`) and ignores unknown values — a crafted link must not be able to point the app (and its OAuth flow) at an arbitrary server.
3. **Everything stays behind the existing confirm screen** (`preview-channel/[channel].tsx`): it grows Backend and Sign-in rows; nothing switches or signs in on a stray tap.
4. **CI resolves the leased slot from the PR body** — the preview deploy (`scripts/preview/preview.ts`) already writes the slot there and the semaphore stays the source of lease truth; the mobile QR publisher just reads the display. Draft PRs (no slot) omit `env`.
5. **Auto-login reuses the existing test-OTP backdoor, adding no new server trust.** Per-PR identity `pr<N>+test@nustom.com`; mobile passes it as OIDC `login_hint` on the authorize request; the auth login page prefills it and — only when the address matches `*+test@nustom.com` and the deployment has test OTP enabled — auto-requests the OTP, fills `424242`, submits. Prod behavior unchanged (flag off; 424242 never matches a real OTP). No headless token minting.
6. **Order on confirm: server switch → sign-in → channel switch last** — `switchChannelAndReload` restarts the JS runtime, so the reload is the final step; tokens/server persist in SecureStore keyed by baseUrl and survive it.
7. **Lazy user/project via existing flows**: first OTP sign-in auto-creates the user (signup allowlist already allows `+test@nustom.com`), auth's project-access screen creates the project row, and mobile's `backfillProjectIfMissing` finishes OS bootstrap. No new provisioning code.

## Assumptions made on your behalf

- Per-PR email (`pr<N>+test@nustom.com`) rather than one shared test user — isolates each PR's project and matches the lease lifecycle.
- `login_hint` reaches the login page via better-auth's signed continue URL; if better-auth drops it, fall back to explicitly forwarding it where our auth worker builds the login redirect. Both are our code.
- Main-commit QRs unchanged (they point at prd where none of this applies).

## Checklist

- [x] `scripts/ci/mobile-preview.ts`: `interstitialUrl` takes `{env, email}` params _(required param, `{}` for none; `leasedPreviewSlotFromBody` exported from `scripts/preview/preview.ts` — no label duplication)_
- [x] `scripts/ci/publish-mobile-pr-preview.ts`: `deepLinkParamsForPr` reads the slot from the fresh PR body; env also rides the QR asset name so a late-arriving lease refreshes the QR
- [x] Interstitial route `m.preview-channel.$channel.ts`: whitelist-forward `env` + `email` (regex-validated, attribute-escaped)
- [x] Mobile `preview-channel/[channel].tsx`: Backend + Sign-in rows; apply order server → sign-in → channel reload; works in Metro dev for the non-channel steps _(no `lib/preview-channel.ts` change needed)_
- [x] Mobile `lib/auth.ts`: `signIn(baseUrl, {loginHint})` → `login_hint` extraParam
- [x] `apps/auth` login page: `login_hint` union accepts an email address (arrives top-level in the oauth-provider's signed login redirect — confirmed in `@better-auth/oauth-provider` dist); prefill + auto test OTP behind `fixedTestOtpEnabled` from the loader, google-hint-style once-per-URL guard
- [x] Tests: interstitial URL building + `deepLinkParamsForPr` (3 new, mobile-preview.test.ts); `serverPresetForEnvKey` validation (servers.test.ts) _(no component-test infra in auth/mobile — gating logic rides already-tested `shouldUseTestOtp`)_
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test` _(all green)_

## Implementation notes

- `login_hint` pass-through confirmed end-to-end in `@better-auth/oauth-provider` dist: the authorize query schema includes `login_hint`, unauthenticated prompts redirect to `/login?<signed serialized query>` (top-level param, not nested), and `getPostLoginRedirectUrl` re-enters authorize from `window.location.search` — so the hint round-trips without any auth-worker change (the spec'd fallback wasn't needed).
- The auto sign-in lane is client-driven (`sendVerificationOtp` → `signIn.emailOtp(424242)`), mirroring the google-hint auto-start (sessionStorage + ref guard, once per URL). Failure just leaves the prefilled form — the human path is untouched.
- `TEST_OTP_CODE`/`shouldUseTestOtp` import into the client bundle is safe: `server/email.ts` is pure (types + string checks).
- Mobile `env` resolution is preset-lookup only; the interstitial also regex-validates both params and HTML-escapes `&` in attribute contexts.
- **Field-test fix (round 2): slot-hosted interstitial.** First real scan (PR #2429) switched the channel but never offered backend/sign-in: the QR pointed at prd's interstitial, and prd runs main's revision — which drops the query params before the `iterate://` bounce. Chicken-and-egg: the forwarding interstitial only exists on this branch. Fix: `deepLinkForPr` (né `deepLinkParamsForPr`) now also picks the interstitial HOST — the leased slot's own OS whenever params ride along (the slot runs the same revision as the publisher, by construction), prd for bare links. Also swept up the two explain-type-cast review threads: `serverPresetForEnvKey` now matches on an explicit `envKey` carried by each preset (cast gone), and login.tsx dropped a redundant `as const`.
- **Field-test fix (round 3): login_hint never left the authorize endpoint.** Live repro (curl against preview-7's real authorize): the signed `/login?…` redirect carried everything except `login_hint`. Root cause: better-call strips query keys the ENDPOINT schema doesn't declare, and `@better-auth/oauth-provider`'s `/oauth2/authorize` endpoint schema omits `login_hint` (the package's richer `oauthAuthorizationQuerySchema` has it — just not wired to the endpoint). Extended the existing package patch (`patches/@better-auth__oauth-provider@1.6.9.patch`, which already carries three iterate fixes) to declare it; `signParams` then serializes it into the signed login redirect automatically. Lockfile updated by hand to only the patch-hash lines — `pnpm patch-commit`'s re-resolve dragged in unrelated typescript@6 peer drift, discarded.
- **Round 4: hint-ferrying UX (Misha's spec), replacing the one-shot apply screen.** The combined Backend/Sign-in/Apply confirm screen is gone. New flow: scan QR → raw `iterate://` deep link WITH params (merged #2417's scheme QRs; params now ride both the scan QR and the tap interstitial) → channel confirm screen (channel switch only; shows a display-only "Recommended backend" row) → after switch/relaunch, redirect to the sign-in screen `/` carrying `env`+`email` as query params (no more build-info dead end) → sign-in screen shows "Recommended backend for this preview channel" under the subtitle, preselects the server (user edits win), and passes the test email as `login_hint` only when signing into the recommended backend → auth login page shows a "Continue as <email>" button above Continue with email/Google; pressing it sends the code and opens the normal OTP screen prefilled with the `otpGuess` (fixed-test-OTP deployments only). Nothing signs in by itself anymore — every step is a suggestion the user confirms. Auto-OTP sessionStorage machinery deleted.
- **Round 5: the phone's missing Continue-as button = expo-router native double-decode.** Live curl proved authorize forwards login_hint, and the login page rendered correctly in a browser — yet the phone kept showing plain buttons. Root cause found in `expo-router/build/fork/extractPathFromURL.js` (`fromDeepLink`): native deep links rebuild the query from already-decoded searchParams values, turning `%2B` into a literal `+`, which the later `new URL().searchParams` parse decodes as a SPACE — so the app saw `pr2429 test@nustom.com` and the strict `+test@` regex silently dropped it (web is unaffected, which is why browser checks passed). Fix: `lib/deep-link-hints.ts` `testEmailFromHint` normalizes spaces back to `+` (lossless — spaces are impossible in the hint) before validating; both screens use it. Proof: `specs/mobile/preview-deeplink-hints.spec.ts` drives the real RN-web app with the phone's exact corrupted param against the REAL deployed slot (skips without `APP_CONFIG_BASE_URL`; CI's preview e2e lane always sets it) — recommendation card, live OAuth popup, Continue-as button, 424242 prefilled. Passing in 2.4s; video attached to the PR.
