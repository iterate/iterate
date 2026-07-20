---
status: in-progress
size: medium
---

# Route device push credentials through project Secrets

**Status summary:** specified and ready for implementation. This stacked follow-up will extend controlled project egress to substitute exact `getSecret(...)` values inside explicitly opted-in JSON request bodies, then replace the Device domain's bespoke encrypted Expo-token storage and direct vendor fetch with a stable, write-only Secret reference. Tests, generated ITX docs, migration behavior, and preview verification remain.

## Outcome

An enrolled device keeps only the path of its Expo push-token Secret. Notification delivery resolves that token at request time through the existing Secret egress boundary, inheriting origin pinning, redirect checks, usage audit, and rotation semantics. Project scripts may request a notification but cannot read the token.

## Secrets JSON substitution

- [ ] Add an explicit JSON-template opt-in to project egress; ordinary JSON request bodies must remain untouched.
- [ ] Parse opted-in JSON bodies and recursively replace only string values that are an exact `getSecret({ path: ... })` or `getSecret({ path: ..., field: ... })` reference.
- [ ] Never substitute object keys or references embedded in longer strings; reject malformed JSON, unsupported content types, and unresolved references without sending the request.
- [ ] Consume the internal opt-in marker before vendor egress and preserve the existing secret-origin and redirect policy.
- [ ] Retain the current one-secret-path-per-request rule and document the new request shape in the ITX surface/examples.
- [ ] Add focused tests covering nested objects/arrays, exact-match behavior, structured-secret fields, invalid bodies/content types, marker stripping, and origin confinement.

## Device push-token integration

- [ ] Store each Expo push token as write-only Secret material at a stable device-owned path pinned to `https://exp.host`.
- [ ] Persist only that Secret path in Device state/events and remove the device-specific ciphertext/decryption path.
- [ ] Send Expo requests through controlled secret egress with JSON-body substitution rather than direct `fetch` with plaintext token material.
- [ ] Preserve authenticated enrollment, token rotation, revocation, retry/receipt behavior, and safe public Device projections.
- [ ] Define a bounded migration for devices enrolled with the previous encrypted-token event shape; do not silently strand or endlessly retry them.
- [ ] Extend processor and real-worker tests to prove rotation uses the latest material and credentials remain undiscoverable.

## Verification

- [ ] Run focused Secrets and Device tests.
- [ ] Run OS typecheck, lint, formatting, and relevant real-worker e2e.
- [ ] Deploy the stacked PR to a preview and verify coherent traces plus one physical push without new unexplained errors.

## Assumptions

- This PR is stacked on `mobile-repo-native-markdown` / PR #2143 and must not alter that branch.
- JSON substitution is explicitly enabled per request rather than inferred from `Content-Type` alone.
- Secret references occupy complete JSON string values. Header and URL-path interpolation retain their existing behavior.
- A stable Secret path gives rotation request-time semantics: a queued notification uses the latest token when delivery begins, while an already-issued vendor request may finish with the prior token.

## Implementation log

- 2026-07-20: agreed to reuse the existing project Secrets domain rather than retain parallel Device token encryption. The required general capability is controlled substitution in explicitly marked JSON bodies.
