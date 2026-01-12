import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { typeid } from "typeid-js";

export const HarnessTypes = ["claude", "opencode", "pi", "iterate"] as const;
export type HarnessType = (typeof HarnessTypes)[number];

const iterateId = <P extends string>(prefix: P) =>
  text("id")
    .primaryKey()
    .$defaultFn(() => typeid(prefix).toString());

const withTimestamps = {
  createdAt: integer("created_at", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
};

export const agents = sqliteTable("agents", {
  id: iterateId("agent"),
  slug: text("slug").notNull().unique(),
  harnessType: text("harness_type", { enum: HarnessTypes }).notNull(),
  harnessAgentId: text("harness_agent_id").notNull(),
  harnessData: text("harness_data", { mode: "json" }).$type<Record<string, unknown>>().default({}),
  ...withTimestamps,
});

export const todos = sqliteTable("todos", {
  id: integer({ mode: "number" }).primaryKey({
    autoIncrement: true,
  }),
  title: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});
