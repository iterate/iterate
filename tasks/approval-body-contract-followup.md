---
status: ready
size: small
---

# Consolidate approval request body metadata

## Status

Starting from merged approval provenance. The follow-up will replace the three overlapping request-body fields with one backwards-compatible body value, then update producers, consumers, and tests.

## Outcome

Approval events expose one coherent `body` object containing the readable capped content, full-body integrity hash, encoding, truncation state, and original byte length. Older events without the object—or with the pre-follow-up fields—remain readable.

## Checklist

- [ ] Define one nullish approval `body` schema with encoding, content, SHA-256, original byte length, and truncation metadata.
- [ ] Stop emitting separate `bodySha256` and `bodyPreview` fields for new approval events.
- [ ] Update approval identity, mobile rendering, and event projections to consume the consolidated body.
- [ ] Preserve compatibility with approval events written by #2231 and events predating body inspection.
- [ ] Add focused contract, approval-key, and mobile rendering regression coverage.
- [ ] Run formatting, lint, typecheck, and affected test suites.

## Implementation log

- Follow-up to review comments on #2231; deliberately separated so the already-green provenance and mobile work could merge.
