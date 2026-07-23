---
status: complete
size: small
---

# Consolidate approval request body metadata

## Status

Complete. Approval events emit one nullish `body` object; its capped readable content and full-body hash travel together. Mobile, CLI, JSON/native approvers, and approval signatures consume only that shape.

## Outcome

Approval events expose one coherent `body` object containing the readable capped content, full-body integrity hash, encoding, truncation state, and original byte length.

## Checklist

- [x] Define one nullish approval `body` schema with encoding, content, SHA-256, original byte length, and truncation metadata. *The project contract uses one `z.object` with `encoding: z.enum(...)` and `.nullish()`.*
- [x] Stop emitting separate `bodySha256` and `bodyPreview` fields for new approval events. *The Project DO now creates only `body`, with the full hash nested beside its bounded content.*
- [x] Update approval identity, mobile rendering, and event projections to consume the consolidated body. *Approval signing, mobile cards, terminal output, JSON output, and the native macOS dialog read the nested fields.*
- [x] Keep consumers direct. *Callers read `body` fields inline, the JSON approver emits the request payload itself, and the terminal renderer builds its few display lines without body helper functions.*
- [x] Remove the split approval-body format rather than carrying a compatibility path. *Consumers accept only the consolidated body object and its required nested SHA-256.*
- [x] Add focused contract, approval-key, and mobile rendering regression coverage. *Tests cover the schema, approval signing, and capped body rendering.*
- [x] Run formatting, lint, typecheck, and affected test suites. *Root format/lint/typecheck, all OS/mobile/iterate unit suites, generated-contract checks, and Swift typecheck pass.*

## Implementation log

- Follow-up to review comments on #2231; deliberately separated so the already-green provenance and mobile work could merge.
- The SHA-256 stays inside `body` because the displayed content is capped at 64 KiB while approval.v1 must bind every original byte.
- The canonical signed JSON still names its field `bodySha256`; its value comes directly from `body.sha256`.
- Review cleanup removed the redundant body hash/preview helpers and the field-by-field JSON projection.
