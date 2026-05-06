---
state: open
priority: medium
size: medium
dependsOn: []
---

# Stream Durable Object hardening

Follow-up from the stream processor refactor and Cloudflare Durable Object critique.

`apps/events/src/durable-objects/stream.ts` is intentionally back to one auditable lifecycle file, with real processor implementations split into their own modules. The remaining questions are architectural enough that they should not be guessed in a cleanup pass.

## Risks to resolve

- Durable Object identity now derives from `projectId` + stream path in the shared stream helpers. Keep future stream identity work on stable IDs, not mutable slugs.
- D1 object cataloging now uses the existing `withD1ObjectCatalog()` mixin through the shared `StreamDurableObject` lifecycle shape.
- There is no current `withKeepAlive()` mixin despite earlier design discussion. `packages/shared/src/durable-object-utils/README.md` describes `keepAliveWhile({ promise })` as future work. Add it deliberately before using opaque long-running promises as a liveness primitive.
- Constructor startup currently does more than local storage hydration under `blockConcurrencyWhile()`: it reconnects dynamic workers and appends a wake-up event. Cloudflare's Durable Object guidance prefers keeping constructor gates fast and local.
- Post-commit `afterAppend` work is detached and caught. That is probably acceptable for subscriber delivery, but not for correctness-critical derived events unless we persist retryable work or track a cursor.
- Builtin `afterAppend` ordering is subtle because async functions run synchronously until their first `await`; a processor can append a derived event before later processors have observed the source event.
- Scheduling moved out of `apps/events` into the shared stream processor package. The follow-up is deciding which runner should host it, not preserving the old built-in scheduler code path.
- `stream()` uses in-memory `ReadableStream` controllers. This is fine for short-lived pull/live readers, but production-grade browser fanout may eventually need hibernatable WebSockets.
- `reduced_state` parse failure is still not real recovery. See `apps/events/tasks/rebuild-stream-state-on-parse-error.md`.

## Useful first-party sources

- Cloudflare Durable Object rules: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Durable Object ReadableStream example: https://developers.cloudflare.com/durable-objects/examples/readable-stream/
- Kenton Varda, Durable Objects: Easy, Fast, Correct: Choose three: https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/
- Kenton Varda, SQLite in Durable Objects: https://blog.cloudflare.com/sqlite-in-durable-objects/
