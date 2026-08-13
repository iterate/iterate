---
status: done
size: small
base: preview-one-click-login (#2485)
---

# Mobile one-tap test sign-in

## Status summary

Implemented, awaiting preview CI (the rewritten mobile spec runs in the
preview lane). Stacked on [#2485](https://github.com/iterate/iterate/pull/2485).

## Ask

Mobile preview sign-in took 7 taps. Decision from discussion: keep the
consent screen ("the mobile app is effectively a userland app/client") and
the unavoidable native ASWebAuthenticationSession dialog; kill everything
else. 7 → 3 (or "2 that count": Continue + Allow access).

| Old tap | Fate | How |
| --- | --- | --- |
| 1 Continue | stays | — |
| 2 native dialog | stays | iOS requirement of ASWebAuthenticationSession |
| 3 Continue with email | gone | browser routed through `/test-login?email=…&return_to=<authorize URL>` |
| 4 OTP submit | gone | same |
| 5 project-access Accept | gone | page auto-selects all + continues for test users (fixed-OTP deployments only) |
| 6 consent Authorize | **kept deliberately** | mobile stays an untrusted dynamically-registered client |
| 7 in-app project picker | gone | auto-open when the account has exactly one project (general UX win, not test-only) |

## Checklist

- [x] mobile: route test-identity sign-ins through `/test-login` — _apps/mobile/src/lib/auth.ts: `makeAuthUrlAsync` + `promptAsync(discovery, {url})`; gated on the hint matching `+test@nustom.com`; fallback (stale deployment without the endpoint) is the old prefilled login page since login_hint still rides the authorize URL_
- [x] auth: project-access auto-continue for test users — _apps/auth/src/routes/_auth/project-access.tsx: gated on build-time `fixedTestOtpEnabled` + `shouldUseTestOtp(session email)` + OAuth flow with projects; selects every project, stores selection, `oauth2.continue`; holds the loading skeleton while in flight; falls back to the interactive page on error_
- [x] mobile: auto-open single project after sign-in — _apps/mobile/src/app/index.tsx login mutation: list projects post-signin, exactly one → backfill + setLastProject + straight to `/project/[projectId]`_
- [x] spec: pin the new flow — _specs/mobile/expected-backend-signin.spec.ts: popup's first interactive page is consent ("Allow Iterate (iOS)?"), Allow access → app lands on the project chat screen ("New chat"), no login/OTP/selection/picker anywhere_

## Implementation log

- Misha's phone test exposed two QR-flow gaps (the QR confirm screen has its
  own sign-in path, separate from the sign-in screen): its `applyPlan`
  landed on the boot path with no `autoOpen`, so the picker still demanded a
  tap; and the post-switch re-entry waited for a second "Continue" even
  though the Switch tap already said everything. Fixed: `applyPlan`
  navigates to the picker with `autoOpen` for sign-in plans, and the Switch
  tap persists a one-shot marker (AsyncStorage — the reload wipes JS state)
  that the re-opened screen consumes to continue by itself once freshness
  and phone-state settle. Bare rescans of the current channel set no marker
  and keep the reassurance screen, so the untick affordance and existing
  specs stay intact. QR flow is now: Switch → native dialog → Allow access.

- expo-auth-session supports the wrap cleanly: `AuthRequest.makeAuthUrlAsync`
  builds the real authorize URL (PKCE intact), `promptAsync(discovery, {url})`
  opens the wrapper instead. `/test-login` already accepts same-origin
  absolute `return_to` (the authorize endpoint is on the auth origin), so no
  endpoint changes were needed.
- project-access auto-continue uses a gated `useQuery` (no useEffect) that
  performs the same store-selection + continue the manual button does, and
  never resolves (redirect keeps it pending) — mirroring the page's
  `redirectAndStayPending` convention.
- Kept the protocol shape identical for test users: selection row →
  consentReferenceId narrowing → project-scoped token. Only the tap is gone.
- Auto-open single project is deliberately NOT test-gated: a one-item picker
  is a pointless tap for real users too. The picker remains reachable (Back,
  and multi-project accounts land on it as before).
- First CI round: four older mobile specs still tapped "Continue" on
  project-access and the project in the picker — removed both (that's the
  feature). Auto-open initially lived in the sign-in mutation with a single
  attempt; the first project list rides a cold itx WebSocket (~20-30s on
  preview slots) so it sometimes fell back to the picker. Moved it into the
  picker's own retrying query, keyed by an `autoOpen` param only the sign-in
  navigation sets — deterministic, and Back-to-picker never auto-bounces.
  Verified against preview-5 locally: 8 passed / 1 skipped, approvals green.
