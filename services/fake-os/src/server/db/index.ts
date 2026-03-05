import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";

const dbPath = process.env.DATABASE_URL ?? "./data/fake-os.db";
mkdirSync(dirname(dbPath), { recursive: true });

export const db = drizzle(dbPath, { schema });
