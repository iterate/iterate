---
status: ready
size: small
---

# Display Auth redirect errors

## Status

Not started. The screenshot repro and expected rendering contract are defined;
implementation, tests, and preview proof remain.

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

- [ ] Add a failing UI-level regression test for the screenshot URL.
- [ ] Render `error_description`, falling back to a humanized `error` code.
- [ ] Verify arbitrary query text is rendered as text and the no-error state is unchanged.
- [ ] Run Auth tests, typecheck, lint, and formatting checks.
- [ ] Verify the error notice against a production-shaped preview.
- [ ] Update the draft PR with browser proof.

## Implementation notes

- Screenshot repro:
  `/?error=Sign_up_is_not_available_for_this_email_address`
- Better Auth converts OAuth callback failures to underscore-separated `error`
  values and may also supply `error_description`.
