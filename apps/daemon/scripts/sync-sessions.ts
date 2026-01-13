#!/usr/bin/env tsx
/* eslint-disable iterate/drizzle-conventions -- This uses better-sqlite3, not Drizzle */
/**
 * Standalone script to sync tmux sessions to SQLite.
 *
 * Called by tmux hooks (session-created, session-closed, session-renamed).
 * Uses better-sqlite3 directly for isolation and testability.
 *
 * Flow:
 * 1. List all tmux sessions
 * 2. Filter to agent_* sessions
 * 3. Upsert running sessions to DB
 * 4. Mark sessions not in tmux as stopped
 * 5. Optionally trigger resurrect save
 */

import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = join(__dirname, "..", "db.sqlite");

function getDbPath(): string {
  return process.env.DATABASE_PATH || DEFAULT_DB_PATH;
}

/**
 * Ensure the schema exists. Keep in sync with server/db/schema.ts.
 */
function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      slug TEXT PRIMARY KEY,
      harness_type TEXT NOT NULL DEFAULT 'claude-code',
      working_directory TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      initial_prompt TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

function listTmuxSessions(): string[] {
  try {
    const result = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
      encoding: "utf8",
    });
    return result.trim().split("\n").filter(Boolean);
  } catch {
    // tmux server not running or no sessions
    return [];
  }
}

function parseAgentSlug(sessionName: string): string | null {
  if (!sessionName.startsWith("agent_")) {
    return null;
  }
  const slug = sessionName.slice(6);
  // Filter out empty slugs (e.g., if session was named just "agent_")
  if (!slug) {
    return null;
  }
  return slug;
}

function syncSessions(db: Database.Database): { synced: number; stopped: number } {
  const tmuxSessions = listTmuxSessions();
  const agentSlugs = tmuxSessions.map(parseAgentSlug).filter((s): s is string => s !== null);

  // Use a transaction for atomicity
  const syncTransaction = db.transaction(() => {
    // Upsert running sessions
    const upsert = db.prepare(`
      INSERT INTO sessions (slug, status, updated_at)
      VALUES (?, 'running', unixepoch())
      ON CONFLICT(slug) DO UPDATE SET
        status = CASE WHEN status = 'error' THEN status ELSE 'running' END,
        updated_at = unixepoch()
    `);

    for (const slug of agentSlugs) {
      upsert.run(slug);
    }

    // Mark missing sessions as stopped (don't overwrite error status)
    const slugSet = new Set(agentSlugs);
    const runningSessions = db
      .prepare("SELECT slug FROM sessions WHERE status = ?")
      .all("running") as { slug: string }[];

    const markStopped = db.prepare(`
      UPDATE sessions SET status = 'stopped', updated_at = unixepoch() WHERE slug = ?
    `);

    let stoppedCount = 0;
    for (const row of runningSessions) {
      if (!slugSet.has(row.slug)) {
        markStopped.run(row.slug);
        stoppedCount++;
      }
    }

    return { synced: agentSlugs.length, stopped: stoppedCount };
  });

  return syncTransaction();
}

function triggerResurrectSave(): boolean {
  try {
    execSync("tmux run-shell '~/.tmux/plugins/tmux-resurrect/scripts/save.sh quiet' 2>/dev/null", {
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  const dbPath = getDbPath();
  const db = new Database(dbPath);

  try {
    ensureSchema(db);
    const result = syncSessions(db);

    // Trigger resurrect save after sync
    const saved = triggerResurrectSave();

    if (process.env.VERBOSE) {
      console.log(
        `Synced ${result.synced} sessions, marked ${result.stopped} as stopped, resurrect save: ${saved}`,
      );
    }
  } finally {
    db.close();
  }
}

main();
