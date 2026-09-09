> **HISTORY (2026-09-03).** Deferred-refactor notes from the fix campaign; the lanes and layer
> numbers they cite predate the itx-surface rename (proofs became `pnpm e2e`). Kept for the
> reasoning. The surface as built is `docs/itx-surface-as-built.md`.

# Deferred refactors — larger layering/design changes, recorded not done

Things that would meaningfully change layering or design. Kept OUT of the fix campaign so each
fix stays small and reviewable. Revisit deliberately.

- **Proofs → harness convergence**: proofs/_.mjs (16 live scripts vs prod) and **tests**/_
  (local harness) overlap heavily. Candidate: demote proofs to a thin deployed-smoke set and
  move their coverage into the deterministic harness lane. Changes what "the board" means.
- **The facet spine density** (LAYERS.md layer 4): the ~200 lines where workerd #6702/#6800/
  #6810 choose the shape. Revisit if workerd ships facet alarms or hibernatable outbound stubs.
- **Dotted client surface (defect 24)**: LANDED for single-dispatch calls (2026-08-20 — hop in
  core/dotted-path-proxy.ts + opaque unknown-surface stub return; see DEFECTS.md 24). Two
  DEFERRED remnants, both deeper than a surface change: (1) **mid-chain `x.get(id).method()`
  pipelining** — the connections view returns a `pathProxy` (NonPipelinable over Workers RPC);
  needs a genuine hopped RpcTarget + capnweb-pipelining bridged across the /api→DO boundary. This
  is an intended consequence of the "capnweb terminates only at /api" rule; working alternative is
  the `invoke` expression door. (2) **isPathMissMessage miss-grammar** — unifying the capability-
  table REPLAY error vocabulary (server-side, not the surface).
- **Row chunking (defect 25)**: StreamEventLog gains an `event_chunks` table — a storage-schema
  change. Fully specced by the apps/os contract (EVENT_CHUNK_SIZE=512KiB, JS-side split,
  offset-per-event, streaming-TextDecoder reassembly, contiguity check, no group_concat). Owner
  wants this DONE. ~90–130 LOC, one file, on the existing raw-`exec` path. SEPARATE (optional,
  rejected-for-now) question: adopt sqlfu (mmkal's typed-SQLite adapter, already vendored) across
  our SQLite — LOW value for one table today + fights storage-laziness (`migrate()` writes on
  boot); revisit only if the SQLite surface grows.
- **Breaker enforcement placement (defect 7)**: moving the token count inside the commit
  transaction is a real semantics decision (pre-check vs post-dedupe), not a guard.

- **Props derived from the mount, not stashed in FacetIdentity** (Phase A review): apps/os
  stashes only the immutable coordinate and reads per-processor config live from the committed
  catalog, so config can never go stale. We fold props into stored identity, which forces the
  "props changed → rebuild" branch in all three configure bodies. Deriving props from the mount
  per-op would delete the props field + the rebuild branch — but it needs a new parent door
  (facet reads props from the parent's table), crossing the facet/parent seam. Design change.

- **Forwarder: unify onto apps/os's single ownership-token + level-triggered orphan GC** (Phase
  B review): replace the two-signal rev/fresh-deleted scheme with one #deliveryStillMatches-style
  token. Blocked on giving the facet progress store key enumeration (list()) so run() can sweep
  progress records with no active mount. Real layering change.
- **Runner concurrency/gap-repair defects deferred from Phase C (6, 19, 20, 21, 22)**: in-batch
  dedupe double-reduce (event log), nested blockProcessorWhile escaping the hold, at-head stall
  on exact 500-multiples, named ephemerals dropped on a non-contiguous push, deep-payload
  idempotent-retry depth. Each is subtle enough to want its own focused session + soak.

- **Connection close: clean-vs-dirty needs the onRpcBroken error arg (defect 14, 15)**: closing
  the pager with 1011 in onRpcBroken regressed the clean-close test — a client ws.close() fires
  onRpcBroken but is arguably a clean end, so dispose-vs-onRpcBroken does NOT map to clean-vs-
  dirty. The real signal is the close/abort reason capnweb passes to onRpcBroken(cb) (currently
  ignored). Deferred: thread that reason through so the directory files graceful vs ungraceful
  ends correctly; concurrent-same-key reconcile (15) rides the same pending-attach work; in-flight-invoke offline coding (16) needs the same reason signal to tell a transport death from a provider app-error without message-sniffing.
