import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";
import { ordersServiceEnvSchema } from "@jonasland5/orders-contract";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const ordersDbPath = ordersServiceEnvSchema.parse(process.env).ORDERS_DB_PATH;

const client = createClient({
  url: `file:${ordersDbPath}`,
});

export const db = drizzle(client);

export const ordersTable = sqliteTable("orders", {
  id: text("id").primaryKey(),
  sku: text("sku").notNull(),
  quantity: integer("quantity").notNull(),
  status: text("status").notNull(),
  eventId: text("event_id").notNull(),
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

export async function getOrdersDbJournalMode(): Promise<string> {
  const result = await client.execute("PRAGMA journal_mode;");
  const value = readPragmaValue(
    (result.rows[0] as Record<string, unknown> | undefined) ?? undefined,
    "journal_mode",
  );
  return value?.toLowerCase() ?? "unknown";
}

export async function getOrdersDbRuntimeConfig() {
  return {
    path: ordersDbPath,
    journalMode: await getOrdersDbJournalMode(),
  };
}

export async function executeOrdersSql(statement: string) {
  return client.execute(statement);
}

export async function initializeOrdersDb() {
  await mkdir(dirname(ordersDbPath), { recursive: true });
  await client.execute("PRAGMA journal_mode = WAL;");

  await db.run(sql`
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

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_orders_created_at
    ON orders (created_at)
  `);
}
