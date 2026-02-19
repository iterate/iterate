---
state: in-progress
priority: medium
size: medium
dependsOn: []
---

# Outbox Event Lineage Tracing

Track causal relationships between outbox events so we can answer "show me everything that happened for machineId X" with a single query.

## Problem

`getLatestMachineEvents` returns only the _most recent_ event per machine. `getMachinePendingConsumers` is a separate query. No way to see the full causal chain (event A → consumer B → event C → ...). The frontend gets `lastEvent` + `pendingConsumers` but can't render a timeline or derive state properly.

## Design

### 1. Schema: `context` column on `outbox_event`

```sql
ALTER TABLE outbox_event ADD COLUMN context jsonb NOT NULL DEFAULT '{}';
```

```ts
{
  causedBy?: {
    eventId: number;        // parent outbox_event.id
    consumerName: string;   // consumer that was running
    jobId: number | string; // pgmq msg_id of the consumer job
  }
}
```

Parent pointer only — reconstruct full tree from pointers. Events emitted outside a consumer (e.g. `reportStatus` RPC, `createMachineForProject`) have `context = {}` — root events with no parent.

### 2. AsyncLocalStorage in pgmq-lib.ts

`nodejs_compat` is enabled on the worker so `AsyncLocalStorage` from `node:async_hooks` works.

```ts
import { AsyncLocalStorage } from "node:async_hooks";

const outboxALS = new AsyncLocalStorage<{
  eventId: number;
  consumerName: string;
  jobId: number | string;
}>();
```

- `processQueue`: wrap each handler call in `outboxALS.run({ eventId: job.message.event_id, consumerName: job.message.consumer_name, jobId: job.msg_id }, () => handler(...))`
- `enqueue`: read `outboxALS.getStore()`, write into `context` column on the INSERT

~10 lines of real code.

### 3. Query helper: `getEventsRelatedTo(db, { key, value })`

Single query returning all events + consumer jobs for a correlation key:

```sql
WITH matched_events AS (
  SELECT * FROM outbox_event
  WHERE payload->>$1 = $2
),
all_consumers AS (
  SELECT msg_id, enqueued_at, vt, read_ct, message
  FROM pgmq.q_consumer_job_queue
  UNION ALL
  SELECT msg_id, enqueued_at, vt, read_ct, message
  FROM pgmq.a_consumer_job_queue
),
matched_consumers AS (
  SELECT ac.* FROM all_consumers ac
  JOIN matched_events me ON (ac.message->>'event_id')::bigint = me.id
)
SELECT
  me.id, me.name, me.payload, me.context, me.created_at,
  coalesce(
    (SELECT json_agg(json_build_object(
      'msg_id', mc.msg_id, 'enqueued_at', mc.enqueued_at,
      'vt', mc.vt, 'read_ct', mc.read_ct, 'message', mc.message
    ) ORDER BY mc.msg_id)
    FROM matched_consumers mc
    WHERE (mc.message->>'event_id')::bigint = me.id),
    '[]'::json
  ) AS consumers
FROM matched_events me
ORDER BY me.id
```

The `context.causedBy` fields let the UI draw edges in the causal graph.

### 4. Admin tRPC endpoint

```ts
admin.outbox.relatedEvents
  .input(z.object({ key: z.string(), value: z.string() }))
  .query(/* calls getEventsRelatedTo */);
```

### 5. Admin UI: Timeline panel

On `/admin/outbox`:

- Click any payload field (e.g. `machineId`) → opens timeline view
- Direct URL: `/admin/outbox?related=machineId:abc123`
- Events in chronological order, indented by causal chain (`context.causedBy`)
- Consumer jobs with status dots per event

### 6. Machine router integration

Replace `getLatestMachineEvents()` + `getMachinePendingConsumers()` with single `getEventsRelatedTo` call. Frontend gets full timeline — basis of a real reducer.

## Implementation order

1. Migration (add `context` column)
2. ALS wiring in `pgmq-lib.ts` (processQueue + enqueue)
3. `getEventsRelatedTo` helper in `machine-metadata.ts` or new file
4. Admin tRPC endpoint
5. Admin UI timeline panel
6. Machine router integration (replace two helpers)

## Not in scope (future)

- "Future" consumer rendering (derive unresolved steps from consumer registry)
- Full state machine visualization
- Real frontend reducer from timeline
- Removing legacy `getLatestMachineEvents` / `getMachinePendingConsumers`
