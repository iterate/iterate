// src/workspace/durable-object.ts — THE WORKSPACE: the facet any context hosts under the name
// `workspace` (`itx.workspaces.get(path)`, library.ts — at most one per path, nothing appended to
// get it). ONE private overlay over a table of REPO MOUNTS: a read tries the overlay, then falls
// through to the mounted repo's `main` at its tip (the repo facet, `itx.repos.get(name)` — its tip
// cache, shared by every workspace of the project); a write shadows the repo's file until
// `gitCommit` lands ONE mount's changes as one commit on that repo's `main` and clears them; a delete
// of a repo file is a WHITEOUT until then. Mounts are DERIVED — every repo in the project catalog at
// `/repos/<name>` (`itx.repos.list()`) — plus what `configure` adds, the reduce in processor.ts
// folding `workspace/configured` into the view. A path under no mount is the workspace's own scratch
// (`/workspace/…` by convention): writable, never committed. On first use the workspace appends its
// birth certificate (`workspace/created { path }`) on its own path and cross-posts it to `/`, where
// the project processor keeps the catalog `itx.workspaces.list()` reads.
//
// Storage is this facet's own SQLite: `files` (the overlay) and `whiteouts`. Text only, one file at
// most a mebibyte (a SQLite value holds 2 MB). ONE writer, no collab, no policies. The repo facets
// reach git as `itx.git` through THEIR context's rules, so a test lends a fake there
// (`provide("itx.git", …)` on `/repos/<name>`, e2e/workspaces.e2e.test.ts) exactly as it fakes `itx.ai`.
//
// THE SINGLE SOURCE: build-sdk.mjs bundles THIS module — pulling `WorkspaceProcessor` from
// ./processor.ts (the tested spec) — into the generated WORKSPACE_PROCESSOR_SOURCE string, the SDK
// imports left external as "./processor.js"; library.ts hands that string to `facets.get` as the spec.
import { StreamProcessorDurableObject } from "../sdk/index.ts";
import type { RepoFileChange, RepoLogEntry } from "../context/repos.ts";
import type { WorkspaceMount, WorkspaceView } from "./contract.ts";
import { WorkspaceProcessor } from "./processor.ts";

/** One overlay entry as `gitStatus` reports it, against its mount at HEAD (scratch is "added"). */
export type WorkspaceChange = { path: string; change: "added" | "deleted" | "modified" };

/** One mount as `gitStatus` reports it: its path, its repo, and the overlay's changes under it. */
export type WorkspaceMountStatus = { path: string; repo: string; changes: WorkspaceChange[] };

/** An absolute workspace path with `.`/`..` resolved and slashes collapsed — the ONE spelling the
 *  overlay, the whiteouts and the mount table are keyed by. */
export function absolutePath(path: string): string {
  // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of a wire-fed argument (its static type is a claim, not a guarantee, across the capability boundary)
  if (typeof path !== "string") throw new Error("workspace: a path is a string");
  const resolved: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return `/${resolved.join("/")}`;
}

/** The mount a FILE path falls under — the LONGEST mount path that is a proper ancestor of it — with
 *  the repo-relative remainder; null under no mount, and null for a mount point itself: a mount
 *  point is a directory, never a file, so an overlay row AT one (scratch written before the mount
 *  existed) stays scratch — listed as unmounted, never handed to a repo as the path "". */
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

export class WorkspaceDurableObject extends StreamProcessorDurableObject<WorkspaceView> {
  processor = new WorkspaceProcessor();

  // ── the overlay and the whiteouts: this facet's own SQLite ──

  #tablesCreated = false;
  get #sql() {
    const sql = this.ctx.storage.sql;
    if (!this.#tablesCreated) {
      sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content TEXT NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS whiteouts (path TEXT PRIMARY KEY)");
      this.#tablesCreated = true;
    }
    return sql;
  }
  /** The overlay's row for a path — `{ content }` (an empty file is a row too), or undefined. */
  #overlayRow(path: string): { content: string } | undefined {
    return this.#sql
      .exec<{ content: string }>("SELECT content FROM files WHERE path = ?", path)
      .toArray()[0];
  }
  /** Every overlay row, path-sorted. */
  #overlayRows(): { path: string; content: string }[] {
    return this.#sql
      .exec<{ path: string; content: string }>("SELECT path, content FROM files ORDER BY path")
      .toArray();
  }
  /** Every whiteout, path-sorted. */
  #whiteouts(): string[] {
    return this.#sql
      .exec<{ path: string }>("SELECT path FROM whiteouts ORDER BY path")
      .toArray()
      .map((row) => row.path);
  }
  #isWhiteout(path: string): boolean {
    return (
      this.#sql.exec<{ path: string }>("SELECT path FROM whiteouts WHERE path = ?", path).toArray()
        .length > 0
    );
  }
  #forget(path: string): void {
    this.#sql.exec("DELETE FROM files WHERE path = ?", path);
    this.#sql.exec("DELETE FROM whiteouts WHERE path = ?", path);
  }

  // ── birth ──

  #born = false;
  /** The birth certificate, once: cross-posted to `/` FIRST, then on this workspace's own path —
   *  the own-path fact is what marks the workspace born, so a cross-post that fails is retried on
   *  the next use and the catalog can never miss a workspace that was born. The SAME event under
   *  the SAME idempotency key both times, so a workspace at `/` itself carries it once. */
  async #ensureBorn(state: WorkspaceView): Promise<void> {
    if (this.#born) return;
    if (!state.created) {
      const { path } = await this.withItx((itx) => itx.whoami());
      const birth = {
        type: "events.iterate.com/workspace/created",
        payload: { path },
        idempotencyKey: `workspace/created:${path}`,
      };
      await this.withItx((itx) => itx.cd("/").append(birth));
      await this.withItx((itx) => itx.append(birth));
    }
    this.#born = true;
  }

  // ── the mount table ──

  /** The EFFECTIVE mounts: every repo in the project catalog at `/repos/<name>` (derived), the
   *  configured ones over them. Every method starts here, so the first use is the birth. */
  async mounts(): Promise<Record<string, WorkspaceMount>> {
    const [repos, { state }] = await Promise.all([
      this.withItx((itx) => itx.repos.list()),
      this.snapshot(),
    ]);
    await this.#ensureBorn(state);
    const mounts: Record<string, WorkspaceMount> = {};
    for (const { name } of repos) mounts[`/repos/${name}`] = { repo: name };
    return { ...mounts, ...state.mounts };
  }

  /** Patch the configured mounts — ONE `workspace/configured` event on this context: a path →
   *  `{ repo }` adds or replaces a mount, → null removes one. Returns the effective table. */
  async configure(input: {
    mounts: Record<string, WorkspaceMount | null>;
  }): Promise<Record<string, WorkspaceMount>> {
    const mounts: Record<string, WorkspaceMount | null> = {};
    for (const [path, mount] of Object.entries(input.mounts)) {
      const mountPath = absolutePath(path);
      if (mountPath === "/")
        throw new Error('workspace: "/" is the workspace itself, never a mount');
      mounts[mountPath] = mount;
    }
    await this.withItx((itx) =>
      itx.append({ type: "events.iterate.com/workspace/configured", payload: { mounts } }),
    );
    return this.mounts();
  }

  // ── files: the merged view ──

  /** The overlay's copy, a whiteout (null), else the mounted repo's file at its tip; null when absent. */
  async readFile(path: string): Promise<string | null> {
    const resolved = absolutePath(path);
    const row = this.#overlayRow(resolved);
    if (row) return row.content;
    if (this.#isWhiteout(resolved)) return null;
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

  /** Write into the overlay (an empty string is a file); a whiteout at the path is lifted. */
  async writeFile(path: string, content: string): Promise<void> {
    const resolved = absolutePath(path);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of a wire-fed argument (its static type is a claim, not a guarantee, across the capability boundary)
    if (typeof content !== "string") throw new Error("workspace: content is a string");
    if (content.length > 1_048_576)
      throw new Error(`workspace: "${resolved}" is over a mebibyte — one SQLite value holds 2 MB`);
    if (resolved === "/" || resolved in (await this.mounts()))
      throw new Error(`workspace: "${resolved}" is a directory`);
    this.#sql.exec(
      "INSERT INTO files (path, content) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content",
      resolved,
      content,
    );
    this.#sql.exec("DELETE FROM whiteouts WHERE path = ?", resolved);
  }

  /** Delete from the merged view: the overlay row goes; a file the mount has is WHITED OUT until
   *  committed. False when the path was not a file of the view. */
  async deleteFile(path: string): Promise<boolean> {
    const resolved = absolutePath(path);
    const hadRow = !!this.#overlayRow(resolved);
    const wasWhiteout = this.#isWhiteout(resolved);
    this.#sql.exec("DELETE FROM files WHERE path = ?", resolved);
    const route = routeMount(await this.mounts(), resolved);
    const mounted =
      !!route &&
      (await this.withItx((itx) => itx.repos.get(route.repo).listFiles())).paths.includes(
        route.relativePath,
      );
    if (mounted) this.#sql.exec("INSERT OR IGNORE INTO whiteouts (path) VALUES (?)", resolved);
    return hadRow || (mounted && !wasWhiteout);
  }

  /** Back to the mount's version: the overlay row and the whiteout both go. */
  async revert(path: string): Promise<void> {
    this.#forget(absolutePath(path));
  }

  /** Every file path of the merged view — the overlay plus every mount's tip, minus whiteouts —
   *  sorted. A tip path is listed only where it ROUTES to that mount: under a nested mount the
   *  nested repo's files show, the parent repo's are hidden, as `readFile` and a commit see them. */
  async listAllFiles(): Promise<string[]> {
    const mounts = await this.mounts();
    const whiteouts = new Set(this.#whiteouts());
    const paths = new Set(this.#overlayRows().map((row) => row.path));
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
    for (const { path, deleted } of [
      ...this.#overlayRows().map((row) => ({ path: row.path, deleted: false })),
      ...this.#whiteouts().map((path) => ({ path, deleted: true })),
    ]) {
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
      if (dirty.length === 0)
        throw new Error("workspace: nothing to commit — no mount has changes");
      if (dirty.length > 1)
        throw new Error(
          `workspace: changes span ${dirty.length} mounts (${dirty.map((m) => `"${m.path}"`).join(", ")}) — a commit never spans mounts; pass { scope }`,
        );
      mount = dirty[0]!;
    }
    if (mount.changes.length === 0)
      throw new Error(`workspace: nothing to commit under "${mount.path}"`);
    const mountPath = mount.path;
    const relative = (path: string) => path.slice(mountPath.length + 1);
    const changes: RepoFileChange[] = [
      ...this.#overlayRows()
        .filter((row) => routeMount(mounts, row.path)?.mountPath === mountPath)
        .map((row) => ({ path: relative(row.path), content: row.content })),
      ...this.#whiteouts()
        .filter((path) => routeMount(mounts, path)?.mountPath === mountPath)
        .map((path) => ({ path: relative(path), delete: true as const })),
    ];
    const committed = await this.withItx((itx) =>
      itx.repos
        .get(mount.repo)
        .commitFiles({ message: input.message, changes, author: input.author }),
    );
    // The commit landed: the overlay under this mount IS the tip now — drop it, whiteouts included.
    for (const { path } of mount.changes) this.#forget(path);
    return {
      commitOid: committed.commitOid,
      mount: mountPath,
      repo: mount.repo,
      changedPaths: committed.changedPaths.map((path) => `${mountPath}/${path}`),
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
