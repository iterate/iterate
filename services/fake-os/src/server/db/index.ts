import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";

export const DEFAULT_FAKE_OS_DB_PATH = "./data/fake-os.db";

export function openFakeOsDatabase(dbPath = process.env.DATABASE_URL ?? DEFAULT_FAKE_OS_DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true });
  return drizzle(dbPath, { schema });
}

export const db = openFakeOsDatabase();
