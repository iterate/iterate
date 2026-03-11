import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { typeid } from "typeid-js";

export { createDeploymentSchema } from "@iterate-com/fake-os-contract";

export const deploymentsTable = sqliteTable("deployments", {
  id: text()
    .primaryKey()
    .$defaultFn(() => typeid("dpl").toString()),
  provider: text({ enum: ["docker", "fly"] }).notNull(),
  slug: text().notNull().unique(),
  opts: text({ mode: "json" }).notNull().default("{}"),
  deploymentLocator: text("deployment_locator", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

export const eventsTable = sqliteTable(
  "events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    streamPath: text("stream_path").notNull(),
    eventType: text("event_type").notNull(),
    payload: text({ mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    streamPathCreatedAtIdx: index("events_stream_path_created_at_idx").on(
      table.streamPath,
      table.createdAt,
    ),
  }),
);
