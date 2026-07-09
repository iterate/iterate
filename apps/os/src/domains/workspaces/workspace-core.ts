import { InMemoryFs, Workspace } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import { countOccurrences, replaceLiteralOccurrences } from "../repos/edit-utils.ts";
import type {
  EditWorkspaceFileInput,
  EditWorkspaceFileResult,
  WorkspaceChange,
  WorkspaceFileInfo,
  WorkspaceGitLogEntry,
  WorkspacePublishResult,
} from "./types.ts";
import { filterPublishablePaths } from "./overlay-ignore.ts";

// The root workspace's materialized head: the commit oid of main currently
// checked out in this workspace's filesystem. Presence doubles as the "cloned
// once" sentinel; every root read compares it against the repo's durable head
// cache and re-materializes only when main actually moved.
const ROOT_HEAD_KEY = "root-head:v1";

// Overlay whiteouts: parent paths hidden by a local delete, kept as ONE kv
// record (a path -> true map) so status can enumerate deletions without a kv
// scan. Writes are serialized on the write chain, so read-modify-write of the
// single record cannot lose updates.
const WHITEOUTS_KEY = "whiteouts:v1";

// The pre-overlay model's clone sentinel. A workspace that carries it holds a
// FULL stale checkout from the clone-on-first-touch era — the first overlay
// touch wipes it (the disposability contract: committed state lives on the
// workspace branch, everything else is disposable).
const LEGACY_CLONE_SENTINEL_KEY = "workspace-cloned:v1";

const DEFAULT_COMMIT_AUTHOR = { email: "support@iterate.com", name: "Iterate" };

// The Artifacts git endpoint intermittently returns 503 on a cold repo
// (observed in preview e2e; the sandbox clone path carries the same loop).
const CLONE_ATTEMPTS = 3;

// shell's Workspace.readDir defaults to a silent 1000-entry limit. That
// default also feeds directory walks (the root materialization's wipe, the
// overlay's local-layer enumeration), where truncation silently loses files —
// so raise it far past any plausible checkout directory.
const READ_DIR_LIMIT = 100_000;

/** {@link Workspace} with the silent readDir truncation lifted (see {@link READ_DIR_LIMIT}). */
export class UnboundedWorkspace extends Workspace {
  override readDir(dir?: string, opts?: { limit?: number; offset?: number }) {
    return super.readDir(dir, { limit: READ_DIR_LIMIT, ...opts });
  }
}

/**
 * The repo surface the core needs: the durable head cursor, clone/push
 * coordinates, and branch history. Satisfied by the project Repo Durable
 * Object's stub.
 */
interface RepoAccess {
  getHead(): Promise<{ commitOid: string }>;
  gitAccess(): Promise<{ defaultBranch: string; remote: string; token: string }>;
  log(input: { branch?: string; limit?: number }): Promise<{
    commits: {
      author: { email: string; name: string };
      message: string;
      oid: string;
      timestamp: number;
    }[];
  }>;
}

/**
 * The read surface an overlay falls through to on a local miss. Satisfied by
 * the root workspace's Durable Object stub (whose methods are themselves
 * backed by a root-mode {@link WorkspaceCore}).
 */
interface ParentReads {
  readFile(path: string): Promise<string | null>;
  readFileBytes(path: string): Promise<Uint8Array | null>;
  stat(path: string): Promise<WorkspaceFileInfo | null>;
  exists(path: string): Promise<boolean>;
  readDir(dir?: string): Promise<WorkspaceFileInfo[]>;
  glob(pattern: string): Promise<WorkspaceFileInfo[]>;
  listAllFiles(): Promise<string[]>;
}

/** The slice of a Durable Object's synchronous kv the core keeps its bookkeeping in. */
interface WorkspaceKv {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): void;
}

type WorkspaceCoreOptions = {
  /** The workspace's own publish branch in the project repo (`workspaces/<path>`). */
  branch: string;
  /** git bound to `workspace`'s filesystem — the root materialization's clone lane. */
  git: ReturnType<typeof createGit>;
  /** Durable synchronous kv for the head cursor / whiteouts / legacy sentinel. */
  kv: WorkspaceKv;
  mode: "overlay" | "root";
  /**
   * The parent the overlay falls through to. A thunk, not a stored stub —
   * stubs must be re-derived per call, never held across them.
   */
  parent: () => ParentReads;
  /**
   * The project repo — a thunk for the same reason as `parent`. Clone
   * coordinates come from its `gitAccess()` (the documented internal DO-to-DO
   * surface, same as the sandbox domain), so repo tokens never appear on any
   * public surface.
   */
  repo: () => RepoAccess;
  /** The local layer: this workspace's own private virtual filesystem. */
  workspace: Workspace;
};

/**
 * The workspace semantics as a host-agnostic library object, constructed
 * inside a Durable Object host (cloudflare/workspace's shape: the Workspace
 * is a library object, the DO a thin host) — so the same core can later be
 * hosted by other DOs and the storage engine stays swappable. One of two
 * modes:
 *
 * ROOT: the project's always-fresh, READ-ONLY materialization of the project
 * repo's main branch. Every read checks the repo's durable head cache (one
 * cheap RPC — the repo's read-your-write boundary, so a commit is visible
 * here the moment `commitFiles` returns) and re-clones only when main
 * actually moved.
 *
 * OVERLAY: a copy-on-write layer over the parent (the root workspace). Writes
 * land in the local filesystem; reads try the local layer first and fall
 * through to the parent on a miss; deletes of parent files leave whiteouts so
 * the parent copy stays hidden. There is NO clone — a fresh overlay workspace
 * is usable instantly and always sees latest main through the fall-through,
 * until a local write pins a path.
 *
 * Truth lives in the filesystem; git is the PUBLISH mechanism, not the
 * storage: `gitCommit` snapshots the merged view (main + local layer, minus
 * whiteouts and .gitignored paths) as one commit force-pushed to this
 * workspace's own branch in the project's Artifacts repo — never to main —
 * which keeps the local layer disposable.
 */
export class WorkspaceCore {
  readonly #branch: string;
  readonly #git: ReturnType<typeof createGit>;
  readonly #isRoot: boolean;
  readonly #kv: WorkspaceKv;
  readonly #parent: () => ParentReads;
  readonly #repo: () => RepoAccess;
  readonly #workspace: Workspace;

  constructor(options: WorkspaceCoreOptions) {
    this.#branch = options.branch;
    this.#git = options.git;
    this.#isRoot = options.mode === "root";
    this.#kv = options.kv;
    this.#parent = options.parent;
    this.#repo = options.repo;
    this.#workspace = options.workspace;
  }

  // -- ROOT mode: materialize latest main, re-materialize when it moves -----

  // In-flight materialization, shared by every concurrent read that finds the
  // head stale. Reset on completion or failure so the next read retries (the
  // common transient: the project repo is still seeding).
  #rootRefresh: Promise<void> | undefined;

  async #ensureFreshRoot(): Promise<void> {
    // Never read mid-materialization — the wipe would show as an empty tree.
    if (this.#rootRefresh !== undefined) await this.#rootRefresh;
    const head = await this.#repo()
      .getHead()
      .catch((error: unknown) => {
        // A cold root with SOME checkout is better than an error while the
        // repo DO hiccups; a root that never materialized has nothing to give.
        if (this.#kv.get(ROOT_HEAD_KEY) === undefined) {
          throw new Error(
            `Root workspace source is not available (the project repo may still be seeding; retry shortly): ${String(error)}`,
          );
        }
        return null;
      });
    if (head === null || this.#kv.get(ROOT_HEAD_KEY) === head.commitOid) return;
    this.#rootRefresh ??= this.#materializeRoot(head.commitOid).finally(() => {
      this.#rootRefresh = undefined;
    });
    await this.#rootRefresh;
  }

  /**
   * Wipe and re-clone main, retrying until the clone observes AT LEAST
   * `expectedHead`. The Artifacts remote is eventually consistent — a clone
   * right after a push can serve the previous HEAD (the same trap the Repo
   * DO's own clone lanes guard with `repo-pushed-head`), and the head cursor
   * that triggered this refresh comes from the commit's read-your-write
   * boundary, so serving anything older would hand a post-commit reader
   * pre-commit content. A clone that is merely DIFFERENT after the retries
   * (main moved again mid-refresh) is recorded as-is — the next read's
   * cursor comparison repairs the lag.
   */
  async #materializeRoot(expectedHead: string): Promise<void> {
    const repo = await this.#repo().gitAccess();
    // The head key comes off BEFORE the wipe: if every attempt below fails,
    // the workspace must read as "never materialized" (reads error and retry)
    // — a lingering key over a wiped filesystem would serve an empty tree as
    // if it were main.
    this.#kv.delete(ROOT_HEAD_KEY);
    for (let attempt = 1, staleAttempt = 1; ; ) {
      // A previous attempt may have died mid-checkout; start from empty so
      // isomorphic-git never sees a half-written .git.
      await this.#wipeFilesystem();
      try {
        await this.#git.clone({
          branch: repo.defaultBranch,
          depth: 1,
          singleBranch: true,
          url: repo.remote,
          username: "x",
          password: repo.token,
        });
      } catch (error) {
        if (attempt >= CLONE_ATTEMPTS) throw error;
        console.warn(`root workspace clone attempt ${attempt} failed, retrying: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        attempt++;
        continue;
      }
      const [head] = await this.#git.log({ depth: 1 });
      if (!head) throw new Error("Root workspace clone has no commits.");
      if (head.oid !== expectedHead && staleAttempt <= 5) {
        console.warn(
          `root workspace clone is behind the head cursor (saw ${head.oid}, expected ${expectedHead}); retry ${staleAttempt}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 500 * staleAttempt));
        staleAttempt++;
        continue;
      }
      this.#kv.put(ROOT_HEAD_KEY, head.oid);
      return;
    }
  }

  // -- OVERLAY mode: local layer + fall-through ------------------------------

  // One-time migration off the clone-on-first-touch model: a legacy full
  // checkout would shadow the ENTIRE parent with a stale copy, so wipe it.
  #overlayReady: Promise<void> | undefined;

  #ensureOverlay(): Promise<void> {
    this.#overlayReady ??= (async () => {
      if (this.#kv.get(LEGACY_CLONE_SENTINEL_KEY) !== undefined) {
        await this.#wipeFilesystem();
        this.#kv.delete(LEGACY_CLONE_SENTINEL_KEY);
      }
    })().catch((error: unknown) => {
      this.#overlayReady = undefined;
      throw error;
    });
    return this.#overlayReady;
  }

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
   * Whether a path is hidden from the parent view: whiteouted (itself or via
   * an ancestor), or the parent's `.git` — platform plumbing of the root's
   * checkout, meaningless (and confusing) inside an overlay.
   */
  #isMaskedFromParent(path: string): boolean {
    const resolved = resolveAbsolutePath(path);
    if (resolved === "/.git" || resolved.startsWith("/.git/")) return true;
    const whiteouts = this.#whiteouts();
    let current = resolved;
    while (true) {
      if (whiteouts[current]) return true;
      if (current === "/") return false;
      current = current.slice(0, current.lastIndexOf("/")) || "/";
    }
  }

  async #parentExists(path: string): Promise<boolean> {
    if (this.#isMaskedFromParent(path)) return false;
    return this.#parent().exists(path);
  }

  /** All file paths of the local layer (absolute, no directories). */
  async #localFilePaths(dir = "/"): Promise<string[]> {
    const paths: string[] = [];
    for (const entry of await this.#workspace.readDir(dir)) {
      if (entry.type === "directory") paths.push(...(await this.#localFilePaths(entry.path)));
      else if (entry.type === "file") paths.push(entry.path);
    }
    return paths;
  }

  // -- lifecycle --------------------------------------------------------------

  async #wipeFilesystem(): Promise<void> {
    for (const entry of await this.#workspace.readDir("/")) {
      await this.#workspace.rm(entry.path, { force: true, recursive: true });
    }
  }

  /**
   * Wipe this workspace back to pristine. Root: the next read re-materializes
   * main (the escape hatch for a wedged checkout). Overlay: the local layer
   * and every whiteout vanish, so the workspace shows exactly the parent
   * again — unpublished work is lost (published state survives on the
   * workspace branch).
   */
  async reset(): Promise<void> {
    // Settle any in-flight materialization or write first — even a FAILING
    // one (that is exactly when reset is needed), hence catch-and-ignore.
    await this.#rootRefresh?.catch(() => {});
    await this.#writeChain.catch(() => {});
    this.#rootRefresh = undefined;
    this.#overlayReady = undefined;
    this.#kv.delete(ROOT_HEAD_KEY);
    this.#kv.delete(WHITEOUTS_KEY);
    this.#kv.delete(LEGACY_CLONE_SENTINEL_KEY);
    await this.#wipeFilesystem();
  }

  /**
   * Un-pin one path: drop the local copy (file or subtree) and clear the
   * whiteouts at or below it, so the path resumes following latest main
   * through the fall-through. The surgical sibling of `reset()` — reverting
   * "/worker.ts" after an edit brings back main's version, reverting a
   * deleted path un-deletes it. Scoped strictly at-or-below: an ancestor
   * whiteout (a deleted parent directory) still masks the path until that
   * ancestor is reverted too.
   */
  async revert(path: string): Promise<void> {
    this.#assertWritablePath(path);
    await this.#ensureOverlay();
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

  // -- write discipline -----------------------------------------------------

  // ALL mutations serialize on this chain: whiteout read-modify-writes and
  // multi-step operations (append's read-then-write, publish's clone) yield
  // the host DO's input gate at awaits, so unserialized writes could
  // interleave and lose updates. Reads stay unserialized — they are local
  // SQLite lookups plus idempotent parent RPCs.
  #writeChain: Promise<unknown> = Promise.resolve();

  #serializeWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.#writeChain.then(write, write);
    this.#writeChain = result.catch(() => {});
    return result;
  }

  #assertWritable(): void {
    if (this.#isRoot) {
      throw new Error(
        'The root workspace ("/") is read-only — it always mirrors the project repo\'s main ' +
          "branch. Write in your own workspace (itx.workspace, or itx.workspaces.get" +
          '("/workspaces/<name>")), or commit to main via itx.repo.',
      );
    }
  }

  // The `.git` name is reserved: the root's checkout is platform-managed, and
  // an overlay writing `.git/**` would shadow the parent's with attacker-
  // chosen content (e.g. a rewritten remote URL for some future git consumer).
  #assertWritablePath(path: string): void {
    this.#assertWritable();
    const resolved = resolveAbsolutePath(path);
    if (resolved === "/" || resolved === "/.git" || resolved.startsWith("/.git/")) {
      throw new Error(
        `Workspace path is not writable: "${path}" (the .git directory and the root are platform-managed).`,
      );
    }
  }

  // -- filesystem (mirrors @cloudflare/shell's Workspace surface, merged) ----

  async readFile(path: string): Promise<string | null> {
    if (this.#isRoot) {
      await this.#ensureFreshRoot();
      return this.#workspace.readFile(path);
    }
    await this.#ensureOverlay();
    const local = await this.#workspace.readFile(path);
    if (local !== null) return local;
    if (this.#isMaskedFromParent(path)) return null;
    return this.#parent().readFile(path);
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    if (this.#isRoot) {
      await this.#ensureFreshRoot();
      return this.#workspace.readFileBytes(path);
    }
    await this.#ensureOverlay();
    const local = await this.#workspace.readFileBytes(path);
    if (local !== null) return local;
    if (this.#isMaskedFromParent(path)) return null;
    return this.#parent().readFileBytes(path);
  }

  async stat(path: string): Promise<WorkspaceFileInfo | null> {
    if (this.#isRoot) {
      await this.#ensureFreshRoot();
      return this.#workspace.stat(path);
    }
    await this.#ensureOverlay();
    const local = await this.#workspace.stat(path);
    if (local !== null) return local;
    if (this.#isMaskedFromParent(path)) return null;
    return this.#parent().stat(path);
  }

  async exists(path: string): Promise<boolean> {
    if (this.#isRoot) {
      await this.#ensureFreshRoot();
      return this.#workspace.exists(path);
    }
    await this.#ensureOverlay();
    if (await this.#workspace.exists(path)) return true;
    return this.#parentExists(path);
  }

  async readDir(dir?: string): Promise<WorkspaceFileInfo[]> {
    if (this.#isRoot) {
      await this.#ensureFreshRoot();
      return this.#workspace.readDir(dir);
    }
    await this.#ensureOverlay();
    // No defensive catches: a missing directory is an empty listing on both
    // sides (plain SQL, never a throw), so any error here is REAL — a parent
    // RPC failure must fail the merged read, not masquerade as an empty or
    // local-only tree.
    const local = await this.#workspace.readDir(dir);
    const target = dir ?? "/";
    const parent = this.#isMaskedFromParent(target) ? [] : await this.#parent().readDir(dir);
    return mergeEntries({
      local,
      parent: parent.filter((entry) => !this.#isMaskedFromParent(entry.path)),
    });
  }

  async glob(pattern: string): Promise<WorkspaceFileInfo[]> {
    if (this.#isRoot) {
      await this.#ensureFreshRoot();
      return this.#workspace.glob(pattern);
    }
    await this.#ensureOverlay();
    // Same rule as readDir: no-match is [], so an error is real and surfaces.
    const local = await this.#workspace.glob(pattern);
    const parent = await this.#parent().glob(pattern);
    return mergeEntries({
      local,
      parent: parent.filter((entry) => !this.#isMaskedFromParent(entry.path)),
    });
  }

  /**
   * Every file path in the merged view (absolute, sorted, no directories).
   * The one-RPC bulk listing overlays use to classify their local layer
   * against the parent — and the cheap way for anything else to see a
   * workspace's full extent without a readDir walk.
   */
  async listAllFiles(): Promise<string[]> {
    if (this.#isRoot) {
      await this.#ensureFreshRoot();
      const paths = await this.#localFilePaths();
      return paths.filter((path) => path !== "/.git" && !path.startsWith("/.git/")).sort();
    }
    await this.#ensureOverlay();
    const merged = new Set(await this.#localFilePaths());
    for (const path of await this.#parent().listAllFiles()) {
      if (!this.#isMaskedFromParent(path)) merged.add(path);
    }
    return [...merged].sort();
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.#assertWritablePath(path);
    await this.#ensureOverlay();
    return this.#serializeWrite(async () => {
      await this.#workspace.writeFile(path, content);
      this.#clearWhiteout(path);
    });
  }

  async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    this.#assertWritablePath(path);
    await this.#ensureOverlay();
    return this.#serializeWrite(async () => {
      await this.#workspace.writeFileBytes(path, data);
      this.#clearWhiteout(path);
    });
  }

  async appendFile(path: string, content: string): Promise<void> {
    this.#assertWritablePath(path);
    await this.#ensureOverlay();
    return this.#serializeWrite(async () => {
      // Copy-up: appending to a parent-only file materializes it locally.
      const local = await this.#workspace.readFile(path);
      const base =
        local ??
        (this.#isMaskedFromParent(path) ? null : await this.#parent().readFile(path)) ??
        "";
      await this.#workspace.writeFile(path, base + content);
      this.#clearWhiteout(path);
    });
  }

  async deleteFile(path: string): Promise<boolean> {
    this.#assertWritablePath(path);
    await this.#ensureOverlay();
    return this.#serializeWrite(async () => {
      // Whiteout FIRST (synchronous), so an unserialized read arriving after
      // the local delete below can never fall through and resurrect the
      // parent copy mid-delete. Retracted at the end if nothing was hidden.
      const wasMasked = this.#isMaskedFromParent(path);
      this.#addWhiteout(path);
      const localDeleted = await this.#workspace.deleteFile(path);
      const parentHas = !wasMasked && (await this.#parent().exists(path));
      if (!parentHas) this.#clearWhiteout(path);
      return localDeleted || parentHas;
    });
  }

  async edit(input: EditWorkspaceFileInput): Promise<EditWorkspaceFileResult> {
    this.#assertWritablePath(input.path);
    if (typeof input.oldString !== "string" || input.oldString === "") {
      throw new Error("edit oldString must be a non-empty string.");
    }
    await this.#ensureOverlay();
    return this.#serializeWrite(async () => {
      // Copy-up: editing a parent file materializes the edited copy locally.
      const content =
        (await this.#workspace.readFile(input.path)) ??
        (this.#isMaskedFromParent(input.path) ? null : await this.#parent().readFile(input.path));
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

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    this.#assertWritablePath(path);
    await this.#ensureOverlay();
    return this.#serializeWrite(async () => {
      await this.#workspace.mkdir(path, opts);
      this.#clearWhiteout(path);
    });
  }

  async rm(path: string, opts?: { force?: boolean; recursive?: boolean }): Promise<void> {
    this.#assertWritablePath(path);
    await this.#ensureOverlay();
    return this.#serializeWrite(async () => {
      // Same whiteout-first ordering as deleteFile (no mid-delete resurrect).
      const wasMasked = this.#isMaskedFromParent(path);
      this.#addWhiteout(path);
      const localExists = await this.#workspace.exists(path);
      if (localExists) await this.#workspace.rm(path, opts);
      const parentHas = !wasMasked && (await this.#parent().exists(path));
      if (!parentHas) this.#clearWhiteout(path);
      if (!localExists && !parentHas && !opts?.force) {
        throw new Error(`Workspace path does not exist: "${path}".`);
      }
    });
  }

  async cp(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    this.#assertWritablePath(dest);
    await this.#ensureOverlay();
    return this.#serializeWrite(() => this.#copyMerged(src, dest, opts));
  }

  async mv(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    this.#assertWritablePath(src);
    this.#assertWritablePath(dest);
    await this.#ensureOverlay();
    return this.#serializeWrite(async () => {
      await this.#copyMerged(src, dest, { recursive: true, ...opts });
      if (await this.#workspace.exists(src)) {
        await this.#workspace.rm(src, { force: true, recursive: true });
      }
      if (await this.#parentExists(src)) this.#addWhiteout(src);
    });
  }

  /**
   * Copy within the MERGED view: the source may live locally, in the parent,
   * or (a directory whose files straddle both) in each — the destination is
   * always local. Runs inside the write chain.
   */
  async #copyMerged(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    const srcStat =
      (await this.#workspace.stat(src)) ??
      (this.#isMaskedFromParent(src) ? null : await this.#parent().stat(src));
    if (srcStat === null) throw new Error(`Workspace path does not exist: "${src}".`);
    if (srcStat.type === "directory") {
      if (!opts?.recursive) {
        throw new Error(`"${src}" is a directory (pass { recursive: true } to copy it).`);
      }
      const from = resolveAbsolutePath(src);
      const to = resolveAbsolutePath(dest);
      const files = (await this.listAllFiles()).filter(
        (path) => path === from || path.startsWith(`${from}/`),
      );
      for (const path of files) {
        await this.#copyMergedFile(path, `${to}${path.slice(from.length)}`);
      }
      return;
    }
    await this.#copyMergedFile(resolveAbsolutePath(src), resolveAbsolutePath(dest));
  }

  async #copyMergedFile(src: string, dest: string): Promise<void> {
    const bytes =
      (await this.#workspace.readFileBytes(src)) ??
      (this.#isMaskedFromParent(src) ? null : await this.#parent().readFileBytes(src));
    if (bytes === null) throw new Error(`Workspace path does not exist: "${src}".`);
    await this.#workspace.writeFileBytes(dest, bytes);
    this.#clearWhiteout(dest);
  }

  // -- publish (git) ----------------------------------------------------------

  /**
   * The overlay's changes relative to the parent: local files that shadow a
   * parent file ("modified" — shadowed, not content-diffed), local files the
   * parent lacks ("added"), and whiteouted parent files ("deleted").
   * `.gitignore`d local files (e.g. spilled script results) are omitted, same
   * as `gitCommit` will omit them.
   */
  async gitStatus(): Promise<WorkspaceChange[]> {
    if (this.#isRoot) {
      throw new Error(
        'The root workspace ("/") mirrors main and has no changes of its own — inspect main via itx.repo.',
      );
    }
    await this.#ensureOverlay();
    const localPaths = await filterPublishablePaths({
      paths: await this.#localFilePaths(),
      readFile: (path) => this.#workspace.readFile(path),
    });
    const parentPaths = await this.#parent().listAllFiles();
    const parentSet = new Set(parentPaths);
    const changes: WorkspaceChange[] = localPaths.map((path) => ({
      change: parentSet.has(path) && !this.#isMaskedFromParent(path) ? "modified" : "added",
      path,
    }));
    const localSet = new Set(localPaths);
    for (const path of parentPaths) {
      if (this.#isMaskedFromParent(path) && !localSet.has(path)) {
        changes.push({ change: "deleted", path });
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Publish the merged view as ONE snapshot commit on this workspace's own
   * branch in the project repo. Implementation: clone main, replay the local
   * layer (minus .gitignored paths) and whiteout deletions onto it, commit,
   * force-push. Force because each publish is a fresh snapshot on the current
   * main — the branch always shows "main as this workspace sees it", not an
   * incremental history.
   */
  async gitCommit(input: {
    author?: { email: string; name: string };
    message: string;
  }): Promise<WorkspacePublishResult> {
    if (this.#isRoot) {
      throw new Error(
        'The root workspace ("/") is read-only — commit to main via itx.repo.commitFiles/edit.',
      );
    }
    if (typeof input.message !== "string" || input.message.trim() === "") {
      throw new Error("commit message must be a non-empty string.");
    }
    await this.#ensureOverlay();
    return this.#serializeWrite(async () => {
      const localPaths = await filterPublishablePaths({
        paths: await this.#localFilePaths(),
        readFile: (path) => this.#workspace.readFile(path),
      });
      const whiteouts = Object.keys(this.#whiteouts());
      if (localPaths.length === 0 && whiteouts.length === 0) {
        throw new Error("Nothing to publish — the workspace has no changes over main.");
      }

      const repo = await this.#repo().gitAccess();
      // Same read-your-write guard as #materializeRoot: the publish base must
      // observe at least the head cursor, or a post-commit publish could
      // snapshot pre-commit main under the overlay (the Artifacts remote is
      // eventually consistent). Same 503-retry as every other clone lane.
      const expectedHead = (await this.#repo().getHead()).commitOid;
      let filesystem: InMemoryFs;
      let git: ReturnType<typeof createGit>;
      for (let attempt = 1, staleAttempt = 1; ; ) {
        filesystem = new InMemoryFs();
        git = createGit(filesystem, "/repo");
        try {
          // Full (non-shallow) clone: pushing needs the object walk to reach
          // a commit the remote already has.
          await git.clone({
            branch: repo.defaultBranch,
            singleBranch: true,
            url: repo.remote,
            username: "x",
            password: repo.token,
          });
        } catch (error) {
          if (attempt >= CLONE_ATTEMPTS) throw error;
          console.warn(`publish clone attempt ${attempt} failed, retrying: ${String(error)}`);
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          attempt++;
          continue;
        }
        const [tip] = await git.log({ depth: 1 });
        if (!tip) throw new Error("Publish clone has no commits.");
        if (tip.oid !== expectedHead && staleAttempt <= 5) {
          console.warn(
            `publish clone is behind the head cursor (saw ${tip.oid}, expected ${expectedHead}); retry ${staleAttempt}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 500 * staleAttempt));
          staleAttempt++;
          continue;
        }
        break;
      }
      await git.checkout({ branch: this.#branch });

      const changedPaths: string[] = [];
      for (const path of localPaths) {
        const bytes = await this.#workspace.readFileBytes(path);
        if (bytes === null) continue;
        const absolute = `/repo${path}`;
        const dir = absolute.slice(0, absolute.lastIndexOf("/"));
        if (dir !== "/repo" && !(await filesystem.exists(dir))) {
          await filesystem.mkdir(dir, { recursive: true });
        }
        await filesystem.writeFileBytes(absolute, bytes);
        await git.add({ filepath: path.slice(1) });
        changedPaths.push(path);
      }
      for (const whiteout of whiteouts) {
        // A whiteout may cover a subtree — expand it against the clone.
        const stat = (await filesystem.exists(`/repo${whiteout}`))
          ? await filesystem.stat(`/repo${whiteout}`)
          : null;
        if (stat === null) continue;
        const doomed =
          stat.type === "directory"
            ? (await walkFiles(filesystem, `/repo${whiteout}`)).map((p) => p.slice("/repo".length))
            : [whiteout];
        for (const path of doomed) {
          if (await filesystem.exists(`/repo${path}`)) await filesystem.rm(`/repo${path}`);
          await git.rm({ filepath: path.slice(1) });
          changedPaths.push(path);
        }
      }

      // The pre-clone guard only proved SOMETHING existed locally; deletions
      // main already applied stage nothing, so re-check what actually staged
      // rather than pushing an empty snapshot (or failing inside git.commit).
      if (changedPaths.length === 0) {
        throw new Error(
          "Nothing to publish — the workspace's deletions have already landed on main.",
        );
      }
      const commit = await git.commit({
        author: input.author ?? DEFAULT_COMMIT_AUTHOR,
        message: input.message,
      });
      const pushed = await git.push({
        force: true,
        ref: this.#branch,
        remote: "origin",
        username: "x",
        password: repo.token,
      });
      if (!pushed.ok) {
        throw new Error(`Failed to push ${this.#branch}: ${JSON.stringify(pushed.refs)}`);
      }
      return { branch: this.#branch, changedPaths: changedPaths.sort(), commitOid: commit.oid };
    });
  }

  /** Published snapshots of this workspace, newest first ([] before the first publish). */
  async gitLog(input: { limit?: number } = {}): Promise<WorkspaceGitLogEntry[]> {
    if (this.#isRoot) {
      throw new Error('The root workspace ("/") mirrors main — read main\'s log via itx.repo.log.');
    }
    // Only "branch does not exist yet" reads as no-publishes; anything else
    // (a bad limit, a broken remote) is the caller's error to see.
    const result = await this.#repo()
      .log({ branch: this.#branch, limit: input.limit })
      .catch((error: unknown) => {
        if (/not.?found|could not find/i.test(String(error))) return null;
        throw error;
      });
    if (result === null) return [];
    return result.commits.map((commit) => ({
      author: commit.author,
      message: commit.message,
      oid: commit.oid,
      timestamp: commit.timestamp,
    }));
  }
}

/**
 * Merge a local and a parent directory listing: union by path, the local
 * entry wins (its metadata describes the copy reads will actually see).
 */
function mergeEntries(input: {
  local: WorkspaceFileInfo[];
  parent: WorkspaceFileInfo[];
}): WorkspaceFileInfo[] {
  const byPath = new Map<string, WorkspaceFileInfo>();
  for (const entry of input.parent) byPath.set(entry.path, entry);
  for (const entry of input.local) byPath.set(entry.path, entry);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** All file paths under a directory of an in-memory checkout (absolute). */
async function walkFiles(filesystem: InMemoryFs, dir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await filesystem.readdir(dir)) {
    const absolute = `${dir}/${entry}`;
    const stat = await filesystem.stat(absolute);
    if (stat.type === "directory") paths.push(...(await walkFiles(filesystem, absolute)));
    else paths.push(absolute);
  }
  return paths;
}

/**
 * Resolve `.`/`..` segments the way the shell's own path normalization does
 * (pop-based, cannot escape the root), so the `.git` write guard and whiteout
 * keys cannot be dodged with `/foo/../.git/config`.
 */
function resolveAbsolutePath(path: string): string {
  const resolved: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return `/${resolved.join("/")}`;
}
