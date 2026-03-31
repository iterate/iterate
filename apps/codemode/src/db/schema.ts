import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const codemodeRunsTable = sqliteTable("codemode_runs", {
  id: text("id").primaryKey(),
  runnerKind: text("runner_kind").notNull().default("legacy"),
  codeSnippet: text("code_snippet").notNull(),
  result: text("result").notNull(),
  logsJson: text("logs_json").notNull().default("[]"),
  error: text("error"),
});
