/**
 * SQLite implementation of StreamStorageManager using Drizzle ORM.
 */
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE } from "@iterate-com/services-contracts/events";
import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import { drizzle as drizzleBetterSqlite } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate as migrateBetterSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { DateTime, Effect, Layer, Option, Stream } from "effect";

import { Event, EventType, Offset, Payload, StreamPath, Version } from "../../domain.ts";
import { parsePushSubscriptionPayload } from "../../push-subscriptions.ts";
import {
  STREAM_METADATA_UPDATED_TYPE,
  parseStreamMetadataUpdatedPayload,
} from "../../stream-metadata.ts";
import { SpanId, TraceContext, TraceId } from "../../tracing/trace-context.ts";
import {
  PushSubscriptionState,
  StreamInfo,
  StreamStorage,
  StreamStorageError,
  StreamStorageManager,
  StreamStorageManagerTypeId,
} from "./service.ts";
import * as schema from "./schema.ts";

const MIGRATIONS_FOLDER = path.resolve(fileURLToPath(new URL("../../../drizzle", import.meta.url)));

type DrizzleDatabase = BetterSQLite3Database;

/**
 * Raw database row shape for events table.
 * Exported for use by debug/CLI tools that need direct DB access.
 */
export interface EventRow {
  path: string;
  offset: string;
  type: string;
  payload: string;
  version: string;
  created_at: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
}

const eventToRow = (event: Event): EventRow => ({
  path: event.path,
  offset: event.offset,
  type: event.type,
  payload: JSON.stringify(event.payload),
  version: event.version,
  created_at: DateTime.formatIso(event.createdAt),
  trace_id: event.trace.traceId,
  span_id: event.trace.spanId,
  parent_span_id: Option.getOrNull(event.trace.parentSpanId),
});

const rowToEvent = (row: EventRow): Event =>
  Event.make({
    path: StreamPath.make(row.path),
    offset: Offset.make(row.offset),
    type: EventType.make(row.type),
    payload: JSON.parse(row.payload) as Payload,
    version: Version.make(row.version),
    createdAt: DateTime.unsafeFromDate(new Date(row.created_at)),
    trace: TraceContext.make({
      traceId: TraceId.make(row.trace_id),
      spanId: SpanId.make(row.span_id),
      parentSpanId: row.parent_span_id
        ? Option.some(SpanId.make(row.parent_span_id))
        : Option.none(),
    }),
  });

const parseMetadataJson = (input: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const ensureSqliteDirectory = async (filename: string): Promise<void> => {
  if (filename === ":memory:") return;

  if (filename.startsWith("file:")) {
    const withoutQuery = filename.slice("file:".length).split("?")[0] ?? "";
    if (withoutQuery.length === 0 || withoutQuery === ":memory:" || withoutQuery === "memory:") {
      return;
    }

    if (withoutQuery.startsWith("//")) {
      const filePath = fileURLToPath(filename);
      const fileDirectory = path.dirname(filePath);
      if (fileDirectory !== path.sep) {
        await mkdir(fileDirectory, { recursive: true });
      }
      return;
    }

    const fileDirectory = path.dirname(withoutQuery);
    if (fileDirectory === "." || fileDirectory === "") return;
    await mkdir(fileDirectory, { recursive: true });
    return;
  }

  const directory = path.dirname(filename);
  if (directory === "." || directory === "") return;
  await mkdir(directory, { recursive: true });
};

const createDb = async (filename: string) => {
  await ensureSqliteDirectory(filename);

  const { default: BetterSqlite3 } = await import("better-sqlite3");
  const sqlite = new BetterSqlite3(filename);
  sqlite.pragma("foreign_keys = ON");

  const db = drizzleBetterSqlite(sqlite);
  migrateBetterSqlite(db, {
    migrationsFolder: MIGRATIONS_FOLDER,
  });

  return {
    db: db as DrizzleDatabase,
    destroy: async () => {
      sqlite.close();
    },
  };
};

export const migrateSqliteFile = async (filename: string): Promise<void> => {
  const db = await createDb(filename);
  await db.destroy();
};

export const sqliteLayer = (
  filename: string,
): Layer.Layer<StreamStorageManager, StreamStorageError> =>
  Layer.scoped(
    StreamStorageManager,
    Effect.acquireRelease(
      Effect.tryPromise(() => createDb(filename)),
      (db) => Effect.promise(() => db.destroy()).pipe(Effect.orDie),
    ).pipe(
      Effect.map(({ db }) => {
        const append = (event: Event) =>
          Effect.tryPromise(async () => {
            const row = eventToRow(event);
            const metadataPayload =
              String(event.type) === STREAM_METADATA_UPDATED_TYPE
                ? parseStreamMetadataUpdatedPayload(event.payload)
                : undefined;
            const metadataJson =
              metadataPayload !== undefined
                ? JSON.stringify(metadataPayload.metadata)
                : JSON.stringify({});

            db.transaction((tx) => {
              tx.insert(schema.eventsTable)
                .values({
                  path: row.path,
                  offset: row.offset,
                  type: row.type,
                  payload: row.payload,
                  version: row.version,
                  createdAt: row.created_at,
                  traceId: row.trace_id,
                  spanId: row.span_id,
                  parentSpanId: row.parent_span_id,
                })
                .run();

              tx.insert(schema.eventStreamsTable)
                .values({
                  path: row.path,
                  createdAt: row.created_at,
                  eventCount: 1,
                  lastEventCreatedAt: row.created_at,
                  metadata: metadataJson,
                })
                .onConflictDoUpdate({
                  target: schema.eventStreamsTable.path,
                  set: {
                    eventCount: sql<number>`${schema.eventStreamsTable.eventCount} + 1`,
                    lastEventCreatedAt: row.created_at,
                    ...(metadataPayload !== undefined ? { metadata: metadataJson } : {}),
                  },
                })
                .run();

              const subscriptionPayload =
                String(event.type) === PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE
                  ? parsePushSubscriptionPayload(event.payload)
                  : undefined;
              if (subscriptionPayload === undefined) return;

              tx.insert(schema.eventStreamSubscriptionsTable)
                .values({
                  eventStreamPath: row.path,
                  subscriptionSlug: subscriptionPayload.subscriptionSlug,
                  type: subscriptionPayload.type,
                  createdAt: row.created_at,
                  updatedAt: row.created_at,
                  lastDeliveredOffset: null,
                  subscriptionJson: JSON.stringify(subscriptionPayload),
                })
                .onConflictDoUpdate({
                  target: [
                    schema.eventStreamSubscriptionsTable.eventStreamPath,
                    schema.eventStreamSubscriptionsTable.subscriptionSlug,
                  ],
                  set: {
                    type: subscriptionPayload.type,
                    updatedAt: row.created_at,
                    subscriptionJson: JSON.stringify(subscriptionPayload),
                  },
                })
                .run();
            });

            return event;
          }).pipe(
            Effect.mapError((cause) => StreamStorageError.make({ cause, context: { event } })),
          );

        const listPushSubscriptions = ({ path }: { path: StreamPath }) =>
          Effect.tryPromise(async () => {
            const rows = db
              .select()
              .from(schema.eventStreamSubscriptionsTable)
              .where(eq(schema.eventStreamSubscriptionsTable.eventStreamPath, path))
              .orderBy(asc(schema.eventStreamSubscriptionsTable.subscriptionSlug))
              .all();

            return rows.flatMap((row): PushSubscriptionState[] => {
              const subscription = parsePushSubscriptionPayload(
                JSON.parse(row.subscriptionJson) as unknown,
              );
              if (subscription === undefined) return [];

              return [
                {
                  subscription,
                  ...(row.lastDeliveredOffset !== null
                    ? { lastDeliveredOffset: Offset.make(row.lastDeliveredOffset) }
                    : {}),
                },
              ];
            });
          }).pipe(
            Effect.mapError((cause) => StreamStorageError.make({ cause, context: { path } })),
          );

        const setPushSubscriptionOffset = ({
          path,
          subscriptionSlug,
          offset,
        }: {
          path: StreamPath;
          subscriptionSlug: string;
          offset: Offset;
        }) =>
          Effect.tryPromise(async () => {
            db.update(schema.eventStreamSubscriptionsTable)
              .set({
                updatedAt: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
                lastDeliveredOffset: offset,
              })
              .where(
                and(
                  eq(schema.eventStreamSubscriptionsTable.eventStreamPath, path),
                  eq(schema.eventStreamSubscriptionsTable.subscriptionSlug, subscriptionSlug),
                  or(
                    isNull(schema.eventStreamSubscriptionsTable.lastDeliveredOffset),
                    lt(schema.eventStreamSubscriptionsTable.lastDeliveredOffset, offset),
                  ),
                ),
              )
              .run();
          }).pipe(
            Effect.mapError((cause) =>
              StreamStorageError.make({ cause, context: { path, subscriptionSlug, offset } }),
            ),
          );

        const read = ({ path, from, to }: { path: StreamPath; from?: Offset; to?: Offset }) =>
          Stream.unwrap(
            Effect.tryPromise(async () => {
              const conditions = [
                eq(schema.eventsTable.path, path),
                ...(from !== undefined ? [gt(schema.eventsTable.offset, from)] : []),
                ...(to !== undefined ? [lte(schema.eventsTable.offset, to)] : []),
              ];

              const rows = db
                .select()
                .from(schema.eventsTable)
                .where(and(...conditions))
                .orderBy(asc(schema.eventsTable.offset))
                .all();

              const events = rows.map(
                (row): Event =>
                  rowToEvent({
                    path: row.path,
                    offset: row.offset,
                    type: row.type,
                    payload: row.payload,
                    version: row.version,
                    created_at: row.createdAt,
                    trace_id: row.traceId,
                    span_id: row.spanId,
                    parent_span_id: row.parentSpanId,
                  }),
              );
              return Stream.fromIterable(events);
            }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),
          );

        const ensurePath = ({ path }: { path: StreamPath }) =>
          Effect.tryPromise(async () => {
            const now = new Date().toISOString();
            db.insert(schema.eventStreamsTable)
              .values({
                path,
                createdAt: now,
                eventCount: 0,
                lastEventCreatedAt: now,
                metadata: JSON.stringify({}),
              })
              .onConflictDoNothing({ target: schema.eventStreamsTable.path })
              .run();
          }).pipe(
            Effect.mapError((cause) => StreamStorageError.make({ cause, context: { path } })),
          );

        const listPaths = () =>
          Effect.tryPromise(async () => {
            const rows = db
              .select()
              .from(schema.eventStreamsTable)
              .orderBy(asc(schema.eventStreamsTable.path))
              .all();

            return rows.map((row) => StreamPath.make(row.path));
          }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause })));

        const listStreams = () =>
          Effect.tryPromise(async () => {
            const rows = db
              .select()
              .from(schema.eventStreamsTable)
              .orderBy(
                desc(schema.eventStreamsTable.lastEventCreatedAt),
                asc(schema.eventStreamsTable.path),
              )
              .all();

            return rows.map(
              (row): StreamInfo => ({
                path: StreamPath.make(row.path),
                createdAt: row.createdAt,
                eventCount: row.eventCount,
                lastEventCreatedAt: row.lastEventCreatedAt,
                metadata: parseMetadataJson(row.metadata),
              }),
            );
          }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause })));

        const forPath = (streamPath: StreamPath): StreamStorage => ({
          read: (options) =>
            read({
              path: streamPath,
              ...(options?.from !== undefined ? { from: options.from } : {}),
              ...(options?.to !== undefined ? { to: options.to } : {}),
            }).pipe(Stream.catchAllCause(() => Stream.empty)),
          append: (event) => append(event).pipe(Effect.orDie),
          listPushSubscriptions: () =>
            listPushSubscriptions({ path: streamPath }).pipe(Effect.orDie),
          setPushSubscriptionOffset: ({ subscriptionSlug, offset }) =>
            setPushSubscriptionOffset({ path: streamPath, subscriptionSlug, offset }).pipe(
              Effect.orDie,
            ),
        });

        return StreamStorageManager.of({
          [StreamStorageManagerTypeId]: StreamStorageManagerTypeId,
          listPaths,
          listStreams,
          ensurePath,
          forPath,
          append,
          read,
          listPushSubscriptions,
          setPushSubscriptionOffset,
        });
      }),
      Effect.mapError((cause) => StreamStorageError.make({ cause })),
    ),
  );
