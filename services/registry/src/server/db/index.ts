import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";

export const DEFAULT_REGISTRY_DB_PATH = "./data/registry.sqlite";

export function openRegistryDatabase(
  dbPath = process.env.REGISTRY_DB_PATH ?? DEFAULT_REGISTRY_DB_PATH,
) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = drizzle(dbPath, { schema });
  db.$client.pragma("journal_mode = WAL");
  return db;
}

export async function initializeRegistryDatabase(
  dbPath = process.env.REGISTRY_DB_PATH ?? DEFAULT_REGISTRY_DB_PATH,
) {
  const db = openRegistryDatabase(dbPath);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS routes (
      host TEXT PRIMARY KEY NOT NULL,
      target TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      caddy_directives_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  return db;
}
