import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";

export const thingsTable = sqliteTable(
  "things",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("things_created_at_idx").on(table.createdAt)],
);
