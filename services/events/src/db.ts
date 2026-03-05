import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { serviceManifest } from "@iterate-com/events/contract";
import type { SqlResultSet } from "@iterate-com/shared/jonasland";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

const eventsDbPath = serviceManifest.envVars.parse(process.env).DATABASE_URL;

// Ensure directory exists before opening — DB path may be on a freshly-mounted volume
mkdirSync(dirname(eventsDbPath), { recursive: true });
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

export const streamEventsTable = sqliteTable(
  "stream_events",
  {
    path: text("path").notNull(),
    offset: text("offset").notNull(),
    offsetIndex: integer("offset_index").notNull(),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    version: text("version").notNull(),
    createdAt: text("created_at").notNull(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.path, table.offset] }),
    pathOffsetIndex: index("idx_stream_events_path_offset_idx").on(table.path, table.offsetIndex),
    pathCreatedAt: index("idx_stream_events_path_created_at").on(table.path, table.createdAt),
  }),
);

function readPragmaValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return null;
  return String(value);
}

async function getEventsDbJournalMode(): Promise<string> {
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

  db.run(sql`
    CREATE TABLE IF NOT EXISTS stream_events (
      path TEXT NOT NULL,
      offset TEXT NOT NULL,
      offset_index INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      PRIMARY KEY (path, offset)
    )
  `);

  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_stream_events_path_offset_idx
    ON stream_events (path, offset_index)
  `);

  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_stream_events_path_created_at
    ON stream_events (path, created_at)
  `);
}
