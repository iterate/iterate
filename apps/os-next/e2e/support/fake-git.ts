// fake-git.ts — `itx.git` in memory, lent to a repo's context with `provide("itx.git", …)`: the repo
// facet reaches git through its context's rules, so a test fakes the physical tier the way it fakes
// `itx.ai`. Each repo is a path → content map plus its commits; the shapes are `GitScope`'s
// (src/context/repos.ts), deletes applied before writes as the real one does. `snapshots` counts the
// full fetches, the thing the repo facet's tip cache is meant to avoid.
import { RpcTarget } from "capnweb";

export type FakeCommit = {
  oid: string;
  message: string;
  author: { name: string; email: string };
  timestamp: number;
  parents: string[];
};

type FakeChange = { path: string; content: string } | { path: string; delete: true };

export class FakeGit extends RpcTarget {
  readonly #repos = new Map<string, { files: Map<string, string>; commits: FakeCommit[] }>();
  /** Every repo `create` made (not the seeded ones). */
  readonly created: string[] = [];
  /** How many times a whole tip was fetched. */
  snapshots = 0;
  /** How many `create` calls still fail (the saga's failure story). */
  failCreates = 0;

  constructor(seed: Record<string, Record<string, string>>) {
    super();
    for (const [name, files] of Object.entries(seed))
      this.#repos.set(name, {
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
  list() {
    return [...this.#repos.keys()].sort();
  }
  create(name: string) {
    if (this.failCreates > 0) {
      this.failCreates -= 1;
      throw new Error("artifacts down");
    }
    if (this.#repos.has(name)) return { created: false };
    this.#repos.set(name, { files: new Map(), commits: [] });
    this.created.push(name);
    return { created: true };
  }
  tip(name: string) {
    return this.#repos.get(name)?.commits.at(-1)?.oid ?? null;
  }
  snapshot(name: string) {
    const known = this.#repos.get(name);
    const tip = known?.commits.at(-1);
    if (!known || !tip) return null;
    this.snapshots += 1;
    return { commitOid: tip.oid, files: Object.fromEntries(known.files) };
  }
  readFile(repo: string, path: string) {
    return this.#repos.get(repo)?.files.get(path) ?? null;
  }
  listFiles(repo: string) {
    const known = this.#repos.get(repo);
    return {
      commitOid: known?.commits.at(-1)?.oid ?? null,
      paths: known ? [...known.files.keys()].sort() : [],
    };
  }
  commitFiles(repo: string, input: { message: string; changes: FakeChange[] }) {
    let known = this.#repos.get(repo);
    if (!known) {
      this.create(repo);
      known = this.#repos.get(repo)!;
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
  writeFile(repo: string, path: string, content: string) {
    return this.commitFiles(repo, { message: `write ${path}`, changes: [{ path, content }] });
  }
  log(repo: string, options: { limit?: number } = {}) {
    return [...(this.#repos.get(repo)?.commits ?? [])].reverse().slice(0, options.limit ?? 20);
  }
}
