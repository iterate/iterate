import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const codemodeRunsTable = sqliteTable("codemode_runs", {
  id: text("id").primaryKey(),
  runnerKind: text("runner_kind").notNull().default("legacy"),
  codeSnippet: text("code_snippet").notNull(),
  sourcesJson: text("sources_json").notNull().default("[]"),
  result: text("result").notNull(),
  logsJson: text("logs_json").notNull().default("[]"),
  error: text("error"),
});

export const codemodeSecretsTable = sqliteTable(
  "codemode_secrets",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(),
    value: text("value").notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_codemode_secrets_created_at").on(table.createdAt)],
);
