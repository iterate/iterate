import type { CollabSnapshot, PersistedCollabOp } from "./collab-engine.ts";
import type { CollabSessionStore } from "./collab-host.ts";

/** The Durable Object's storage backing: four tables, every multi-row write
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
       created_at INTEGER NOT NULL DEFAULT 0,
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
    `CREATE TABLE IF NOT EXISTS collab_bases(
       path TEXT PRIMARY KEY, version INTEGER NOT NULL, content TEXT NOT NULL)`,
  );
  sql.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS collab_ops_client_seq
       ON collab_ops(path, epoch, client_id, client_seq)`,
  );
  // Live objects born before created_at existed: CREATE TABLE IF NOT EXISTS
  // skips their table, so bring the schema forward explicitly.
  const opsColumns = sql
    .exec(`PRAGMA table_info('collab_ops')`)
    .toArray()
    .map((row) => row.name);
  if (!opsColumns.includes("created_at")) {
    sql.exec(`ALTER TABLE collab_ops ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`);
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
        if (!live.length) throw new Error(`stale collab session for ${path} — reopen`);
        for (const op of ops) {
          sql.exec(
            `INSERT INTO collab_ops(path, epoch, version, client_id, client_seq, changes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            path,
            epoch,
            op.version,
            op.clientId,
            op.clientSeq,
            JSON.stringify(op.changes),
            op.createdAt ?? 0,
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
    // AND baseline birth (idempotent) are one atomic move. Pruning keeps ops
    // back to the redline baseline — the op log is the tracked-changes data,
    // bounded by commit cadence.
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
          if (!live.length) throw new Error(`stale collab session for ${path} — reopen`);
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
        sql.exec(
          `INSERT OR IGNORE INTO collab_bases(path, version, content)
           VALUES (?, ?, ?)`,
          path,
          snapshot.version,
          snapshot.content,
        );
        const baseVersion =
          (sql.exec(`SELECT version FROM collab_bases WHERE path = ?`, path).toArray()[0]
            ?.version as number | undefined) ?? snapshot.version;
        sql.exec(
          `DELETE FROM collab_ops WHERE path = ? AND version < ?`,
          path,
          Math.min(snapshot.version, baseVersion),
        );
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
              createdAt: (row.created_at as number) || undefined,
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
      !!sql.exec(`SELECT 1 FROM collab_sessions WHERE path = ?`, path).toArray().length,
    markFlushed: (path, version, epoch) => {
      sql.exec(
        `UPDATE collab_sessions SET overlay_version = ? WHERE path = ?${epoch ? " AND epoch = ?" : ""}`,
        ...(epoch ? [version, path, epoch] : [version, path]),
      );
    },
    // One atomic transition for every baseline a commit stamps: partial
    // multi-file advancement after a crash is unrepresentable.
    setBases: (files) => {
      storage.transactionSync(() => {
        for (const file of files) {
          const live = sql
            .exec(
              `SELECT 1 FROM collab_sessions WHERE path = ? AND epoch = ?`,
              file.path,
              file.epoch,
            )
            .toArray();
          if (!live.length) continue; // session ended mid-commit — nothing to stamp
          sql.exec(
            `INSERT OR REPLACE INTO collab_bases(path, version, content) VALUES (?, ?, ?)`,
            file.path,
            file.version,
            file.content,
          );
          const snapshotVersion =
            (sql.exec(`SELECT version FROM collab_snapshots WHERE path = ?`, file.path).toArray()[0]
              ?.version as number | undefined) ?? file.version;
          sql.exec(
            `DELETE FROM collab_ops WHERE path = ? AND version < ?`,
            file.path,
            Math.min(file.version, snapshotVersion),
          );
        }
      });
    },
    getBase: (path) => {
      const row = sql.exec(`SELECT * FROM collab_bases WHERE path = ?`, path).toArray()[0];
      if (!row) return null;
      return { content: row.content as string, version: row.version as number };
    },
    endSession: (path) => {
      storage.transactionSync(() => {
        sql.exec(`DELETE FROM collab_sessions WHERE path = ?`, path);
        sql.exec(`DELETE FROM collab_snapshots WHERE path = ?`, path);
        sql.exec(`DELETE FROM collab_ops WHERE path = ?`, path);
        sql.exec(`DELETE FROM collab_bases WHERE path = ?`, path);
      });
    },
  };
}
