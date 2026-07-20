---
status: in-progress
size: small
---

# Route Device push tokens through Secrets

**Status summary:** implementation and local verification are complete. Device-owned ciphertext and its crypto module are replaced by a Secret path, and Expo delivery uses JSON-body substitution. Existing enrollments deliberately do not migrate and must re-register; preview and trace verification remain.

## Outcome

New Device enrollments store Expo push tokens as write-only Secret material pinned to Expo. Device state retains only the Secret path, and notification delivery sends the token through the Secret cell without exposing plaintext to project code.

## Checklist

- [x] Store each newly enrolled Expo token at a stable device-specific Secret path pinned to `https://exp.host`. _Enrollment creates or updates `/secrets/devices/<deviceId>/expo-push-token` through the Secret Durable Object._
- [x] Replace Device token ciphertext state/events with the Secret path; do not add migration or legacy compatibility code. _The contract has one Secret-backed representation; the obsolete crypto module and its test are deleted._
- [x] Send Expo requests through Secret egress using the opted-in JSON template added by the parent PR. _The Expo adapter emits an exact `getSecret(...)` value and Device delegates the request to that Secret cell._
- [x] Preserve enrollment authentication, token rotation, revocation, retry/receipt behavior, and safe public projections. _Credential writes are serialized and carry the exact Secret revision so stale invalid-token results cannot clear a newer rotation._
- [x] Treat project access as the Device authorization boundary; retain `ownerId` only as provenance. _The RPC target establishes project access; Device mutation methods no longer add an enrolling-owner ACL._
- [x] Cover enrollment, rotation, revocation, invalid-token handling, and non-disclosure with focused and real-worker tests. _52 focused specs pass; the 9-test real-worker egress/device run proves public enrollment, rotation, request append, and journal non-disclosure._
- [ ] Verify typecheck, lint, formatting, tests, preview behavior, and coherent traces without unexplained errors. _Typecheck, lint, format, focused unit tests, and local real-worker tests pass; preview evidence remains._

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
- 2026-07-20: implemented the single Secret-backed state/event contract, removed Device crypto entirely, retained revision-safe invalidation, and passed focused unit plus local real-worker verification.
