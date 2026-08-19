# Deferred refactors — larger layering/design changes, recorded not done

Things that would meaningfully change layering or design. Kept OUT of the fix campaign so each
fix stays small and reviewable. Revisit deliberately.

- **Proofs → harness convergence**: proofs/_.mjs (16 live scripts vs prod) and **tests**/_
  (local harness) overlap heavily. Candidate: demote proofs to a thin deployed-smoke set and
  move their coverage into the deterministic harness lane. Changes what "the board" means.
- **The facet spine density** (LAYERS.md layer 4): the ~200 lines where workerd #6702/#6800/
  #6810 choose the shape. Revisit if workerd ships facet alarms or hibernatable outbound stubs.
- **Dotted client surface (defect 24)**: adding the path-proxy fallback to Itx is a surface
  expansion (reserved-name policy on Itx) — design, not a guard. Parity feature, phase 5.
- **Row chunking (defect 25)**: StreamEventLog gains an event_chunks table — a storage-schema
  change. Well-specified by the apps/os contract but it is new machinery in the log. Phase 5.
- **Breaker enforcement placement (defect 7)**: moving the token count inside the commit
  transaction is a real semantics decision (pre-check vs post-dedupe), not a guard.

- **Props derived from the mount, not stashed in FacetIdentity** (Phase A review): apps/os
  stashes only the immutable coordinate and reads per-processor config live from the committed
  catalog, so config can never go stale. We fold props into stored identity, which forces the
  "props changed → rebuild" branch in all three configure bodies. Deriving props from the mount
  per-op would delete the props field + the rebuild branch — but it needs a new parent door
  (facet reads props from the parent's table), crossing the facet/parent seam. Design change.
