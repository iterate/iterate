import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ordersServiceEnvSchema } from "@iterate-com/orders-contract";
import type { SqlResultSet } from "@iterate-com/jonasland-shared";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const ordersDbPath = ordersServiceEnvSchema.parse(process.env).ORDERS_DB_PATH;

const dbConnection = drizzle(ordersDbPath);
const client = dbConnection.$client;
export const db = dbConnection;

export const ordersTable = sqliteTable("orders", {
  id: text("id").primaryKey(),
  sku: text("sku").notNull(),
  quantity: integer("quantity").notNull(),
  status: text("status").notNull(),
  eventId: text("event_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

function readPragmaValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return null;
  return String(value);
}

async function getOrdersDbJournalMode(): Promise<string> {
  const value = readPragmaValue(client.pragma("journal_mode", { simple: true }));
  return value?.toLowerCase() ?? "unknown";
}

export async function getOrdersDbRuntimeConfig() {
  return {
    path: ordersDbPath,
    journalMode: await getOrdersDbJournalMode(),
  };
}

export async function executeOrdersSql(statement: string) {
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

export async function initializeOrdersDb() {
  await mkdir(dirname(ordersDbPath), { recursive: true });
  client.pragma("journal_mode = WAL");

  db.run(sql`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      status TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_orders_created_at
    ON orders (created_at)
  `);
}
