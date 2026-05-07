/// <reference types="@cloudflare/workers-types" />

import type {
  LifecycleHooksMembers,
  LifecycleHooksProtected,
  LifecycleStructuredName,
} from "./with-lifecycle-hooks.ts";
import type {
  Constructor,
  DurableObjectClass,
  DurableObjectConstructor,
  DurableObjectMixinResult,
  MembersOf,
  ReqEnvOf,
} from "./mixin-types.ts";
import type { DurableObjectCoreProtected } from "./with-durable-object-core.ts";

export type D1ObjectCatalogRecord<StructuredName extends LifecycleStructuredName> = {
  class: string;
  name: string;
  id: string;
  structuredName: StructuredName;
  createdAt: string;
  lastWokenAt: string;
};

export type D1ObjectCatalogIndexValue = string | number | readonly (string | number)[];

export type D1ObjectCatalogIndexDefinitions<StructuredName extends LifecycleStructuredName> =
  Record<string, (structuredName: StructuredName) => D1ObjectCatalogIndexValue>;

export type D1ObjectCatalogMembers<StructuredName extends LifecycleStructuredName> = {
  /**
   * Returns this Durable Object's D1 catalog row, or `null` when no row is
   * available yet.
   *
   * `null` covers ordinary best-effort states: the object has not been
   * initialized, the background D1 write has not run yet, or the mixin-owned
   * tables have not been created yet.
   */
  getD1ObjectCatalogRecord(): Promise<D1ObjectCatalogRecord<StructuredName> | null>;
};

type WithD1ObjectCatalogResult<
  TBase extends DurableObjectClass,
  StructuredName extends LifecycleStructuredName,
  Env,
> =
  // Preserve the Cloudflare-style `class Room extends Base<Env>` ergonomics
  // while carrying the D1 requirement forward.
  //
  // `Env` here is not necessarily the final worker env. It is the smallest env
  // shape required by `getDatabase(env)`, for example:
  //
  //   type NeedsCatalog = { DO_CATALOG: D1Database };
  //   const Base = withD1ObjectCatalog<RoomInit, NeedsCatalog>(...)(RoomBase);
  //
  // Then this works because FullEnv has at least DO_CATALOG:
  //
  //   type FullEnv = NeedsCatalog & { OTHER: string };
  //   class Room extends Base<FullEnv> {}
  //
  // And this fails because MissingEnv does not satisfy the lower bound:
  //
  //   class Broken extends Base<{ OTHER: string }> {}
  DurableObjectMixinResult<TBase, D1ObjectCatalogMembers<StructuredName>, ReqEnvOf<TBase> & Env>;

/**
 * Best-effort D1 catalog for initialized Durable Objects.
 *
 * This is intentionally implemented as a lifecycle-hooks consumer: it registers
 * an instance wake hook, then starts a separately caught D1 write so startup does
 * not depend on an external database. Local Durable Object storage remains the
 * source of truth; D1 is only for discovery and cross-object lookup.
 *
 * `indexes` derives secondary lookup rows from structured names. Use it for stable
 * identity fields such as `ownerUserId` or `projectId`, not for mutable state.
 */
export function withD1ObjectCatalog<StructuredName extends LifecycleStructuredName, Env>(options: {
  className: string;
  getDatabase(env: Env): D1Database;
  indexes?: D1ObjectCatalogIndexDefinitions<StructuredName>;
}) {
  return function <TBase extends DurableObjectClass>(
    Base: TBase,
  ): WithD1ObjectCatalogResult<TBase, StructuredName, Env> {
    const BaseWithLifecycle = Base as unknown as DurableObjectConstructor<
      Env,
      DurableObjectCoreProtected &
        LifecycleHooksMembers<StructuredName> &
        LifecycleHooksProtected<StructuredName>
    >;

    abstract class D1ObjectCatalogMixin
      extends BaseWithLifecycle
      implements D1ObjectCatalogMembers<StructuredName>
    {
      constructor(...args: any[]) {
        super(...args);

        this.registerOnInstanceWake((structuredName) => {
          this.scheduleD1ObjectCatalogUpsert(structuredName);
        });
      }

      /**
       * Reads the external D1 catalog without initializing the object.
       */
      async getD1ObjectCatalogRecord() {
        const initialized = tryGetInitialized(this);
        if (!initialized) {
          return null;
        }

        return await getD1ObjectCatalogRecord<StructuredName>(options.getDatabase(this.env), {
          className: options.className,
          name: this.name,
        });
      }

      /**
       * Fire-and-log catalog update.
       *
       * D1 is outside the Durable Object's local transaction boundary. This
       * promise is deliberately detached and caught: startup can succeed and
       * callers can retry even when D1 is temporarily unavailable.
       *
       * Cloudflare documents that `ctx.waitUntil()` has no Worker-style lifetime
       * effect inside Durable Objects. DOs stay alive while there is ongoing work
       * or pending I/O, so the important behavior here is starting the promise and
       * handling its rejection.
       * https://developers.cloudflare.com/durable-objects/api/state/#waituntil
       */
      private scheduleD1ObjectCatalogUpsert(structuredName: StructuredName) {
        void Promise.resolve()
          .then(() =>
            upsertD1ObjectCatalog({
              db: options.getDatabase(this.env),
              className: options.className,
              id: this.getDurableObjectId().toString(),
              indexes: options.indexes,
              name: this.name,
              structuredName,
            }),
          )
          .catch((error: unknown) => {
            console.error("[withD1ObjectCatalog] failed to upsert catalog row", error);
          });
      }
    }

    // TypeScript cannot infer that this class expression preserves Base's
    // static/protected side while adding the D1 env lower-bound. The result type
    // above publishes that composed class shape and keeps `class Room extends
    // Base<FullEnv>` working when FullEnv includes the D1 binding fragment.
    return D1ObjectCatalogMixin as unknown as WithD1ObjectCatalogResult<TBase, StructuredName, Env>;
  };
}

export async function getD1ObjectCatalogRecord<StructuredName extends LifecycleStructuredName>(
  db: D1Database,
  input: {
    className: string;
    name: string;
  },
): Promise<D1ObjectCatalogRecord<StructuredName> | null> {
  try {
    const row = await db
      .prepare(
        `SELECT class, name, id, structured_name_json, created_at, last_woken_at
         FROM mixin_d1_object_catalog_objects
         WHERE class = ? AND name = ?
         LIMIT 1`,
      )
      .bind(input.className, input.name)
      .first<D1ObjectCatalogRow>();

    return row === null ? null : parseD1ObjectCatalogRow<StructuredName>(row);
  } catch (error) {
    if (isMissingD1ObjectCatalogTableError(error)) {
      return null;
    }

    throw error;
  }
}

export async function listD1ObjectCatalogRecordsByIndex<
  StructuredName extends LifecycleStructuredName,
>(
  db: D1Database,
  input: {
    className: string;
    indexName: string;
    indexValue: string | number;
  },
): Promise<D1ObjectCatalogRecord<StructuredName>[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT o.class, o.name, o.id, o.structured_name_json, o.created_at, o.last_woken_at
         FROM mixin_d1_object_catalog_indexes i
         JOIN mixin_d1_object_catalog_objects o
           ON o.class = i.class AND o.name = i.name
         WHERE i.class = ? AND i.index_name = ? AND i.index_value = ?
         ORDER BY o.created_at ASC, o.name ASC`,
      )
      .bind(input.className, input.indexName, String(input.indexValue))
      .all<D1ObjectCatalogRow>();

    return results.map((row) => parseD1ObjectCatalogRow<StructuredName>(row));
  } catch (error) {
    if (isMissingD1ObjectCatalogTableError(error)) {
      return [];
    }

    throw error;
  }
}

export async function listD1ObjectCatalogRecords<StructuredName extends LifecycleStructuredName>(
  db: D1Database,
  input: {
    className: string;
  },
): Promise<D1ObjectCatalogRecord<StructuredName>[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT class, name, id, structured_name_json, created_at, last_woken_at
         FROM mixin_d1_object_catalog_objects
         WHERE class = ?
         ORDER BY created_at ASC, name ASC`,
      )
      .bind(input.className)
      .all<D1ObjectCatalogRow>();

    return results.map((row) => parseD1ObjectCatalogRow<StructuredName>(row));
  } catch (error) {
    if (isMissingD1ObjectCatalogTableError(error)) {
      return [];
    }

    throw error;
  }
}

export async function upsertD1ObjectCatalog<StructuredName extends LifecycleStructuredName>(input: {
  db: D1Database;
  className: string;
  id: string;
  indexes: D1ObjectCatalogIndexDefinitions<StructuredName> | undefined;
  name: string;
  structuredName: StructuredName;
}) {
  const now = new Date().toISOString();
  const indexEntries = getIndexEntries(input.indexes, input.structuredName);

  // Idempotent bootstrap + upsert: every write can create both mixin-owned
  // tables, then replace the `(class, name)` row and the derived index rows.
  // Constructors stay cheap because this happens from the lifecycle instance
  // wake hook, outside the startup readiness boundary. `created_at` remains the
  // first insertion time; `last_woken_at` moves whenever the hook runs.
  await input.db.batch([
    input.db.prepare(CREATE_D1_OBJECT_CATALOG_OBJECTS_TABLE_SQL),
    input.db.prepare(CREATE_D1_OBJECT_CATALOG_INDEXES_TABLE_SQL),
    input.db
      .prepare(
        `INSERT INTO mixin_d1_object_catalog_objects (
          class,
          name,
          id,
          structured_name_json,
          created_at,
          last_woken_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(class, name) DO UPDATE SET
          id = excluded.id,
          structured_name_json = excluded.structured_name_json,
          last_woken_at = excluded.last_woken_at`,
      )
      .bind(
        input.className,
        input.name,
        input.id,
        // The catalog is intentionally a simple external index. Structured names
        // used with this mixin must be JSON-compatible by convention. JSON.stringify
        // catches some failures, like BigInt and circular references, but it can
        // silently coerce or drop functions, Maps, and class instances.
        JSON.stringify(input.structuredName),
        now,
        now,
      ),
    input.db
      .prepare(
        `DELETE FROM mixin_d1_object_catalog_indexes
         WHERE class = ? AND name = ?`,
      )
      .bind(input.className, input.name),
    ...indexEntries.map((entry) =>
      input.db
        .prepare(
          `INSERT INTO mixin_d1_object_catalog_indexes (
            class,
            index_name,
            index_value,
            name
          )
          VALUES (?, ?, ?, ?)`,
        )
        .bind(input.className, entry.indexName, entry.indexValue, input.name),
    ),
  ]);
}

const CREATE_D1_OBJECT_CATALOG_OBJECTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS mixin_d1_object_catalog_objects (
      class TEXT NOT NULL,
      name TEXT NOT NULL,
      id TEXT NOT NULL,
      structured_name_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_woken_at TEXT NOT NULL,
      PRIMARY KEY (class, name)
    )`;

const CREATE_D1_OBJECT_CATALOG_INDEXES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS mixin_d1_object_catalog_indexes (
      class TEXT NOT NULL,
      index_name TEXT NOT NULL,
      index_value TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (class, index_name, index_value, name)
    )`;

type D1ObjectCatalogRow = {
  class: string;
  name: string;
  id: string;
  structured_name_json: string;
  created_at: string;
  last_woken_at: string;
};

function parseD1ObjectCatalogRow<StructuredName extends LifecycleStructuredName>(
  row: D1ObjectCatalogRow,
): D1ObjectCatalogRecord<StructuredName> {
  return {
    class: row.class,
    name: row.name,
    id: row.id,
    structuredName: JSON.parse(row.structured_name_json) as StructuredName,
    createdAt: row.created_at,
    lastWokenAt: row.last_woken_at,
  };
}

function getIndexEntries<StructuredName extends LifecycleStructuredName>(
  indexes: D1ObjectCatalogIndexDefinitions<StructuredName> | undefined,
  structuredName: StructuredName,
) {
  return Object.entries(indexes ?? {}).flatMap(([indexName, getValue]) => {
    const value = getValue(structuredName);
    const values = Array.isArray(value) ? value : [value];

    return values.map((indexValue) => ({
      indexName,
      indexValue: String(indexValue),
    }));
  });
}

function tryGetInitialized<StructuredName extends LifecycleStructuredName>(
  instance: LifecycleHooksMembers<StructuredName>,
) {
  try {
    instance.assertInitialized();
    return true;
  } catch (error) {
    // Avoid importing the concrete error class just for an instanceof check
    // across Worker module boundaries. The public error name is stable enough
    // for this internal "initialized or not" probe.
    if (error instanceof Error && error.name === "NotInitializedError") {
      return false;
    }

    throw error;
  }
}

function isMissingD1ObjectCatalogTableError(error: unknown) {
  return (
    error instanceof Error && error.message.includes("no such table: mixin_d1_object_catalog_")
  );
}
