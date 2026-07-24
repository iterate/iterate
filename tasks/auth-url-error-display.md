---
status: in-progress
size: small
---

# Display Auth redirect errors

## Status

The signed-in error notice is complete. Follow-up work is in progress to show
the same error to signed-out users without preserving it after sign-in.

## Problem

Better Auth redirects failed sign-in attempts back to the Auth UI with an
`error` query parameter. The signed-in home currently ignores it, so
`/?error=Sign_up_is_not_available_for_this_email_address` renders the normal
account page with no explanation.

## Decision

Render a persistent destructive notice above the account card when the Auth
home URL contains an error:

- prefer `error_description` when present;
- otherwise turn the `error` code's underscores into spaces;
- accept future error codes without a hard-coded allowlist;
- rely on React text rendering so query data is never interpreted as markup.

The URL remains the source of truth, so refreshes preserve the explanation and
normal visits without an error remain unchanged.

## Checklist

- [x] Add a failing UI-level regression test for the screenshot URL. _A server-rendered component test reproduces the missing notice for the exact error value._
- [x] Render `error_description`, falling back to a humanized `error` code. _The signed-in home validates both search fields and renders a destructive alert._
- [x] Verify arbitrary query text is rendered as text and the no-error state is unchanged. _The regression test covers escaped markup and the empty render._
- [x] Run Auth tests, typecheck, lint, and formatting checks. _All 75 Auth tests pass, including the three new UI cases; Auth typecheck and touched-file lint/format checks pass._
- [x] Verify the error notice against a production-shaped preview. _Auth Preview 2 renders the screenshot error and prefers a supplied `error_description`._
- [x] Update the draft PR with browser proof. _PR #2291 includes the exact preview URL and an inline screenshot._
- [x] Show redirect errors immediately on the public login page. _The protected-route handoff and legacy nested redirects now put the error fields directly on `/login`, which renders the shared notice._
- [x] Remove handled error fields from the post-login destination while preserving its other path, query, and hash. _A pure redirect regression test covers the screenshot URL plus a destination with unrelated query and hash state._
- [ ] Verify both signed-in and signed-out error paths against the preview.

## Implementation notes

- Screenshot repro:
  `/?error=Sign_up_is_not_available_for_this_email_address`
- Better Auth converts OAuth callback failures to underscore-separated `error`
  values and may also supply `error_description`.
- The root cause was the Auth home route having no search validation or
  rendering path for Better Auth's redirect error fields.
- Follow-up review found that a signed-out request to the protected home nests
  its error URL in `/login?redirect=...`; this hides the error until after
  sign-in and then displays stale failure state.
- The original clipboard URL used Preview 14; PR #2291 was assigned Preview 2.
  Verifying the allocated slot avoided mistaking Preview 14's old build for a
  regression in the new route.
