import { index, sqliteTable } from "drizzle-orm/sqlite-core";

export const kv = sqliteTable("kv", (t) => ({
  key: t.text().unique().primaryKey(),
  value: t.blob({ mode: "json" }),
}));

export const sessionToThread = sqliteTable(
  "session_to_thread",
  (t) => ({
    sessionID: t.text().unique().primaryKey(),
    threadID: t.text().notNull(),
    directory: t.text().notNull(),
  }),
  (t) => [index("session_idx").on(t.sessionID), index("thread_idx").on(t.threadID)],
);
