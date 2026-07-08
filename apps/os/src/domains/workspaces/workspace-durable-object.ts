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
} from "../../types.ts";
import { workspaceBranchName } from "./utils.ts";

// Storage-schema-versioned so a clone-recipe change (different checkout
// layout, different branch model) can invalidate old workspaces cleanly.
const CLONE_SENTINEL_KEY = "workspace-cloned:v1";

const DEFAULT_COMMIT_AUTHOR = { email: "support@iterate.com", name: "Iterate" };

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
 * be recovered from the branch.
 *
 * Clone coordinates come from the project Repo Durable Object's `gitAccess()`
 * (the documented internal DO-to-DO surface, same as the sandbox domain), so
 * repo tokens never appear on this object's public surface.
 */
export class WorkspaceDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.ctx.id.name,
  });
  readonly #git = createGit(new WorkspaceFileSystem(this.#workspace), "/");
  readonly #branch = workspaceBranchName(this.#name.path);

  whoami(): string {
    return `workspace ${this.#name.projectId}:${this.#name.path}`;
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
    // A previous clone attempt may have died mid-checkout; start from empty
    // so isomorphic-git never sees a half-written .git.
    for (const entry of await this.#workspace.readDir("/")) {
      await this.#workspace.rm(entry.path, { force: true, recursive: true });
    }
    await this.#git.clone({
      branch: repo.defaultBranch,
      depth: 1,
      singleBranch: true,
      url: repo.remote,
      username: "x",
      password: repo.token,
    });
    // The workspace lives on its own branch from the first commit onwards;
    // main is only ever the clone base.
    await this.#git.checkout({ branch: this.#branch });
    this.ctx.storage.kv.put(CLONE_SENTINEL_KEY, {
      branch: this.#branch,
      clonedAt: Date.now(),
      clonedFrom: repo.defaultBranch,
    });
  }

  #projectRepoStub() {
    return this.env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        path: PROJECT_REPO_PATH,
        projectId: this.#name.projectId,
      }),
    );
  }

  // -- filesystem (mirrors @cloudflare/shell's Workspace surface) ----------

  async readFile(path: string): Promise<string | null> {
    await this.#ready();
    return this.#workspace.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#ready();
    return this.#workspace.writeFile(path, content);
  }

  async appendFile(path: string, content: string): Promise<void> {
    await this.#ready();
    return this.#workspace.appendFile(path, content);
  }

  async deleteFile(path: string): Promise<boolean> {
    await this.#ready();
    return this.#workspace.deleteFile(path);
  }

  async edit(input: EditWorkspaceFileInput): Promise<EditWorkspaceFileResult> {
    await this.#ready();
    if (typeof input.oldString !== "string" || input.oldString === "") {
      throw new Error("edit oldString must be a non-empty string.");
    }
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
    await this.#workspace.writeFile(
      input.path,
      replaceLiteralOccurrences({
        content,
        newString: input.newString,
        oldString: input.oldString,
      }),
    );
    return { occurrenceCount, path: input.path };
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.#ready();
    return this.#workspace.mkdir(path, opts);
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
    return this.#workspace.rm(path, opts);
  }

  async cp(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.#ready();
    return this.#workspace.cp(src, dest, opts);
  }

  async mv(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.#ready();
    return this.#workspace.mv(src, dest, opts);
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

  // Mutating git operations serialize on this chain: commit and push yield
  // the input gate at network awaits, so two interleaved callers could
  // otherwise stage/commit each other's half-done work.
  #gitChain: Promise<unknown> = Promise.resolve();

  #serializeGit<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#gitChain.then(op, op);
    this.#gitChain = result.catch(() => {});
    return result;
  }

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
    return this.#serializeGit(() => this.#git.add({ filepath: input.filepath }));
  }

  async gitRm(input: { filepath: string }) {
    await this.#ready();
    return this.#serializeGit(() => this.#git.rm({ filepath: input.filepath }));
  }

  async gitCommit(input: { author?: { email: string; name: string }; message: string }) {
    await this.#ready();
    return this.#serializeGit(() =>
      this.#git.commit({
        author: input.author ?? DEFAULT_COMMIT_AUTHOR,
        message: input.message,
      }),
    );
  }

  /**
   * Push this workspace's branch to the project repo. The remote and a write
   * token are fetched from the Repo Durable Object per push (it caches the
   * token per isolate); the token never rides on a public return value.
   */
  async gitPush(input: { force?: boolean } = {}) {
    await this.#ready();
    return this.#serializeGit(async () => {
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
