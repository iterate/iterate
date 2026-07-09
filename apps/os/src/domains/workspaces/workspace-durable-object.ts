import { DurableObject } from "cloudflare:workers";
import { Workspace, WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { PROJECT_REPO_PATH } from "../repos/utils.ts";
import { countOccurrences, replaceLiteralOccurrences } from "../repos/edit-utils.ts";
import type {
  EditWorkspaceFileInput,
  EditWorkspaceFileResult,
  WorkspaceFileInfo,
} from "./types.ts";
import { workspaceBranchName } from "./utils.ts";

// Storage-schema-versioned so a clone-recipe change (different checkout
// layout, different branch model) can invalidate old workspaces cleanly.
// NOTE a version bump is destructive by design: the next touch wipes the
// filesystem and re-clones, so uncommitted (unpushed) work is lost — that is
// the disposability contract (committed state lives on the workspace branch).
const CLONE_SENTINEL_KEY = "workspace-cloned:v1";

const DEFAULT_COMMIT_AUTHOR = { email: "support@iterate.com", name: "Iterate" };

// The Artifacts git endpoint intermittently returns 503 on a cold repo
// (observed in preview e2e; the sandbox clone path carries the same loop).
const CLONE_ATTEMPTS = 3;

// shell's Workspace.readDir defaults to a silent 1000-entry limit. That
// default also feeds the git fs-adapter's directory walker, where a truncated
// listing makes `add(".")` treat unlisted files as deleted — so raise it far
// past any plausible checkout directory.
const READ_DIR_LIMIT = 100_000;

/** {@link Workspace} with the silent readDir truncation lifted (see {@link READ_DIR_LIMIT}). */
class UnboundedWorkspace extends Workspace {
  override readDir(dir?: string, opts?: { limit?: number; offset?: number }) {
    return super.readDir(dir, { limit: READ_DIR_LIMIT, ...opts });
  }
}

/**
 * A durable workspace: a private virtual filesystem living in this Durable
 * Object's SQLite storage (via `@cloudflare/shell`'s `Workspace`), seeded on
 * first touch with a clone of the project repo and carrying a full `.git` so
 * ordinary git operations work against it.
 *
 * Truth lives in the filesystem; git is the sync mechanism. Every public
 * method waits for the initial clone (reads block until the checkout exists),
 * reads and writes then hit SQLite directly, and `gitPush` publishes commits
 * to this workspace's own branch in the project's Artifacts repo — never to
 * main — which makes the SQLite copy disposable: committed state can always
 * be recovered from the branch, and `reset()` wipes the copy for a fresh
 * clone on the next call.
 *
 * Clone coordinates come from the project Repo Durable Object's `gitAccess()`
 * (the documented internal DO-to-DO surface, same as the sandbox domain), so
 * repo tokens never appear on this object's public surface.
 *
 * Deliberate non-goal: workspace branches are for durability and handoff, NOT
 * for worker builds. Worker refs resolve branch heads through the Repo DO's
 * durable head cache, which only pushes through that DO keep fresh — a worker
 * ref pointed at a workspace branch would go permanently stale.
 */
export class WorkspaceDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #workspace = new UnboundedWorkspace({
    sql: this.ctx.storage.sql,
    name: () => this.ctx.id.name,
    // Files past @cloudflare/shell's inline threshold (1.5MB — the DO SQLite
    // row cap zone) spill transparently to R2, so workspace files have no
    // practical size limit. The bucket is shared with the files domain, whose
    // keys always start "{projectId}.iterate" (project ids are prj_-prefixed)
    // — the "workspace/" prefix can never collide with them. The shell owns
    // the object lifecycle: rm/mv/overwrite/recursive-delete all clean up the
    // bucket objects, so reset()'s wipe leaves nothing orphaned.
    r2: this.env.FILES_BUCKET,
    r2Prefix: `workspace/${this.ctx.id.name!}`,
  });
  readonly #git = createGit(new WorkspaceFileSystem(this.#workspace), "/");
  readonly #branch = workspaceBranchName(this.#name.path);

  whoami(): string {
    return `workspace ${this.#name.projectId}:${this.#name.path}`;
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  // -- clone-on-first-touch gate ------------------------------------------

  // In-flight clone, shared by every concurrent first call. Reset on failure
  // so the next call retries (the common transient: the project repo is still
  // seeding). Once the sentinel is durably set the promise is never consulted.
  #clonePromise: Promise<void> | undefined;

  async #ready(): Promise<void> {
    if (this.ctx.storage.kv.get(CLONE_SENTINEL_KEY) !== undefined) return;
    if (this.#clonePromise === undefined) {
      this.#clonePromise = this.#cloneProjectRepo().catch((error: unknown) => {
        this.#clonePromise = undefined;
        throw error;
      });
    }
    await this.#clonePromise;
  }

  async #cloneProjectRepo(): Promise<void> {
    const repo = await this.#projectRepoStub()
      .gitAccess()
      .catch((error: unknown) => {
        throw new Error(
          `Workspace clone source is not available (the project repo may still be seeding; retry shortly): ${String(error)}`,
        );
      });
    for (let attempt = 1; ; attempt++) {
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
        break;
      } catch (error) {
        if (attempt >= CLONE_ATTEMPTS) throw error;
        console.warn(`workspace clone attempt ${attempt} failed, retrying: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    // The workspace lives on its own branch from the first commit onwards;
    // main is only ever the clone base.
    await this.#git.checkout({ branch: this.#branch });
    this.ctx.storage.kv.put(CLONE_SENTINEL_KEY, {
      branch: this.#branch,
      clonedAt: Date.now(),
      clonedFrom: repo.defaultBranch,
    });
  }

  async #wipeFilesystem(): Promise<void> {
    for (const entry of await this.#workspace.readDir("/")) {
      await this.#workspace.rm(entry.path, { force: true, recursive: true });
    }
  }

  /**
   * Wipe the filesystem and clear the clone sentinel so the next call
   * re-clones the project repo. Uncommitted (unpushed) work is lost — this is
   * the escape hatch for a wedged checkout, not an undo button.
   */
  async reset(): Promise<void> {
    // Settle any in-flight clone or write first — even a FAILING clone (that
    // is exactly when reset is needed), hence catch-and-ignore.
    await this.#clonePromise?.catch(() => {});
    await this.#writeChain.catch(() => {});
    this.#clonePromise = undefined;
    this.ctx.storage.kv.delete(CLONE_SENTINEL_KEY);
    await this.#wipeFilesystem();
  }

  #projectRepoStub() {
    return this.env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        path: PROJECT_REPO_PATH,
        projectId: this.#name.projectId,
      }),
    );
  }

  // -- write discipline -----------------------------------------------------

  // ALL mutations (filesystem and git) serialize on this chain: git commit
  // and push yield the input gate at network awaits, so an unserialized
  // writeFile could land mid-`add(".")` and be half-captured by the commit;
  // two concurrent edit() calls are a lost-update race. Reads stay
  // unserialized — they are synchronous SQLite lookups.
  #writeChain: Promise<unknown> = Promise.resolve();

  #serializeWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.#writeChain.then(write, write);
    this.#writeChain = result.catch(() => {});
    return result;
  }

  // The `.git` directory is platform-managed: writes there could corrupt the
  // checkout — or worse, rewrite `.git/config`'s origin URL so a later push
  // presents the repo write token to an attacker-chosen host. Reads are fine.
  #assertWritablePath(path: string): void {
    const resolved = resolveAbsolutePath(path);
    if (resolved === "/" || resolved === "/.git" || resolved.startsWith("/.git/")) {
      throw new Error(
        `Workspace path is not writable: "${path}" (the .git directory and the root are platform-managed; use the git methods instead).`,
      );
    }
  }

  // -- filesystem (mirrors @cloudflare/shell's Workspace surface) ----------

  async readFile(path: string): Promise<string | null> {
    await this.#ready();
    return this.#workspace.readFile(path);
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    await this.#ready();
    return this.#workspace.readFileBytes(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#ready();
    this.#assertWritablePath(path);
    return this.#serializeWrite(() => this.#workspace.writeFile(path, content));
  }

  async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    await this.#ready();
    this.#assertWritablePath(path);
    return this.#serializeWrite(() => this.#workspace.writeFileBytes(path, data));
  }

  async appendFile(path: string, content: string): Promise<void> {
    await this.#ready();
    this.#assertWritablePath(path);
    return this.#serializeWrite(() => this.#workspace.appendFile(path, content));
  }

  async deleteFile(path: string): Promise<boolean> {
    await this.#ready();
    this.#assertWritablePath(path);
    return this.#serializeWrite(() => this.#workspace.deleteFile(path));
  }

  async edit(input: EditWorkspaceFileInput): Promise<EditWorkspaceFileResult> {
    await this.#ready();
    this.#assertWritablePath(input.path);
    if (typeof input.oldString !== "string" || input.oldString === "") {
      throw new Error("edit oldString must be a non-empty string.");
    }
    return this.#serializeWrite(async () => {
      const content = await this.#workspace.readFile(input.path);
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
      return { occurrenceCount, path: input.path };
    });
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.#ready();
    this.#assertWritablePath(path);
    return this.#serializeWrite(() => this.#workspace.mkdir(path, opts));
  }

  async readDir(dir?: string): Promise<WorkspaceFileInfo[]> {
    await this.#ready();
    return this.#workspace.readDir(dir);
  }

  async glob(pattern: string): Promise<WorkspaceFileInfo[]> {
    await this.#ready();
    return this.#workspace.glob(pattern);
  }

  async rm(path: string, opts?: { force?: boolean; recursive?: boolean }): Promise<void> {
    await this.#ready();
    this.#assertWritablePath(path);
    return this.#serializeWrite(() => this.#workspace.rm(path, opts));
  }

  async cp(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.#ready();
    this.#assertWritablePath(dest);
    return this.#serializeWrite(() => this.#workspace.cp(src, dest, opts));
  }

  async mv(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.#ready();
    this.#assertWritablePath(src);
    this.#assertWritablePath(dest);
    return this.#serializeWrite(() => this.#workspace.mv(src, dest, opts));
  }

  async stat(path: string): Promise<WorkspaceFileInfo | null> {
    await this.#ready();
    return this.#workspace.stat(path);
  }

  async exists(path: string): Promise<boolean> {
    await this.#ready();
    return this.#workspace.exists(path);
  }

  // -- git ------------------------------------------------------------------

  async gitStatus() {
    await this.#ready();
    return this.#git.status();
  }

  async gitLog(input: { depth?: number } = {}) {
    await this.#ready();
    return this.#git.log(input);
  }

  async gitDiff() {
    await this.#ready();
    return this.#git.diff();
  }

  async gitAdd(input: { filepath: string }) {
    await this.#ready();
    return this.#serializeWrite(() => this.#git.add({ filepath: input.filepath }));
  }

  async gitRm(input: { filepath: string }) {
    await this.#ready();
    return this.#serializeWrite(() => this.#git.rm({ filepath: input.filepath }));
  }

  async gitCommit(input: { author?: { email: string; name: string }; message: string }) {
    await this.#ready();
    return this.#serializeWrite(async () => {
      // isomorphic-git happily creates empty commits; a retrying agent would
      // stack them. Only STAGED changes commit, so the guard must ignore
      // working-tree-only entries (status lists those too): staged means the
      // index differs from HEAD — a tracked file whose stage is not
      // "identical" (1), or an untracked file that has been added (stage > 0).
      const status = await this.#git.status();
      const staged = status.filter((entry) =>
        entry.head === 1 ? entry.stage !== 1 : entry.stage !== 0,
      );
      if (staged.length === 0) {
        const unstaged = status.length - staged.length;
        throw new Error(
          `Nothing staged to commit${unstaged > 0 ? ` (${unstaged} unstaged change(s) in the working tree)` : ""} — call git.add({ filepath: "." }) first.`,
        );
      }
      return this.#git.commit({
        author: input.author ?? DEFAULT_COMMIT_AUTHOR,
        message: input.message,
      });
    });
  }

  /**
   * Push this workspace's branch to the project repo. The write token comes
   * from the Repo Durable Object per push (it caches the token per isolate)
   * and never rides a public return value. The push resolves "origin" from
   * `.git/config`, which is safe ONLY because the `.git` write guard makes
   * that file immutable to callers — origin is always the clone-time
   * Artifacts remote, so the token cannot be redirected to a foreign host.
   */
  async gitPush(input: { force?: boolean } = {}) {
    await this.#ready();
    return this.#serializeWrite(async () => {
      const repo = await this.#projectRepoStub().gitAccess();
      const pushed = await this.#git.push({
        force: input.force,
        password: repo.token,
        ref: this.#branch,
        remote: "origin",
        username: "x",
      });
      if (!pushed.ok) {
        throw new Error(`Failed to push ${this.#branch}: ${JSON.stringify(pushed.refs)}`);
      }
      return { branch: this.#branch, ok: true as const };
    });
  }
}

/**
 * Resolve `.`/`..` segments the way the shell's own path normalization does
 * (pop-based, cannot escape the root), so the `.git` write guard cannot be
 * dodged with `/foo/../.git/config`.
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
