import { DurableObject } from "cloudflare:workers";
import { WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { CONFIG_REPO_PATH } from "../repos/utils.ts";
import type {
  EditWorkspaceFileInput,
  EditWorkspaceFileResult,
  WorkspaceChange,
  WorkspaceFileInfo,
  WorkspaceGitLogEntry,
  WorkspacePublishResult,
} from "./types.ts";
import { UnboundedWorkspace, WorkspaceCore } from "./workspace-core.ts";
import { ROOT_WORKSPACE_PATH, isRootWorkspacePath, workspaceBranchName } from "./utils.ts";

/**
 * A durable workspace: a private virtual filesystem living in this Durable
 * Object's SQLite storage (via `@cloudflare/shell`'s `Workspace`), in one of
 * two modes decided by its path:
 *
 * ROOT (`/workspaces`, spelled `"/"` by callers): the project's always-fresh,
 * READ-ONLY materialization of the config repo's main branch. Every read
 * checks the Repo Durable Object's durable head cache (one cheap RPC — the
 * repo's read-your-write boundary, so a commit is visible here the moment
 * `commitFiles` returns) and re-clones only when main actually moved.
 *
 * OVERLAY (everything else): a copy-on-write layer over the root. Writes land
 * in this DO's own filesystem; reads try the local layer first and fall
 * through to the root workspace on a miss; deletes of parent files leave
 * whiteouts so the parent copy stays hidden. There is NO clone — a fresh
 * overlay workspace is usable instantly and always sees latest main through
 * the fall-through, until a local write pins a path.
 *
 * Truth lives in the filesystem; git is the PUBLISH mechanism, not the
 * storage: `gitCommit` snapshots the merged view (main + local layer, minus
 * whiteouts and .gitignored paths) as one commit force-pushed to this
 * workspace's own branch in the project's Artifacts repo — never to main —
 * which keeps the local layer disposable.
 *
 * Clone coordinates come from the project Repo Durable Object's `gitAccess()`
 * (the documented internal DO-to-DO surface, same as the sandbox domain), so
 * repo tokens never appear on this object's public surface.
 *
 * All of the above semantics live in {@link WorkspaceCore} — a host-agnostic
 * library object constructed with explicit deps (cloudflare/workspace's
 * shape). This DO is the thin host: it parses its name, wires its storage,
 * git, and sibling-DO stubs into the core, and delegates.
 *
 * Deliberate non-goal: workspace branches are for durability and handoff, NOT
 * for worker builds. Worker refs resolve branch heads through the Repo DO's
 * durable head cache, which only pushes through that DO keep fresh — a worker
 * ref pointed at a workspace branch would go permanently stale.
 */
export class WorkspaceDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #isRoot = isRootWorkspacePath(this.#name.path);
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
  readonly #core = new WorkspaceCore({
    branch: workspaceBranchName(this.#name.path),
    git: createGit(new WorkspaceFileSystem(this.#workspace), "/"),
    kv: this.ctx.storage.kv,
    mode: this.#isRoot ? "root" : "overlay",
    parent: () => this.#rootWorkspaceStub(),
    repo: () => this.#projectRepoStub(),
    workspace: this.#workspace,
  });

  whoami(): string {
    return this.#isRoot
      ? `workspace ${this.#name.projectId}:/ (root — read-only mirror of the config repo's main branch)`
      : `workspace ${this.#name.projectId}:${this.#name.path} (overlay over "/")`;
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  #projectRepoStub() {
    return this.env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        path: CONFIG_REPO_PATH,
        projectId: this.#name.projectId,
      }),
    );
  }

  #rootWorkspaceStub() {
    return this.env.WORKSPACE.getByName(
      DurableObjectNameCodec.stringify({
        path: ROOT_WORKSPACE_PATH,
        projectId: this.#name.projectId,
      }),
    );
  }

  // -- lifecycle --------------------------------------------------------------

  /**
   * Wipe this workspace back to pristine. Root: the next read re-materializes
   * main (the escape hatch for a wedged checkout). Overlay: the local layer
   * and every whiteout vanish, so the workspace shows exactly the parent
   * again — unpublished work is lost (published state survives on the
   * workspace branch).
   */
  reset(): Promise<void> {
    return this.#core.reset();
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
  revert(path: string): Promise<void> {
    return this.#core.revert(path);
  }

  // -- filesystem (mirrors @cloudflare/shell's Workspace surface, merged) ----

  readFile(path: string): Promise<string | null> {
    return this.#core.readFile(path);
  }

  readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.#core.readFileBytes(path);
  }

  stat(path: string): Promise<WorkspaceFileInfo | null> {
    return this.#core.stat(path);
  }

  exists(path: string): Promise<boolean> {
    return this.#core.exists(path);
  }

  readDir(dir?: string): Promise<WorkspaceFileInfo[]> {
    return this.#core.readDir(dir);
  }

  glob(pattern: string): Promise<WorkspaceFileInfo[]> {
    return this.#core.glob(pattern);
  }

  /**
   * Every file path in the merged view (absolute, sorted, no directories).
   * The one-RPC bulk listing overlays use to classify their local layer
   * against the parent — and the cheap way for anything else to see a
   * workspace's full extent without a readDir walk.
   */
  listAllFiles(): Promise<string[]> {
    return this.#core.listAllFiles();
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.#core.writeFile(path, content);
  }

  writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    return this.#core.writeFileBytes(path, data);
  }

  appendFile(path: string, content: string): Promise<void> {
    return this.#core.appendFile(path, content);
  }

  deleteFile(path: string): Promise<boolean> {
    return this.#core.deleteFile(path);
  }

  edit(input: EditWorkspaceFileInput): Promise<EditWorkspaceFileResult> {
    return this.#core.edit(input);
  }

  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.#core.mkdir(path, opts);
  }

  rm(path: string, opts?: { force?: boolean; recursive?: boolean }): Promise<void> {
    return this.#core.rm(path, opts);
  }

  cp(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.#core.cp(src, dest, opts);
  }

  mv(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.#core.mv(src, dest, opts);
  }

  // -- publish (git) ----------------------------------------------------------

  /**
   * The overlay's changes relative to the parent: local files that shadow a
   * parent file ("modified" — shadowed, not content-diffed), local files the
   * parent lacks ("added"), and whiteouted parent files ("deleted").
   * `.gitignore`d local files (e.g. spilled script results) are omitted, same
   * as `gitCommit` will omit them.
   */
  gitStatus(): Promise<WorkspaceChange[]> {
    return this.#core.gitStatus();
  }

  /**
   * Publish the merged view as ONE snapshot commit on this workspace's own
   * branch in the config repo. Implementation: clone main, replay the local
   * layer (minus .gitignored paths) and whiteout deletions onto it, commit,
   * force-push. Force because each publish is a fresh snapshot on the current
   * main — the branch always shows "main as this workspace sees it", not an
   * incremental history.
   */
  gitCommit(input: {
    author?: { email: string; name: string };
    message: string;
  }): Promise<WorkspacePublishResult> {
    return this.#core.gitCommit(input);
  }

  /** Published snapshots of this workspace, newest first ([] before the first publish). */
  gitLog(input: { limit?: number } = {}): Promise<WorkspaceGitLogEntry[]> {
    return this.#core.gitLog(input);
  }
}
