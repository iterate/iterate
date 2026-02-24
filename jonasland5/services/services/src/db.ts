import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SqlResultSet } from "@jonasland5/shared";
import { drizzle } from "drizzle-orm/better-sqlite3";

export interface PersistedRoute {
  host: string;
  target: string;
  metadata: Record<string, string>;
  tags: string[];
  updatedAt: string;
}

export interface PersistedConfigEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

function toRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

function toTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseRouteRow(row: Record<string, unknown>): PersistedRoute {
  return {
    host: String(row.host ?? ""),
    target: String(row.target ?? ""),
    metadata: toRecord(parseJson(row.metadata_json)),
    tags: toTags(parseJson(row.tags_json)),
    updatedAt: String(row.updated_at ?? new Date(0).toISOString()),
  };
}

function parseConfigRow(row: Record<string, unknown>): PersistedConfigEntry {
  return {
    key: String(row.key ?? ""),
    value: parseJson(row.value_json),
    updatedAt: String(row.updated_at ?? new Date(0).toISOString()),
  };
}

export class ServicesStore {
  private readonly sqlite;

  private constructor(dbPath: string) {
    this.sqlite = drizzle(dbPath).$client;
  }

  static async open(dbPath: string): Promise<ServicesStore> {
    await mkdir(dirname(dbPath), { recursive: true });
    const store = new ServicesStore(dbPath);
    await store.bootstrap();
    return store;
  }

  async executeSql(statement: string): Promise<SqlResultSet> {
    const prepared = this.sqlite.prepare(statement);
    if (prepared.reader) {
      const headers = prepared.columns();
      const rows = prepared.raw().all() as unknown[][];
      return {
        columns: headers.map((header) => header.name),
        columnTypes: headers.map((header) => header.type ?? null),
        rows,
        rowsAffected: rows.length,
      };
    }

    const runResult = prepared.run();
    return {
      columns: [],
      columnTypes: [],
      rows: [],
      rowsAffected: runResult.changes,
      lastInsertRowid: runResult.lastInsertRowid,
    };
  }

  async close(): Promise<void> {
    this.sqlite.close();
  }

  async bootstrap(): Promise<void> {
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS routes (
        host TEXT PRIMARY KEY NOT NULL,
        target TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        tags_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async upsertRoute(input: {
    host: string;
    target: string;
    metadata?: Record<string, string>;
    tags?: string[];
  }): Promise<PersistedRoute> {
    const host = input.host.trim().toLowerCase();
    const target = input.target.trim();
    const metadata = toRecord(input.metadata ?? {});
    const tags = toTags(input.tags ?? []);
    const updatedAt = new Date().toISOString();

    this.sqlite
      .prepare(
        `
          INSERT INTO routes (host, target, metadata_json, tags_json, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(host) DO UPDATE SET
            target = excluded.target,
            metadata_json = excluded.metadata_json,
            tags_json = excluded.tags_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(host, target, JSON.stringify(metadata), JSON.stringify(tags), updatedAt);

    return {
      host,
      target,
      metadata,
      tags,
      updatedAt,
    };
  }

  async removeRoute(host: string): Promise<boolean> {
    const normalizedHost = host.trim().toLowerCase();
    const result = this.sqlite.prepare("DELETE FROM routes WHERE host = ?").run(normalizedHost);
    return result.changes > 0;
  }

  async listRoutes(): Promise<PersistedRoute[]> {
    const rows = this.sqlite
      .prepare(
        "SELECT host, target, metadata_json, tags_json, updated_at FROM routes ORDER BY host ASC",
      )
      .all() as Record<string, unknown>[];

    return rows.map((row) => parseRouteRow(row));
  }

  async getConfig(key: string): Promise<PersistedConfigEntry | null> {
    const row = this.sqlite
      .prepare("SELECT key, value_json, updated_at FROM config WHERE key = ? LIMIT 1")
      .get(key) as Record<string, unknown> | undefined;

    return row ? parseConfigRow(row) : null;
  }

  async setConfig(input: { key: string; value: unknown }): Promise<PersistedConfigEntry> {
    const updatedAt = new Date().toISOString();
    const key = input.key.trim();

    this.sqlite
      .prepare(
        `
          INSERT INTO config (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(key, JSON.stringify(input.value), updatedAt);

    return {
      key,
      value: input.value,
      updatedAt,
    };
  }

  async listConfig(): Promise<PersistedConfigEntry[]> {
    const rows = this.sqlite
      .prepare("SELECT key, value_json, updated_at FROM config ORDER BY key ASC")
      .all() as Record<string, unknown>[];

    return rows.map((row) => parseConfigRow(row));
  }
}
