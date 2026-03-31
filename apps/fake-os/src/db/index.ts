import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

export const DEFAULT_FAKE_OS_DB_PATH = "./data/fake-os.db";

export function openFakeOsDatabase(dbPath = process.env.DATABASE_URL ?? DEFAULT_FAKE_OS_DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = drizzle(dbPath, { schema });
  db.$client.pragma("journal_mode = WAL");
  migrate(db, { migrationsFolder: resolve("drizzle") });
  return db;
}

export const db = openFakeOsDatabase();
