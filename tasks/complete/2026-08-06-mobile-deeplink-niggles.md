---
status: done
size: medium
branch: mobile-deeplink-niggles
base: mobile-preview-deeplink-env (PR #2429)
---

# Niggles: reply-push markdown + preview deep-link UX + auth-hint tests

Follow-ups from field-testing #2422 (reply push notifications) and #2429 (preview QR deep-link hints). Stacked on #2429.

## Status summary

Implementation complete; all local checks green (typecheck, lint, knip, format; os notifications tests, auth tests, mobile specs).

- Done: markdown-flattened push bodies, AppDrawerButton on signed-out screens, always-shown switch screen with Continue + commit message row, auth login_hint e2e + pure-helper unit tests.
- Remaining: CI + review on PR #2433.

## Niggle 1 — push notification shows raw markdown

`**Berlin**` renders literally in the push body. iOS notifications have no inline rich text at all — the bold first line is just how iOS styles the *title*; APNs bodies are always plain — so "respect bold/italics" is impossible. Therefore: strip.

- [x] Add a small `markdownToPlainText` helper in the notifications domain _(checked: annotated-markdown has no text renderer; wrote `markdown-plain-text.ts`)_: bold/italic/strikethrough markers dropped, inline code/backticks unwrapped, `[text](url)` → `text`, heading `#`s and list markers dropped, code fences unwrapped, images → alt text, collapse blank runs
- [x] Apply in `pushBody` (`apps/os/src/domains/notifications/chat-reply-notify-implementation.ts`) BEFORE truncation, so markers don't eat the length budget
- [x] Unit tests next to the producer tests _(18-case table in markdown-plain-text.test.ts + Berlin-with-link producer case)_ (chat-reply-notify.test.ts): the Berlin case, links, fences, truncation-after-strip

## Niggle 2 — preview deep-link UX

1. **Hamburger always reachable.** The drawer only exists inside a project; the signed-out sign-in screen has no path to Build info. Add a persistent menu affordance on the signed-out/sign-in screen — when signed out it can carry just Build info (and the current channel is visible there).
   - [x] Explore the existing drawer and reuse it _(project-drawer.tsx generalized: `AppDrawerButton` renders the same drawer with only Build info when no project; placed on the sign-in screen and the Projects header)_
2. **Scanning a QR for the channel you're already on must still show the "Switch to" screen** (reassurance, not a silent redirect). Today `[channel].tsx` auto-forwards when `current === channel`.
   - [x] Always render the screen; when already on target, the primary button reads "Continue" and just forwards the hints to the sign-in screen _(post-switch relaunch gets the same treatment; spec covers the flow via localStorage-seeded channel override)_
   - [x] Show commit details: `buildInfo` stamps `message` alongside `commit`/`branch` — add the running bundle's commit message (and keep `branch @ sha`) to the card
3. **Auth changes unprotected by tests** (rewrite-proofing the login_hint feature):
   - [x] `apps/auth` e2e (`oauth-code-exchange.e2e.test.ts` lane — plain fetch against a deployed/local auth): authorize request with `login_hint` → assert the signed `/login` redirect Location carries it (protects the `@better-auth/oauth-provider` patch)
   - [x] Extract the login page's hint/otp-guess derivation (`hintedEmail`, `otpGuess` from search + config) into a pure `apps/auth/src/utils/login-hint.ts` with node unit tests _(utils/login-hint.ts + 8 node tests; login.tsx now renders what it derives)_
   - [x] Note: full-UI coverage (Continue-as button → prefilled OTP) already exists in `specs/mobile/preview-deeplink-hints.spec.ts` (preview e2e lane)

## Assumptions

- "Respect bold if we can" — we can't (APNs plain-text bodies), so stripping is the whole move; no config knob.
- Target-channel commit details (pre-switch) would need the EAS API from the device; out of scope — the card shows the *running* bundle's sha + message, which covers the reassurance case after switching.
- Hamburger on signed-in project screens already exists and stays as-is; this only adds reachability from the signed-out flow.

## Implementation notes

(log kept while implementing)

## Late addition

- [x] Remove the floating build-timestamp overlay (bottom of every screen, `_layout.tsx`) — redundant now that Build info is reachable from everywhere via the drawer; `BUILD_TIMESTAMP` export dropped (build-info screen reads `buildInfo.builtAt` directly)
