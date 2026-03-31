import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const secretsTable = sqliteTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    value: text("value").notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_secrets_created_at").on(table.createdAt)],
);
