import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env.ts";
import type { CheckoutIndexEntry } from "./lib/tasks-api.ts";

/**
 * The project's checkout index: one SQLite Durable Object per project (named
 * by projectId) whose ONLY job is remembering which checkouts exist — the
 * checkout DOs themselves are unenumerable (their names hash away), so the
 * sidebar needs somewhere to ask. Checkout DOs report in on seed, join, and
 * commit; the capnweb `project.checkouts()` reads it back, newest first.
 */
export class TasksCheckoutIndexDurableObject extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS checkouts (
        repo_path TEXT NOT NULL,
        checkout_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_commit TEXT,
        PRIMARY KEY (repo_path, checkout_id)
      )
    `);
  }

  async record(input: {
    repoPath: string;
    checkoutId: string;
    baseCommit?: string;
  }): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO checkouts (repo_path, checkout_id, created_at, last_seen_at, last_commit)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (repo_path, checkout_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         last_commit = COALESCE(excluded.last_commit, checkouts.last_commit)`,
      input.repoPath,
      input.checkoutId,
      now,
      now,
      input.baseCommit ?? null,
    );
  }

  async list(): Promise<CheckoutIndexEntry[]> {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT repo_path, checkout_id, created_at, last_seen_at, last_commit
         FROM checkouts ORDER BY last_seen_at DESC`,
      )
      .toArray();
    return rows.map((row) => ({
      repoPath: String(row.repo_path),
      checkoutId: String(row.checkout_id),
      createdAt: Number(row.created_at),
      lastSeenAt: Number(row.last_seen_at),
      lastCommit: row.last_commit === null ? null : String(row.last_commit),
    }));
  }

  async forget(input: { repoPath: string; checkoutId: string }): Promise<void> {
    this.ctx.storage.sql.exec(
      `DELETE FROM checkouts WHERE repo_path = ? AND checkout_id = ?`,
      input.repoPath,
      input.checkoutId,
    );
  }
}
