---
status: done, pending review
size: medium
base: simple-truthiness-check (#2491)
---

# Kill the stream coreState projectId tri-state

Review follow-up from #2491. Stream core state declares four independently
optional identity fields:

```ts
projectId: z.string().trim().min(1).nullable().optional(),
path: z.string().trim().min(1).optional(),
streamId: z.uuid().optional(),
createdAt: z.string().optional(),
```

`undefined` means "stream/created not folded yet", `projectId: null` means
"the GLOBAL namespace". That tri-state is exactly the footgun class the
simple-truthiness-check sweep tripped over (a `!state.projectId` rewrite made
every global stream look forever-uninitialized), and it forced three reasoned
oxlint-disable lines in stream-event-sender.ts.

## Plan

- [x] Group the four fields into ONE optional object in
      `core-processor-contract.ts`:
      `identity: z.object({ projectId: nullable, path, streamId, createdAt }).optional()`.
      "Uninitialized" becomes a single honest `!state.identity` truthiness
      check; inside, `projectId` is plainly `string | null`.
- [x] Bump `CORE_STATE_VERSION` to 32 (checkpoint shape changed). The DO
      discards checkpoints from other reducer versions and rebuilds from the
      event log, so the migration is self-healing.
- [x] Update the `stream/created` fold in `core-processor.ts` and every
      consumer (stream-durable-object.ts, stream-event-sender.ts, browser
      client mirror, pretty-state UI readers).
- [x] Delete the three "projectId tri-state" disable comments — the refactor
      makes them unnecessary by construction.
- [x] Regenerate the itx API types (`pnpm generate:itx-api`) — the state shape
      is part of the public snapshot surface.
- [x] Update tests asserting the old flat shape.

## Implementation log

- Compiler-driven: schema + fold changed first, tsc enumerated all 45
  consumer errors across stream-durable-object, stream-event-sender,
  core-processor, the streams-example e2e cast, and test fixtures.
- The three disable-comment doors became single `!state.identity` checks —
  the wake door, the subscription-delivery door, and the batch door; the
  webhook lane and diagnostics read identity fields through the narrowed
  object (several `state.streamId!` bangs in e2e tests disappeared too).
- Browser client mirror (`parseBrowserCoreProcessorState`) parses the nested
  identity and flattens for the local DB's two-field comparison; pretty-state
  UI reads `core.identity` via `readRuntimeRecord`.
- Untyped seams found by tests, not tsc: test fixtures feeding flat identity
  keys through `stateSchema.parse` (zod silently strips unknown keys), and a
  checkpoint fixture overriding flat `streamId` that the new schema ignored.
- `pnpm generate:itx-api` refreshed the public snapshot type.
- Review follow-up ("no scattered runtime `?.` checks"): added exported
  `bornStreamIdentity(state)` — check once at the boundary, flat reads
  after. Zero `identity?.`/`identity!.` remain; the only conditional
  reads left are boundaries where unborn is a real case (the two
  append-if-streamId lifetime fences, checkpoint validation, diagnostics
  spread, self-subscribe guard, expectedStreamId compare), each narrowing
  once into a local.
