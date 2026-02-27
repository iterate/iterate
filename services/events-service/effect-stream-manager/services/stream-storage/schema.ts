import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const eventsTable = sqliteTable(
  "events",
  {
    path: text("path").notNull(),
    offset: text("offset").notNull(),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    version: text("version").notNull().default("1"),
    createdAt: text("created_at").notNull(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
  },
  (table) => [
    primaryKey({
      name: "events_pk",
      columns: [table.path, table.offset],
    }),
    index("idx_events_path_offset").on(table.path, table.offset),
  ],
);

export const eventStreamsTable = sqliteTable(
  "event_streams",
  {
    path: text("path").primaryKey(),
    createdAt: text("created_at").notNull(),
    eventCount: integer("event_count").notNull(),
    lastEventCreatedAt: text("last_event_created_at").notNull(),
    metadata: text("metadata").notNull().default("{}"),
  },
  (table) => [index("idx_event_streams_last_event_created_at").on(table.lastEventCreatedAt)],
);

export const eventStreamSubscriptionsTable = sqliteTable(
  "event_stream_subscriptions",
  {
    eventStreamPath: text("event_stream_path")
      .notNull()
      .references(() => eventStreamsTable.path, { onDelete: "cascade" }),
    subscriptionSlug: text("subscription_slug").notNull(),
    type: text("type").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastDeliveredOffset: text("last_delivered_offset"),
    subscriptionJson: text("subscription_json").notNull(),
  },
  (table) => [
    primaryKey({
      name: "event_stream_subscriptions_pk",
      columns: [table.eventStreamPath, table.subscriptionSlug],
    }),
    index("idx_event_stream_subscriptions_path").on(table.eventStreamPath),
    index("idx_event_stream_subscriptions_type").on(table.type),
  ],
);
