# Opus review: subscriptions private bridge (round 6)

**Review method.** Claude Opus 5.5 xhigh reviewed the dirty source snapshot read-only. The raw response is retained at `/tmp/core-simplification-opus/round-6.json`; its model usage records canonical model `claude-opus-5-5`, 47,481 thinking tokens, and no web searches. Prompt: `/tmp/core-simplification-opus/round-6-prompt.md`.

## Verdict

**Conditionally accept a direct, private event handoff.** Once the subscriptions runner is actually reserved and its native channel cannot be redirected by a context rule, the host's second log read adds no untrusted-boundary protection: an untrusted loaded worker cannot mint the entrypoint props or reach the method through `publicMethods`. The bridge should derive the caller cause and delivery hash itself, retain current-row fences before and after target resolution, and accept the fresh source page from the runner. This removes duplicate reconstruction, including the ephemeral ring lookup and 16-page loop.

This is only a private first-party contract. The current `platform` prop is not an authentication mechanism among platform code: every first-party facet has the worker's `ctx.exports` and can mint one. That is acceptable after the entrypoint is removed from the public-shaped service and the caller set is explicitly platform code. It does not authorize dynamically loaded code.

## Findings

1. **Reserve the subscriptions facet before passing event bodies.** It is currently a first-party facet with ordinary placement. A user can configure or target `subscriptions` through the normal processor/facet surfaces. That makes `processEventBatch(events, range)` reachable without its required rows argument and lets `processors.disable("subscriptions")` destroy cursor storage. Reserve its name consistently in `facets.get`, processor enable/disable/claim, abort, and hosting-target conversion; do not allow the generic `FacetHandle + processEventBatch` platform route to name it.

2. **Pin reads, claims, and bridge calls to the context DO.** The subscriptions facet currently uses `getItx().readEvents` and `getItx().processors.claim`, which resolve through owner-writable rewrite rules. The existing bridge re-read only protects body provenance, not cursor progress: a rewritten read can still return an empty page with an advanced scanned offset. Use the native `ITERATE_CONTEXT.getByName(props.iterateContextName)` channel for the source read, claim, and private bridge. This is a kernel-owned path and cannot be redirected or jailed by a context configuration. A weaker alternative is `itx.builtins.*`, but direct native calls make the ownership boundary clear.

3. **Delete the entrypoint bridge methods and subscription props after the direct native handoff.** The dynamically loaded worker's ITX lacks `platform`, and its `ctx.exports` are its own module's, so it cannot reach the bridge. First-party facets can otherwise mint arbitrary platform props, and can already call the DO directly. A special entrypoint method therefore adds a hop and a misleading guard. Keep the actual private DO method inaccessible from expression dispatch; pass the row identity in the native call.

4. **The main latency waste is repeated facet-to-context calls, not local SQLite re-reading.** One ordered batch currently performs claims before and after work, reads to admit, reads again to deliver, invokes, then reads again to discover head. The runner receives every commit and rewrites configuration even when the row consumes none. Reuse the admission page for the first attempt, reread only a persisted pending range after restart/retry, omit the final head read, and start a drain only for a consumed event or due wake. Persist facet configuration only if it changed. The direct body handoff then removes the bridge reconstruction, but it should not be presented as the sole hop reduction.

5. **Reuse claim lifecycle mechanics privately.** The facet's manual `#runInBackground` and `#syncClaim` await and issue unsynchronised claims around every task. `ProcessorEngine` already serializes claims, holds one while work is in flight, and contains revive/death behavior. Extract only that private helper (including an effective-earliest-wake input), use it in both places, and avoid hosting an engine per durable row. This preserves stream processor authoring and client APIs.

6. **Put delivery single-flight beside target invocation.** Aborting the facet at a deadline does not cancel target work already running in the context DO. A revived facet may retry while that target still executes, and an abort discards all rows' in-memory state. Maintain a small DO-local in-flight guard keyed by row generation and resume stamp; reject an overlapping attempt as retryable. The guard dies with the same incarnation as target work. This is a private boundary and lets the SDK delete its facet-abort hook.

7. **Extend the row fence to resume and halt state.** The delivery bridge currently fences only configured offset and durable mode; terminal recording also verifies the resume stamp. The direct handoff must send `resumeAtOffset`, reject a halted row, and fence `(configuredAtOffset, delivery, !halted, resumed?.atOffset)` both before target resolution and immediately before the call. This ensures reconfiguration or resume cannot execute a stale target.

## Direct bridge contract

Accept `{ name, configuredAtOffset, resumeAtOffset, range, events }` over the private native channel. The bridge performs only linear structural validation:

- events are non-empty, one page or less, strictly increasing, and lie in `(range.after, range.through]`;
- each belongs to this context and matches the row's `consumes`;
- durable delivery contains no ephemerals and does not exceed the durable mark;
- an ephemeral handoff has exactly one event, with `through === after + 1 === event.offset`;
- the current row fence holds before resolution and after it;
- the DO-local single-flight guard admits the attempt.

It then derives cause and fan-out hash exactly as before, resolves the normal target, invokes it, and releases sessions. No event body is persisted in facet KV. A retry rereads its persisted range from the context's private read, which is the durable proof.

## Required checks

- Reserve the facet name across all ordinary public surfaces and show durable cursors survive rejected attempts.
- Show user rewrite rules, provides, masks, and jailed contexts cannot alter subscriptions source bodies, cursor progress, claims, or bridge calls.
- Show a loaded worker cannot call the former bridge service.
- Cover every direct-bridge structural check, halted/resumed/reconfigured races, and an overlapping attempt.
- Prove a hung target does not create an overlapping duplicate and does not interrupt other rows.
- Measure a caught-up relevant commit, unrelated commits, and ephemeral-only commits. The target is one facet-to-context call for the caught-up ordered path and no parent writes/claims for unrelated ephemeral traffic.
- Drive the facet's lifecycle through the same restart/claim scenarios used by `ProcessorEngine`.

The source-anchored full Opus response is preserved in the raw JSON above.
