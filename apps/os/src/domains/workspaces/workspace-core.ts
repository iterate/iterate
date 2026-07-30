import { Workspace } from "@cloudflare/shell";
import { walkWorkspaceFiles, wipeWorkspace } from "../../lib/shell-fs.ts";
import type { RepoFileChange } from "../repos/types.ts";
import { ITERATE_GITHUB_BOT_COMMIT_AUTHOR } from "../integrations/utils.ts";
import { countOccurrences, replaceLiteralOccurrences } from "../repos/edit-utils.ts";
import type {
  EditWorkspaceFileInput,
  EditWorkspaceFileResult,
  WorkspaceChange,
  WorkspaceCommitInput,
  WorkspaceCommitResult,
  WorkspaceGitLogEntry,
  WorkspaceGitLogInput,
  WorkspaceStatus,
} from "./types.ts";
import type { WorkspaceMount } from "./workspace-processor-contract.ts";
import { encodeRepoContent } from "./utils.ts";
import { resolveAbsolutePath } from "./paths.ts";
import { filterPublishablePaths } from "./overlay-ignore.ts";

// Overlay whiteouts: mount paths hidden by a local delete, kept as ONE kv
// record (a path -> true map) so status can enumerate deletions without a kv
// scan. Writes are serialized on the write chain, so read-modify-write of the
// single record cannot lose updates.
const WHITEOUTS_KEY = "whiteouts:v1";

const DEFAULT_COMMIT_AUTHOR = {
  email: ITERATE_GITHUB_BOT_COMMIT_AUTHOR.email,
  name: ITERATE_GITHUB_BOT_COMMIT_AUTHOR.name,
};

/**
 * The repo surface one mount falls through to — satisfied by the Repo Durable
 * Object's stub. HEAD reads are the repo's own read lanes (clone-backed with
 * an in-object snapshot cache today; lazy per-object reads against the
 * Artifacts REST API are the planned successor).
 */
export interface MountRepoAccess {
  readFile(input: {
    path: string;
    encoding?: "utf8" | "base64";
  }): Promise<{ commitOid: string; content: string; path: string } | null>;
  listFiles(): Promise<{ commitOid: string; paths: string[] }>;
  /** HEAD tree text contents in ONE call (head-cache-backed) — bulk consumers
   * must use this instead of fanning readFile() per path, which overloads the
   * repo object. `paths` scopes the returned record to exactly those
   * repo-relative files; mount reads MUST pass it, because a big repo's full
   * tree does not fit a 32MiB RPC (iterate/iterate: 43.7MB at HEAD). */
  getFilesSnapshot(input?: { branch?: string; paths?: string[] }): Promise<{
    commitOid: string;
    files: Record<string, string>;
  }>;
  commitFiles(input: {
    author?: { email: string; name: string };
    changes: RepoFileChange[];
    message: string;
  }): Promise<{ branch: string; changedPaths: string[]; commitOid: string; noChanges: boolean }>;
  log(input: { branch?: string; limit?: number }): Promise<{
    commits: {
      author: { email: string; name: string };
      message: string;
      oid: string;
      timestamp: number;
    }[];
  }>;
}

/** The slice of a Durable Object's synchronous kv the core keeps its bookkeeping in. */
interface WorkspaceKv {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): void;
}

type WorkspaceCoreOptions = {
  /** Durable synchronous kv for the whiteout map. */
  kv: WorkspaceKv;
  /**
   * The EFFECTIVE mount table (mount path → mount): the derived default
   * (every project repo at its own /repos/** path) merged with the
   * workspace's stored overlays. A thunk evaluated per operation, so a
   * `configured` event or a freshly created repo is visible to the very next
   * read without any cache invalidation here.
   */
  mounts: () => Promise<Record<string, WorkspaceMount>>;
  /**
   * Repo access per mount — a thunk because Durable Object stubs must be
   * re-derived per call, never held across them.
   */
  repo: (repoPath: string) => MountRepoAccess;
  /**
   * The workspace's own directory — its stream path (e.g.
   * `/workspaces/agents/foo`). The ONLY subtree where unmounted private
   * files may be written; everything else is either a mounted repo or not
   * writable at all, so a typo'd path fails loudly instead of silently
   * becoming stray scratch.
   */
  scratchRoot: string;
  /** The local layer: this workspace's own private virtual filesystem. */
  workspace: Workspace;
};

/** One mount resolved against a concrete path: mount point, mount, repo-relative path. */
type ResolvedMount = { mount: WorkspaceMount; mountPath: string; repoRelativePath: string };

/**
 * The workspace semantics as a host-agnostic library object: ONE private
 * copy-on-write local layer over a TABLE OF REPO MOUNTS.
 *
 * Reads try the local layer first and fall through, per subtree, to the
 * longest-prefix-matching mount's repo at HEAD; deletes of mount files leave
 * whiteouts; paths under no mount are pure local scratch. Commits route per
 * mount — `gitCommit({ scope })` turns the local changes under ONE mount into
 * one ordinary commit on that repo's main branch via its own `commitFiles`
 * lane, honoring the mount's write policy, then clears just that subtree (the
 * rest of the workspace's uncommitted work survives).
 */
export class WorkspaceCore {
  readonly #kv: WorkspaceKv;
  readonly #mounts: () => Promise<Record<string, WorkspaceMount>>;
  readonly #repo: (repoPath: string) => MountRepoAccess;
  readonly #scratchRoot: string;
  readonly #workspace: Workspace;

  constructor(options: WorkspaceCoreOptions) {
    this.#kv = options.kv;
    this.#mounts = options.mounts;
    this.#repo = options.repo;
    this.#scratchRoot = resolveAbsolutePath(options.scratchRoot);
    this.#workspace = options.workspace;
  }

  // -- mount routing ----------------------------------------------------------

  /** {@link routeMount} over the current table — single-lookup callers only.
   * Multi-path work (status/commit classification) routes over ONE snapshot
   * instead, so a config re-read mid-operation cannot split its view. */
  async #mountFor(path: string): Promise<ResolvedMount | null> {
    return routeMount(await this.#mounts(), path);
  }

  /** A mount's file paths at HEAD, spelled as absolute workspace paths. */
  async #mountFilePaths(mountPath: string, mount: WorkspaceMount): Promise<string[]> {
    const { paths } = await this.#repo(mount.repoPath).listFiles();
    return paths.map((path) => `${mountPath}/${path}`);
  }

  // -- whiteouts ---------------------------------------------------------------

  #whiteouts(): Record<string, true> {
    return this.#kv.get<Record<string, true>>(WHITEOUTS_KEY) ?? {};
  }

  #addWhiteout(path: string): void {
    const whiteouts = this.#whiteouts();
    whiteouts[resolveAbsolutePath(path)] = true;
    this.#kv.put(WHITEOUTS_KEY, whiteouts);
  }

  #clearWhiteout(path: string): void {
    const whiteouts = this.#whiteouts();
    const resolved = resolveAbsolutePath(path);
    if (whiteouts[resolved] === undefined) return;
    delete whiteouts[resolved];
    this.#kv.put(WHITEOUTS_KEY, whiteouts);
  }

  /**
   * Whether a path is hidden from its mount. EXACT-MATCH ONLY: the delete API
   * tombstones individual FILES, so treating a tombstone as recursive would
   * let a file deletion in one repo mask (and mass-delete) a repo later
   * mounted beneath that path — cross-repository data loss. A directory
   * tombstone type can exist only if a directory-delete API ever does.
   */
  isMaskedFromMount(path: string): boolean {
    return this.#whiteouts()[resolveAbsolutePath(path)] === true;
  }

  // -- write discipline ---------------------------------------------------------

  // ALL mutations serialize on this chain: whiteout read-modify-writes and
  // multi-step operations yield the host DO's input gate at awaits, so
  // unserialized writes could interleave and lose updates. Reads stay
  // unserialized — they are local SQLite lookups plus idempotent repo RPCs.
  #writeChain: Promise<unknown> = Promise.resolve();

  #serializeWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.#writeChain.then(write, write);
    this.#writeChain = result.catch(() => {});
    return result;
  }

  /**
   * Run work serialized with every overlay mutation and commit — the door the
   * hosting Durable Object uses to make CONFIGURATION changes atomic with
   * respect to in-flight filesystem work: an unmount or repo swap must never
   * interleave a commit that already classified against the old table.
   */
  runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.#serializeWrite(work);
  }

  /** The write guard's public face — doors that will write LATER (a collab
   * session's flush) pre-check here, so a doomed flush can never wedge a
   * settle barrier on an unwritable path. */
  assertWritable(path: string): Promise<void> {
    return this.#assertWritable(path);
  }

  // `.git` is reserved anywhere in the tree: mounts are repo checkouts in
  // spirit, and a local `.git` segment could shadow platform-managed plumbing
  // for some future git consumer.
  #assertPlatformWritablePath(path: string): void {
    const resolved = resolveAbsolutePath(path);
    if (resolved === "/" || resolved.split("/").includes(".git")) {
      throw new Error(
        `Workspace path is not writable: "${path}" (the root and .git segments are platform-managed).`,
      );
    }
  }

  /**
   * THE write guard, judged against the live mount table from inside the
   * write chain (a queued configure cannot slip a mount under a write between
   * guard and mutation):
   *
   * - `.git` segments and `/` are platform-managed everywhere.
   * - Mount points and their virtual ancestors are DIRECTORIES: a local file
   *   there would collide with the mounted subtree (and a mount-point file
   *   would commit as an empty repo path).
   * - A path inside a mounted repo is writable (the write is a private
   *   shadow; the mount's POLICY gates commit, not the overlay).
   * - A path under the workspace's own directory (its stream path) is private
   *   scratch — always writable, never committable.
   * - Everything else is rejected loudly: an unmounted absolute path is
   *   almost always a typo (a repo that does not exist, another workspace's
   *   directory), and silently accepting it would strand the caller's work.
   */
  async #assertWritable(path: string): Promise<void> {
    this.#assertPlatformWritablePath(path);
    const resolved = resolveAbsolutePath(path);
    const mounts = await this.#mounts();
    if (isVirtualDirectoryPath(mounts, resolved)) {
      throw new Error(
        `Workspace path is not writable: "${path}" is a mount point or a directory containing one.`,
      );
    }
    if (routeMount(mounts, resolved) !== null) return;
    if (resolved.startsWith(`${this.#scratchRoot}/`)) return;
    throw new Error(
      `Workspace path is not writable: "${path}". Private files live under your workspace directory ("${this.#scratchRoot}/..."; relative paths resolve there), repo files under a mounted repo path (${summarizeMountPoints(mounts)}).`,
    );
  }

  // -- filesystem ----------------------------------------------------------------

  async readFile(path: string): Promise<string | null> {
    const local = await this.#workspace.readFile(path);
    if (local !== null) return local;
    const resolved = this.resolveMountFallThrough(await this.#mounts(), path);
    if (resolved === null) return null;
    const file = await this.#repo(resolved.mount.repoPath).readFile({
      path: resolved.repoRelativePath,
    });
    return file === null ? null : file.content;
  }

  /**
   * THE mount fall-through predicate — whiteout mask, virtual-directory mask
   * (a mount point or an ancestor of one is a DIRECTORY in the merged view),
   * then longest-prefix routing. Every reader that falls through a missing
   * local copy (readFile, readFileBytes, batched readFiles) consults THIS,
   * so single-file and batched semantics agree structurally.
   */
  resolveMountFallThrough(
    mounts: Record<string, WorkspaceMount>,
    path: string,
  ): ResolvedMount | null {
    if (this.isMaskedFromMount(path)) return null;
    if (isVirtualDirectoryPath(mounts, path)) return null;
    const resolved = routeMount(mounts, path);
    return resolved === null || resolved.repoRelativePath === "" ? null : resolved;
  }

  /** The OVERLAY copy only — no mount fall-through (bulk readers take the
   * batched fall-through arm instead; see readMountFiles). */
  async readOverlayFile(path: string): Promise<string | null> {
    return this.#workspace.readFile(path);
  }

  /**
   * The batched mount fall-through — readFile's routing at bulk-read scale.
   * Each mount pays ONE snapshot RPC scoped to exactly the repo-relative
   * paths routed to it: fanning readFile() per path overloads the repo
   * object, and an UNSCOPED snapshot ships the whole HEAD tree across a
   * 32MiB-capped RPC (43.7MB on iterate/iterate — the board-seed outage).
   * Paths that resolve to no mount (whiteouts, virtual directories, scratch)
   * read as null.
   */
  async readMountFiles(paths: string[]): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    // ONE mount-table read, then synchronous grouping — an awaited read per
    // path could interleave with a configure, mint two groups for one mount,
    // and route them by different tables.
    const mounts = await this.#mounts();
    const byMount = new Map<
      string,
      { entries: { path: string; repoRelativePath: string }[]; repoPath: string }
    >();
    for (const path of paths) {
      const resolved = this.resolveMountFallThrough(mounts, path);
      if (resolved === null) {
        result[path] = null;
        continue;
      }
      const group = byMount.get(resolved.mountPath) ?? {
        entries: [],
        repoPath: resolved.mount.repoPath,
      };
      group.entries.push({ path, repoRelativePath: resolved.repoRelativePath });
      byMount.set(resolved.mountPath, group);
    }
    await Promise.all(
      [...byMount.values()].map(async (group) => {
        const snapshot = await this.#repo(group.repoPath).getFilesSnapshot({
          paths: group.entries.map((entry) => entry.repoRelativePath),
        });
        for (const entry of group.entries) {
          result[entry.path] = snapshot.files[entry.repoRelativePath] ?? null;
        }
      }),
    );
    return result;
  }

  /** The BASE of a path — its mount's content at HEAD, ignoring the overlay
   * and whiteouts entirely. This is what uncommitted work diffs against
   * (redlines, merge views); null for unmounted/scratch paths. */
  async readBase(path: string): Promise<string | null> {
    const mounts = await this.#mounts();
    if (isVirtualDirectoryPath(mounts, path)) return null;
    return this.#mountRead(mounts, path);
  }

  /** The mount read arm for readBase (baselines ignore whiteouts by design). */
  async #mountRead(mounts: Record<string, WorkspaceMount>, path: string): Promise<string | null> {
    const resolved = routeMount(mounts, path);
    if (resolved === null || resolved.repoRelativePath === "") return null;
    const file = await this.#repo(resolved.mount.repoPath).readFile({
      path: resolved.repoRelativePath,
    });
    return file === null ? null : file.content;
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    const local = await this.#workspace.readFileBytes(path);
    if (local !== null) return local;
    const resolved = this.resolveMountFallThrough(await this.#mounts(), path);
    if (resolved === null) return null;
    const file = await this.#repo(resolved.mount.repoPath).readFile({
      encoding: "base64",
      path: resolved.repoRelativePath,
    });
    return file === null ? null : Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
  }

  async exists(path: string): Promise<boolean> {
    if (await this.#workspace.exists(path)) return true;
    const mounts = await this.#mounts();
    // Virtual directories (mount points and their ancestors) EXIST regardless
    // of any old file tombstone at the same path — a tombstone only ever
    // masks a file, and a mounted subtree implies its ancestor chain.
    if (isVirtualDirectoryPath(mounts, path)) return true;
    const resolved = routeMount(mounts, path);
    if (this.isMaskedFromMount(path)) return false;
    if (resolved === null) return false;
    const target = resolveAbsolutePath(path);
    const mountFiles = await this.#mountFilePaths(resolved.mountPath, resolved.mount);
    return mountFiles.some(
      (file) => (file === target || file.startsWith(`${target}/`)) && !this.isMaskedFromMount(file),
    );
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.#serializeWrite(async () => {
      // Inside the chain: a queued configure cannot slip a mount point under
      // this write between guard and mutation.
      await this.#assertWritable(path);
      await this.#workspace.writeFile(path, content);
      this.#clearWhiteout(path);
    });
  }

  async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    return this.#serializeWrite(async () => {
      await this.#assertWritable(path);
      await this.#workspace.writeFileBytes(path, data);
      this.#clearWhiteout(path);
    });
  }

  async edit(input: EditWorkspaceFileInput): Promise<EditWorkspaceFileResult> {
    if (typeof input.oldString !== "string" || input.oldString === "") {
      throw new Error("edit oldString must be a non-empty string.");
    }
    return this.#serializeWrite(async () => {
      await this.#assertWritable(input.path);
      // Copy-up: editing a mount file materializes the edited copy locally.
      const content = await this.readFile(input.path);
      if (content === null) {
        throw new Error(`Workspace file does not exist: "${input.path}".`);
      }
      const occurrenceCount = countOccurrences(content, input.oldString);
      if (occurrenceCount === 0) {
        throw new Error(`Edit oldString was not found in "${input.path}".`);
      }
      if (!input.replaceAll && occurrenceCount !== 1) {
        throw new Error(
          `Edit oldString matched ${occurrenceCount} times in "${input.path}"; pass replaceAll to replace every occurrence.`,
        );
      }
      const edited = replaceLiteralOccurrences({
        content,
        newString: input.newString,
        oldString: input.oldString,
      });
      await this.#workspace.writeFile(input.path, edited);
      this.#clearWhiteout(input.path);
      return { occurrenceCount, path: input.path };
    });
  }

  async deleteFile(path: string): Promise<boolean> {
    return this.#serializeWrite(async () => {
      // Inside the chain (writeFile's rule): a virtual directory cannot be
      // deleted — a whiteout at a mount's ancestor would claim a path both
      // gone and populated by the mounted subtree beneath it.
      await this.#assertWritable(path);
      // An already-masked path has nothing mount-side left to hide: deleting
      // it again must NOT touch the existing whiteout (retracting it would
      // resurrect the mount file). Only a local copy — visible above an
      // ancestor whiteout because the local layer wins — can remain to delete.
      if (this.isMaskedFromMount(path)) {
        return this.#workspace.deleteFile(path);
      }
      // ALL fallible inspection happens BEFORE any mutation: a failed repo
      // probe must not have consumed the local shadow (its bytes are the
      // caller's uncommitted work) or left a whiteout behind.
      const resolved = await this.#mountFor(path);
      const mountHas =
        resolved !== null &&
        resolved.repoRelativePath !== "" &&
        (await this.#repo(resolved.mount.repoPath).readFile({
          path: resolved.repoRelativePath,
        })) !== null;
      // Whiteout before the local delete, so an unserialized read arriving
      // between them can never fall through and resurrect the mount copy
      // mid-delete. The local delete CAN fail (R2 + SQL); retract the
      // whiteout this call installed so a failed RPC hides nothing.
      if (mountHas) this.#addWhiteout(path);
      try {
        const localDeleted = await this.#workspace.deleteFile(path);
        return localDeleted || mountHas;
      } catch (error) {
        if (mountHas) this.#clearWhiteout(path);
        throw error;
      }
    });
  }

  /**
   * Every file path in the merged view (absolute, sorted, no directories):
   * the local layer plus each mount's HEAD tree, minus whiteouts. Paths under
   * no mount are the workspace's private scratch and appear too.
   */
  async listAllFiles(): Promise<string[]> {
    const mounts = await this.#mounts();
    const merged = new Set(await this.#localFilePaths());
    for (const [mountPath, mount] of Object.entries(mounts)) {
      for (const path of await this.#mountFilePaths(resolveAbsolutePath(mountPath), mount)) {
        if (this.isMaskedFromMount(path)) continue;
        // A deeper mount shadows this one's files under its point.
        if (routeMount(mounts, path)?.mount !== mount) continue;
        // A repo FILE at a deeper mount's ancestor is masked: that path is a
        // directory in the merged view (readFile/exists agree).
        if (isVirtualDirectoryPath(mounts, path)) continue;
        merged.add(path);
      }
    }
    return [...merged].sort();
  }

  /** All file paths of the local layer (absolute, no directories), fully paged. */
  #localFilePaths(): Promise<string[]> {
    return walkWorkspaceFiles(this.#workspace);
  }

  // -- lifecycle ----------------------------------------------------------------

  /**
   * Wipe the local layer and every whiteout — the workspace shows exactly its
   * mounts at HEAD again. Uncommitted work is lost (committed state lives on
   * the mounted repos' mains).
   */
  async reset(): Promise<void> {
    return this.#serializeWrite(async () => {
      this.#kv.delete(WHITEOUTS_KEY);
      await this.#wipeFilesystem();
    });
  }

  /** Un-pin one path: drop the local copy/deletions so it follows its mount again. */
  async revert(path: string): Promise<void> {
    this.#assertPlatformWritablePath(path);
    return this.#serializeWrite(async () => {
      if (await this.#workspace.exists(path)) {
        await this.#workspace.rm(path, { force: true, recursive: true });
      }
      const resolved = resolveAbsolutePath(path);
      const whiteouts = this.#whiteouts();
      let changed = false;
      for (const key of Object.keys(whiteouts)) {
        if (key === resolved || key.startsWith(`${resolved}/`)) {
          delete whiteouts[key];
          changed = true;
        }
      }
      if (changed) this.#kv.put(WHITEOUTS_KEY, whiteouts);
    });
  }

  #wipeFilesystem(): Promise<void> {
    return wipeWorkspace(this.#workspace);
  }

  /**
   * Guard a mount-table transition against SILENT overlay adoption and
   * namespace collisions, from inside the configuration lock:
   *
   * - Dirty overlay state (local files, whiteouts) is path-bound; a
   *   transition that changes which repo owns a dirty path would carry those
   *   edits/deletions into a DIFFERENT repository's next commit. Rejected —
   *   commit, revert, or reset the affected paths first.
   * - A new mount point (or a virtual ancestor of one) colliding with an
   *   existing local FILE would create a file/directory contradiction.
   *
   * Pure bookkeeping: routes local paths and tombstones under both tables,
   * no repo listings.
   */
  async assertMountTransitionSafe(
    current: Record<string, WorkspaceMount>,
    next: Record<string, WorkspaceMount>,
  ): Promise<void> {
    const localFiles = await this.#localFilePaths();
    const dirty = [...localFiles, ...Object.keys(this.#whiteouts())];
    const moved = reRoutedPaths(current, next, dirty);
    if (moved.length > 0) {
      throw new Error(
        `mount change would silently move uncommitted work to a different repo (or orphan it): ` +
          `${moved
            .slice(0, 5)
            .map((path) => `"${path}"`)
            .join(", ")}${moved.length > 5 ? ` and ${moved.length - 5} more` : ""} — ` +
          "commit, revert, or reset these paths first.",
      );
    }
    const localSet = new Set(localFiles);
    for (const key of Object.keys(next)) {
      const mountPath = resolveAbsolutePath(key);
      // A local file at the mount point or any ancestor segment of it makes
      // the mount path unreachable as a directory.
      const segments = mountPath.slice(1).split("/");
      for (let i = 1; i <= segments.length; i++) {
        const prefix = `/${segments.slice(0, i).join("/")}`;
        if (localSet.has(prefix)) {
          throw new Error(
            `mount at "${mountPath}" collides with the local FILE at "${prefix}" — delete or move it first.`,
          );
        }
      }
    }
  }

  // -- git ------------------------------------------------------------------------

  /** The mount table as one normalized-key snapshot: routing, grouping, and
   * scope resolution within an operation all speak the same spelling, taken
   * ONCE — a config re-read mid-operation cannot split its view. */
  async #mountSnapshot(): Promise<MountSnapshot> {
    const mounts = Object.fromEntries(
      Object.entries(await this.#mounts()).map(([key, value]) => [resolveAbsolutePath(key), value]),
    );
    return { mountPaths: Object.keys(mounts).sort(), mounts };
  }

  /**
   * Route every local file and whiteout key to its owning mount — pure
   * bookkeeping with NO repo listings, so dirty-mount inference and scope
   * errors stay cheap even when an unrelated mount is a big repository.
   */
  #groupLocalAndWhiteouts(snapshot: MountSnapshot, localFiles: string[]): GroupedOverlay {
    const localByMount = new Map<string, string[]>();
    const whiteoutsByMount = new Map<string, string[]>();
    for (const mountPath of snapshot.mountPaths) {
      localByMount.set(mountPath, []);
      whiteoutsByMount.set(mountPath, []);
    }
    const unmounted: WorkspaceChange[] = [];
    for (const path of localFiles) {
      const resolved = routeMount(snapshot.mounts, path);
      if (resolved === null) unmounted.push({ change: "added", path });
      else localByMount.get(resolved.mountPath)!.push(path);
    }
    for (const key of Object.keys(this.#whiteouts())) {
      const resolved = routeMount(snapshot.mounts, key);
      if (resolved !== null) whiteoutsByMount.get(resolved.mountPath)!.push(key);
    }
    unmounted.sort((a, b) => a.path.localeCompare(b.path));
    return { localByMount, unmounted, whiteoutsByMount };
  }

  /**
   * One mount's changes, from one repo listing: publishable local files
   * (evaluated against that mount's OWN `.gitignore`s on repo-relative paths
   * — ignore rules never cross a mount boundary), whiteout deletions (only
   * for paths this mount actually owns — a deeper mount's files are
   * unreachable here and are never its deletions), plus STALE whiteouts that
   * mask nothing at HEAD (residue of a commit interrupted between the repo
   * write and cleanup) for the serialized commit path to heal.
   */
  async #classifyMount(
    snapshot: MountSnapshot,
    grouped: GroupedOverlay,
    mountPath: string,
  ): Promise<{ changes: WorkspaceChange[]; localPaths: string[]; staleWhiteouts: string[] }> {
    const owned = grouped.localByMount.get(mountPath)!;
    // A CLEAN mount (no local shadows, no whiteouts) classifies to nothing
    // without a repo listing — with every project repo mounted, status and
    // commit inference must not pay one listFiles per repo just to learn
    // that untouched mounts are untouched.
    if (owned.length === 0 && grouped.whiteoutsByMount.get(mountPath)!.length === 0) {
      return { changes: [], localPaths: [], staleWhiteouts: [] };
    }
    const ownedSet = new Set(owned);
    const localPaths = await this.#publishableLocalPaths(mountPath, owned);
    const mountFiles = await this.#mountFilePaths(mountPath, snapshot.mounts[mountPath]!);
    const mountSet = new Set(mountFiles);

    const changes: WorkspaceChange[] = localPaths.map((path) => ({
      change: mountSet.has(path) && !this.isMaskedFromMount(path) ? "modified" : "added",
      path,
    }));
    for (const path of mountFiles) {
      if (!this.isMaskedFromMount(path) || ownedSet.has(path)) continue;
      if (routeMount(snapshot.mounts, path)?.mountPath !== mountPath) continue;
      changes.push({ change: "deleted", path });
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));

    const staleWhiteouts = grouped.whiteoutsByMount
      .get(mountPath)!
      // Exact-match semantics: a tombstone is live only when it masks a mount
      // FILE at exactly its path. One AT the mount point (a virtual
      // directory) can never mask anything and is always crash residue.
      .filter((key) => !mountSet.has(key));
    return { changes, localPaths, staleWhiteouts };
  }

  /** One mount's PUBLISHABLE local files: its own `.gitignore`s evaluated on
   * repo-relative paths (ignore rules never cross a mount boundary). Local
   * reads only — cheap enough for commit's dirty inference too. */
  async #publishableLocalPaths(mountPath: string, owned: string[]): Promise<string[]> {
    const fromRel = (rel: string) => `${mountPath}${rel}`;
    const publishableRel = await filterPublishablePaths({
      paths: owned.map((path) => path.slice(mountPath.length)),
      readFile: (rel) => this.#workspace.readFile(fromRel(rel)),
    });
    return publishableRel.map(fromRel);
  }

  /**
   * Changes per mount (local files shadowing/adding over that mount's HEAD,
   * whiteouted mount files as deletions), plus the unmounted local scratch
   * (never committable). "modified" means shadowed, not content-diffed.
   * Mounts classify concurrently — each needs only its own repo's listing.
   */
  async gitStatus(): Promise<WorkspaceStatus> {
    const snapshot = await this.#mountSnapshot();
    const grouped = this.#groupLocalAndWhiteouts(snapshot, await this.#localFilePaths());
    const classified = await Promise.all(
      snapshot.mountPaths.map(async (mountPath) => {
        const { changes, staleWhiteouts } = await this.#classifyMount(snapshot, grouped, mountPath);
        return {
          entry: {
            changes,
            path: mountPath,
            policy: snapshot.mounts[mountPath]!.policy,
            repoPath: snapshot.mounts[mountPath]!.repoPath,
          },
          staleWhiteouts,
        };
      }),
    );
    // Heal crash residue on the READ path too — a commit that died between
    // the repo write and cleanup must not need another commit attempt to
    // stop masking a future re-add of the file.
    const stale = classified.flatMap((mount) => mount.staleWhiteouts);
    if (stale.length > 0) await this.#healStaleWhiteouts(stale);
    return { mounts: classified.map((mount) => mount.entry), unmounted: grouped.unmounted };
  }

  /** Serialized whiteout removal with an in-lock re-probe against a FRESH
   * mount snapshot: only keys that STILL mask nothing at HEAD (one point read
   * each; rare path) are dropped — a remount between classification and this
   * lock re-routes rather than probing the old repo. */
  #healStaleWhiteouts(candidates: string[]): Promise<void> {
    return this.#serializeWrite(async () => {
      const snapshot = await this.#mountSnapshot();
      const whiteouts = this.#whiteouts();
      let changed = false;
      for (const key of candidates) {
        if (whiteouts[key] === undefined) continue;
        const resolved = routeMount(snapshot.mounts, key);
        if (resolved === null) continue;
        const masksFile =
          resolved.repoRelativePath !== "" &&
          (await this.#repo(resolved.mount.repoPath).readFile({
            path: resolved.repoRelativePath,
          })) !== null;
        if (masksFile) continue;
        delete whiteouts[key];
        changed = true;
      }
      if (changed) this.#kv.put(WHITEOUTS_KEY, whiteouts);
    });
  }

  /**
   * Commit the local changes under ONE mount to that repo's MAIN branch via
   * its own `commitFiles` lane — the same lane as that repo's direct
   * `commitFiles`, so head cursors, worker rebuilds, and GitHub mirrors fire
   * exactly as for a direct commit. `scope` names the mount; it may be omitted
   * when exactly one mount is dirty. Commits never span mounts, never list an
   * unrelated mount's repository, and on success clear ONLY the committed
   * mount's local copies and whiteouts — every other mount's uncommitted work
   * (including pending deletions under a deeper mount's subtree) survives.
   */
  async gitCommit(input: WorkspaceCommitInput): Promise<WorkspaceCommitResult> {
    if (typeof input.message !== "string" || input.message.trim() === "") {
      throw new Error("commit message must be a non-empty string.");
    }
    return this.#serializeWrite(async () => {
      const snapshot = await this.#mountSnapshot();
      const grouped = this.#groupLocalAndWhiteouts(snapshot, await this.#localFilePaths());

      let mountPath: string;
      if (input.scope === undefined) {
        // Inferred WITHOUT repo listings: any mount holding a PUBLISHABLE
        // local file or a whiteout may have changes — .gitignored files
        // never nominate a mount, so they cannot fabricate span errors. (A
        // stale whiteout can still nominate a mount that classification then
        // proves clean — that fails loudly below instead of silently
        // guessing another.)
        const dirty: string[] = [];
        for (const path of snapshot.mountPaths) {
          const publishable =
            grouped.whiteoutsByMount.get(path)!.length > 0 ||
            (await this.#publishableLocalPaths(path, grouped.localByMount.get(path)!)).length > 0;
          if (publishable) dirty.push(path);
        }
        if (dirty.length === 0) {
          throw new Error("Nothing to commit — no mount has changes.");
        }
        if (dirty.length > 1) {
          throw new Error(
            `Changes span ${dirty.length} mounts (${dirty.map((path) => `"${path}"`).join(", ")}); ` +
              "commits never span mounts — pass { scope } to pick one.",
          );
        }
        mountPath = dirty[0]!;
      } else {
        const scope = resolveAbsolutePath(input.scope);
        if (!(scope in snapshot.mounts)) {
          throw new Error(
            `No mount at "${scope}" (mounts: ${snapshot.mountPaths.map((path) => `"${path}"`).join(", ")}).`,
          );
        }
        mountPath = scope;
      }
      const mount = snapshot.mounts[mountPath]!;
      if (mount.policy === "read-only") {
        throw new Error(
          `The mount at "${mountPath}" (${mount.repoPath}) is read-only — its changes cannot be committed.`,
        );
      }

      const { changes, localPaths, staleWhiteouts } = await this.#classifyMount(
        snapshot,
        grouped,
        mountPath,
      );
      // Heal crash residue FIRST: a whiteout masking nothing at HEAD (a prior
      // commit died between the repo write and cleanup) would otherwise mark
      // this mount dirty forever and hide a future re-add of the file.
      if (staleWhiteouts.length > 0) {
        const whiteouts = this.#whiteouts();
        for (const key of staleWhiteouts) delete whiteouts[key];
        this.#kv.put(WHITEOUTS_KEY, whiteouts);
      }
      if (changes.length === 0) {
        throw new Error(`Nothing to commit — no changes under the mount at "${mountPath}".`);
      }

      const toRepoPath = (path: string) => path.slice(mountPath.length + 1);
      const repoChanges: RepoFileChange[] = [];
      for (const path of localPaths) {
        const bytes = await this.#workspace.readFileBytes(path);
        if (bytes === null) continue;
        repoChanges.push({ path: toRepoPath(path), ...encodeRepoContent(bytes) });
      }
      for (const change of changes) {
        if (change.change === "deleted") {
          repoChanges.push({ delete: true, path: toRepoPath(change.path) });
        }
      }

      const result = await this.#repo(mount.repoPath).commitFiles({
        author: input.author ?? DEFAULT_COMMIT_AUTHOR,
        changes: repoChanges,
        message: input.message,
      });

      // The changes are on that repo's main; clear ONLY what this mount owns.
      // Ownership is ROUTED against the snapshot, never subtree containment:
      // a "/" commit must not consume a deeper mount's pending deletions.
      const whiteouts = this.#whiteouts();
      let whiteoutsChanged = false;
      for (const key of Object.keys(whiteouts)) {
        if (routeMount(snapshot.mounts, key)?.mountPath !== mountPath) continue;
        delete whiteouts[key];
        whiteoutsChanged = true;
      }
      if (whiteoutsChanged) this.#kv.put(WHITEOUTS_KEY, whiteouts);
      for (const path of localPaths) {
        await this.#workspace.rm(path, { force: true, recursive: true });
      }

      return {
        branch: result.branch,
        changedPaths: result.changedPaths
          .map((path) => `${mountPath}/${path.replace(/^\//, "")}`)
          .sort(),
        commitOid: result.commitOid,
        mount: mountPath,
        repoPath: mount.repoPath,
      };
    });
  }

  /** One mounted repo's main-branch history, newest first. */
  async gitLog(input: WorkspaceGitLogInput = {}): Promise<WorkspaceGitLogEntry[]> {
    const snapshot = await this.#mountSnapshot();
    let mountPath: string;
    if (input.scope === undefined) {
      if (snapshot.mountPaths.length !== 1) {
        throw new Error(
          `log needs { scope } when the workspace has ${snapshot.mountPaths.length} mounts ` +
            `(${snapshot.mountPaths.map((path) => `"${path}"`).join(", ")}).`,
        );
      }
      mountPath = snapshot.mountPaths[0]!;
    } else {
      mountPath = resolveAbsolutePath(input.scope);
      if (!(mountPath in snapshot.mounts)) {
        throw new Error(
          `No mount at "${mountPath}" (mounts: ${snapshot.mountPaths.map((path) => `"${path}"`).join(", ")}).`,
        );
      }
    }
    const result = await this.#repo(snapshot.mounts[mountPath]!.repoPath).log({
      limit: input.limit,
    });
    return result.commits.map((commit) => ({
      author: commit.author,
      message: commit.message,
      oid: commit.oid,
      timestamp: commit.timestamp,
    }));
  }
}

/** One consistent view of the mount table for one operation. */
type MountSnapshot = { mountPaths: string[]; mounts: Record<string, WorkspaceMount> };

/** Local files and whiteout keys, routed to their owning mounts (no repo calls). */
type GroupedOverlay = {
  localByMount: Map<string, string[]>;
  unmounted: WorkspaceChange[];
  whiteoutsByMount: Map<string, string[]>;
};

/**
 * The mount owning a path: longest prefix wins, `"/"` mounts everything not
 * claimed by a deeper mount. `null` for unmounted paths (pure local scratch)
 * and for the mount point itself (a directory, never a repo file). Pure over
 * the given table, so multi-path classification routes every path against one
 * consistent snapshot.
 */
/** A mount point or a strict ancestor of one: a DIRECTORY in the merged view
 * by construction — no file may appear, be written, or be deleted there. */
export function isVirtualDirectoryPath(
  mounts: Record<string, WorkspaceMount>,
  path: string,
): boolean {
  const resolved = resolveAbsolutePath(path);
  return Object.keys(mounts).some((key) => {
    const mountPath = resolveAbsolutePath(key);
    return mountPath === resolved || mountPath.startsWith(`${resolved}/`);
  });
}

/** Paths whose OWNING mount changed between two mount tables (longest-prefix
 * ownership): removed, re-pointed, or stolen by a newly added nested mount.
 * The mount-transition session sweep ends exactly these. */
export function reRoutedPaths(
  before: Record<string, WorkspaceMount>,
  after: Record<string, WorkspaceMount>,
  paths: string[],
): string[] {
  return paths.filter((path) => {
    const ownerBefore = routeMount(before, path);
    const ownerAfter = routeMount(after, path);
    return (
      ownerBefore?.mountPath !== ownerAfter?.mountPath ||
      ownerBefore?.mount.repoPath !== ownerAfter?.mount.repoPath
    );
  });
}

/** A short, stable rendering of the table's mount points for error text. */
function summarizeMountPoints(mounts: Record<string, WorkspaceMount>): string {
  const points = Object.keys(mounts).sort();
  const shown = points.slice(0, 5).map((point) => `"${point}"`);
  const rest = points.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

export function routeMount(
  mounts: Record<string, WorkspaceMount>,
  path: string,
): ResolvedMount | null {
  const resolved = resolveAbsolutePath(path);
  let best: { mount: WorkspaceMount; mountPath: string } | null = null;
  for (const [key, mount] of Object.entries(mounts)) {
    const mountPath = resolveAbsolutePath(key);
    // A "/" mount owns nothing: the workspace root is the project namespace,
    // never a repo checkout (the doors reject "/" mounts; a raw-appended one
    // reduces to a harmless dead entry).
    const owns = resolved === mountPath || resolved.startsWith(`${mountPath}/`);
    if (!owns) continue;
    if (best === null || mountPath.length > best.mountPath.length) best = { mount, mountPath };
  }
  if (best === null) return null;
  if (resolved === best.mountPath) {
    return { mount: best.mount, mountPath: best.mountPath, repoRelativePath: "" };
  }
  return {
    mount: best.mount,
    mountPath: best.mountPath,
    repoRelativePath: resolved.slice(best.mountPath.length + 1),
  };
}
