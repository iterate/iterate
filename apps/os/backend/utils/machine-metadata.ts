import { sql } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import type { OutboxEventContext } from "../db/schema.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TRANSIENT_TOP_LEVEL_MACHINE_METADATA_KEYS = new Set([
  // Legacy keys — can be removed once all machines have cycled
  "daemonStatus",
  "daemonStatusMessage",
  "daemonReadyAt",
  "host",
  "port",
  "ports",
  "containerId",
  "containerName",
  "sandboxName",
]);

function stripNestedRuntimeKey(params: {
  metadata: Record<string, unknown>;
  parentKey: string;
  childKey: string;
}): void {
  const { metadata, parentKey, childKey } = params;
  const nested = metadata[parentKey];
  if (!isRecord(nested)) return;

  const updated = { ...nested };
  delete updated[childKey];

  if (Object.keys(updated).length === 0) {
    delete metadata[parentKey];
    return;
  }

  metadata[parentKey] = updated;
}

/**
 * Remove machine-state/runtime metadata while preserving config/intent metadata.
 *
 * Deny-list by design: we only strip known-bad transient keys that should not be
 * carried between machines or retained after successful provisioning.
 */
export function stripMachineStateMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = { ...metadata };

  for (const key of TRANSIENT_TOP_LEVEL_MACHINE_METADATA_KEYS) {
    delete cleaned[key];
  }

  stripNestedRuntimeKey({ metadata: cleaned, parentKey: "fly", childKey: "machineId" });
  stripNestedRuntimeKey({ metadata: cleaned, parentKey: "daytona", childKey: "sandboxId" });
  stripNestedRuntimeKey({ metadata: cleaned, parentKey: "docker", childKey: "containerRef" });

  return cleaned;
}

/** Machine event names that are relevant for UI status derivation. */
const MACHINE_EVENT_NAMES = [
  "machine:created",
  "machine:daemon-status-reported",
  "machine:probe-sent",
  "machine:probe-succeeded",
  "machine:probe-failed",
  "machine:activated",
  "machine:restart-requested",
] as const;

export type MachineEventName = (typeof MACHINE_EVENT_NAMES)[number];

export type MachineLastEvent = {
  name: MachineEventName;
  payload: Record<string, unknown>;
  createdAt: Date;
};

/** Consumer names that are relevant for UI status derivation. */
const MACHINE_CONSUMER_NAMES = [
  "provisionMachine",
  "sendReadinessProbe",
  "pollProbeResponse",
  "activateMachine",
] as const;

export type MachineConsumerName = (typeof MACHINE_CONSUMER_NAMES)[number];

/**
 * Query the latest machine lifecycle event for each given machineId.
 * Uses a JSONB query on outbox_event (no dedicated column needed).
 */
export async function getLatestMachineEvents(
  db: DB,
  machineIds: string[],
): Promise<Map<string, MachineLastEvent>> {
  if (machineIds.length === 0) return new Map();

  // Use DISTINCT ON to get the latest event per machineId in a single query.
  // The payload->>'machineId' extract + ORDER BY id DESC gives us the most recent.
  const raw = await db.execute(sql`
    SELECT DISTINCT ON (payload->>'machineId')
      payload->>'machineId' AS machine_id,
      name,
      payload,
      created_at
    FROM outbox_event
    WHERE payload->>'machineId' IN (${sql.join(
      machineIds.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND name IN (${sql.join(
        [...MACHINE_EVENT_NAMES].map((n) => sql`${n}`),
        sql`, `,
      )})
    ORDER BY payload->>'machineId', id DESC
  `);

  // drizzle execute returns array (postgres.js) or { rows } (neon)
  const rows = (Array.isArray(raw) ? raw : ((raw as { rows: unknown[] }).rows ?? [])) as Array<{
    machine_id: string;
    name: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>;

  const result = new Map<string, MachineLastEvent>();
  for (const row of rows) {
    result.set(row.machine_id, {
      name: row.name as MachineEventName,
      payload: row.payload,
      createdAt: row.created_at,
    });
  }
  return result;
}

/**
 * Query the consumer job queue for pending/in-flight jobs related to the given machines.
 * Returns a map of machineId → list of consumer names that are scheduled or processing.
 *
 * This is an abstraction over the pgmq queue internals — if the outbox later emits
 * consumer lifecycle events, this function can be swapped to query those instead.
 */
export async function getMachinePendingConsumers(
  db: DB,
  machineIds: string[],
): Promise<Map<string, MachineConsumerName[]>> {
  if (machineIds.length === 0) return new Map();

  const raw = await db.execute(sql`
    SELECT
      message->'event_payload'->>'machineId' AS machine_id,
      message->>'consumer_name' AS consumer_name
    FROM pgmq.q_consumer_job_queue
    WHERE message->'event_payload'->>'machineId' IN (${sql.join(
      machineIds.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND message->>'consumer_name' IN (${sql.join(
        [...MACHINE_CONSUMER_NAMES].map((n) => sql`${n}`),
        sql`, `,
      )})
  `);

  const rows = (Array.isArray(raw) ? raw : ((raw as { rows: unknown[] }).rows ?? [])) as Array<{
    machine_id: string;
    consumer_name: string;
  }>;

  const result = new Map<string, MachineConsumerName[]>();
  for (const row of rows) {
    const existing = result.get(row.machine_id) ?? [];
    existing.push(row.consumer_name as MachineConsumerName);
    result.set(row.machine_id, existing);
  }
  return result;
}

// --- Event lineage tracing ---

export type RelatedEvent = {
  id: number;
  name: string;
  payload: Record<string, unknown>;
  context: OutboxEventContext;
  createdAt: string;
  consumers: Array<{
    msg_id: number | string;
    enqueued_at: string;
    vt: string;
    read_ct: number;
    message: Record<string, unknown>;
  }>;
};

/**
 * Fetch all outbox events + consumer jobs related to a correlation key.
 * e.g. `getEventsRelatedTo(db, { key: "machineId", value: "mach_abc" })`
 *
 * Returns events in chronological order with their consumer jobs attached,
 * plus `context.causedBy` for causal graph edges.
 */
export async function getEventsRelatedTo(
  db: DB,
  params: { key: string; value: string },
): Promise<RelatedEvent[]> {
  const result = await db.execute(sql`
    with matched_events as (
      select * from outbox_event
      where payload->>${"" + params.key} = ${params.value}
    ),
    all_consumers as (
      select msg_id, enqueued_at, vt, read_ct, message
      from pgmq.q_consumer_job_queue
      union all
      select msg_id, enqueued_at, vt, read_ct, message
      from pgmq.a_consumer_job_queue
    ),
    matched_consumers as (
      select ac.* from all_consumers ac
      join matched_events me on (ac.message->>'event_id')::bigint = me.id
    )
    select
      me.id,
      me.name,
      me.payload,
      me.context,
      me.created_at as "createdAt",
      coalesce(
        (select json_agg(json_build_object(
          'msg_id', mc.msg_id, 'enqueued_at', mc.enqueued_at,
          'vt', mc.vt, 'read_ct', mc.read_ct, 'message', mc.message
        ) order by mc.msg_id)
        from matched_consumers mc
        where (mc.message->>'event_id')::bigint = me.id),
        '[]'::json
      ) as consumers
    from matched_events me
    order by me.id
  `);

  const rows = (
    Array.isArray(result) ? result : ((result as { rows: unknown[] }).rows ?? [])
  ) as RelatedEvent[];
  return rows;
}
