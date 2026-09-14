import type { CollabSnapshot, PersistedCollabOp } from "./collab-engine.ts";
import type { CollabSessionStore } from "./collab-host.ts";

/** The Durable Object's storage backing: three tables, every multi-row write
 * in one transactionSync (output gates make the ack crash-durable). */
export function sqliteCollabStore(storage: {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(closure: () => T): T;
}): CollabSessionStore {
  const sql = storage.sql;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS collab_ops(
       path TEXT NOT NULL, epoch TEXT NOT NULL, version INTEGER NOT NULL,
       client_id TEXT NOT NULL, client_seq INTEGER NOT NULL, changes TEXT NOT NULL,
       PRIMARY KEY (path, epoch, version))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS collab_snapshots(
       path TEXT PRIMARY KEY, epoch TEXT NOT NULL, version INTEGER NOT NULL,
       content TEXT NOT NULL, client_seqs TEXT NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS collab_sessions(
       path TEXT PRIMARY KEY, epoch TEXT NOT NULL,
       head_version INTEGER NOT NULL, overlay_version INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS collab_ops_client_seq
       ON collab_ops(path, epoch, client_id, client_seq)`,
  );
  // Live objects born with the tracked-changes schema: the baseline table
  // and the accept-time column served only the redline fold, which is gone.
  sql.exec(`DROP TABLE IF EXISTS collab_bases`);
  const opsColumns = sql
    .exec(`PRAGMA table_info('collab_ops')`)
    .toArray()
    .map((row) => row.name);
  if (opsColumns.includes("created_at")) {
    sql.exec(`ALTER TABLE collab_ops DROP COLUMN created_at`);
  }
  return {
    // Every mutation is EPOCH-CONDITIONAL: a stale engine (whose session was
    // ended and reopened while its work sat on a queue) must fail loudly,
    // never advance the new session's state by path alone.
    append: async (path, epoch, ops) => {
      storage.transactionSync(() => {
        const live = sql
          .exec(`SELECT 1 FROM collab_sessions WHERE path = ? AND epoch = ?`, path, epoch)
          .toArray();
        if (live.length === 0) throw new Error(`stale collab session for ${path} — reopen`);
        for (const op of ops) {
          sql.exec(
            `INSERT INTO collab_ops(path, epoch, version, client_id, client_seq, changes)
             VALUES (?, ?, ?, ?, ?, ?)`,
            path,
            epoch,
            op.version,
            op.clientId,
            op.clientSeq,
            JSON.stringify(op.changes),
          );
        }
        sql.exec(
          `UPDATE collab_sessions SET head_version = ? WHERE path = ? AND epoch = ?`,
          ops.at(-1)!.version + 1,
          path,
          epoch,
        );
      });
    },
    getSnapshot: async (path) => {
      const row = sql.exec(`SELECT * FROM collab_snapshots WHERE path = ?`, path).toArray()[0];
      if (!row) return null;
      return {
        clientSeqs: JSON.parse(row.client_seqs as string) as Record<string, number>,
        content: row.content as string,
        epoch: row.epoch as string,
        version: row.version as number,
      } satisfies CollabSnapshot;
    },
    // The compaction point: snapshot upsert + covered-op pruning + session
    // birth (idempotent) are one atomic move. Ops below the snapshot are
    // never read again (rehydration replays from the snapshot), so the log
    // holds exactly the ops since it.
    putSnapshot: async (path, snapshot, opts) => {
      storage.transactionSync(() => {
        // A compaction is epoch-conditional exactly like append: after
        // endSession deleted the rows, a still-in-flight engine snapshot
        // must die loudly instead of re-birthing the session.
        if (opts?.birth !== true) {
          const live = sql
            .exec(
              `SELECT 1 FROM collab_sessions WHERE path = ? AND epoch = ?`,
              path,
              snapshot.epoch,
            )
            .toArray();
          if (live.length === 0) throw new Error(`stale collab session for ${path} — reopen`);
        }
        sql.exec(
          `INSERT OR REPLACE INTO collab_snapshots(path, epoch, version, content, client_seqs)
           VALUES (?, ?, ?, ?, ?)`,
          path,
          snapshot.epoch,
          snapshot.version,
          snapshot.content,
          JSON.stringify(snapshot.clientSeqs),
        );
        sql.exec(
          `INSERT OR IGNORE INTO collab_sessions(path, epoch, head_version, overlay_version)
           VALUES (?, ?, ?, ?)`,
          path,
          snapshot.epoch,
          snapshot.version,
          snapshot.version,
        );
        sql.exec(`DELETE FROM collab_ops WHERE path = ? AND version < ?`, path, snapshot.version);
      });
    },
    readOps: async (path, epoch, afterVersion) =>
      sql
        .exec(
          `SELECT * FROM collab_ops WHERE path = ? AND epoch = ? AND version > ? ORDER BY version`,
          path,
          epoch,
          afterVersion,
        )
        .toArray()
        .map(
          (row) =>
            ({
              changes: JSON.parse(row.changes as string),
              clientId: row.client_id as string,
              clientSeq: row.client_seq as number,
              version: row.version as number,
            }) satisfies PersistedCollabOp,
        ),
    sessions: () =>
      sql
        .exec(`SELECT path, head_version, overlay_version FROM collab_sessions`)
        .toArray()
        .map((row) => ({
          headVersion: row.head_version as number,
          overlayVersion: row.overlay_version as number,
          path: row.path as string,
        })),
    hasSession: (path) =>
      sql.exec(`SELECT 1 FROM collab_sessions WHERE path = ?`, path).toArray().length > 0,
    markFlushed: (path, version, epoch) => {
      sql.exec(
        `UPDATE collab_sessions SET overlay_version = ? WHERE path = ?${epoch === undefined ? "" : " AND epoch = ?"}`,
        ...(epoch === undefined ? [version, path] : [version, path, epoch]),
      );
    },
    endSession: (path) => {
      storage.transactionSync(() => {
        sql.exec(`DELETE FROM collab_sessions WHERE path = ?`, path);
        sql.exec(`DELETE FROM collab_snapshots WHERE path = ?`, path);
        sql.exec(`DELETE FROM collab_ops WHERE path = ?`, path);
      });
    },
  };
}
