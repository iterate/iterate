import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient, type ResultSet } from "@libsql/client";

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
  private readonly client;

  private constructor(dbPath: string) {
    this.client = createClient({ url: `file:${dbPath}` });
  }

  static async open(dbPath: string): Promise<ServicesStore> {
    await mkdir(dirname(dbPath), { recursive: true });
    const store = new ServicesStore(dbPath);
    await store.bootstrap();
    return store;
  }

  async executeSql(statement: string): Promise<ResultSet> {
    return await this.client.execute(statement);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async bootstrap(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS routes (
        host TEXT PRIMARY KEY NOT NULL,
        target TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        tags_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      )
    `);

    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
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

    await this.client.execute({
      sql: `
        INSERT INTO routes (host, target, metadata_json, tags_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET
          target = excluded.target,
          metadata_json = excluded.metadata_json,
          tags_json = excluded.tags_json,
          updated_at = excluded.updated_at
      `,
      args: [host, target, JSON.stringify(metadata), JSON.stringify(tags), updatedAt],
    });

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
    const result = await this.client.execute({
      sql: "DELETE FROM routes WHERE host = ?",
      args: [normalizedHost],
    });
    return (result.rowsAffected ?? 0) > 0;
  }

  async listRoutes(): Promise<PersistedRoute[]> {
    const result = await this.client.execute({
      sql: "SELECT host, target, metadata_json, tags_json, updated_at FROM routes ORDER BY host ASC",
      args: [],
    });

    return result.rows.map((row) => parseRouteRow(row as Record<string, unknown>));
  }

  async getConfig(key: string): Promise<PersistedConfigEntry | null> {
    const result = await this.client.execute({
      sql: "SELECT key, value_json, updated_at FROM config WHERE key = ? LIMIT 1",
      args: [key],
    });

    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseConfigRow(row) : null;
  }

  async setConfig(input: { key: string; value: unknown }): Promise<PersistedConfigEntry> {
    const updatedAt = new Date().toISOString();
    const key = input.key.trim();

    await this.client.execute({
      sql: `
        INSERT INTO config (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `,
      args: [key, JSON.stringify(input.value), updatedAt],
    });

    return {
      key,
      value: input.value,
      updatedAt,
    };
  }

  async listConfig(): Promise<PersistedConfigEntry[]> {
    const result = await this.client.execute({
      sql: "SELECT key, value_json, updated_at FROM config ORDER BY key ASC",
      args: [],
    });

    return result.rows.map((row) => parseConfigRow(row as Record<string, unknown>));
  }
}
