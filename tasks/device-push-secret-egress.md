---
status: in-progress
size: medium
---

# Route device push credentials through project Secrets

**Status summary:** implementation and local real-worker verification are complete. Controlled egress now supports explicit exact-value JSON substitution, Device enrollment stores Expo tokens in revisioned Secret material at a stable path, and legacy ciphertext migrates once without exposing plaintext. Unit/type/lint and focused real-worker egress/device tests pass; stacked-preview deployment, trace audit, and a physical push remain.

## Outcome

An enrolled device keeps only the path of its Expo push-token Secret. Notification delivery resolves that token at request time through the existing Secret egress boundary, inheriting origin pinning, redirect checks, usage audit, and rotation semantics. Project scripts may request a notification but cannot read the token.

## Secrets JSON substitution

- [x] Add an explicit JSON-template opt-in to project egress; ordinary JSON request bodies must remain untouched. _`x-iterate-secret-template: json` gates all body parsing and is consumed before terminal fetch._
- [x] Parse opted-in JSON bodies and recursively replace only string values that are an exact `getSecret({ path: ... })` or `getSecret({ path: ..., field: ... })` reference. _The async request scanner and substituter traverse object/array values after parsing and re-encode at the Secret DO boundary._
- [x] Never substitute object keys or references embedded in longer strings; reject malformed JSON, unsupported content types, and unresolved references without sending the request. _Focused utility specs cover exactness, `application/json`/`+json`, malformed bodies, unsupported modes, and a 1 MiB template ceiling._
- [x] Consume the internal opt-in marker before vendor egress and preserve the existing secret-origin and redirect policy. _The Secret DO remains the materialization/fetch cell, including origin pins and per-hop redirect checks._
- [x] Retain the current one-secret-path-per-request rule and document the new request shape in the ITX surface/examples. _Updated ADR 0005, the integrations/secrets design, generated ITX docs, and `secret-postman-echo`._
- [x] Add focused tests covering nested objects/arrays, exact-match behavior, structured-secret fields, invalid bodies/content types, marker stripping, and origin confinement. _Unit coverage plus the public real-worker egress test prove the complete route._

## Device push-token integration

- [x] Store each Expo push token as write-only Secret material at a stable device-owned path pinned to `https://exp.host`. _Enrollment creates/updates `/secrets/devices/<id>/expo-push-token`; the Secret cell owns encryption and origin confinement._
- [x] Persist only that Secret path in Device state/events and remove the device-specific ciphertext/decryption path. _New events carry the path and exact Secret update offset; the old device ciphertext type remains solely as migration input._
- [x] Send Expo requests through controlled secret egress with JSON-body substitution rather than direct `fetch` with plaintext token material. _The Expo adapter emits a templated `to` value and Device delegates the request to its Secret DO._
- [x] Preserve authenticated enrollment, token rotation, revocation, retry/receipt behavior, and safe public Device projections. _Credential operations serialize; compare-and-clear at the Secret update offset prevents a stale `DeviceNotRegistered` result from erasing a rotation. Project access, not enrolling-user identity, is the authorization boundary._
- [x] Define a bounded migration for devices enrolled with the previous encrypted-token event shape; do not silently strand or endlessly retry them. _At-head legacy state decrypts once, writes the Secret, and journals an idempotent link event; replay of the linked journal performs no migration._
- [x] Extend processor and real-worker tests to prove rotation uses the latest material and credentials remain undiscoverable. _Processor specs cover migration and stale invalidation; real-worker enrollment rotates and proves neither device nor Secret journals contain Expo plaintext._

## Verification

- [x] Run focused Secrets and Device tests. _51 focused unit specs pass; the complete OS suite passes 2,023 tests plus expected skips/failures._
- [x] Run OS typecheck, lint, formatting, and relevant real-worker e2e. _OS typecheck, root lint/format, and 9 focused e2e tests pass against the local workerd deployment._
- [ ] Deploy the stacked PR to a preview and verify coherent traces plus one physical push without new unexplained errors.

## Assumptions

- This PR is stacked on `mobile-repo-native-markdown` / PR #2143 and must not alter that branch.
- JSON substitution is explicitly enabled per request rather than inferred from `Content-Type` alone.
- Secret references occupy complete JSON string values. Header and URL-path interpolation retain their existing behavior.
- A stable Secret path gives rotation request-time semantics: a queued notification uses the latest token when delivery begins, while an already-issued vendor request may finish with the prior token.

## Implementation log

- 2026-07-20: agreed to reuse the existing project Secrets domain rather than retain parallel Device token encryption. The required general capability is controlled substitution in explicitly marked JSON bodies.
- 2026-07-20: added recursive exact-value JSON substitution, body validation/limits, docs, generated discovery, and a public egress proof. Device tokens now rotate through a stable Secret path with the Secret update offset carried into delivery; conditional material clearing is atomic at that revision, so late invalid-token results cannot erase a newer token.
- 2026-07-20: retained the legacy AES-GCM device envelope only as bounded migration input. An at-head processor writes it into Secrets and appends one idempotent link fact; full replay is side-effect free afterward.
- 2026-07-20: aligned Device authorization with the project trust rule: `DeviceRpcTarget` establishes project access, while `ownerId` remains provenance rather than a second ACL.
