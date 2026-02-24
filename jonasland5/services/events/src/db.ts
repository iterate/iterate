import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { eventsServiceEnvSchema } from "@jonasland5/events-contract";
import type { SqlResultSet } from "@jonasland5/shared";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

const eventsDbPath = eventsServiceEnvSchema.parse(process.env).EVENTS_DB_PATH;

const dbConnection = drizzle(eventsDbPath);
const client = dbConnection.$client;
export const db = dbConnection;

export const eventsTable = sqliteTable("events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

function readPragmaValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return null;
  return String(value);
}

export async function getEventsDbJournalMode(): Promise<string> {
  const value = readPragmaValue(client.pragma("journal_mode", { simple: true }));
  return value?.toLowerCase() ?? "unknown";
}

export async function getEventsDbRuntimeConfig() {
  return {
    path: eventsDbPath,
    journalMode: await getEventsDbJournalMode(),
  };
}

export async function executeEventsSql(statement: string) {
  const prepared = client.prepare(statement);
  if (prepared.reader) {
    const headers = prepared.columns();
    const rows = prepared.raw().all() as unknown[][];
    return {
      columns: headers.map((header) => header.name),
      columnTypes: headers.map((header) => header.type ?? null),
      rows,
      rowsAffected: rows.length,
    } satisfies SqlResultSet;
  }

  const runResult = prepared.run();
  return {
    columns: [],
    columnTypes: [],
    rows: [],
    rowsAffected: runResult.changes,
    lastInsertRowid: runResult.lastInsertRowid,
  } satisfies SqlResultSet;
}

export async function initializeEventsDb() {
  await mkdir(dirname(eventsDbPath), { recursive: true });
  client.pragma("journal_mode = WAL");

  db.run(sql`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_events_created_at
    ON events (created_at)
  `);
}
