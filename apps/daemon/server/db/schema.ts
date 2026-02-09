import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const events = sqliteTable("events", {
  id: text().primaryKey(),
  type: text().notNull(),
  externalId: text("external_id"),
  payload: text({ mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

/** An agent is a logical unit of work identified by a URL path (e.g. `/agent/slack/ts/abc`). */
export const agents = sqliteTable("agents", {
  path: text().primaryKey(),
  workingDirectory: text("working_directory").notNull(),
  metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

/**
 * Maps an agent path to a destination URL. Typically routes to a path on the
 * same HTTP server (e.g. `/opencode/sessions/xyz`), but the destination can
 * be any base URL.
 */
export const agentRoutes = sqliteTable(
  "agent_routes",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    agentPath: text("agent_path")
      .notNull()
      .references(() => agents.path),
    destination: text().notNull(),
    active: integer({ mode: "boolean" }).notNull().default(true),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  },
  (table) => ({
    activeRouteUnique: uniqueIndex("agent_routes_active_unique")
      .on(table.agentPath)
      .where(sql`${table.active} = 1`),
  }),
);

export type AgentRoute = typeof agentRoutes.$inferSelect;
export type NewAgentRoute = typeof agentRoutes.$inferInsert;
