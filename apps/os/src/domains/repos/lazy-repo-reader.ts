import type { RepoFileChange } from "./types.ts";
import { base64ToBytes } from "./utils.ts";
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
 * Sync installs the delta between a CALLER-VALIDATED target head and the
 * store: one fetch wanting the target with every known directory tree as a
 * `have` (the server excludes unchanged subtrees recursively), plus exact-oid
 * hydration for blobs the exclusion swallowed. Reads serve verified store
 * bytes, rehydrating missing or corrupt blobs by exact oid. Commits rebuild
 * ONLY the changed paths' ancestor directories, push one small pack under a
 * compare-and-swap, and return a TYPED outcome — a caller may fall back to
 * another write lane only on `rejected`, where the remote provably did not
 * move.
 *
 * This module holds no freshness policy: WHICH head to sync to, and whether
 * a resolved candidate is trustworthy, is the caller's decision (the Durable
 * Object judges candidates against its branch authority).
 */

const GITLINK_MODE = "160000";
const DIR_MODE = "40000";
/** git's canonical empty tree — a commit may legally empty the repository. */
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const parentDirOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

type LazyCommitOutcome =
  | {
      changedPaths: string[];
      commitOid: string;
      kind: "applied";
      /** Set when the push landed but installing it locally failed — the
       * caller must drop its cursors so reads re-sync; NEVER re-commit. */
      localInstallError?: unknown;
      parentCommitOid: string;
    }
  | { detail: string; kind: "rejected" }
  | { detail: string; kind: "indeterminate"; proposedCommitOid: string };

export function createLazyRepoReader(input: {
  branch: string;
  store: GitObjectStore;
  wire: GitWireTransport;
}) {
  const { branch, store, wire } = input;
  // Store mutations SERIALIZE: concurrent syncs (and commit installs) each
  // run against fresh store state, in arrival order — a caller can never get
  // one sync's head label over another sync's content.
  let installChain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const result = installChain.then(run, run);
    installChain = result.catch(() => {});
    return result;
  };

  const resolveTree = async (
    oid: string,
    fromPack: Map<string, RawGitObject>,
  ): Promise<TreeEntry[]> => {
    const packed = fromPack.get(oid);
    if (packed !== undefined) {
      if (packed.type !== "tree") throw new Error(`object ${oid} is a ${packed.type}, not a tree`);
      return parseTree(packed.payload);
    }
    const stored = await store.getObject(oid);
    if (stored === null || stored.type !== "tree") {
      throw new Error(`tree ${oid} is in neither the sync pack nor the store`);
    }
    return parseTree(stored.payload);
  };

  const walkManifest = async (
    rootTreeOid: string,
    fromPack: Map<string, RawGitObject>,
  ): Promise<{ dirs: { path: string; treeOid: string }[]; files: ManifestFile[] }> => {
    const files: ManifestFile[] = [];
    const dirs: { path: string; treeOid: string }[] = [];
    const walk = async (treeOid: string, prefix: string): Promise<void> => {
      dirs.push({ path: prefix, treeOid });
      for (const entry of await resolveTree(treeOid, fromPack)) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === DIR_MODE) await walk(entry.oid, path);
        else files.push({ blobOid: entry.oid, mode: entry.mode, path });
      }
    };
    await walk(rootTreeOid, "");
    return { dirs, files };
  };

  /** Fetch `oids` the store lacks, in bounded batches, and persist them. */
  const hydrate = async (oids: string[]): Promise<void> => {
    const unique = [...new Set(oids)];
    const present = store.hasObjects(unique);
    const missing = unique.filter((oid) => !present.has(oid));
    for (let index = 0; index < missing.length; index += 200) {
      store.putObjects(await wire.fetchObjects({ wants: missing.slice(index, index + 200) }));
    }
    const after = store.hasObjects(missing);
    if (after.size < missing.length) {
      const gone = missing.filter((oid) => !after.has(oid));
      throw new Error(`remote did not return ${gone.length} wanted object(s): ${gone[0]} …`);
    }
  };

  const syncOnce = async (targetOid: string): Promise<StoredHead> => {
    const current = store.head(branch);
    if (current?.commitOid === targetOid) return current;
    const objects = await wire.fetchObjects({
      deepen: 1,
      haves: store.dirTrees(branch).map((dir) => dir.treeOid),
      wants: [targetOid],
    });
    const fromPack = new Map(objects.map((object) => [object.oid, object]));
    const commit = fromPack.get(targetOid);
    if (commit === undefined || commit.type !== "commit") {
      // Wants for unknown oids are silently dropped by the server — surface
      // the inconsistency instead of persisting a half-synced head.
      throw new Error(`sync fetch did not return commit ${targetOid}`);
    }
    const rootTreeOid = parseCommit(commit.payload).tree;
    const next = await walkManifest(rootTreeOid, fromPack);
    const before = new Map(store.manifest(branch).map((file) => [file.path, file]));
    const nextPaths = new Set(next.files.map((file) => file.path));
    const upserts = next.files.filter((file) => {
      const old = before.get(file.path);
      return old === undefined || old.blobOid !== file.blobOid || old.mode !== file.mode;
    });
    // Persist pack objects, then make sure every NEW manifest blob is really
    // held: the server's have-closure exclusion can swallow a blob that moved
    // into a changed directory from an unchanged one (rename/copy).
    store.putObjects(objects);
    await hydrate(upserts.filter((file) => file.mode !== GITLINK_MODE).map((file) => file.blobOid));
    store.installSnapshot(branch, {
      commitOid: targetOid,
      dirs: next.dirs,
      removes: [...before.keys()].filter((path) => !nextPaths.has(path)),
      rootTreeOid,
      upserts,
    });
    return { commitOid: targetOid, rootTreeOid };
  };

  const readPathBytes = async (paths: string[]): Promise<(Uint8Array | null)[]> => {
    const entries = store.manifestEntries(branch, paths);
    await hydrate(
      entries
        .filter((entry): entry is ManifestFile => entry !== null && entry.mode !== GITLINK_MODE)
        .map((entry) => entry.blobOid),
    );
    const out: (Uint8Array | null)[] = [];
    for (const entry of entries) {
      if (entry === null || entry.mode === GITLINK_MODE) {
        out.push(null);
        continue;
      }
      let object = await store.getObject(entry.blobOid).catch(() => null);
      if (object === null) {
        // Missing after hydration = a corrupt row was deleted mid-read; give
        // the remote one chance to replace it.
        await hydrate([entry.blobOid]);
        object = await store.getObject(entry.blobOid);
      }
      if (object === null) throw new Error(`blob ${entry.blobOid} unavailable after rehydration`);
      out.push(object.payload);
    }
    return out;
  };

  return {
    head: (): StoredHead | null => store.head(branch),

    /** Every file path at the synced head (gitlinks excluded, like a checkout walk). */
    listPaths: (): string[] =>
      store
        .manifest(branch)
        .filter((file) => file.mode !== GITLINK_MODE)
        .map((file) => file.path),

    /** The remote's current tip — a CANDIDATE the caller must validate
     * against its authority before syncing to it. */
    resolveRemoteHead: async (): Promise<string> => {
      const refs = await wire.lsRefs([`refs/heads/${branch}`]);
      // gitty ignores ref-prefix filters (probed) — match by exact name.
      const tip = refs.find((ref) => ref.name === `refs/heads/${branch}`)?.oid;
      if (tip === undefined) throw new Error(`remote has no refs/heads/${branch}`);
      return tip;
    },

    /** Install a validated target head. Serialized; a no-op when current. */
    syncToHead: (targetOid: string): Promise<StoredHead> => serialized(() => syncOnce(targetOid)),

    readPathBytes,

    readPaths: async (paths: string[]): Promise<(string | null)[]> =>
      (await readPathBytes(paths)).map((payload) =>
        payload === null ? null : textDecoder.decode(payload),
      ),

    /**
     * Build a commit from the synced head — rebuilding ONLY the changed
     * paths' ancestor directories — and push it under a compare-and-swap.
     * Returns a typed outcome; see LazyCommitOutcome for the caller contract.
     */
    commitFiles: async (input: {
      author: { date: Date; email: string; name: string };
      changes: RepoFileChange[];
      message: string;
    }): Promise<LazyCommitOutcome> => {
      const head = store.head(branch);
      if (head === null) throw new Error("lazy commit requires a synced head");
      const manifest = new Map(store.manifest(branch).map((file) => [file.path, file]));
      const oldDirs = new Map(store.dirTrees(branch).map((dir) => [dir.path, dir.treeOid]));

      // Apply changes to the manifest map, validating structure: a path may
      // not be written where a DIRECTORY lives, nor under an existing FILE —
      // the same shapes the clone lane's real filesystem rejects.
      const dirsWithFiles = new Set<string>();
      for (const file of manifest.keys()) {
        for (let dir = parentDirOf(file); dir !== ""; dir = parentDirOf(dir)) {
          dirsWithFiles.add(dir);
        }
      }
      const newBlobs = new Map<string, Uint8Array>();
      const removes: string[] = [];
      const upserts = new Map<string, ManifestFile>();
      for (const change of input.changes) {
        const path = change.path.replace(/^\/+/, "");
        if ("delete" in change && change.delete) {
          if (manifest.delete(path)) {
            upserts.delete(path);
            removes.push(path);
          }
          continue;
        }
        if (dirsWithFiles.has(path)) throw new Error(`cannot write "${path}": it is a directory`);
        for (let dir = parentDirOf(path); dir !== ""; dir = parentDirOf(dir)) {
          if (manifest.has(dir)) throw new Error(`cannot write "${path}": "${dir}" is a file`);
          dirsWithFiles.add(dir);
        }
        const payload =
          "contentBase64" in change
            ? base64ToBytes(change.contentBase64)
            : textEncoder.encode((change as { content: string }).content);
        const oid = await hashObject("blob", payload);
        newBlobs.set(oid, payload);
        const file = { blobOid: oid, mode: manifest.get(path)?.mode ?? "100644", path };
        manifest.set(path, file);
        upserts.set(path, file);
      }

      // Rebuild exactly the ancestor chains of the touched paths; every other
      // directory keeps its synced oid (content addressing IS the reuse).
      const changedDirs = new Set<string>([""]);
      for (const path of [...upserts.keys(), ...removes]) {
        for (let dir = parentDirOf(path); ; dir = parentDirOf(dir)) {
          changedDirs.add(dir);
          if (dir === "") break;
        }
      }
      const filesByDir = new Map<string, ManifestFile[]>();
      const childDirs = new Map<string, Set<string>>();
      const noteChild = (dir: string) => {
        if (dir === "") return;
        const parent = parentDirOf(dir);
        let set = childDirs.get(parent);
        if (set === undefined) childDirs.set(parent, (set = new Set()));
        if (!set.has(dir)) {
          set.add(dir);
          noteChild(parent);
        }
      };
      for (const file of manifest.values()) {
        const dir = parentDirOf(file.path);
        noteChild(dir);
        if (!changedDirs.has(dir)) continue;
        let list = filesByDir.get(dir);
        if (list === undefined) filesByDir.set(dir, (list = []));
        list.push(file);
      }
      for (const dir of oldDirs.keys()) if (dir !== "") noteChild(dir);

      const newTrees = new Map<string, Uint8Array>();
      const newDirs = new Map<string, string>(oldDirs);
      const buildDir = async (dir: string): Promise<string | null> => {
        if (!changedDirs.has(dir)) return oldDirs.get(dir) ?? null;
        const entries: TreeEntry[] = [];
        for (const child of childDirs.get(dir) ?? []) {
          const childOid = await buildDir(child);
          if (childOid === null) newDirs.delete(child);
          else {
            newDirs.set(child, childOid);
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
        if (entries.length === 0 && dir !== "") return null; // git prunes empty dirs
        const payload = encodeTree(entries);
        const oid = await hashObject("tree", payload);
        newTrees.set(oid, payload);
        return oid;
      };
      const newRootOid = (await buildDir("")) ?? EMPTY_TREE_OID;
      if (newRootOid === EMPTY_TREE_OID && !newTrees.has(EMPTY_TREE_OID)) {
        newTrees.set(EMPTY_TREE_OID, new Uint8Array(0));
      }
      newDirs.set("", newRootOid);
      if (newRootOid === head.rootTreeOid) {
        return {
          changedPaths: [],
          commitOid: head.commitOid,
          kind: "applied",
          parentCommitOid: head.commitOid,
        };
      }

      const commitPayload = encodeCommit({
        author: input.author,
        message: input.message.endsWith("\n") ? input.message : `${input.message}\n`,
        parents: [head.commitOid],
        tree: newRootOid,
      });
      const commitOid = await hashObject("commit", commitPayload);
      const packCandidates: {
        oid: string;
        payload: Uint8Array;
        type: "blob" | "commit" | "tree";
      }[] = [
        ...[...newBlobs.entries()].map(([oid, payload]) => ({
          oid,
          payload,
          type: "blob" as const,
        })),
        ...[...newTrees.entries()].map(([oid, payload]) => ({
          oid,
          payload,
          type: "tree" as const,
        })),
        { oid: commitOid, payload: commitPayload, type: "commit" as const },
      ];
      const alreadyStored = store.hasObjects(packCandidates.map((object) => object.oid));
      const pack = await buildPack(
        packCandidates.filter((object) => !alreadyStored.has(object.oid)),
      );

      let pushed: { ok: boolean; refErrors: string[] } | undefined;
      try {
        pushed = await wire.push({
          newOid: commitOid,
          oldOid: head.commitOid,
          pack,
          ref: `refs/heads/${branch}`,
        });
      } catch (transportError) {
        // The request died in flight — the server may or may not have applied
        // it. Reconcile against the ref itself before judging.
        for (let attempt = 0; attempt < 3 && pushed === undefined; attempt++) {
          try {
            const tip = (await wire.lsRefs([`refs/heads/${branch}`])).find(
              (ref) => ref.name === `refs/heads/${branch}`,
            )?.oid;
            if (tip === commitOid) pushed = { ok: true, refErrors: [] };
            else if (tip === head.commitOid && attempt === 2) {
              // Provably still at our parent after retries: never applied.
              return { detail: String(transportError), kind: "rejected" };
            }
          } catch {
            // the reconcile read itself failed; keep trying
          }
        }
        if (pushed === undefined) {
          return {
            detail: `push transport failed and the ref state is unknown: ${String(transportError)}`,
            kind: "indeterminate",
            proposedCommitOid: commitOid,
          };
        }
      }
      if (!pushed.ok) return { detail: pushed.refErrors.join("; "), kind: "rejected" };

      // THE PUSH IS APPLIED. Local install failures degrade the outcome, not
      // the verdict — the caller must never re-run the mutation.
      const changedPaths = [...new Set([...upserts.keys(), ...removes])].sort();
      try {
        await serialized(async () => {
          store.putObjects(packCandidates);
          store.installSnapshot(branch, {
            commitOid,
            dirs: [...newDirs.entries()].map(([path, treeOid]) => ({ path, treeOid })),
            removes,
            rootTreeOid: newRootOid,
            upserts: [...upserts.values()],
          });
        });
      } catch (localInstallError) {
        return {
          changedPaths,
          commitOid,
          kind: "applied",
          localInstallError,
          parentCommitOid: head.commitOid,
        };
      }
      return { changedPaths, commitOid, kind: "applied", parentCommitOid: head.commitOid };
    },
  };
}
