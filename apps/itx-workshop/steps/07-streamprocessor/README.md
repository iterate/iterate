# Step 07 — the context is a durable event log, folded by a real StreamProcessor

**Adds:** durability and automatic delivery. The capability table stops being an
in-memory registry and becomes the **fold of a durable event log**:
`Itx extends StreamProcessor<ItxContract>` (the real `@iterate-com/streams` base
class), hosted in `ItxDO` via `createStreamProcessorHost`, backed by the real
`Stream` Durable Object as the log.

Crucially, the stream **delivers** appended events to the processor on its own:
`ItxDO` appends a `subscription-configured` event pointing the stream at its own
`requestStreamSubscription`, and the Stream DO then pumps every appended batch
into the processor's `ingest`. So an event written by _anyone_ — not just this
context's own `provide` — is folded in automatically.

- `provide` appends a `capability-provided` event; the fold projects it into the
  table; `invoke` resolves over the fold. (Provides also self-ingest so they're
  readable immediately — read-your-writes.)
- Replaying the durable log into a fresh processor rebuilds the identical table
  (the fold is the source of truth) — see the main harness's Step 8/11.

**The failure it buys you out of:** an in-memory registry dies on eviction and
only ever sees its own writes. A folded durable log survives restarts, replays
deterministically, and (via the subscription) stays current with every writer.

**Implementation:** the shared core — `../../itx-contract.ts`,
`../../itx-processor.ts`, and `ItxDO` in `../../server.ts`. This folder is the
intent test + this note; the intent test drives the real `/itx` context and proves
an **external** append reaches the fold purely through subscription delivery.

**Run:** `npm run dev`, then `node --experimental-strip-types steps/07-streamprocessor/intent.test.ts`.
