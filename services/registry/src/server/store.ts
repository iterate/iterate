import type { SqlResultSet } from "@iterate-com/shared/jonasland";
import { openRegistryDatabase } from "./db/index.ts";

export interface PersistedRoute {
  host: string;
  target: string;
  metadata: Record<string, string>;
  tags: string[];
  caddyDirectives: string[];
  updatedAt: string;
}

interface PersistedConfigEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

function toRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
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

function toCaddyDirectives(value: unknown): string[] {
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
    caddyDirectives: toCaddyDirectives(parseJson(row.caddy_directives_json)),
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
    this.sqlite = openRegistryDatabase(dbPath).$client;
  }

  static async open(dbPath: string): Promise<ServicesStore> {
    return new ServicesStore(dbPath);
  }

  async executeSql(statement: string): Promise<SqlResultSet> {
    const prepared = this.sqlite.prepare(statement);
    if (prepared.reader) {
      const headers = prepared.columns() as Array<{ name: string; type?: string | null }>;
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

  async upsertRoute(input: {
    host: string;
    target: string;
    metadata?: Record<string, string>;
    tags?: string[];
    caddyDirectives?: string[];
  }): Promise<PersistedRoute> {
    const host = input.host.trim().toLowerCase();
    const target = input.target.trim();
    const metadata = toRecord(input.metadata ?? {});
    const tags = toTags(input.tags ?? []);
    const caddyDirectives = toCaddyDirectives(input.caddyDirectives ?? []);
    const updatedAt = new Date().toISOString();

    this.sqlite
      .prepare(
        `
          INSERT INTO routes (host, target, metadata_json, tags_json, caddy_directives_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(host) DO UPDATE SET
            target = excluded.target,
            metadata_json = excluded.metadata_json,
            tags_json = excluded.tags_json,
            caddy_directives_json = excluded.caddy_directives_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        host,
        target,
        JSON.stringify(metadata),
        JSON.stringify(tags),
        JSON.stringify(caddyDirectives),
        updatedAt,
      );

    return {
      host,
      target,
      metadata,
      tags,
      caddyDirectives,
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
        "SELECT host, target, metadata_json, tags_json, caddy_directives_json, updated_at FROM routes ORDER BY host ASC",
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
