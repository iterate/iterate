---
status: in-progress
size: medium
branch: mobile-deeplink-niggles
base: mobile-preview-deeplink-env (PR #2429)
---

# Niggles: reply-push markdown + preview deep-link UX + auth-hint tests

Follow-ups from field-testing #2422 (reply push notifications) and #2429 (preview QR deep-link hints). Stacked on #2429.

## Status summary

Spec fleshed out; implementation not started.

## Niggle 1 — push notification shows raw markdown

`**Berlin**` renders literally in the push body. iOS notifications have no inline rich text at all — the bold first line is just how iOS styles the *title*; APNs bodies are always plain — so "respect bold/italics" is impossible. Therefore: strip.

- [ ] Add a small `markdownToPlainText` helper in the notifications domain (or reuse an existing renderer if `packages/iterate/src/annotated-markdown` already has one — check first): bold/italic/strikethrough markers dropped, inline code/backticks unwrapped, `[text](url)` → `text`, heading `#`s and list markers dropped, code fences unwrapped, images → alt text, collapse blank runs
- [ ] Apply in `pushBody` (`apps/os/src/domains/notifications/chat-reply-notify-implementation.ts`) BEFORE truncation, so markers don't eat the length budget
- [ ] Unit tests next to the producer tests (chat-reply-notify.test.ts): the Berlin case, links, fences, truncation-after-strip

## Niggle 2 — preview deep-link UX

1. **Hamburger always reachable.** The drawer only exists inside a project; the signed-out sign-in screen has no path to Build info. Add a persistent menu affordance on the signed-out/sign-in screen — when signed out it can carry just Build info (and the current channel is visible there).
   - [ ] Explore the existing drawer (project screens) and reuse its look; minimal version: hamburger icon on the sign-in screen → Build info
2. **Scanning a QR for the channel you're already on must still show the "Switch to" screen** (reassurance, not a silent redirect). Today `[channel].tsx` auto-forwards when `current === channel`.
   - [ ] Always render the screen; when already on target, the primary button reads "Continue" and just forwards the hints to the sign-in screen (post-switch relaunch gets the same treatment — one extra reassuring tap)
   - [ ] Show commit details: `buildInfo` now stamps `message` alongside `commit`/`branch` — add the running bundle's commit message (and keep `branch @ sha`) to the card
3. **Auth changes unprotected by tests** (rewrite-proofing the login_hint feature):
   - [ ] `apps/auth` e2e (`oauth-code-exchange.e2e.test.ts` lane — plain fetch against a deployed/local auth): authorize request with `login_hint` → assert the signed `/login` redirect Location carries it (protects the `@better-auth/oauth-provider` patch)
   - [ ] Extract the login page's hint/otp-guess derivation (`hintedEmail`, `otpGuess` from search + config) into a pure `apps/auth/src/utils/login-hint.ts` with node unit tests (the `*+test@nustom.com` gate, fixedTestOtpEnabled gating, email vs mode hints)
   - [ ] Note: full-UI coverage (Continue-as button → prefilled OTP) already exists in `specs/mobile/preview-deeplink-hints.spec.ts` (preview e2e lane)

## Assumptions

- "Respect bold if we can" — we can't (APNs plain-text bodies), so stripping is the whole move; no config knob.
- Target-channel commit details (pre-switch) would need the EAS API from the device; out of scope — the card shows the *running* bundle's sha + message, which covers the reassurance case after switching.
- Hamburger on signed-in project screens already exists and stays as-is; this only adds reachability from the signed-out flow.

## Implementation notes

(log kept while implementing)
