import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const todosTable = sqliteTable("todos", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  completed: integer({ mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});
