import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = join(homedir(), ".iterate/slack.sqlite");

let db: Database.Database | null = null;

/**
 * Get the SQLite database instance, creating it if needed.
 * Runs migrations on first access.
 */
export function getDb(): Database.Database {
  if (db) return db;

  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

/**
 * Run database migrations using simple CREATE IF NOT EXISTS statements.
 */
function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      external_id TEXT UNIQUE,
      channel TEXT,
      thread_ts TEXT,
      payload TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_events_external_id ON events(external_id);
    CREATE INDEX IF NOT EXISTS idx_events_channel_thread ON events(channel, thread_ts);
  `);
}

export interface SlackEvent {
  id: string;
  type: string;
  externalId: string | null;
  channel: string | null;
  threadTs: string | null;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

/**
 * Store a Slack webhook event. Uses INSERT OR IGNORE for idempotency.
 */
export function storeEvent(
  id: string,
  externalId: string | null,
  channel: string | null,
  threadTs: string | null,
  payload: unknown,
): void {
  getDb()
    .prepare(
      `
    INSERT OR IGNORE INTO events (id, type, external_id, channel, thread_ts, payload)
    VALUES (?, 'slack:webhook', ?, ?, ?, ?)
  `,
    )
    .run(id, externalId, channel, threadTs, JSON.stringify(payload));
}

/**
 * Check if an event with the given external ID already exists.
 */
export function eventExists(externalId: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM events WHERE external_id = ?").get(externalId);
  return row !== undefined;
}

/**
 * Find the thread_ts for a message by searching stored events.
 */
export function findThreadTs(channel: string, messageTs: string): string | null {
  interface EventRow {
    payload: string;
  }

  const events = getDb()
    .prepare<[string], EventRow>(
      `
    SELECT payload FROM events
    WHERE channel = ? AND type = 'slack:webhook'
    ORDER BY created_at DESC
  `,
    )
    .all(channel);

  for (const row of events) {
    const payload = JSON.parse(row.payload) as {
      event?: { ts?: string; thread_ts?: string };
    };
    if (payload.event?.ts === messageTs) {
      return payload.event.thread_ts ?? messageTs;
    }
  }

  return null;
}
