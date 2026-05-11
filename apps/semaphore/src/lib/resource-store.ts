import {
  semaphoreDataSchema,
  semaphoreTypeSchema,
  type SemaphoreJsonObject,
  type SemaphoreResourceRecord,
} from "@iterate-com/semaphore-contract";
import { z } from "zod";
import {
  deleteResourceByTypeAndSlug,
  insertResourceRow,
  selectResourceByTypeAndSlug,
  selectResourcePresenceByType,
  selectResources,
  selectResourcesByType,
  updateResourceAvailable,
  updateResourceLeased,
} from "../../sql/queries.ts";

type ResourceRow = {
  type: string;
  slug: string;
  data: string;
  lease_state: string;
  leased_until?: number | null;
  last_acquired_at?: number | null;
  last_released_at?: number | null;
  created_at: string;
  updated_at: string;
};

export class ResourceInputError extends Error {}

export function parseType(input: string): string {
  return semaphoreTypeSchema.parse(input);
}

function parseData(value: string): SemaphoreJsonObject {
  try {
    return semaphoreDataSchema.parse(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ResourceInputError("data must be valid JSON");
    }

    throw error;
  }
}

function rowToResourceRecord(row: ResourceRow): SemaphoreResourceRecord {
  return {
    type: row.type,
    slug: row.slug,
    data: parseData(row.data),
    leaseState: z.enum(["available", "leased"]).parse(row.lease_state),
    leasedUntil: row.leased_until ?? null,
    lastAcquiredAt: row.last_acquired_at ?? null,
    lastReleasedAt: row.last_released_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listResourcesFromDb(
  db: D1Database,
  params: { type?: string } = {},
): Promise<SemaphoreResourceRecord[]> {
  const rows = params.type
    ? await selectResourcesByType(db, { type: params.type })
    : await selectResources(db);
  return rows.map(rowToResourceRecord);
}

export async function findResourceByKey(
  db: D1Database,
  key: { type: string; slug: string },
): Promise<SemaphoreResourceRecord | null> {
  const row = await selectResourceByTypeAndSlug(db, key);
  return row ? rowToResourceRecord(row) : null;
}

export async function insertResource(
  db: D1Database,
  resource: {
    type: string;
    slug: string;
    data: SemaphoreJsonObject;
  },
): Promise<SemaphoreResourceRecord> {
  await insertResourceRow(db, {
    type: resource.type,
    slug: resource.slug,
    data: JSON.stringify(resource.data),
  });

  const row = await findResourceByKey(db, {
    type: resource.type,
    slug: resource.slug,
  });

  if (!row) {
    throw new Error("Inserted resource row not found");
  }

  return row;
}

export async function deleteResourceFromDb(
  db: D1Database,
  key: {
    type: string;
    slug: string;
  },
): Promise<boolean> {
  const result = await deleteResourceByTypeAndSlug(db, key);
  return (result.changes ?? 0) > 0;
}

export async function selectInventoryByType(
  db: D1Database,
  type: string,
): Promise<SemaphoreResourceRecord[]> {
  return listResourcesFromDb(db, { type });
}

export async function hasInventoryForType(db: D1Database, type: string): Promise<boolean> {
  const result = await selectResourcePresenceByType(db, { type });
  return Boolean(result?.present);
}

export async function markResourceLeasedInDb(
  db: D1Database,
  params: {
    type: string;
    slug: string;
    leasedUntil: number;
    lastAcquiredAt: number;
  },
): Promise<boolean> {
  const result = await updateResourceLeased(
    db,
    {
      leasedUntil: params.leasedUntil,
      lastAcquiredAt: params.lastAcquiredAt,
    },
    {
      type: params.type,
      slug: params.slug,
    },
  );
  return (result.changes ?? 0) > 0;
}

export async function markResourceAvailableInDb(
  db: D1Database,
  params: {
    type: string;
    slug: string;
    lastReleasedAt: number | null;
  },
): Promise<void> {
  await updateResourceAvailable(
    db,
    {
      lastReleasedAt: params.lastReleasedAt,
    },
    {
      type: params.type,
      slug: params.slug,
    },
  );
}
