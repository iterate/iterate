---
status: complete
size: small
---

# Let signed-out OS users choose a different account

## Status

Both OS sign-in methods now offer account selection, and the chooser shows all
alternatives on one screen. Local checks and preview browser proof pass.

## Problem

Signing out of `os.iterate.com` correctly clears only the OS session. The
session at `auth.iterate.com` remains, so clicking **Sign in with Google** can
immediately authorize the same Iterate account and return to OS. The user gets
no chance to choose another account.

## Decision

Keep the auth session. When OS starts either sign-in flow, require Iterate Auth
to show its account chooser if an auth session already exists:

- continue with the current Iterate account; or
- continue with email; or
- continue with Google and use Google's account picker.

Show those alternatives directly below an **or** divider, with no “Current”
badge or reveal step. Do not globally sign out of Iterate Auth or Google.
OAuth clients that do not explicitly request account selection must keep their
current behavior.

## Checklist

- [x] Add a failing public-flow spec proving a Google sign-in request asks the authorization server to select an account. _Covered by the shared client and relying-party redirect specs._
- [x] Thread the account-selection request from the OS sign-in button through the shared relying-party client and server. _OS sends the standard OIDC `prompt=select_account`; Auth renders its existing `/login` chooser._
- [x] Verify existing login hints and non-forced sign-in callers keep their behavior. _The server forwards only the supported one-shot prompt and Auth's chooser hook otherwise returns false._
- [x] Run focused tests, typecheck, lint, and formatting checks for the touched packages. _Auth's 72 tests, Auth/OS typechecks, and touched-file lint/format checks pass._
- [x] Prove the account chooser flow in a browser against a production-shaped environment. _Preview 14 showed the current Auth account and “Log in as someone else”; continuing did not repeat the chooser._
- [x] Update the draft PR with the user-visible behavior and proof. _PR #2281 includes the preview URLs, verification notes, and an inline chooser screenshot._
- [x] Require the same account-selection opportunity for OS email sign-in. _Both OS method buttons send the one-shot `select_account` prompt._
- [x] Remove the “Current” badge from account rows. _The account's actions already convey which session is active._
- [x] Show the email and Google alternatives directly below an “or” divider without an extra reveal step. _The chooser has no reveal state or “Log in as someone else” button._
- [x] Re-run checks and replace the preview browser proof. _The full monorepo suite passes after merging current main; Preview 14 verifies the final one-screen email and Google chooser, and PR #2281 contains the updated screenshot._

## Implementation notes

- The shared `@iterate-com/auth` relying-party client currently forwards
  `login_hint=google` but sends no OIDC `prompt`, allowing an existing
  authorization-server session to complete without rendering `/login`.
- Prefer the standard OIDC account-selection request over clearing cookies or
  adding client-side session workarounds.
- The chooser prompt is removed when `/login` resumes the signed authorization
  query. This keeps account selection one-shot and prevents both "continue"
  and Google reauthentication from returning to the chooser.
- Preview review found that OS's email button did not send the prompt, so an
  existing Auth session could still silently authorize its Google identity.
- The account chooser uses its own transient `account_chooser_method` search
  key so OS's upstream `login_hint=email` does not hide either alternative on
  entry. The key is removed before the authorization redirect resumes.
