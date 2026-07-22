import {
  buildPack,
  encodeCommit,
  encodeTree,
  hashObject,
  parseCommit,
  parseTree,
  type GitWireTransport,
  type RawGitObject,
  type TreeEntry,
} from "./git-wire.ts";
import type { GitObjectStore, ManifestFile, StoredHead } from "./repo-object-store.ts";

/**
 * The lazy repo lane: reads and commits against the Artifacts remote without
 * ever cloning. Composition of the two layers below it —
 *
 *   wire  (git-wire.ts)          what the server speaks
 *   store (repo-object-store.ts) what this object remembers durably
 *
 * Sync transfers the delta between the remote head and the store: one fetch
 * wanting the new head with every KNOWN directory tree as a `have`, which the
 * server (probed) excludes recursively — unchanged subtrees never ride the
 * wire again. First-ever sync has no haves and ingests the whole snapshot
 * once; that cost is durable, not per-wake, because the store is SQLite.
 * Reads hydrate missing blobs by exact oid. Commits are built locally from
 * the manifest (new blobs + rebuilt ancestor trees + commit), pushed as a
 * self-contained pack with a compare-and-swap on the old head, and primed
 * back into the store — a post-commit read fetches nothing.
 */

export class LazyRepoConflict extends Error {
  constructor(detail: string) {
    super(`lazy commit rejected by the remote (ref moved?): ${detail}`);
  }
}

export type LazyChange =
  | { content: string; path: string }
  | { contentBase64: string; path: string }
  | { delete: true; path: string };

const GITLINK_MODE = "160000";
const DIR_MODE = "40000";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function createLazyRepoReader(input: {
  branch: string;
  store: GitObjectStore;
  wire: GitWireTransport;
}) {
  const { branch, store, wire } = input;
  let syncing: Promise<StoredHead> | null = null;

  const resolveTree = (oid: string, fromPack: Map<string, RawGitObject>): TreeEntry[] => {
    const packed = fromPack.get(oid);
    if (packed !== undefined) {
      if (packed.type !== "tree") throw new Error(`object ${oid} is a ${packed.type}, not a tree`);
      return parseTree(packed.payload);
    }
    const stored = store.getObject(oid);
    if (stored === null || stored.type !== "tree") {
      throw new Error(`tree ${oid} is in neither the sync pack nor the store`);
    }
    return parseTree(stored.payload);
  };

  const walkManifest = (
    rootTreeOid: string,
    fromPack: Map<string, RawGitObject>,
  ): { dirs: { path: string; treeOid: string }[]; files: ManifestFile[] } => {
    const files: ManifestFile[] = [];
    const dirs: { path: string; treeOid: string }[] = [];
    const walk = (treeOid: string, prefix: string) => {
      dirs.push({ path: prefix, treeOid });
      for (const entry of resolveTree(treeOid, fromPack)) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === DIR_MODE) walk(entry.oid, path);
        else files.push({ blobOid: entry.oid, mode: entry.mode, path });
      }
    };
    walk(rootTreeOid, "");
    return { dirs, files };
  };

  const syncOnce = async (targetOid?: string): Promise<StoredHead> => {
    const target =
      targetOid ??
      (await wire.lsRefs([`refs/heads/${branch}`])).find(
        // gitty ignores ref-prefix filters (probed) — match by exact name.
        (ref) => ref.name === `refs/heads/${branch}`,
      )?.oid;
    if (target === undefined) throw new Error(`remote has no refs/heads/${branch}`);
    const current = store.head(branch);
    if (current?.commitOid === target) return current;
    const objects = await wire.fetchObjects({
      deepen: 1,
      haves: store.dirTreeOids(branch),
      wants: [target],
    });
    const fromPack = new Map(objects.map((object) => [object.oid, object]));
    const commit = fromPack.get(target);
    if (commit === undefined || commit.type !== "commit") {
      // Wants for unknown oids are silently dropped by the server — surface
      // the inconsistency instead of persisting a half-synced head.
      throw new Error(`sync fetch did not return commit ${target}`);
    }
    const rootTreeOid = parseCommit(commit.payload).tree;
    const manifest = walkManifest(rootTreeOid, fromPack);
    store.putObjects(objects);
    store.replaceManifest(branch, { commitOid: target, rootTreeOid, ...manifest });
    return { commitOid: target, rootTreeOid };
  };

  const hydrate = async (oids: string[]): Promise<void> => {
    const missing = [...new Set(oids)].filter((oid) => !store.hasObject(oid));
    if (missing.length === 0) return;
    store.putObjects(await wire.fetchObjects({ wants: missing }));
    const still = missing.filter((oid) => !store.hasObject(oid));
    if (still.length > 0) {
      throw new Error(`remote did not return ${still.length} wanted blob(s): ${still[0]} …`);
    }
  };

  return {
    /** The synced head, or null before the first sync. */
    head: (): StoredHead | null => store.head(branch),

    /** Every file path at the synced head (gitlinks excluded, like a checkout walk). */
    listPaths: (): string[] =>
      store
        .manifest(branch)
        .filter((file) => file.mode !== GITLINK_MODE)
        .map((file) => file.path),

    /**
     * Bring the store to the remote head (or to `targetOid` when the caller
     * already knows it, saving the ls-refs round trip). Single-flight.
     */
    syncToHead: (targetOid?: string): Promise<StoredHead> => {
      syncing ??= syncOnce(targetOid).finally(() => {
        syncing = null;
      });
      return syncing;
    },

    /** Read blob bytes at the synced head; null for absent paths and gitlinks. */
    readPathBytes: async (paths: string[]): Promise<(Uint8Array | null)[]> => {
      const entries = store.manifestEntries(branch, paths);
      await hydrate(
        entries
          .filter((entry): entry is ManifestFile => entry !== null && entry.mode !== GITLINK_MODE)
          .map((entry) => entry.blobOid),
      );
      const oidsRead: string[] = [];
      const results = entries.map((entry) => {
        if (entry === null || entry.mode === GITLINK_MODE) return null;
        const object = store.getObject(entry.blobOid);
        if (object === null) throw new Error(`blob ${entry.blobOid} vanished after hydration`);
        oidsRead.push(entry.blobOid);
        return object.payload;
      });
      store.touchBlobs(oidsRead);
      return results;
    },

    /** Read utf-8 contents at the synced head; null for absent paths. */
    readPaths: async function (paths: string[]): Promise<(string | null)[]> {
      const bytes = await this.readPathBytes(paths);
      return bytes.map((payload) => (payload === null ? null : textDecoder.decode(payload)));
    },

    /**
     * Build a commit locally from the manifest and push it with a
     * compare-and-swap on the synced head. No clone, no fetch. On success the
     * store is primed with the new objects and manifest, so read-your-write
     * costs nothing. Throws LazyRepoConflict when the remote head moved.
     */
    commitFiles: async (input: {
      author: { date: Date; email: string; name: string };
      changes: LazyChange[];
      message: string;
    }): Promise<{ commitOid: string; noChanges: boolean }> => {
      const head = store.head(branch);
      if (head === null) throw new Error("lazy commit requires a synced head");
      const manifest = new Map(store.manifest(branch).map((file) => [file.path, file]));
      const newBlobs: { oid: string; payload: Uint8Array }[] = [];
      for (const change of input.changes) {
        const path = change.path.replace(/^\/+/, "");
        if ("delete" in change) {
          manifest.delete(path);
          continue;
        }
        const payload =
          "content" in change
            ? textEncoder.encode(change.content)
            : Uint8Array.from(atob(change.contentBase64), (c) => c.charCodeAt(0));
        const oid = await hashObject("blob", payload);
        newBlobs.push({ oid, payload });
        manifest.set(path, { blobOid: oid, mode: manifest.get(path)?.mode ?? "100644", path });
      }

      // Rebuild the tree from the manifest. Unchanged directories hash to
      // their existing oids (content-addressing IS the reuse), so the pack
      // and the store writes below stay proportional to the change.
      const filesByDir = new Map<string, ManifestFile[]>();
      const childDirs = new Map<string, Set<string>>();
      const noteDir = (dir: string) => {
        if (childDirs.has(dir)) return;
        childDirs.set(dir, new Set());
        if (dir !== "") {
          const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
          noteDir(parent);
          childDirs.get(parent)!.add(dir);
        }
      };
      noteDir("");
      for (const file of manifest.values()) {
        const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
        noteDir(dir);
        let list = filesByDir.get(dir);
        if (list === undefined) filesByDir.set(dir, (list = []));
        list.push(file);
      }
      const newTrees: { oid: string; payload: Uint8Array }[] = [];
      const buildDir = async (dir: string): Promise<string | null> => {
        const entries: TreeEntry[] = [];
        for (const child of childDirs.get(dir) ?? []) {
          const childOid = await buildDir(child);
          if (childOid !== null) {
            entries.push({
              mode: DIR_MODE,
              name: child.slice(dir === "" ? 0 : dir.length + 1),
              oid: childOid,
            });
          }
        }
        for (const file of filesByDir.get(dir) ?? []) {
          entries.push({
            mode: file.mode,
            name: file.path.slice(dir === "" ? 0 : dir.length + 1),
            oid: file.blobOid,
          });
        }
        if (entries.length === 0) return null; // git prunes empty directories
        const payload = encodeTree(entries);
        const oid = await hashObject("tree", payload);
        newTrees.push({ oid, payload });
        return oid;
      };
      const newRootOid = await buildDir("");
      if (newRootOid === null) throw new Error("a commit cannot empty the whole repository");
      if (newRootOid === head.rootTreeOid) return { commitOid: head.commitOid, noChanges: true };

      const commitPayload = encodeCommit({
        author: input.author,
        message: input.message.endsWith("\n") ? input.message : `${input.message}\n`,
        parents: [head.commitOid],
        tree: newRootOid,
      });
      const commitOid = await hashObject("commit", commitPayload);
      const packObjects: { payload: Uint8Array; type: "blob" | "commit" | "tree" }[] = [
        ...newBlobs
          .filter((blob) => !store.hasObject(blob.oid))
          .map((blob) => ({ payload: blob.payload, type: "blob" as const })),
        ...newTrees
          .filter((tree) => !store.hasObject(tree.oid))
          .map((tree) => ({ payload: tree.payload, type: "tree" as const })),
        { payload: commitPayload, type: "commit" as const },
      ];
      const pushed = await wire.push({
        newOid: commitOid,
        oldOid: head.commitOid,
        pack: await buildPack(packObjects),
        ref: `refs/heads/${branch}`,
      });
      if (!pushed.ok) throw new LazyRepoConflict(pushed.refErrors.join("; "));

      // Prime the store: read-your-write without a single fetch.
      store.putObjects([
        ...newBlobs.map((blob) => ({
          oid: blob.oid,
          payload: blob.payload,
          type: "blob" as const,
        })),
        ...newTrees.map((tree) => ({
          oid: tree.oid,
          payload: tree.payload,
          type: "tree" as const,
        })),
        { oid: commitOid, payload: commitPayload, type: "commit" as const },
      ]);
      const manifestNow = walkManifest(newRootOid, new Map());
      store.replaceManifest(branch, { commitOid, rootTreeOid: newRootOid, ...manifestNow });
      return { commitOid, noChanges: false };
    },
  };
}
