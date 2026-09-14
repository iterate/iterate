// src/repo/durable-object.ts — THE REPO: the facet the context at `/repos/<name>` hosts under the name
// `repo` (`itx.repos.get(name)`, library.ts). A repo's files live in git, in Artifacts, behind the
// stateless `itx.git`; this host is what makes a repo a DOMAIN OBJECT — the creation SAGA on its own
// path (`create()` appends `repos/create-requested`; the processor's effect, wired here to `itx.git`
// and `itx.cd("/")`, provisions the Artifacts repo and appends the terminal `repos/created`, the
// birth certificate the project catalog folds, or `repos/create-failed`), a `commit-completed` fact
// for every commit that lands through it, and THE TIP CACHE: the tip's snapshot (every file's text)
// in this facet's own SQLite, validated against the remote's tip with ONE `ls-refs` per call
// (`itx.git.tip`) and re-fetched only when the tip moved; a commit through this facet updates the
// cache in place, so read-your-writes costs no fetch. Workspaces mount repos THROUGH this facet, so
// every workspace of a project shares one cache per repo.
//
// THE SINGLE SOURCE: build-sdk.mjs bundles THIS module — pulling `RepoProcessor` from ./processor.ts —
// into the generated REPO_PROCESSOR_SOURCE string; library.ts hands it to `facets.get` as the spec.
import { StreamProcessorDurableObject } from "../sdk/index.ts";
import type { RepoFileChange, RepoLogEntry } from "../context/repos.ts";
import type { RepoIdentity, RepoView } from "./contract.ts";
import { RepoProcessor } from "./processor.ts";

export class RepoDurableObject extends StreamProcessorDurableObject<RepoView> {
  processor = new RepoProcessor({
    createRepo: (name) => this.withItx((itx) => itx.git.create(name)),
    crossPost: (event) => this.withItx((itx) => itx.cd("/").append(event)),
  });

  // ── identity: the context this facet is hosted on names the repo ──

  #identityRead?: RepoIdentity;
  async #identity(): Promise<RepoIdentity> {
    if (this.#identityRead) return this.#identityRead;
    const { path } = await this.withItx((itx) => itx.whoami());
    if (!path.startsWith("/repos/") || path === "/repos/")
      throw new Error(`repo: hosted on "${path}" — a repo facet lives on a /repos/<name> context`);
    return (this.#identityRead = { name: path.slice("/repos/".length), path });
  }

  // ── the tip cache: this facet's own SQLite ──

  #tablesCreated = false;
  get #sql() {
    const sql = this.ctx.storage.sql;
    if (!this.#tablesCreated) {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS snapshot_files (path TEXT PRIMARY KEY, content TEXT NOT NULL)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS snapshot_tip (id INTEGER PRIMARY KEY CHECK (id = 1), commit_oid TEXT)",
      );
      this.#tablesCreated = true;
    }
    return sql;
  }
  #cachedTip(): string | null {
    const row = this.#sql
      .exec<{ commit_oid: string | null }>("SELECT commit_oid FROM snapshot_tip WHERE id = 1")
      .toArray()[0];
    return row ? row.commit_oid : null;
  }
  #setCachedTip(commitOid: string | null): void {
    this.#sql.exec(
      "INSERT INTO snapshot_tip (id, commit_oid) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET commit_oid = excluded.commit_oid",
      commitOid,
    );
  }

  /** The cache brought to the remote's tip: ONE `ls-refs`; the pack only when the tip moved (or the
   *  cache is empty). Returns the tip — null for a repo that does not exist or an unborn `main`. */
  async #fresh(): Promise<string | null> {
    const { name } = await this.#identity();
    const tip = await this.withItx((itx) => itx.git.tip(name));
    if (tip === this.#cachedTip()) return tip;
    const snapshot = await this.withItx((itx) => itx.git.snapshot(name));
    this.#sql.exec("DELETE FROM snapshot_files");
    if (!snapshot) {
      this.#setCachedTip(null);
      return null;
    }
    for (const [path, content] of Object.entries(snapshot.files))
      this.#sql.exec("INSERT INTO snapshot_files (path, content) VALUES (?, ?)", path, content);
    this.#setCachedTip(snapshot.commitOid);
    return snapshot.commitOid;
  }

  // ── the creation saga ──

  /** Bring the repo into being — the saga, as apps/os runs it: append `repos/create-requested` (a
   *  new attempt after a failure; a no-op while one is open or done), let the processor's effect
   *  provision the Artifacts repo and land the terminal fact, then answer with the certificate or
   *  throw the recorded failure. Idempotent: a created repo answers at once. */
  async create(): Promise<RepoIdentity> {
    const identity = await this.#identity();
    let { state } = await this.snapshot();
    if (state.creation !== "requested" && state.creation !== "created") {
      await this.withItx((itx) =>
        itx.append({
          type: "events.iterate.com/repos/create-requested",
          payload: identity,
          idempotencyKey: `repos/create-requested:${identity.path}:${state.attempts}`,
        }),
      );
      ({ state } = await this.snapshot()); // reduces the request and drives the effect
    }
    // The effect lands the terminal fact DURING the catch-up that reads the request, one page past
    // it: a bounded re-read sees it.
    for (let reads = 0; reads < 5 && state.creation === "requested"; reads++)
      ({ state } = await this.snapshot());
    if (state.creation === "created") return identity;
    if (state.creation === "failed")
      throw new Error(`repo ${identity.name}: creation failed — ${state.error}`);
    throw new Error(`repo ${identity.name}: creation still owed after the request landed`);
  }

  /** `main`'s tip at the remote, or null. */
  async tip(): Promise<string | null> {
    return this.#fresh();
  }

  async readFile(path: string): Promise<string | null> {
    await this.#fresh();
    const row = this.#sql
      .exec<{ content: string }>("SELECT content FROM snapshot_files WHERE path = ?", path)
      .toArray()[0];
    return row ? row.content : null;
  }

  async listFiles(): Promise<{ commitOid: string | null; paths: string[] }> {
    const commitOid = await this.#fresh();
    return {
      commitOid,
      paths: this.#sql
        .exec<{ path: string }>("SELECT path FROM snapshot_files ORDER BY path")
        .toArray()
        .map((row) => row.path),
    };
  }

  /** ONE commit on `main` (`itx.git.commitFiles`) on a repo the saga has created (run first if not),
   *  the cache updated in place under the new tip, and `repo/commit-completed` on this repo's path.
   *  A batch that changes nothing commits nothing. */
  async commitFiles(input: {
    message: string;
    changes: RepoFileChange[];
    author?: { name: string; email: string };
  }): Promise<{ commitOid: string | null; changedPaths: string[] }> {
    const { name } = await this.create();
    const parentOid = await this.#fresh();
    const committed = await this.withItx((itx) => itx.git.commitFiles(name, input));
    if (committed.changedPaths.length === 0 || !committed.commitOid) return committed;
    for (const change of input.changes) {
      if (!committed.changedPaths.includes(change.path)) continue;
      if ("delete" in change)
        this.#sql.exec("DELETE FROM snapshot_files WHERE path = ?", change.path);
      else
        this.#sql.exec(
          "INSERT INTO snapshot_files (path, content) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content",
          change.path,
          change.content,
        );
    }
    this.#setCachedTip(committed.commitOid);
    await this.withItx((itx) =>
      itx.append({
        type: "events.iterate.com/repo/commit-completed",
        payload: {
          commitOid: committed.commitOid,
          parentOid,
          message: input.message,
          changedPaths: committed.changedPaths,
        },
        idempotencyKey: `repo/commit-completed:${committed.commitOid}`,
      }),
    );
    return committed;
  }

  writeFile(
    path: string,
    content: string,
  ): Promise<{ commitOid: string | null; changedPaths: string[] }> {
    return this.commitFiles({ message: `write ${path}`, changes: [{ path, content }] });
  }

  async log(options: { limit?: number } = {}): Promise<RepoLogEntry[]> {
    const { name } = await this.#identity();
    return this.withItx((itx) => itx.git.log(name, options));
  }
}
