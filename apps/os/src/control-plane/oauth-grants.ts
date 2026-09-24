// src/control-plane/oauth-grants.ts — THE OAUTH PROVIDER'S GRANTS: the `grant:<userId>:<grantId>`
// records @cloudflare/workers-oauth-provider keeps (the code's hash and PKCE challenge, the current
// and previous refresh token hashes, the encrypted props), as a table in the control plane's SQLite
// (durable-object.ts), not in KV. The provider rewrites a grant on the code exchange and on every
// refresh, and the next refresh must read that write. KV does not promise it: a location that
// cached a key keeps serving its copy for up to 60 s after another location wrote a new one. A
// refresh reaching the location that ran consent, one second after the exchange ran at another,
// read the grant as consent wrote it, with no refresh token yet, and was refused `invalid_grant:
// Invalid refresh token` (CI, 2026-09-23: 34 refreshes, each ~1 s after an exchange served by the
// other of IAD/EWR). One object reads its own writes.
//
// The provider's KV semantics are kept (oauth-store.ts is the KV-shaped face): an expiry, absolute
// or relative, after which a row reads as absent (purged on the next write); a key-ordered,
// prefix-scoped, cursor-paged list. No `await` in this file: a unit test drives it over node:sqlite
// (oauth-grants.test.ts).
import type { SqlStorageHandle } from "iterate/next/stream/processor";

/** KV's page size cap: `list` answers at most this many keys. */
const LIST_LIMIT_MAX = 1000;

/** A page of keys, as KV's `list` answers it. `cursor` is the last key answered. */
export type OAuthGrantListing = {
  keys: { name: string; expiration?: number }[];
  list_complete: boolean;
  cursor?: string;
};

export class OAuthGrantTable {
  readonly #sql: SqlStorageHandle;

  constructor(sql: SqlStorageHandle) {
    this.#sql = sql;
    // expires_at: epoch seconds (KV's unit), NULL for a row that never expires.
    sql.exec(
      "CREATE TABLE IF NOT EXISTS oauth_grants (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS oauth_grants_expiry ON oauth_grants (expires_at)");
  }

  /** The grant's JSON, or null when absent or expired at `now` (epoch seconds). */
  get(key: string, now: number): string | null {
    const [row] = this.#sql
      .exec<{ value: string }>(
        "SELECT value FROM oauth_grants WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
        key,
        now,
      )
      .toArray();
    return row?.value ?? null;
  }

  /** Write the grant whole, as KV's `put` does: a put without an expiry leaves a row that never
   *  expires. Every expired row goes first, so the table holds only live grants plus whatever
   *  expired since the last write. */
  put(key: string, value: string, expiresAt: number | null, now: number): void {
    this.#sql.exec("DELETE FROM oauth_grants WHERE expires_at <= ?", now);
    this.#sql.exec(
      "INSERT INTO oauth_grants (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      key,
      value,
      expiresAt,
    );
  }

  delete(key: string): void {
    this.#sql.exec("DELETE FROM oauth_grants WHERE key = ?", key);
  }

  /** The live keys starting with `prefix`, in key order, after `cursor`. A prefix is compared as
   *  text, never as a LIKE pattern: a user id's `_` is a LIKE wildcard. */
  list(
    prefix: string,
    options: { cursor?: string; limit?: number },
    now: number,
  ): OAuthGrantListing {
    const limit = Math.min(options.limit ?? LIST_LIMIT_MAX, LIST_LIMIT_MAX);
    const rows = this.#sql
      .exec<{ key: string; expires_at: number | null }>(
        "SELECT key, expires_at FROM oauth_grants WHERE substr(key, 1, ?) = ? AND key > ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?",
        prefix.length,
        prefix,
        options.cursor || "",
        now,
        limit + 1,
      )
      .toArray();
    const page = rows.slice(0, limit);
    const keys = page.map((row) =>
      row.expires_at === null ? { name: row.key } : { name: row.key, expiration: row.expires_at },
    );
    if (rows.length <= limit) return { keys, list_complete: true };
    return { keys, list_complete: false, cursor: page.at(-1)!.key };
  }
}
