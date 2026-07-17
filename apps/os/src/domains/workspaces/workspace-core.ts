import { minimatch } from "minimatch";
import { Workspace } from "@cloudflare/shell";
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

// shell's Workspace.readDir has a silent default page limit, so every
// directory read here PAGES until a short page — no directory size silently
// truncates a listing, a status, or a wipe.
const READ_DIR_PAGE = 1_000;

/** One directory's complete entries, paged (shell truncates silently otherwise). */
async function readDirComplete(
  workspace: Workspace,
  dir?: string,
): Promise<{ name: string; path: string; type: string }[]> {
  const entries: { name: string; path: string; type: string }[] = [];
  for (let offset = 0; ; offset += READ_DIR_PAGE) {
    const page = await workspace.readDir(dir, { limit: READ_DIR_PAGE, offset });
    entries.push(...page);
    if (page.length < READ_DIR_PAGE) return entries;
  }
}

/** Every file path under `dir` (absolute, no directories), fully paged. */
export async function walkWorkspaceFiles(workspace: Workspace, dir = "/"): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readDirComplete(workspace, dir)) {
    if (entry.type === "directory")
      paths.push(...(await walkWorkspaceFiles(workspace, entry.path)));
    else if (entry.type === "file") paths.push(entry.path);
  }
  return paths;
}

/** Remove every entry of `dir`: destructive wipes consume page zero until empty. */
export async function wipeWorkspace(workspace: Workspace, dir = "/"): Promise<void> {
  for (;;) {
    const page = await workspace.readDir(dir, { limit: READ_DIR_PAGE });
    if (page.length === 0) return;
    for (const entry of page) {
      await workspace.rm(entry.path, { force: true, recursive: true });
    }
  }
}

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
   * The mount table (mount path → mount), from the workspace's folded
   * processor state. A thunk evaluated per operation, so a `configured` event
   * is visible to the very next read without any cache invalidation here.
   */
  mounts: () => Promise<Record<string, WorkspaceMount>>;
  /**
   * Repo access per mount — a thunk because Durable Object stubs must be
   * re-derived per call, never held across them.
   */
  repo: (repoPath: string) => MountRepoAccess;
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
  readonly #workspace: Workspace;

  constructor(options: WorkspaceCoreOptions) {
    this.#kv = options.kv;
    this.#mounts = options.mounts;
    this.#repo = options.repo;
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
    const prefix = mountPath === "/" ? "" : mountPath;
    return paths.map((path) => `${prefix}/${path}`);
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

  /** Whether a path is hidden from its mount: whiteouted itself or via an ancestor. */
  #isMaskedFromMount(path: string): boolean {
    const whiteouts = this.#whiteouts();
    let current = resolveAbsolutePath(path);
    while (true) {
      if (whiteouts[current]) return true;
      if (current === "/") return false;
      current = current.slice(0, current.lastIndexOf("/")) || "/";
    }
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

  // `.git` is reserved anywhere in the tree: mounts are repo checkouts in
  // spirit, and a local `.git` segment could shadow platform-managed plumbing
  // for some future git consumer.
  #assertWritablePath(path: string): void {
    const resolved = resolveAbsolutePath(path);
    if (resolved === "/" || resolved.split("/").includes(".git")) {
      throw new Error(
        `Workspace path is not writable: "${path}" (the root and .git segments are platform-managed).`,
      );
    }
  }

  // -- filesystem ----------------------------------------------------------------

  async readFile(path: string): Promise<string | null> {
    const local = await this.#workspace.readFile(path);
    if (local !== null) return local;
    if (this.#isMaskedFromMount(path)) return null;
    const resolved = await this.#mountFor(path);
    if (resolved === null || resolved.repoRelativePath === "") return null;
    const file = await this.#repo(resolved.mount.repoPath).readFile({
      path: resolved.repoRelativePath,
    });
    return file === null ? null : file.content;
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    const local = await this.#workspace.readFileBytes(path);
    if (local !== null) return local;
    if (this.#isMaskedFromMount(path)) return null;
    const resolved = await this.#mountFor(path);
    if (resolved === null || resolved.repoRelativePath === "") return null;
    const file = await this.#repo(resolved.mount.repoPath).readFile({
      encoding: "base64",
      path: resolved.repoRelativePath,
    });
    return file === null ? null : Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
  }

  async exists(path: string): Promise<boolean> {
    if (await this.#workspace.exists(path)) return true;
    if (this.#isMaskedFromMount(path)) return false;
    const resolved = await this.#mountFor(path);
    if (resolved === null) return false;
    // A mount point is a virtual directory; anything else may be a mount FILE
    // or a mount DIRECTORY (a prefix of mount files) — one listing answers both.
    if (resolved.repoRelativePath === "") return true;
    const target = resolveAbsolutePath(path);
    const mountFiles = await this.#mountFilePaths(resolved.mountPath, resolved.mount);
    return mountFiles.some(
      (file) =>
        (file === target || file.startsWith(`${target}/`)) && !this.#isMaskedFromMount(file),
    );
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.#assertWritablePath(path);
    await this.#assertNotMountPoint(path);
    return this.#serializeWrite(async () => {
      await this.#workspace.writeFile(path, content);
      this.#clearWhiteout(path);
    });
  }

  async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    this.#assertWritablePath(path);
    await this.#assertNotMountPoint(path);
    return this.#serializeWrite(async () => {
      await this.#workspace.writeFileBytes(path, data);
      this.#clearWhiteout(path);
    });
  }

  /** A mount point is a virtual DIRECTORY — a local file there would collide
   * with every mounted descendant and commit as an empty repo path. */
  async #assertNotMountPoint(path: string): Promise<void> {
    const resolved = await this.#mountFor(path);
    if (resolved !== null && resolved.repoRelativePath === "" && resolved.mountPath !== "/") {
      throw new Error(
        `Workspace path is not writable: "${path}" is the mount point of ${resolved.mount.repoPath} (a directory).`,
      );
    }
  }

  async edit(input: EditWorkspaceFileInput): Promise<EditWorkspaceFileResult> {
    this.#assertWritablePath(input.path);
    if (typeof input.oldString !== "string" || input.oldString === "") {
      throw new Error("edit oldString must be a non-empty string.");
    }
    return this.#serializeWrite(async () => {
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
    this.#assertWritablePath(path);
    return this.#serializeWrite(async () => {
      // An already-masked path has nothing mount-side left to hide: deleting
      // it again must NOT touch the existing whiteout (retracting it would
      // resurrect the mount file). Only a local copy — visible above an
      // ancestor whiteout because the local layer wins — can remain to delete.
      if (this.#isMaskedFromMount(path)) {
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
      // Whiteout before the local delete (both now infallible-cheap), so an
      // unserialized read arriving between them can never fall through and
      // resurrect the mount copy mid-delete.
      if (mountHas) this.#addWhiteout(path);
      const localDeleted = await this.#workspace.deleteFile(path);
      return localDeleted || mountHas;
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
        if (this.#isMaskedFromMount(path)) continue;
        // A deeper mount shadows this one's files under its point.
        if (routeMount(mounts, path)?.mount !== mount) continue;
        merged.add(path);
      }
    }
    return [...merged].sort();
  }

  /** Files in the merged view matching a glob pattern (paths only). */
  async glob(pattern: string): Promise<string[]> {
    const all = await this.listAllFiles();
    return all.filter((path) => minimatch(path, pattern, { dot: true }));
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
    this.#assertWritablePath(path);
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
    const fromRel = (rel: string) => (mountPath === "/" ? rel : `${mountPath}${rel}`);
    const owned = grouped.localByMount.get(mountPath)!;
    const ownedSet = new Set(owned);
    const publishableRel = await filterPublishablePaths({
      paths: owned.map((path) => (mountPath === "/" ? path : path.slice(mountPath.length))),
      readFile: (rel) => this.#workspace.readFile(fromRel(rel)),
    });
    const localPaths = publishableRel.map(fromRel);
    const mountFiles = await this.#mountFilePaths(mountPath, snapshot.mounts[mountPath]!);
    const mountSet = new Set(mountFiles);

    const changes: WorkspaceChange[] = localPaths.map((path) => ({
      change: mountSet.has(path) && !this.#isMaskedFromMount(path) ? "modified" : "added",
      path,
    }));
    for (const path of mountFiles) {
      if (!this.#isMaskedFromMount(path) || ownedSet.has(path)) continue;
      if (routeMount(snapshot.mounts, path)?.mountPath !== mountPath) continue;
      changes.push({ change: "deleted", path });
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));

    const staleWhiteouts = grouped.whiteoutsByMount
      .get(mountPath)!
      .filter(
        (key) => !mountSet.has(key) && !mountFiles.some((file) => file.startsWith(`${key}/`)),
      );
    return { changes, localPaths, staleWhiteouts };
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
    if (stale.length > 0) await this.#healStaleWhiteouts(snapshot, stale);
    return { mounts: classified.map((mount) => mount.entry), unmounted: grouped.unmounted };
  }

  /** Serialized whiteout removal with an in-lock re-probe: only keys that
   * STILL mask nothing at HEAD (one point read each; rare path) are dropped. */
  #healStaleWhiteouts(snapshot: MountSnapshot, candidates: string[]): Promise<void> {
    return this.#serializeWrite(async () => {
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
        // Inferred WITHOUT repo listings: any mount holding a local file or a
        // whiteout may have changes. (A stale whiteout can nominate a mount
        // that classification then proves clean — that fails loudly below
        // instead of silently guessing another mount.)
        const dirty = snapshot.mountPaths.filter(
          (path) =>
            grouped.localByMount.get(path)!.length > 0 ||
            grouped.whiteoutsByMount.get(path)!.length > 0,
        );
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

      const toRepoPath = (path: string) =>
        mountPath === "/" ? path.slice(1) : path.slice(mountPath.length + 1);
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
          .map((path) => `${mountPath === "/" ? "" : mountPath}/${path.replace(/^\//, "")}`)
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
function routeMount(mounts: Record<string, WorkspaceMount>, path: string): ResolvedMount | null {
  const resolved = resolveAbsolutePath(path);
  let best: { mount: WorkspaceMount; mountPath: string } | null = null;
  for (const [key, mount] of Object.entries(mounts)) {
    const mountPath = resolveAbsolutePath(key);
    const owns =
      mountPath === "/" || resolved === mountPath || resolved.startsWith(`${mountPath}/`);
    if (!owns) continue;
    if (best === null || mountPath.length > best.mountPath.length) best = { mount, mountPath };
  }
  if (best === null) return null;
  if (resolved === best.mountPath) {
    return { mount: best.mount, mountPath: best.mountPath, repoRelativePath: "" };
  }
  const repoRelativePath =
    best.mountPath === "/" ? resolved.slice(1) : resolved.slice(best.mountPath.length + 1);
  return { mount: best.mount, mountPath: best.mountPath, repoRelativePath };
}
