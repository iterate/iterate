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
    `CREATE TABLE IF NOT EXISTS collab_bases(
       path TEXT PRIMARY KEY, version INTEGER NOT NULL, content TEXT NOT NULL)`,
  );
  return {
    append: async (path, epoch, ops) => {
      storage.transactionSync(() => {
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
          `UPDATE collab_sessions SET head_version = ? WHERE path = ?`,
          ops.at(-1)!.version + 1,
          path,
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
    putSnapshot: async (path, snapshot) => {
      storage.transactionSync(() => {
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
              version: row.version as number,
            }) satisfies PersistedCollabOp,
        ),
    dirtySessions: () =>
      sql
        .exec(`SELECT path FROM collab_sessions WHERE head_version > overlay_version`)
        .toArray()
        .map((row) => row.path as string),
    livePaths: () =>
      sql
        .exec(`SELECT path FROM collab_sessions`)
        .toArray()
        .map((row) => row.path as string),
    hasSession: (path) =>
      sql.exec(`SELECT 1 FROM collab_sessions WHERE path = ?`, path).toArray().length > 0,
    markFlushed: (path, version) => {
      sql.exec(`UPDATE collab_sessions SET overlay_version = ? WHERE path = ?`, version, path);
    },
    getBase: (path) => {
      const row = sql.exec(`SELECT * FROM collab_bases WHERE path = ?`, path).toArray()[0];
      if (!row) return null;
      return { content: row.content as string, version: row.version as number };
    },
    // A new baseline licenses pruning everything the old one retained.
    setBase: (path, base) => {
      storage.transactionSync(() => {
        sql.exec(
          `INSERT OR REPLACE INTO collab_bases(path, version, content) VALUES (?, ?, ?)`,
          path,
          base.version,
          base.content,
        );
        const snapshotVersion =
          (sql.exec(`SELECT version FROM collab_snapshots WHERE path = ?`, path).toArray()[0]
            ?.version as number | undefined) ?? base.version;
        sql.exec(
          `DELETE FROM collab_ops WHERE path = ? AND version < ?`,
          path,
          Math.min(base.version, snapshotVersion),
        );
      });
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
