// fake-artifacts.ts — `itx.cfArtifacts` in memory, lent to a repo's context with
// `itx.cd(path).provide("itx.cfArtifacts", …)`: the repo facet reaches its physical tier through its
// context's rules, so a test fakes it the way it fakes `itx.ai`. Keyed by the repo's context PATH
// (`/repos/config`) — the Artifacts repo NAME is src/context/repos.ts's own detail and never crosses
// here. Each repo is a path → content map plus its commits; the shapes are `ArtifactsScope`'s
// (src/context/repos.ts), deletes applied before writes as the real one does. `snapshots` counts the
// full fetches — what the repo facet's memo avoids.
import { RpcTarget } from "capnweb";
import type { RepoFileChange, RepoLogEntry } from "../../src/context/repos.ts";

/** One commit as the fake's `log` lists it — the real `RepoLogEntry`, newest first. */
export type FakeCommit = RepoLogEntry;

/** What the fake's `get(path)` hands back — an `RpcTarget` like the real `ScopedArtifactRepo`, so it
 *  crosses the wire and `get(path).createToken(…)` pipelines; the credential is a placeholder. */
class FakeArtifactRepo extends RpcTarget {
  createToken(_scope: "read" | "write", _ttlSeconds: number): Promise<{ plaintext: string }> {
    return Promise.resolve({ plaintext: "fake" });
  }
}

export class FakeArtifacts extends RpcTarget {
  readonly #repos = new Map<string, { files: Map<string, string>; commits: FakeCommit[] }>();
  /** Every repo path `create` made (not the seeded ones). */
  readonly created: string[] = [];
  /** How many times a whole tip was fetched. */
  snapshots = 0;
  /** How many `create` calls still fail (the creation's failure story). */
  failCreates = 0;

  /** `seed`: repo PATH → its files, each seeded repo born with ONE commit ("seed"). */
  constructor(seed: Record<string, Record<string, string>>) {
    super();
    for (const [path, files] of Object.entries(seed))
      this.#repos.set(path, {
        files: new Map(Object.entries(files)),
        commits: [this.#commit("seed", [])],
      });
  }
  #commit(message: string, parents: string[]): FakeCommit {
    return {
      oid: `c${Math.random().toString(36).slice(2, 10)}`,
      message,
      author: { name: "iterate", email: "config@iterate.com" },
      timestamp: Date.now(),
      parents,
    };
  }
  create(path: string) {
    if (this.failCreates > 0) {
      this.failCreates -= 1;
      throw new Error("artifacts down");
    }
    if (this.#repos.has(path)) return { created: false };
    this.#repos.set(path, { files: new Map(), commits: [] });
    this.created.push(path);
    return { created: true };
  }
  get(_path: string) {
    return new FakeArtifactRepo();
  }
  /** Every repo, as paths — ONE page, never a cursor. */
  list(_options: { limit?: number; cursor?: string } = {}) {
    return { repos: [...this.#repos.keys()].map((path) => ({ path })) };
  }
  delete(path: string) {
    return this.#repos.delete(path);
  }
  tip(path: string) {
    return this.#repos.get(path)?.commits.at(-1)?.oid ?? null;
  }
  snapshot(path: string) {
    const known = this.#repos.get(path);
    const tip = known?.commits.at(-1);
    if (!known || !tip) return null;
    this.snapshots += 1;
    return { commitOid: tip.oid, files: Object.fromEntries(known.files) };
  }
  commitFiles(path: string, input: { message: string; changes: RepoFileChange[] }) {
    let known = this.#repos.get(path);
    if (!known) {
      this.create(path);
      known = this.#repos.get(path)!;
    }
    const changedPaths: string[] = [];
    for (const change of input.changes) {
      if ("delete" in change && known.files.delete(change.path)) changedPaths.push(change.path);
    }
    for (const change of input.changes) {
      if ("delete" in change) continue;
      if (known.files.get(change.path) !== change.content) {
        known.files.set(change.path, change.content);
        changedPaths.push(change.path);
      }
    }
    const tip = known.commits.at(-1);
    if (changedPaths.length === 0) return { commitOid: tip?.oid ?? null, changedPaths };
    const commit = this.#commit(input.message, tip ? [tip.oid] : []);
    known.commits.push(commit);
    return { commitOid: commit.oid, changedPaths };
  }
  log(path: string, options: { limit?: number } = {}) {
    return [...(this.#repos.get(path)?.commits ?? [])].reverse().slice(0, options.limit ?? 20);
  }
}
