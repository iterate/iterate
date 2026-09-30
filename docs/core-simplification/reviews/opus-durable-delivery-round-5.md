# Independent implementation review: durable delivery — round 5

**Model:** Claude Opus 5.5 xhigh. It ran in restricted mode with Read only and
strict MCP configuration. Raw JSON and the full review are private at
`/tmp/core-simplification-opus/round-5.json` and
`/tmp/core-simplification-opus/round-5-result.md`.

## Release decision: no-go

This was an in-flight snapshot. The following source-verified blockers must be
resolved and independently re-reviewed before merge or deployment.

1. `subscription-delivery.ts` references an undeclared private delivery budget,
   making the Worker bundle fail to load. The context Durable Object also stubs
   `deliveriesQueuedFor`, removing the barrier processors use before a read.
2. Terminal receipts are appended through the normal control-event boundary,
   which refuses them as stream records. Ordered rows retry terminal reporting
   forever; fan-out stops on its first terminal item. Append them as stream
   records, include resume generation in halted idempotency, and treat a stale
   terminal acknowledgement as settled.
3. `row.consumes || []` changes an omitted consume filter from every event to
   no events, then advances the cursor past them. Use `row.consumes ?? ["*"]`.
4. A halt removes the runner/cursor; resume then reconstructs at configuration
   offset, ignores ordered seeks and cannot re-admit a selected fan-out offset.
   Keep halted runner state, apply resume inside its serialized drain, and
   compare state after every await before writing a terminal/attempt result.
5. The bridge sends any durable `processEventBatch` target through
   `callFacetAsPlatform`, bypassing the facet's public-method wall. Reject that
   route; a durable subscription must not gain platform-only facet authority.
6. Live attachments bypass platform-only config, jail and fence admission.
   A project member can temporarily provide `itx.config` at root and shadow
   publication. Preflight every caller and fence attach/detach shadows. Loaded
   code currently sends an empty attachment, making its provides/subscribes
   silently ineffective.
7. Ordered delivery duplicates ephemerals via both direct push and ring read;
   it can also mistake an offset reused after reset for the old ephemeral. Keep
   ring ephemerals out of ordered drain, flag the one-event ephemeral bridge
   path, push metadata only, restore bounded push memory and bound fan-out
   calls.
8. Refusing pre-v18 state in the Stream constructor bricks the context,
   including `destroy` and sweep. Record a refusal for normal entry points but
   leave destroy/identity/sweep able to recreate it.

The SDK runner does move cursor, pending range, retry ladder and fan-out
records out of the old core loop. It does not yet remove all durable plumbing:
core still owns configuration, receipts, authority bridge, push, list merge and
webhook policy. Keep core durable delivery until the parity cases above pass.
