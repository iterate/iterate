import { hashObject, type GitObjectType } from "./git-wire.ts";

/**
 * The repo Durable Object's durable git snapshot — the storage half of the
 * lazy lane and the SINGLE byte authority for lazy reads. Content-addressed
 * objects (chunked under the SQLite value cap) plus, per branch: the synced
 * head, a flat path→blob manifest, and the directory-tree listing (the
 * `have`s that make incremental fetches cheap).
 *
 * Lifecycle is bounded by construction: `installSnapshot` applies the
 * manifest delta and, in the same transaction, prunes every object no
 * longer reachable from any branch's manifest, dir listing, or head. The
 * store holds exactly the live snapshots — no eviction policy, no budget.
 *
 * Reads are verified: assembled chunks must match the recorded size and
 * re-hash to their oid. A corrupt row is deleted and reported, never served.
 */

const CHUNK_BYTES = 512 * 1024;

export class CorruptStoredObject extends Error {
  constructor(oid: string, detail: string) {
    super(`stored git object ${oid} is corrupt (${detail}) — deleted; rehydrate by oid`);
  }
}

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

export interface SnapshotDelta {
  commitOid: string;
  /** Full directory listing at the new head (small; replaced wholesale). */
  dirs: { path: string; treeOid: string }[];
  /** Manifest rows to delete (paths removed by this transition). */
  removes: string[];
  rootTreeOid: string;
  /** Manifest rows to insert or overwrite. */
  upserts: ManifestFile[];
}

export interface GitObjectStore {
  dirTrees(branch: string): { path: string; treeOid: string }[];
  /** Verified read: null when absent; throws CorruptStoredObject (and deletes) on damage. */
  getObject(oid: string): Promise<{ payload: Uint8Array; type: GitObjectType } | null>;
  hasObjects(oids: string[]): Set<string>;
  head(branch: string): StoredHead | null;
  manifest(branch: string): ManifestFile[];
  manifestEntries(branch: string, paths: string[]): (ManifestFile | null)[];
  putObjects(objects: { oid: string; payload: Uint8Array; type: GitObjectType }[]): void;
  /** Apply a head transition and prune unreachable objects — one transaction. */
  installSnapshot(branch: string, delta: SnapshotDelta): void;
  /** Total blob bytes referenced by a branch's manifest (drives the contentHash gate). */
  manifestByteSize(branch: string): number;
}

export function sqliteGitObjectStore(storage: {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(closure: () => T): T;
}): GitObjectStore {
  const sql = storage.sql;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS git_objects(
       oid TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL)`,
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

  const deleteObject = (oid: string) => {
    sql.exec(`DELETE FROM git_objects WHERE oid = ?`, oid);
    sql.exec(`DELETE FROM git_object_chunks WHERE oid = ?`, oid);
  };

  /** Bindings-list helper: `IN (?, ?, …)` for one chunk of values. */
  const chunked = <T>(values: T[], size = 100): T[][] => {
    const out: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
      out.push(values.slice(index, index + size));
    }
    return out;
  };

  return {
    dirTrees: (branch) =>
      sql
        .exec(`SELECT path, tree_oid FROM git_dir_trees WHERE branch = ?`, branch)
        .toArray()
        .map((row) => ({ path: row.path as string, treeOid: row.tree_oid as string })),

    getObject: async (oid) => {
      const row = sql.exec(`SELECT type, size FROM git_objects WHERE oid = ?`, oid).toArray()[0];
      if (row === undefined) return null;
      const chunks = sql
        .exec(`SELECT idx, bytes FROM git_object_chunks WHERE oid = ? ORDER BY idx`, oid)
        .toArray();
      const payload = new Uint8Array(
        chunks.reduce((total, chunk) => total + (chunk.bytes as ArrayBuffer).byteLength, 0),
      );
      let cursor = 0;
      let contiguous = true;
      for (const [index, chunk] of chunks.entries()) {
        if ((chunk.idx as number) !== index) contiguous = false;
        payload.set(new Uint8Array(chunk.bytes as ArrayBuffer), cursor);
        cursor += (chunk.bytes as ArrayBuffer).byteLength;
      }
      const type = row.type as GitObjectType;
      if (!contiguous || payload.length !== (row.size as number)) {
        deleteObject(oid);
        throw new CorruptStoredObject(oid, `assembled ${payload.length}B of ${row.size}B`);
      }
      if ((await hashObject(type, payload)) !== oid) {
        deleteObject(oid);
        throw new CorruptStoredObject(oid, "content does not hash to its oid");
      }
      return { payload, type };
    },

    hasObjects: (oids) => {
      const present = new Set<string>();
      for (const group of chunked([...new Set(oids)])) {
        const rows = sql
          .exec(
            `SELECT oid FROM git_objects WHERE oid IN (${group.map(() => "?").join(",")})`,
            ...group,
          )
          .toArray();
        for (const row of rows) present.add(row.oid as string);
      }
      return present;
    },

    head: (branch) => {
      const row = sql
        .exec(`SELECT commit_oid, root_tree_oid FROM git_heads WHERE branch = ?`, branch)
        .toArray()[0];
      return row === undefined
        ? null
        : { commitOid: row.commit_oid as string, rootTreeOid: row.root_tree_oid as string };
    },

    installSnapshot: (branch, delta) => {
      storage.transactionSync(() => {
        for (const group of chunked(delta.removes)) {
          sql.exec(
            `DELETE FROM git_manifest WHERE branch = ? AND path IN (${group.map(() => "?").join(",")})`,
            branch,
            ...group,
          );
        }
        for (const file of delta.upserts) {
          sql.exec(
            `INSERT INTO git_manifest(branch, path, blob_oid, mode) VALUES (?, ?, ?, ?)
               ON CONFLICT(branch, path) DO UPDATE SET blob_oid = excluded.blob_oid,
                                                       mode = excluded.mode`,
            branch,
            file.path,
            file.blobOid,
            file.mode,
          );
        }
        sql.exec(`DELETE FROM git_dir_trees WHERE branch = ?`, branch);
        for (const dir of delta.dirs) {
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
          delta.commitOid,
          delta.rootTreeOid,
        );
        // The lifecycle: everything unreachable from the LIVE snapshots (any
        // branch's manifest blobs, dir trees, or head commit) goes, in the
        // same transaction that made it unreachable. No policy, no budget —
        // the store holds exactly the current working set.
        sql.exec(
          `DELETE FROM git_objects WHERE oid NOT IN (
             SELECT blob_oid FROM git_manifest
             UNION SELECT tree_oid FROM git_dir_trees
             UNION SELECT commit_oid FROM git_heads
           )`,
        );
        sql.exec(`DELETE FROM git_object_chunks WHERE oid NOT IN (SELECT oid FROM git_objects)`);
      });
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

    manifestByteSize: (branch) =>
      (sql
        .exec(
          `SELECT COALESCE(SUM(o.size), 0) AS total
             FROM git_manifest m JOIN git_objects o ON o.oid = m.blob_oid
            WHERE m.branch = ?`,
          branch,
        )
        .toArray()[0]?.total ?? 0) as number,

    manifestEntries: (branch, paths) => {
      const byPath = new Map<string, ManifestFile>();
      for (const group of chunked(paths)) {
        const rows = sql
          .exec(
            `SELECT path, blob_oid, mode FROM git_manifest
              WHERE branch = ? AND path IN (${group.map(() => "?").join(",")})`,
            branch,
            ...group,
          )
          .toArray();
        for (const row of rows) {
          byPath.set(row.path as string, {
            blobOid: row.blob_oid as string,
            mode: row.mode as string,
            path: row.path as string,
          });
        }
      }
      return paths.map((path) => byPath.get(path) ?? null);
    },

    putObjects: (objects) => {
      storage.transactionSync(() => {
        const present = new Set<string>();
        for (const group of chunked([...new Set(objects.map((object) => object.oid))])) {
          const rows = sql
            .exec(
              `SELECT oid FROM git_objects WHERE oid IN (${group.map(() => "?").join(",")})`,
              ...group,
            )
            .toArray();
          for (const row of rows) present.add(row.oid as string);
        }
        for (const object of objects) {
          if (present.has(object.oid)) continue;
          present.add(object.oid);
          sql.exec(
            `INSERT INTO git_objects(oid, type, size) VALUES (?, ?, ?)`,
            object.oid,
            object.type,
            object.payload.length,
          );
          // Zero-length payloads store no chunk rows; chunks are copies, not
          // subarray views (binding views is driver-dependent for offsets).
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
  };
}
