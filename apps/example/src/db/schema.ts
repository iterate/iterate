import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const thingsTable = sqliteTable(
  "things",
  {
    id: text("id").primaryKey(),
    thing: text("thing").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_things_created_at").on(table.createdAt)],
);
