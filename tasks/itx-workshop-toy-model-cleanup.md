---
state: done
priority: high
size: small
tags: [itx, workshop, dx]
---

# Shrink the itx public API surface in the workshop toy model

The original sprawling cleanup was mostly noise. The real intent was a couple of
small simplifications to the itx public API surface, so the workshop reads as the
minimal kernel it is.

## What changed

- **Dropped `list()`.** `describe()` is now the single read verb. It returns the
  capability paths _plus_ each one's `kind`, `instructions`, and `types`, so a
  separate names-only verb was redundant. Internal `listCapabilities()` is gone;
  anywhere that needed names uses `Object.keys(await itx.describe())`.
- **`describe()` climbs the chain.** It merges this context's own provides +
  built-ins with the parent's `describe()` recursively up to the global root,
  child shadowing parent (same resolution order as `invoke`). Returns a flat data
  structure for now — nicer formatting/provenance can layer on later.
- **Dropped `capability-disconnected`.** It was declared in the contract but never
  appended or folded. A live provider going away is just: the durable row still
  shows in `describe()` (`kind: "live"`), `invoke` fails because the in-memory
  bridge has no stub, and you `revokeCapability` to remove the row. No special
  event.

The served wire surface is now: `provideCapability`, `revokeCapability`,
`invoke`, `describe` (+ the `rebuildFromLog` / `appendToStream` proof hooks the
harness uses — left as labelled instrumentation, factor out later).

## Explicitly NOT done

The original task's vocabulary sweep (OpenAPI/MCP/loopback/env-binding/DO-namespace
"target kinds", per-README term alignment) was deemed not worth it. Only doc spots
that mentioned `list` or `capability-disconnected` were synced.

## Verification

- `pnpm --dir apps/itx-workshop test` (model checks) green.
- `npm run e2e` 9/9 (replay still rebuilds the same table via `describe` keys).
- Step intent tests 07 / 08 / 11 / 12 / 13 green; oxlint clean.
- `rg "capability-disconnected|listCapabilities|\.list\(\)" apps/itx-workshop`
  returns only the unrelated `slack.users.list` / `projects.list` / step-04
  `RegistryDO.list` hits.
