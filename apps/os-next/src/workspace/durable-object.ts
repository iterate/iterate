// src/workspace/durable-object.ts — THE WORKSPACE: the facet any context hosts under the name
// `workspace` (`itx.workspaces.get(path)`, library.ts — at most one per path, nothing appended to
// get it). ONE private overlay over a table of REPO MOUNTS: a read tries the overlay, then falls
// through to the mounted repo's `main` at its tip (the repo facet, `itx.repos.get(path)` — its tip
// cache, shared by every workspace of the project); a write shadows the repo's file until
// `gitCommit` lands ONE mount's changes as one commit on that repo's `main` and clears them; a delete
// of a repo file is a WHITEOUT until then. Mounts are DERIVED — every repo in the project catalog at
// its own path (`itx.repos.list()`; the workspace is a view of the project's one path namespace) —
// plus what `configure` adds, the reduce in processor.ts
// folding `workspace/configured` into the view. A path under no mount is the workspace's own scratch
// (`/workspace/…` by convention): writable, never committed. `create()` runs the creation saga: the
// certificate (`workspace/created { path }`) crosses to `/`, where the project processor keeps the
// catalog `itx.workspaces.list()` reads, and lands on this path.
//
// Storage is this facet's own SQLite: `files` (the overlay) and `whiteouts`. Text only, one file at
// most a mebibyte (a SQLite value holds 2 MB). ONE writer, no collab, no policies. The repo facets
// reach git as `itx.git` through THEIR context's rules, so a test lends a fake there
// (`provide("itx.git", …)` on the repo's path, e2e/workspaces.e2e.test.ts) exactly as it fakes `itx.ai`.
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
  processor = new WorkspaceProcessor({
    crossPost: (event) => this.withItx((itx) => itx.cd("/").append(event)),
  });

  #pathRead?: string;
  async #path(): Promise<string> {
    return (this.#pathRead ??= (await this.withItx((itx) => itx.whoami())).path);
  }

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

  // ── the creation saga ──

  /** Bring the workspace into being — the saga, as apps/os runs it: append
   *  `workspace/create-requested` unless a request is open or done (a new attempt after a failure,
   *  keyed by the attempt), let the catch-up drive the processor's effect (nothing to provision yet:
   *  the certificate alone), re-read for the terminal fact (it lands one page past the request),
   *  then answer with the identity — or throw the recorded failure. Idempotent: a created workspace
   *  answers at once. Every other method refuses until the saga has completed. */
  async create(): Promise<{ path: string }> {
    const path = await this.#path();
    let { state } = await this.snapshot();
    if (state.creation !== "requested" && state.creation !== "created") {
      await this.withItx((itx) =>
        itx.append({
          type: "events.iterate.com/workspace/create-requested",
          payload: { path },
          idempotencyKey: `workspace/create-requested:${path}:${state.attempts}`,
        }),
      );
      ({ state } = await this.snapshot()); // reduces the request and drives the effect
    }
    for (let reads = 0; reads < 5 && state.creation === "requested"; reads++)
      ({ state } = await this.snapshot());
    if (state.creation === "created") return { path };
    if (state.creation === "failed")
      throw new Error(`workspace ${path}: creation failed — ${state.error}`);
    throw new Error(`workspace ${path}: creation still owed after the request landed`);
  }

  // ── the mount table ──

  /** The EFFECTIVE mounts: every repo in the project catalog at its OWN path (derived — the
   *  workspace is a view of the project's one path namespace), the configured ones over them. Every
   *  method starts here: a workspace the saga has not completed refuses. */
  async mounts(): Promise<Record<string, WorkspaceMount>> {
    const [repos, { state }] = await Promise.all([
      this.withItx((itx) => itx.repos.list()),
      this.snapshot(),
    ]);
    if (state.creation !== "created")
      throw new Error(`workspace ${await this.#path()}: not created — call create() first`);
    const mounts: Record<string, WorkspaceMount> = {};
    for (const { path } of repos) mounts[path] = { repo: path };
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
