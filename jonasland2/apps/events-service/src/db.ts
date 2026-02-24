import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

const eventsDbPath = process.env.EVENTS_DB_PATH || "/var/lib/jonasland2/events-service.sqlite";

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

export async function initializeEventsDb() {
  await mkdir(dirname(eventsDbPath), { recursive: true });

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
