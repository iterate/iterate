---
status: complete
size: small
---

# Consolidate approval request body metadata

## Status

Complete. New approval events emit one nullish `body` object; its capped readable content and full-body hash now travel together. Mobile, CLI, JSON/native approvers, and approval signatures consume that shape, with compatibility reads for #2231 events.

## Outcome

Approval events expose one coherent `body` object containing the readable capped content, full-body integrity hash, encoding, truncation state, and original byte length. Older events without the object—or with the pre-follow-up fields—remain readable.

## Checklist

- [x] Define one nullish approval `body` schema with encoding, content, SHA-256, original byte length, and truncation metadata. *The project contract uses one `z.object` with `encoding: z.enum(...)` and `.nullish()`.*
- [x] Stop emitting separate `bodySha256` and `bodyPreview` fields for new approval events. *The Project DO now creates only `body`, with the full hash nested beside its bounded content.*
- [x] Update approval identity, mobile rendering, and event projections to consume the consolidated body. *Approval signing, mobile cards, terminal output, JSON output, and the native macOS dialog read the nested fields.*
- [x] Preserve compatibility with approval events written by #2231 and events predating body inspection. *Compatibility readers accept legacy top-level preview/hash fields and body objects that predate nested `sha256`; approval.v1 bytes remain unchanged.*
- [x] Add focused contract, approval-key, and mobile rendering regression coverage. *Tests cover the schema, legacy/new signature equivalence, capped bodies, and legacy mobile rendering.*
- [x] Run formatting, lint, typecheck, and affected test suites. *Root format/lint/typecheck, all OS/mobile/iterate unit suites, generated-contract checks, and Swift typecheck pass.*

## Implementation log

- Follow-up to review comments on #2231; deliberately separated so the already-green provenance and mobile work could merge.
- The SHA-256 stays inside `body` because the displayed content is capped at 64 KiB while approval.v1 must bind every original byte.
- The canonical signed JSON still names its field `bodySha256`, preserving existing enrolled approver signatures and verification semantics.
