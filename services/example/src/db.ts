import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { exampleServiceEnvSchema } from "@iterate-com/example-contract";
import type { SqlResultSet } from "@iterate-com/shared/jonasland";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { text, sqliteTable } from "drizzle-orm/sqlite-core";

const exampleDbPath = exampleServiceEnvSchema.parse(process.env).EXAMPLE_DB_PATH;

const dbConnection = drizzle(exampleDbPath);
const client = dbConnection.$client;
export const db = dbConnection;

export const thingsTable = sqliteTable("things", {
  id: text("id").primaryKey(),
  thing: text("thing").notNull(),
  eventId: text("event_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

function readPragmaValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return null;
  return String(value);
}

async function getExampleDbJournalMode(): Promise<string> {
  const value = readPragmaValue(client.pragma("journal_mode", { simple: true }));
  return value?.toLowerCase() ?? "unknown";
}

export async function getExampleDbRuntimeConfig() {
  return {
    path: exampleDbPath,
    journalMode: await getExampleDbJournalMode(),
  };
}

export async function executeExampleSql(statement: string) {
  const prepared = client.prepare(statement);
  if (prepared.reader) {
    const headers = prepared.columns() as Array<{ name: string; type?: string | null }>;
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

export async function initializeExampleDb() {
  await mkdir(dirname(exampleDbPath), { recursive: true });
  client.pragma("journal_mode = WAL");

  db.run(sql`
    CREATE TABLE IF NOT EXISTS things (
      id TEXT PRIMARY KEY NOT NULL,
      thing TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_things_created_at
    ON things (created_at)
  `);
}
