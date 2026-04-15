import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const secretsTable = sqliteTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    projectSlug: text("project_slug").notNull().default("public"),
    name: text("name").notNull(),
    value: text("value").notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("secrets_project_slug_name_unique").on(table.projectSlug, table.name),
    index("idx_secrets_project_slug_created_at").on(table.projectSlug, table.createdAt),
  ],
);
