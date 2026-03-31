import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

const DEFAULT_REGISTRY_DB_PATH = "./data/registry.sqlite";
const MIGRATIONS_FOLDER = resolve(import.meta.dirname, "../../drizzle");

let databaseCache:
  | {
      dbPath: string;
      db: ReturnType<typeof drizzle<typeof schema>>;
    }
  | undefined;

export function openRegistryDatabase(
  dbPath = process.env.REGISTRY_DB_PATH ?? DEFAULT_REGISTRY_DB_PATH,
) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle({ client: sqlite, schema });
  return db;
}

export type RegistryDatabase = ReturnType<typeof openRegistryDatabase>;

function initializeRegistryDatabase(
  dbPath = process.env.REGISTRY_DB_PATH ?? DEFAULT_REGISTRY_DB_PATH,
) {
  const db = openRegistryDatabase(dbPath);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

export function getRegistryDatabase(
  dbPath = process.env.REGISTRY_DB_PATH ?? DEFAULT_REGISTRY_DB_PATH,
): RegistryDatabase {
  if (databaseCache?.dbPath === dbPath) {
    return databaseCache.db;
  }

  databaseCache?.db.$client.close();
  const db = initializeRegistryDatabase(dbPath);
  databaseCache = { dbPath, db };
  return db;
}
