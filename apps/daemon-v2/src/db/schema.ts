import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const routesTable = sqliteTable("routes", {
  host: text().primaryKey(),
  target: text().notNull(),
  metadataJson: text("metadata_json", { mode: "json" })
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  tagsJson: text("tags_json", { mode: "json" }).$type<string[]>().notNull().default([]),
  caddyDirectivesJson: text("caddy_directives_json", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default([]),
  updatedAt: text("updated_at").notNull(),
});

export const configTable = sqliteTable("config", {
  key: text().primaryKey(),
  valueJson: text("value_json", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: text("updated_at").notNull(),
});
