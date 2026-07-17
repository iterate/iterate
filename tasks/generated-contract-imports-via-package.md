---
state: todo
priority: low
size: small
dependsOn: []
tags: [itx, contract, mobile, streams-example-app, iterate-package]
---

# Import the generated itx contract from the package, not by relative path

`apps/mobile` (10 files) imports types from `apps/os/src/itx-api.generated.ts`
via deep relative paths (`../../../os/src/…`). The identical file ships in the
package (`packages/iterate/src/itx-api.generated.ts`, byte-equality
test-enforced) and is exported from `iterate/sdk`, `iterate/client`, and
`iterate/node`.

**2026-07-17: the streams-example-app half is DONE** (its five `~`-alias sites
now import `iterate/sdk`). What remains is the mobile half — fold it into
`tasks/mobile-on-shared-itx-client.md`'s PR rather than doing it standalone
(Metro exports-resolution gets verified there anyway).

Re-point the type imports at the package (add the workspace dep where
missing). Zero runtime change — these are type-only — but it removes the last
cross-app reach-ins and makes the package the one public door to the contract.

Follow-on question (separate decision): should the generator live in the
package and apps/os consume it, inverting today's emit-a-copy flow?

Context: PR #2063 (which did this for everything else).
