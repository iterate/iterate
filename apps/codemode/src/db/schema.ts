import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const codemodeRunsTable = sqliteTable("codemode_runs", {
  id: text("id").primaryKey(),
  codeSnippet: text("code_snippet").notNull(),
  result: text("result").notNull(),
});
