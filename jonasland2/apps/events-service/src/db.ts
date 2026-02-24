import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";
import { eventsServiceEnvSchema } from "@jonasland2/events-contract";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

const eventsDbPath = eventsServiceEnvSchema.parse(process.env).EVENTS_DB_PATH;

const client = createClient({
  url: `file:${eventsDbPath}`,
});

export const db = drizzle(client);

export const eventsTable = sqliteTable("events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

function readPragmaValue(
  row: Record<string, unknown> | undefined,
  expectedColumn: string,
): string | null {
  if (!row) return null;
  const value = row[expectedColumn] ?? Object.values(row)[0];
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return null;
  return String(value);
}

export async function getEventsDbJournalMode(): Promise<string> {
  const result = await client.execute("PRAGMA journal_mode;");
  const value = readPragmaValue(
    (result.rows[0] as Record<string, unknown> | undefined) ?? undefined,
    "journal_mode",
  );
  return value?.toLowerCase() ?? "unknown";
}

export async function getEventsDbRuntimeConfig() {
  return {
    path: eventsDbPath,
    journalMode: await getEventsDbJournalMode(),
  };
}

export async function executeEventsSql(statement: string) {
  return client.execute(statement);
}

export async function initializeEventsDb() {
  await mkdir(dirname(eventsDbPath), { recursive: true });
  await client.execute("PRAGMA journal_mode = WAL;");

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_events_created_at
    ON events (created_at)
  `);
}
