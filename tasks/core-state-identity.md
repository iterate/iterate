---
status: in-progress
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

- [ ] Group the four fields into ONE optional object in
      `core-processor-contract.ts`:
      `identity: z.object({ projectId: nullable, path, streamId, createdAt }).optional()`.
      "Uninitialized" becomes a single honest `!state.identity` truthiness
      check; inside, `projectId` is plainly `string | null`.
- [ ] Bump `CORE_STATE_VERSION` to 32 (checkpoint shape changed). The DO
      discards checkpoints from other reducer versions and rebuilds from the
      event log, so the migration is self-healing.
- [ ] Update the `stream/created` fold in `core-processor.ts` and every
      consumer (stream-durable-object.ts, stream-event-sender.ts, browser
      client mirror, pretty-state UI readers).
- [ ] Delete the three "projectId tri-state" disable comments — the refactor
      makes them unnecessary by construction.
- [ ] Regenerate the itx API types (`pnpm generate:itx-api`) — the state shape
      is part of the public snapshot surface.
- [ ] Update tests asserting the old flat shape.

## Implementation log

(appended as work happens)
