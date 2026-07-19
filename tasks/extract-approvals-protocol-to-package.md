---
state: todo
priority: medium
size: medium
dependsOn: []
tags: [approvals, mobile, iterate-package, consolidation]
---

# Extract the approvals protocol into the iterate package (CLI ↔ mobile dedupe)

`packages/iterate/src/approve-core.ts` (321 LOC) was ported **near-verbatim**
to `apps/mobile/src/lib/approvals.ts` (222 LOC — its own header says so):
`deriveOpenRequests`, `awaitSettlement`, backlog reconciliation, `grant`/
`reject` all exist twice. The only real difference is signing, and it is
already injected (`sign?: () => Promise<{keyId, signature}>`) — the seam
exists; the extraction is mechanical.

## What to do

- Move the pure reduction/settlement protocol into the package (e.g.
  `packages/iterate/src/approvals/protocol.ts`), signing pluggable.
- CLI and mobile import it; both keep their own signers (enclave/software).
- Bonus: this removes one of the two remaining `apps/os` relative imports
  inside the package (`approve-core.ts` → `domains/projects/egress-approvals.ts`)
  — decide whether the egress-approvals types move too or get re-exported.

Distinct from `tasks/mobile-native-capabilities.md` (Secure Enclave hardware
signing) — this is about the duplicated protocol code, not the key storage.

Context: PR #2063's consolidation-sweep findings; `approve-core.test.ts` (13
tests) is the spec and should end up in the package next to the moved code.
