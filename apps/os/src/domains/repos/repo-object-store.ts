import type { GitObjectType } from "./git-wire.ts";

/**
 * The repo Durable Object's persistent git object cache — the storage half of
 * the lazy read path. Objects are immutable and content-addressed, so rows
 * never invalidate: a head move only ADDS objects. What changes per branch is
 * the synced head, its flat file manifest (path → blob), and the directory
 * tree listing (the `have`s that make incremental fetches cheap).
 *
 * Blob payloads are chunked well under the Durable Object SQLite value cap.
 * Blobs are LRU-evictable (they can always be re-fetched by exact oid); trees
 * and commits are small, load-bearing for sync diffing, and never evicted.
 */

const CHUNK_BYTES = 512 * 1024;

export interface StoredHead {
  commitOid: string;
  rootTreeOid: string;
}

export interface ManifestFile {
  blobOid: string;
  /** Octal mode string: 100644, 100755, or 120000 (symlinks read as their target path). */
  mode: string;
  path: string;
}

export interface GitObjectStore {
  dirTreeOids(branch: string): string[];
  getObject(oid: string): { payload: Uint8Array; type: GitObjectType } | null;
  hasObject(oid: string): boolean;
  head(branch: string): StoredHead | null;
  manifest(branch: string): ManifestFile[];
  manifestEntries(branch: string, paths: string[]): (ManifestFile | null)[];
  putObjects(objects: { oid: string; payload: Uint8Array; type: GitObjectType }[]): void;
  replaceManifest(
    branch: string,
    input: {
      commitOid: string;
      dirs: { path: string; treeOid: string }[];
      files: ManifestFile[];
      rootTreeOid: string;
    },
  ): void;
  /** Evict least-recently-read blobs until total blob bytes ≤ budget. */
  evictBlobs(budgetBytes: number): number;
  touchBlobs(oids: string[]): void;
}

export function sqliteGitObjectStore(storage: {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(closure: () => T): T;
}): GitObjectStore {
  const sql = storage.sql;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS git_objects(
       oid TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL,
       last_read INTEGER NOT NULL DEFAULT 0)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS git_object_chunks(
       oid TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL,
       PRIMARY KEY (oid, idx))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS git_heads(
       branch TEXT PRIMARY KEY, commit_oid TEXT NOT NULL, root_tree_oid TEXT NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS git_manifest(
       branch TEXT NOT NULL, path TEXT NOT NULL, blob_oid TEXT NOT NULL, mode TEXT NOT NULL,
       PRIMARY KEY (branch, path))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS git_dir_trees(
       branch TEXT NOT NULL, path TEXT NOT NULL, tree_oid TEXT NOT NULL,
       PRIMARY KEY (branch, path))`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS git_objects_blob_lru ON git_objects(last_read) WHERE type = 'blob'`,
  );

  let readClock = Date.now();

  const readPayload = (oid: string): Uint8Array => {
    const chunks = sql
      .exec(`SELECT bytes FROM git_object_chunks WHERE oid = ? ORDER BY idx`, oid)
      .toArray()
      .map((row) => new Uint8Array(row.bytes as ArrayBuffer));
    const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let cursor = 0;
    for (const chunk of chunks) {
      out.set(chunk, cursor);
      cursor += chunk.length;
    }
    return out;
  };

  return {
    dirTreeOids: (branch) =>
      sql
        .exec(`SELECT tree_oid FROM git_dir_trees WHERE branch = ?`, branch)
        .toArray()
        .map((row) => row.tree_oid as string),

    evictBlobs: (budgetBytes) => {
      return storage.transactionSync(() => {
        const total = (sql
          .exec(`SELECT COALESCE(SUM(size), 0) AS total FROM git_objects WHERE type = 'blob'`)
          .toArray()[0]?.total ?? 0) as number;
        let excess = total - budgetBytes;
        if (excess <= 0) return 0;
        let evicted = 0;
        // Never evict a blob the CURRENT manifests still reference cheaply?
        // Deliberately allowed: manifest blobs re-hydrate by exact oid. LRU
        // order keeps hot board files resident in practice.
        const victims = sql
          .exec(`SELECT oid, size FROM git_objects WHERE type = 'blob' ORDER BY last_read ASC`)
          .toArray();
        for (const victim of victims) {
          if (excess <= 0) break;
          sql.exec(`DELETE FROM git_objects WHERE oid = ?`, victim.oid);
          sql.exec(`DELETE FROM git_object_chunks WHERE oid = ?`, victim.oid);
          excess -= victim.size as number;
          evicted += 1;
        }
        return evicted;
      });
    },

    getObject: (oid) => {
      const row = sql.exec(`SELECT type FROM git_objects WHERE oid = ?`, oid).toArray()[0];
      if (row === undefined) return null;
      return { payload: readPayload(oid), type: row.type as GitObjectType };
    },

    hasObject: (oid) =>
      sql.exec(`SELECT 1 AS one FROM git_objects WHERE oid = ?`, oid).toArray().length > 0,

    head: (branch) => {
      const row = sql
        .exec(`SELECT commit_oid, root_tree_oid FROM git_heads WHERE branch = ?`, branch)
        .toArray()[0];
      return row === undefined
        ? null
        : { commitOid: row.commit_oid as string, rootTreeOid: row.root_tree_oid as string };
    },

    manifest: (branch) =>
      sql
        .exec(
          `SELECT path, blob_oid, mode FROM git_manifest WHERE branch = ? ORDER BY path`,
          branch,
        )
        .toArray()
        .map((row) => ({
          blobOid: row.blob_oid as string,
          mode: row.mode as string,
          path: row.path as string,
        })),

    manifestEntries: (branch, paths) =>
      paths.map((path) => {
        const row = sql
          .exec(
            `SELECT blob_oid, mode FROM git_manifest WHERE branch = ? AND path = ?`,
            branch,
            path,
          )
          .toArray()[0];
        return row === undefined
          ? null
          : { blobOid: row.blob_oid as string, mode: row.mode as string, path };
      }),

    putObjects: (objects) => {
      storage.transactionSync(() => {
        for (const object of objects) {
          const exists =
            sql.exec(`SELECT 1 AS one FROM git_objects WHERE oid = ?`, object.oid).toArray()
              .length > 0;
          if (exists) continue;
          sql.exec(
            `INSERT INTO git_objects(oid, type, size, last_read) VALUES (?, ?, ?, ?)`,
            object.oid,
            object.type,
            object.payload.length,
            readClock,
          );
          // Zero-length payloads store no chunk rows (an empty read is the
          // empty payload); chunks are copied, not subarray views — binding a
          // view is driver-dependent for offsets and NULLs empty slices.
          for (let index = 0; index * CHUNK_BYTES < object.payload.length; index++) {
            sql.exec(
              `INSERT INTO git_object_chunks(oid, idx, bytes) VALUES (?, ?, ?)`,
              object.oid,
              index,
              object.payload.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
            );
          }
        }
      });
    },

    replaceManifest: (branch, input) => {
      storage.transactionSync(() => {
        sql.exec(`DELETE FROM git_manifest WHERE branch = ?`, branch);
        sql.exec(`DELETE FROM git_dir_trees WHERE branch = ?`, branch);
        for (const file of input.files) {
          sql.exec(
            `INSERT INTO git_manifest(branch, path, blob_oid, mode) VALUES (?, ?, ?, ?)`,
            branch,
            file.path,
            file.blobOid,
            file.mode,
          );
        }
        for (const dir of input.dirs) {
          sql.exec(
            `INSERT INTO git_dir_trees(branch, path, tree_oid) VALUES (?, ?, ?)`,
            branch,
            dir.path,
            dir.treeOid,
          );
        }
        sql.exec(
          `INSERT INTO git_heads(branch, commit_oid, root_tree_oid) VALUES (?, ?, ?)
             ON CONFLICT(branch) DO UPDATE SET commit_oid = excluded.commit_oid,
                                               root_tree_oid = excluded.root_tree_oid`,
          branch,
          input.commitOid,
          input.rootTreeOid,
        );
      });
    },

    touchBlobs: (oids) => {
      readClock = Math.max(readClock + 1, Date.now());
      storage.transactionSync(() => {
        for (const oid of oids) {
          sql.exec(`UPDATE git_objects SET last_read = ? WHERE oid = ?`, readClock, oid);
        }
      });
    },
  };
}
