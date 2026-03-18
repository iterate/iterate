import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Option, Stream } from "effect";
import {
  PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  parseStreamMetadataUpdatedPayload,
} from "@iterate-com/registry-contract";
import {
  Event,
  EventType,
  Offset,
  Payload,
  StreamPath,
  Version,
} from "../../../../events/effect-stream-manager/domain.ts";
import { parsePushSubscriptionPayload } from "../../../../events/effect-stream-manager/push-subscriptions.ts";
import {
  SpanId,
  TraceContext,
  TraceId,
} from "../../../../events/effect-stream-manager/tracing/trace-context.ts";
import {
  StreamStorageError,
  StreamStorageManager,
  StreamStorageManagerTypeId,
  type PushSubscriptionState,
  type StreamInfo,
  type StreamStorage,
} from "../../../../events/effect-stream-manager/services/stream-storage/service.ts";
import type { RegistryDatabase } from "../db/index.ts";
import * as schema from "../db/schema.ts";

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
    payload: parsePayloadJson(row.payload),
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsePayloadJson = (input: string): Payload => {
  const parsed = JSON.parse(input);

  if (!isRecord(parsed)) {
    throw new Error("Expected persisted event payload to be a JSON object");
  }

  return parsed;
};

const parseMetadataJson = (input: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(input);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const sqliteLayer = (
  db: RegistryDatabase,
): Layer.Layer<StreamStorageManager, StreamStorageError> =>
  Layer.succeed(
    StreamStorageManager,
    StreamStorageManager.of({
      [StreamStorageManagerTypeId]: StreamStorageManagerTypeId,
      listPaths: () =>
        Effect.tryPromise(async () => {
          const rows = db
            .select()
            .from(schema.eventStreamsTable)
            .orderBy(asc(schema.eventStreamsTable.path))
            .all();

          return rows.map((row) => StreamPath.make(row.path));
        }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),

      listStreams: () =>
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
        }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),

      ensurePath: ({ path }) =>
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
        }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause, context: { path } }))),

      forPath: (streamPath) => ({
        read: (options) =>
          Stream.unwrap(
            Effect.tryPromise(async () => {
              const conditions = [
                eq(schema.eventsTable.path, streamPath),
                ...(options?.from !== undefined
                  ? [gt(schema.eventsTable.offset, options.from)]
                  : []),
                ...(options?.to !== undefined ? [lte(schema.eventsTable.offset, options.to)] : []),
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
          ).pipe(Stream.catchAllCause(() => Stream.empty)),

        append: (event) =>
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
            Effect.orDie,
          ),

        listPushSubscriptions: () =>
          Effect.tryPromise(async () => {
            const rows = db
              .select()
              .from(schema.eventStreamSubscriptionsTable)
              .where(eq(schema.eventStreamSubscriptionsTable.eventStreamPath, streamPath))
              .orderBy(asc(schema.eventStreamSubscriptionsTable.subscriptionSlug))
              .all();

            return rows.flatMap((row): PushSubscriptionState[] => {
              const subscription = parsePushSubscriptionPayload(JSON.parse(row.subscriptionJson));
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
            Effect.mapError((cause) =>
              StreamStorageError.make({ cause, context: { path: streamPath } }),
            ),
            Effect.orDie,
          ),

        setPushSubscriptionOffset: ({ subscriptionSlug, offset }) =>
          Effect.tryPromise(async () => {
            db.update(schema.eventStreamSubscriptionsTable)
              .set({
                updatedAt: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
                lastDeliveredOffset: offset,
              })
              .where(
                and(
                  eq(schema.eventStreamSubscriptionsTable.eventStreamPath, streamPath),
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
              StreamStorageError.make({
                cause,
                context: { path: streamPath, subscriptionSlug, offset },
              }),
            ),
            Effect.orDie,
          ),
      }),

      read: ({ path, from, to }) =>
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
        ),

      append: (event) =>
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
        }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause, context: { event } }))),

      listPushSubscriptions: ({ path }) =>
        Effect.tryPromise(async () => {
          const rows = db
            .select()
            .from(schema.eventStreamSubscriptionsTable)
            .where(eq(schema.eventStreamSubscriptionsTable.eventStreamPath, path))
            .orderBy(asc(schema.eventStreamSubscriptionsTable.subscriptionSlug))
            .all();

          return rows.flatMap((row): PushSubscriptionState[] => {
            const subscription = parsePushSubscriptionPayload(JSON.parse(row.subscriptionJson));
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
        }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause, context: { path } }))),

      setPushSubscriptionOffset: ({ path, subscriptionSlug, offset }) =>
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
        ),
    }),
  );
