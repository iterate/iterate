# Independent implementation review — round 4

**Model:** Claude Opus 5.5 xhigh. Raw JSON and complete response are private at
`/tmp/core-simplification-opus/round-4.json` and
`/tmp/core-simplification-opus/round-4-result.md`.

## Release decision

Do not merge or deploy the reviewed checkpoint. Re-run this review after the
concurrent edits settle.

1. **Old state is silently damaged.** Version 18 re-reduces from zero, but
   `reduceCoreEventBatch` reports and skips a missing-delivery error. Existing
   config/platform birth rows and processor rows vanish rather than rejecting
   the context for recreation. Pinned matches and hole targets also survive as
   rows with changed meaning. Gate the whole context/reduce or recreate state;
   never skip individual old control rows.
2. **Loaded-code lends now dangle.** `provide(stub)` and callback subscribe
   still write durable rows, but presence cleanup is now a no-op. On disconnect
   they leave a permanent `RPC_STUB_OFFLINE` shadow and live row. Restore
   compare-and-set cleanup or turn loaded-code lends into governed attachments.
3. **Live attachments bypass authority and fences.** Pager attach does not run
   platform-only config/jail checks or take the revocation fence. A member can
   provide `itx.config` at root and shadow publication while connected; stale
   snapshots can keep an old shadow for the 5-second TTL. Apply the same
   admission and fence semantics on attach/detach shadows.
4. **The SDK runner is not ready to replace core delivery.** Its useful parts
   are correct: durable pending range before call, stable delivery key, bounded
   fanout and no emitted success event. But core still delivers the same durable
   row, so wiring the bridge duplicates effects. Its in-progress host retries a
   terminal bridge failure every second, blocks fanout behind a terminal item,
   loses runners after restart, and bypasses `consumes` for ephemerals. The
   published package export also lacks a tsdown entry.

The review found no fresh-row defect in the reduced no-hole recipe semantics:
fixed calls precede caller arguments; a final fixed call followed by caller
arguments invokes its returned value; trailing steps remain; and property-name
longest match is total. The risk is retained old rows, not this fresh-state
behavior.
