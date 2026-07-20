---
status: in-progress
size: small
---

# Route Device push tokens through Secrets

**Status summary:** specified and ready for implementation. This deliberately breaking change will replace Device-owned token ciphertext with a Secret path and use JSON-body substitution for Expo egress. Existing enrollments will not migrate and must re-register.

## Outcome

New Device enrollments store Expo push tokens as write-only Secret material pinned to Expo. Device state retains only the Secret path, and notification delivery sends the token through the Secret cell without exposing plaintext to project code.

## Checklist

- [ ] Store each newly enrolled Expo token at a stable device-specific Secret path pinned to `https://exp.host`.
- [ ] Replace Device token ciphertext state/events with the Secret path; do not add migration or legacy compatibility code.
- [ ] Send Expo requests through Secret egress using the opted-in JSON template added by the parent PR.
- [ ] Preserve enrollment authentication, token rotation, revocation, retry/receipt behavior, and safe public projections.
- [ ] Treat project access as the Device authorization boundary; retain `ownerId` only as provenance.
- [ ] Cover enrollment, rotation, revocation, invalid-token handling, and non-disclosure with focused and real-worker tests.
- [ ] Verify typecheck, lint, formatting, tests, preview behavior, and coherent traces without unexplained errors.

## Breaking-change policy

- Devices enrolled before this change may become unusable and must enroll again.
- No processor migration, dual-read, compatibility event, or fallback decryption path is permitted.
- The new state/event contract should be simpler because only the post-change representation exists.

## Stack

- Base branch: `device-push-secret-egress`
- Base PR: #2145
- #2145 itself stacks on mobile PR #2143.

## Implementation log

- 2026-07-20: split from the generic JSON-body Secrets capability at the user's request. Existing project state is explicitly disposable, so migration code would add complexity without product value.
