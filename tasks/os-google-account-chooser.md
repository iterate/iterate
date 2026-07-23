---
status: in-progress
size: small
---

# Let signed-out OS users choose a different account

## Status

Specified and ready for implementation. The intended UX is agreed; the failing
relying-party sign-in spec, implementation, and browser proof are still missing.

## Problem

Signing out of `os.iterate.com` correctly clears only the OS session. The
session at `auth.iterate.com` remains, so clicking **Sign in with Google** can
immediately authorize the same Iterate account and return to OS. The user gets
no chance to choose another account.

## Decision

Keep the auth session. When OS starts its Google sign-in flow, require Iterate
Auth to show its account chooser if an auth session already exists:

- continue with the current Iterate account; or
- choose **Log in as someone else**, then use Google's account picker.

Do not globally sign out of Iterate Auth or Google. Email sign-in and OAuth
clients that do not explicitly request account selection must keep their
current behavior.

## Checklist

- [ ] Add a failing public-flow spec proving a Google sign-in request asks the authorization server to select an account.
- [ ] Thread the account-selection request from the OS sign-in button through the shared relying-party client and server.
- [ ] Verify existing login hints and non-forced sign-in callers keep their behavior.
- [ ] Run focused tests, typecheck, lint, and formatting checks for the touched packages.
- [ ] Prove the account chooser flow in a browser against a production-shaped environment.
- [ ] Update the draft PR with the user-visible behavior and proof.

## Implementation notes

- The shared `@iterate-com/auth` relying-party client currently forwards
  `login_hint=google` but sends no OIDC `prompt`, allowing an existing
  authorization-server session to complete without rendering `/login`.
- Prefer the standard OIDC account-selection request over clearing cookies or
  adding client-side session workarounds.
