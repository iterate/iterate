import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";
import { ordersServiceEnvSchema } from "@jonasland2/orders-contract";
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

export async function initializeOrdersDb() {
  await mkdir(dirname(ordersDbPath), { recursive: true });

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
