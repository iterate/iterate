// src/workspace/durable-object.ts — THE WORKSPACE: the facet a context at ANY path hosts under the
// name `workspace` (`itx.workspaces.get(path)`, library.ts; `/workspaces/<name>` is the convention,
// not a rule). ONE private overlay over the MOUNT TABLE — every repo in the project catalog at its own
// path (`itx.repos.list()`: the workspace is a view of the project's one path namespace): a read
// tries the overlay, then falls through to the mounted repo's `main` at its tip (the repo facet); a
// write shadows the repo's file until `gitCommit` lands ONE mount's changes as one commit on that
// repo's `main` and clears them; a delete of a repo file is a WHITEOUT until then. A path under no
// mount is scratch (`/workspace/…` by convention): writable, never committed. It is also what makes a
// workspace a DOMAIN OBJECT: it hosts the workspace processor (processor.ts) — the creation saga
// `itx.workspaces.create(path)` opens, whose certificate is cross-posted to `/` for the catalog
// `itx.workspaces.list()` reads — and every method refuses until the certificate has landed
// (`state.creation`) and again once deletion has been asked for (`state.deletion`, the saga
// `itx.workspaces.delete(path)` opens; the overlay goes with the facet when the row is dropped).
//
// Storage is this facet's own SQLite: one `files` table, a row per touched path — its content, or the
// `deleted` flag that makes it a whiteout. Text only, ONE writer, no policies. The repo facets speak
// git themselves (src/repo/git-wire.ts) and reach the Artifacts binding — their token and remote — as
// `itx.cfArtifacts` through THEIR context's rules, so a test lends a fake proxy there
// (`provide("itx.cfArtifacts", …)`, e2e/support/fake-artifacts.ts). Hosted from `ctx.exports`
// (first-party-facets.ts): ordinary bundled worker code, reached as `itx.facets.get("workspace")`
// (library.ts).
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/next/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { RepoFileChange, RepoLogEntry } from "../repo/git-wire.ts";
import type { WorkspaceState } from "./contract.ts";
import { WorkspaceProcessor } from "./processor.ts";

/** One mount: the PATH of the project repo whose `main` shows through at the mount path (its own). */
export type WorkspaceMount = { repo: string };

/** One overlay entry as `gitStatus` reports it, against its mount at HEAD (scratch is "added"). */
export type WorkspaceChange = { path: string; change: "added" | "deleted" | "modified" };

/** One mount as `gitStatus` reports it: its path, its repo, and the overlay's changes under it. */
export type WorkspaceMountStatus = { path: string; repo: string; changes: WorkspaceChange[] };

/** An absolute workspace path — the ONE spelling the overlay and the mount table are keyed by:
 *  starts with `/`, no empty, `.` or `..` segment. */
export function absolutePath(path: string): string {
  const segments = path.slice(1).split("/");
  const malformed =
    !path.startsWith("/") ||
    (path !== "/" && segments.some((s) => s === "" || s === "." || s === ".."));
  if (malformed) throw new Error(`workspace: not an absolute path (${JSON.stringify(path)})`);
  return path;
}

/** The mount a FILE path falls under — the LONGEST mount path that is a proper ancestor of it (a
 *  repo may live at a path beneath another's) — with the repo-relative remainder; null under no
 *  mount, and null for a mount point itself: a mount point is a directory, never a file. */
export function routeMount(
  mounts: Record<string, WorkspaceMount>,
  path: string,
): { mountPath: string; repo: string; relativePath: string } | null {
  let best: { mountPath: string; repo: string; relativePath: string } | null = null;
  for (const [mountPath, mount] of Object.entries(mounts)) {
    if (!path.startsWith(`${mountPath}/`)) continue;
    if (best && best.mountPath.length >= mountPath.length) continue;
    best = { mountPath, repo: mount.repo, relativePath: path.slice(mountPath.length + 1) };
  }
  return best;
}

export class WorkspaceDurableObject extends StreamProcessorDurableObject<
  WorkspaceState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new WorkspaceProcessor((call) => this.withItx(call));

  #pathRead?: string;
  async #path(): Promise<string> {
    return (this.#pathRead ??= (await this.withItx((itx) => itx.whoami())).path);
  }

  // ── the overlay: this facet's own SQLite, one row per touched path — content, or a whiteout (`deleted`) ──

  #tableCreated = false;
  get #sql() {
    const sql = this.ctx.storage.sql;
    if (!this.#tableCreated) {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)",
      );
      this.#tableCreated = true;
    }
    return sql;
  }
  #row(path: string): { content: string; deleted: number } | undefined {
    return this.#sql
      .exec<{ content: string; deleted: number }>(
        "SELECT content, deleted FROM files WHERE path = ?",
        path,
      )
      .toArray()[0];
  }
  #rows(): { path: string; content: string; deleted: number }[] {
    return this.#sql
      .exec<{ path: string; content: string; deleted: number }>(
        "SELECT path, content, deleted FROM files ORDER BY path",
      )
      .toArray();
  }

  // ── the created guard ──

  /** Every verb starts here: a workspace whose certificate has not landed refuses, and so does one
   *  whose deletion has been asked for. Deletion can land at any moment, so the state is read on
   *  every call (in memory once the facet is caught up). */
  async #created(): Promise<void> {
    const path = await this.#path();
    const { state } = await this.snapshot();
    if (state.deletion) throw new Error(`workspace ${path}: deleted`);
    if (state.creation?.status !== "created")
      throw new Error(
        `workspace ${path}: not created — itx.workspaces.create(${JSON.stringify(path)}) first`,
      );
  }

  /** The mount table: every repo in the project catalog at its OWN path. */
  async mounts(): Promise<Record<string, WorkspaceMount>> {
    await this.#created();
    const mounts: Record<string, WorkspaceMount> = {};
    for (const { path } of await this.withItx((itx) => itx.repos.list()))
      mounts[path] = { repo: path };
    return mounts;
  }

  // ── files: the merged view ──

  /** The overlay's copy (a whiteout reads null), else the mounted repo's file at its tip; null when absent. */
  async readFile(path: string): Promise<string | null> {
    const resolved = absolutePath(path);
    const row = this.#row(resolved);
    if (row) return row.deleted ? null : row.content;
    return this.#readMounted(resolved, await this.mounts());
  }

  /** The mounted repo's file at its tip whatever the overlay says — what uncommitted work diffs against. */
  async readBase(path: string): Promise<string | null> {
    return this.#readMounted(absolutePath(path), await this.mounts());
  }

  async #readMounted(path: string, mounts: Record<string, WorkspaceMount>): Promise<string | null> {
    const route = routeMount(mounts, path);
    if (!route) return null;
    return this.withItx((itx) => itx.repos.get(route.repo).readFile(route.relativePath));
  }

  /** Write into the overlay (an empty string is a file); a whiteout at the path is overwritten. */
  async writeFile(path: string, content: string): Promise<void> {
    const resolved = absolutePath(path);
    if (resolved === "/" || resolved in (await this.mounts()))
      throw new Error(`workspace: "${resolved}" is a directory`);
    this.#sql.exec(
      "INSERT INTO files (path, content, deleted) VALUES (?, ?, 0) ON CONFLICT(path) DO UPDATE SET content = excluded.content, deleted = 0",
      resolved,
      content,
    );
  }

  /** Delete from the merged view: the overlay row goes; a file the mount has is WHITED OUT until
   *  committed. False when the path was not a file of the view. */
  async deleteFile(path: string): Promise<boolean> {
    const resolved = absolutePath(path);
    const row = this.#row(resolved);
    const route = routeMount(await this.mounts(), resolved);
    const mounted =
      !!route &&
      (await this.withItx((itx) => itx.repos.get(route.repo).listFiles())).paths.includes(
        route.relativePath,
      );
    if (mounted)
      this.#sql.exec(
        "INSERT INTO files (path, content, deleted) VALUES (?, '', 1) ON CONFLICT(path) DO UPDATE SET content = '', deleted = 1",
        resolved,
      );
    else this.#sql.exec("DELETE FROM files WHERE path = ?", resolved);
    return row ? !row.deleted : mounted;
  }

  /** Back to the mount's version: the overlay row — a shadowing write or a whiteout — goes. */
  async revert(path: string): Promise<void> {
    this.#sql.exec("DELETE FROM files WHERE path = ?", absolutePath(path));
  }

  /** Every file path of the merged view — the overlay plus every mount's tip, minus whiteouts —
   *  sorted. A tip path is listed only where it ROUTES to that mount (a repo beneath another's path
   *  hides the parent's files under it), as `readFile` and a commit see them. */
  async listAllFiles(): Promise<string[]> {
    const mounts = await this.mounts();
    const paths = new Set<string>();
    const whiteouts = new Set<string>();
    for (const row of this.#rows()) (row.deleted ? whiteouts : paths).add(row.path);
    await Promise.all(
      Object.entries(mounts).map(async ([mountPath, { repo }]) => {
        for (const relativePath of (await this.withItx((itx) => itx.repos.get(repo).listFiles()))
          .paths) {
          const path = `${mountPath}/${relativePath}`;
          if (!whiteouts.has(path) && routeMount(mounts, path)?.mountPath === mountPath)
            paths.add(path);
        }
      }),
    );
    return [...paths].sort();
  }

  // ── git, per mount ──

  /** The overlay's changes grouped by mount (every mount listed, dirty or not), plus the unmounted
   *  scratch — which is never committed. */
  async gitStatus(): Promise<{ mounts: WorkspaceMountStatus[]; unmounted: WorkspaceChange[] }> {
    return this.#status(await this.mounts());
  }

  async #status(
    mounts: Record<string, WorkspaceMount>,
  ): Promise<{ mounts: WorkspaceMountStatus[]; unmounted: WorkspaceChange[] }> {
    const byMount = new Map<string, WorkspaceMountStatus>();
    for (const [path, { repo }] of Object.entries(mounts))
      byMount.set(path, { path, repo, changes: [] });
    const unmounted: WorkspaceChange[] = [];
    // The tip's paths of every TOUCHED mount, read once: an overlay row over a file the tip has is
    // "modified", over one it lacks "added"; a whiteout is "deleted".
    const tipPaths = new Map<string, Set<string>>();
    for (const { path, deleted } of this.#rows()) {
      const route = routeMount(mounts, path);
      if (!route) {
        unmounted.push({ path, change: deleted ? "deleted" : "added" });
        continue;
      }
      let tip = tipPaths.get(route.mountPath);
      if (!tip) {
        tip = new Set((await this.withItx((itx) => itx.repos.get(route.repo).listFiles())).paths);
        tipPaths.set(route.mountPath, tip);
      }
      byMount.get(route.mountPath)!.changes.push({
        path,
        change: deleted ? "deleted" : tip.has(route.relativePath) ? "modified" : "added",
      });
    }
    return { mounts: [...byMount.values()], unmounted };
  }

  /** ONE mount's changes become ONE commit on its repo's `main` (`scope` names the mount; optional
   *  when exactly one is dirty); the overlay under it is then the tip and is cleared. Scratch is never
   *  committed. */
  async gitCommit(input: {
    message: string;
    scope?: string;
    author?: { name: string; email: string };
  }): Promise<{ commitOid: string | null; mount: string; repo: string; changedPaths: string[] }> {
    const mounts = await this.mounts();
    const status = await this.#status(mounts);
    const dirty = status.mounts.filter((candidate) => candidate.changes.length > 0);
    let mount: WorkspaceMountStatus | undefined;
    if (input.scope) {
      const scope = absolutePath(input.scope);
      mount = status.mounts.find((candidate) => candidate.path === scope);
      if (!mount)
        throw new Error(
          `workspace: no mount at "${scope}" (mounts: ${status.mounts.map((m) => `"${m.path}"`).join(", ")})`,
        );
    } else {
      if (dirty.length !== 1)
        throw new Error(
          dirty.length === 0
            ? "workspace: nothing to commit — no mount has changes"
            : `workspace: changes span ${dirty.length} mounts (${dirty.map((m) => `"${m.path}"`).join(", ")}) — a commit never spans mounts; pass { scope }`,
        );
      mount = dirty[0]!;
    }
    if (mount.changes.length === 0)
      throw new Error(`workspace: nothing to commit under "${mount.path}"`);
    const mountPath = mount.path;
    const changes: RepoFileChange[] = this.#rows()
      .filter((row) => routeMount(mounts, row.path)?.mountPath === mountPath)
      .map((row) => {
        const path = row.path.slice(mountPath.length + 1);
        return row.deleted ? { path, delete: true as const } : { path, content: row.content };
      });
    const committed = await this.withItx((itx) =>
      itx.repos
        .get(mount.repo)
        .commitFiles({ message: input.message, changes, author: input.author }),
    );
    // The commit landed: the overlay under this mount IS the tip now — drop it, whiteouts included.
    for (const { path } of mount.changes) this.#sql.exec("DELETE FROM files WHERE path = ?", path);
    return {
      commitOid: committed.commitOid,
      mount: mountPath,
      repo: mount.repo,
      changedPaths: committed.changedPaths.map((path: string) => `${mountPath}/${path}`),
    };
  }

  /** One mount's history, newest first (`scope` optional when there is exactly one mount). */
  async gitLog(input: { scope?: string; limit?: number } = {}): Promise<RepoLogEntry[]> {
    const mounts = await this.mounts();
    const mountPaths = Object.keys(mounts);
    const scope = input.scope
      ? absolutePath(input.scope)
      : mountPaths.length === 1
        ? mountPaths[0]!
        : "";
    const mount = mounts[scope];
    if (!mount)
      throw new Error(
        `workspace: name the mount to log — { scope } is one of ${mountPaths.map((path) => `"${path}"`).join(", ")}`,
      );
    return this.withItx((itx) => itx.repos.get(mount.repo).log({ limit: input.limit }));
  }
}
