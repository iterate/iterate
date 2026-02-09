import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "./schema.ts";

const DATA_DIR = join(homedir(), ".iterate");
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = join(DATA_DIR, "discord.db");

export class DatabaseService {
  static readonly SCHEMA = schema;
  public readonly db: ReturnType<typeof drizzle<typeof schema>>;
  public readonly kv: {
    get: <T>(key: string) => Promise<T | null>;
    set: <T>(key: string, value: T) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };

  constructor(dbPath?: string) {
    this.db = drizzle({
      connection: dbPath ?? DB_PATH,
      casing: "snake_case",
      schema,
    });

    // Auto-create tables if they don't exist
    this.db.run(sql`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value BLOB
      )
    `);
    this.db.run(sql`
      CREATE TABLE IF NOT EXISTS session_to_thread (
        session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        directory TEXT NOT NULL
      )
    `);
    this.db.run(sql`CREATE INDEX IF NOT EXISTS session_idx ON session_to_thread(session_id)`);
    this.db.run(sql`CREATE INDEX IF NOT EXISTS thread_idx ON session_to_thread(thread_id)`);
    this.kv = {
      get: async <T>(key: string): Promise<T | null> => {
        const entry = await this.db.query.kv.findFirst({
          where: eq(schema.kv.key, key),
        });
        return entry ? (entry.value as T) : null;
      },
      set: async <T>(key: string, value: T): Promise<void> => {
        await this.db
          .insert(schema.kv)
          .values({ key, value })
          .onConflictDoUpdate({
            target: [schema.kv.key],
            set: { value },
          });
      },
      delete: async (key: string): Promise<void> => {
        await this.db.delete(schema.kv).where(eq(schema.kv.key, key));
      },
    };
  }
}
