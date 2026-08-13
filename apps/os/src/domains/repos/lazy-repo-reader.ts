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
  type PushReport,
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
 * Reads and installs share ONE serialization chain, so a read's head label,
 * manifest rows, and object bytes always describe the same snapshot — never
 * head A's oid over head B's content, and never a row whose object a
 * concurrent install pruned mid-read.
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
    if (packed) {
      if (packed.type !== "tree") throw new Error(`object ${oid} is a ${packed.type}, not a tree`);
      return parseTree(packed.payload);
    }
    let stored = await store.getObject(oid).catch(() => null);
    if (!stored) {
      // Corrupt (now quarantined) or missing — the server excluded it via a
      // have-closure while our copy rotted. Heal by exact oid; a tree that
      // stays unavailable would otherwise wedge every future sync, because
      // git_dir_trees keeps advertising it as a have.
      await hydrate([oid]);
      stored = await store.getObject(oid);
    }
    if (!stored || stored.type !== "tree") {
      throw new Error(`tree ${oid} is unavailable from the pack, the store, and the remote`);
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

  const syncOnce = async (targetOid: string, stillWanted?: () => boolean): Promise<StoredHead> => {
    const current = store.head(branch);
    if (current?.commitOid === targetOid) return current;
    const objects = await wire.fetchObjects({
      deepen: 1,
      haves: store.dirTrees(branch).map((dir) => dir.treeOid),
      wants: [targetOid],
    });
    const fromPack = new Map(objects.map((object) => [object.oid, object]));
    const commit = fromPack.get(targetOid);
    if (!commit || commit.type !== "commit") {
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
      return !old || old.blobOid !== file.blobOid || old.mode !== file.mode;
    });
    // Persist pack objects, then make sure every NEW manifest blob is really
    // held: the server's have-closure exclusion can swallow a blob that moved
    // into a changed directory from an unchanged one (rename/copy).
    store.putObjects(objects);
    await hydrate(upserts.filter((file) => file.mode !== GITLINK_MODE).map((file) => file.blobOid));
    if (stillWanted && !stillWanted()) {
      // The caller's policy moved on during the fetch (a commit advanced the
      // floor). The fetched objects are content-addressed and harmless;
      // installing the now-stale snapshot is not.
      return store.head(branch) ?? current ?? { commitOid: targetOid, rootTreeOid: "" };
    }
    store.installSnapshot(branch, {
      commitOid: targetOid,
      dirs: next.dirs,
      removes: [...before.keys()].filter((path) => !nextPaths.has(path)),
      rootTreeOid,
      upserts,
    });
    return { commitOid: targetOid, rootTreeOid };
  };

  /** MUST run inside `serialized()` — head/manifest/object consistency. */
  const readPathBytesLocked = async (paths: string[]): Promise<(Uint8Array | null)[]> => {
    const entries = store.manifestEntries(branch, paths);
    await hydrate(
      entries
        .filter((entry): entry is ManifestFile => !!entry && entry.mode !== GITLINK_MODE)
        .map((entry) => entry.blobOid),
    );
    const out: (Uint8Array | null)[] = [];
    for (const entry of entries) {
      if (!entry || entry.mode === GITLINK_MODE) {
        out.push(null);
        continue;
      }
      let object = await store.getObject(entry.blobOid).catch(() => null);
      if (!object) {
        // Missing after hydration = a corrupt row was deleted mid-read; give
        // the remote one chance to replace it.
        await hydrate([entry.blobOid]);
        object = await store.getObject(entry.blobOid);
      }
      if (!object) throw new Error(`blob ${entry.blobOid} unavailable after rehydration`);
      out.push(object.payload);
    }
    return out;
  };

  /**
   * After an ambiguous push, RE-SEND the same pack: the CAS (parent→proposed)
   * is idempotent at the commit-oid level, so a retry either applies it,
   * reports "already moved" (then the tip tells us whether it moved to US),
   * or stays ambiguous. Seeing the PARENT on a ref read proves nothing —
   * Artifacts head visibility is eventually consistent — so a stale parent
   * never downgrades to `rejected`; a rejected CAS retry alongside a
   * parent-reading ls-refs is a CONTRADICTION and stays indeterminate.
   */
  const reconcilePush = async (
    detail: string,
    push: { newOid: string; oldOid: string; pack: Uint8Array; ref: string },
  ): Promise<PushReport> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let retried: PushReport | undefined;
      try {
        retried = await wire.push(push);
      } catch {
        // transport still failing; fall through to the tip read
      }
      if (retried?.kind === "applied") return { kind: "applied" };
      try {
        const tip = await resolveRemoteHead();
        if (tip === push.newOid) return { kind: "applied" };
        if (retried?.kind === "rejected") {
          if (tip === push.oldOid) {
            // The CAS says the ref moved; ls-refs says it did not. One of
            // them is stale — never authorize a re-run on contradiction.
            return { detail: `${detail}; CAS/ls-refs contradiction`, kind: "indeterminate" };
          }
          // The ref moved to something that is not our commit: a competing
          // writer won. Our pack provably did not land.
          return { detail: retried.detail, kind: "rejected" };
        }
      } catch {
        // the reconcile read itself failed; keep trying
      }
    }
    return { detail, kind: "indeterminate" };
  };

  const resolveRemoteHead = async (): Promise<string> => {
    const refs = await wire.lsRefs([`refs/heads/${branch}`]);
    // gitty ignores ref-prefix filters (probed) — match by exact name.
    const tip = refs.find((ref) => ref.name === `refs/heads/${branch}`)?.oid;
    if (!tip) throw new Error(`remote has no refs/heads/${branch}`);
    return tip;
  };

  return {
    head: (): StoredHead | null => store.head(branch),

    resolveRemoteHead,

    /**
     * Install a validated target head. Serialized; a no-op when current.
     * `stillWanted` re-checks the caller's policy INSIDE the chain (at entry
     * and again after the network awaits, right before install): a target
     * validated before queueing may be outdated by the time its turn comes —
     * e.g. a commit that moved the pushed floor while this sync waited. A
     * skipped sync returns the current head untouched.
     */
    syncToHead: (targetOid: string, opts?: { stillWanted?: () => boolean }): Promise<StoredHead> =>
      serialized(async () => {
        const current = store.head(branch);
        if (opts?.stillWanted && !opts.stillWanted()) {
          if (!current) throw new Error("sync skipped by its guard and no snapshot exists");
          return current;
        }
        return syncOnce(targetOid, opts?.stillWanted);
      }),

    /**
     * The synced head with every file path it holds — ONE consistent
     * observation (gitlinks excluded, like a checkout walk).
     */
    listHead: (): Promise<{ head: StoredHead; paths: string[] }> =>
      serialized(async () => {
        const head = store.head(branch);
        if (!head) throw new Error("listHead requires a synced head");
        return {
          head,
          paths: store
            .manifest(branch)
            .filter((file) => file.mode !== GITLINK_MODE)
            .map((file) => file.path),
        };
      }),

    /**
     * The synced head with the requested paths' bytes — head label, manifest
     * rows, and blob contents captured under one barrier, so an interleaved
     * install can never mix snapshots inside a single response.
     */
    readHeadPaths: (paths: string[]): Promise<{ bytes: (Uint8Array | null)[]; head: StoredHead }> =>
      serialized(async () => {
        const head = store.head(branch);
        if (!head) throw new Error("readHeadPaths requires a synced head");
        return { bytes: await readPathBytesLocked(paths), head };
      }),

    /**
     * The ENTIRE snapshot — head, every path, every content — as ONE
     * observation. Only for small manifests (the caller gates by byte size);
     * feeds contentHash publication, which must never mix two snapshots.
     */
    readHeadSnapshot: (): Promise<{ files: Record<string, string>; head: StoredHead }> =>
      serialized(async () => {
        const head = store.head(branch);
        if (!head) throw new Error("readHeadSnapshot requires a synced head");
        const paths = store
          .manifest(branch)
          .filter((file) => file.mode !== GITLINK_MODE)
          .map((file) => file.path);
        const bytes = await readPathBytesLocked(paths);
        const files: Record<string, string> = {};
        paths.forEach((path, index) => {
          const payload = bytes[index];
          if (payload) {
            files[path] = textDecoder.decode(payload);
          }
        });
        return { files, head };
      }),

    /** Contents at the synced head, unlabeled — probe/test convenience. */
    readPaths: async (paths: string[]): Promise<(string | null)[]> =>
      serialized(async () =>
        (await readPathBytesLocked(paths)).map((payload) =>
          !payload ? null : textDecoder.decode(payload),
        ),
      ),

    /**
     * Build a commit from the synced head — rebuilding ONLY the changed
     * paths' ancestor directories — and push it under a compare-and-swap.
     * Returns a typed outcome; see LazyCommitOutcome for the caller contract.
     */
    commitFiles: (
      input: {
        author: { date: Date; email: string; name: string };
        changes: RepoFileChange[];
        message: string;
      },
      opts?: { onApplied?: (applied: { commitOid: string; parentCommitOid: string }) => void },
    ): Promise<LazyCommitOutcome> => serialized(() => commitFilesLocked(input, opts)),
  };

  /** The whole commit — snapshot capture, compile, push, local install —
   * runs as ONE chained operation: a sync arriving mid-commit queues behind
   * it, so a delta computed against head A can never install over a newer
   * head B that slipped in between. */
  async function commitFilesLocked(
    input: {
      author: { date: Date; email: string; name: string };
      changes: RepoFileChange[];
      message: string;
    },
    opts?: { onApplied?: (applied: { commitOid: string; parentCommitOid: string }) => void },
  ): Promise<LazyCommitOutcome> {
    {
      const head = store.head(branch);
      if (!head) throw new Error("lazy commit requires a synced head");
      const manifest = new Map(store.manifest(branch).map((file) => [file.path, file]));
      const oldDirs = new Map(store.dirTrees(branch).map((dir) => [dir.path, dir.treeOid]));

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

      // Validate the FINAL manifest, not intermediate states: a batch may
      // delete a directory's last file and create a file of the same name in
      // one commit. Sorted adjacency finds every file/directory collision (a
      // path that is an ancestor of another path cannot be a file).
      const sortedPaths = [...manifest.keys()].sort();
      for (let index = 0; index + 1 < sortedPaths.length; index++) {
        if (sortedPaths[index + 1]!.startsWith(`${sortedPaths[index]!}/`)) {
          throw new Error(
            `cannot commit: "${sortedPaths[index]}" is a file but "${sortedPaths[index + 1]}" nests under it`,
          );
        }
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
        if (!set) childDirs.set(parent, (set = new Set()));
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
        if (!list) filesByDir.set(dir, (list = []));
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
          if (!childOid) newDirs.delete(child);
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
        if (!entries.length && dir !== "") return null; // git prunes empty dirs
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

      // Push, then classify. `rejected` must be a PROOF the ref did not
      // move; a dead transport or an ambiguous report reconciles by
      // re-sending the idempotent CAS before judging.
      const pushDescriptor = {
        newOid: commitOid,
        oldOid: head.commitOid,
        pack,
        ref: `refs/heads/${branch}`,
      };
      let report: PushReport;
      try {
        report = await wire.push(pushDescriptor);
      } catch (transportError) {
        report = { detail: String(transportError), kind: "indeterminate" };
      }
      if (report.kind === "indeterminate") {
        report = await reconcilePush(report.detail, pushDescriptor);
      }
      if (report.kind === "rejected") return { detail: report.detail, kind: "rejected" };
      if (report.kind === "indeterminate") {
        return { detail: report.detail, kind: "indeterminate", proposedCommitOid: commitOid };
      }

      // THE PUSH IS APPLIED. The caller's hook runs HERE — synchronously,
      // inside the chain, before any other queued operation can observe the
      // store — so authority bookkeeping (the pushed floor) and the snapshot
      // move together; a concurrent freshness read can never see the new
      // snapshot under the old floor and "correct" it backwards.
      opts?.onApplied?.({ commitOid, parentCommitOid: head.commitOid });
      // Local install failures degrade the outcome, not the verdict — the
      // caller must never re-run the mutation.
      const changedPaths = [...new Set([...upserts.keys(), ...removes])].sort();
      try {
        store.putObjects(packCandidates);
        store.installSnapshot(branch, {
          commitOid,
          dirs: [...newDirs.entries()].map(([path, treeOid]) => ({ path, treeOid })),
          removes,
          rootTreeOid: newRootOid,
          upserts: [...upserts.values()],
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
    }
  }
}
