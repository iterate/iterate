import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
