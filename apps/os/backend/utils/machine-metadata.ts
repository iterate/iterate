import { sql } from "drizzle-orm";
import type { DB } from "../db/client.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TRANSIENT_TOP_LEVEL_MACHINE_METADATA_KEYS = new Set([
  "provisioningError",
  "daemonReportedStatus",
  "daemonReportedMessage",
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
  "machine:daemon-ready",
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
