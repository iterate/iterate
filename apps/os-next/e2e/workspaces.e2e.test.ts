// workspaces.e2e.test.ts — `itx.workspaces.get(path)`: THE WORKSPACE of any context, at most one per
// path, nothing appended to get it — the `workspace` facet (src/workspace/durable-object.ts) hosted
// on `itx.cd(path)` by the library root (src/library.ts). ONE private overlay over a table of repo
// mounts: every project repo at `/repos/<name>` (derived from `itx.repos.list()`) plus what
// `configure` adds; reads fall through to a mount's repo at its tip; a write shadows until
// `gitCommit` lands ONE mount's changes on its repo's `main`; a delete is a whiteout until then;
// `/workspace/…` is scratch — never committed. Locally the repo tier is a FAKE lent to the
// workspace's context (`provide("itx.repos", …)`: the facet reaches `itx.repos` through the
// context's rules, exactly as a test fakes `itx.ai`); against the deployed worker the last test runs
// the same story on real Artifacts (`WORKER_BASE_URL=https://os.iterate2.com pnpm e2e workspaces`).

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, rejection } from "./support/client.ts";
import { deployedOnly } from "./support/project-host.ts";

type FakeCommit = {
  oid: string;
  message: string;
  author: { name: string; email: string };
  timestamp: number;
  parents: string[];
};

/** `itx.repos` in memory — each repo a path → content map and its commits; `commitFiles` applies the
 *  changes and records one commit. The shapes are `ReposScope`'s (src/context/repos.ts). */
class FakeRepos extends RpcTarget {
  readonly #repos = new Map<string, { files: Map<string, string>; commits: FakeCommit[] }>();
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
  commitFiles(
    repo: string,
    input: {
      message: string;
      changes: ({ path: string; content: string } | { path: string; delete: true })[];
    },
  ) {
    let known = this.#repos.get(repo);
    if (!known) this.#repos.set(repo, (known = { files: new Map(), commits: [] }));
    const changedPaths: string[] = [];
    for (const change of input.changes) {
      if ("delete" in change) {
        if (known.files.delete(change.path)) changedPaths.push(change.path);
      } else if (known.files.get(change.path) !== change.content) {
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
  log(repo: string, options: { limit?: number } = {}) {
    return [...(this.#repos.get(repo)?.commits ?? [])].reverse().slice(0, options.limit ?? 20);
  }
}

const SEED = { config: { "worker.ts": "export default 1;\n", "notes/log.md": "# log\n" } };

/** A fresh project whose `/workspaces/<name>` context has the fake repo tier lent to it, and the
 *  workspace handle at that path. */
async function workspaceOverFakeRepos(name: string) {
  const itx = openItx(freshCtx("ws"));
  const repos = new FakeRepos(SEED);
  await itx.cd(`/workspaces/${name}`).provide("itx.repos", repos);
  return { itx, repos, workspace: itx.workspaces.get(`/workspaces/${name}`) };
}

test("reads fall through to the mounted repo at its tip; a write shadows; the merged listing and the status say which is which", async () => {
  const { workspace } = await workspaceOverFakeRepos("one");
  expect(await workspace.mounts()).toEqual({ "/repos/config": { repo: "config" } });
  expect(await workspace.readFile("/repos/config/worker.ts")).toBe("export default 1;\n");
  expect(await workspace.readFile("/repos/config/missing.ts")).toBeNull();
  await workspace.writeFile("/repos/config/worker.ts", "export default 2;\n");
  await workspace.writeFile("/repos/config/new.ts", "");
  await workspace.writeFile("/workspace/scratch.md", "mine");
  expect(await workspace.readFile("/repos/config/worker.ts")).toBe("export default 2;\n");
  expect(await workspace.readBase("/repos/config/worker.ts")).toBe("export default 1;\n");
  expect(await workspace.readFile("/repos/config/new.ts")).toBe("");
  expect(await workspace.listAllFiles()).toEqual([
    "/repos/config/new.ts",
    "/repos/config/notes/log.md",
    "/repos/config/worker.ts",
    "/workspace/scratch.md",
  ]);
  expect(await workspace.gitStatus()).toEqual({
    mounts: [
      {
        path: "/repos/config",
        repo: "config",
        changes: [
          { path: "/repos/config/new.ts", change: "added" },
          { path: "/repos/config/worker.ts", change: "modified" },
        ],
      },
    ],
    unmounted: [{ path: "/workspace/scratch.md", change: "added" }],
  });
  expect((await rejection(workspace.writeFile("/repos/config", "x"))).message).toMatch(
    /is a directory/,
  );
});

test("gitCommit lands one mount's changes as ONE commit on its repo and clears the overlay; the fall-through then reads the new tip; gitLog shows it", async () => {
  const { workspace, repos } = await workspaceOverFakeRepos("two");
  await workspace.writeFile("/repos/config/notes/log.md", "# log\n- one\n");
  await workspace.deleteFile("/repos/config/worker.ts");
  await workspace.writeFile("/workspace/scratch.md", "mine"); // scratch never commits
  const commit = await workspace.gitCommit({ message: "notes + drop the worker" });
  expect(commit).toMatchObject({
    mount: "/repos/config",
    repo: "config",
    changedPaths: ["/repos/config/notes/log.md", "/repos/config/worker.ts"],
  });
  expect(repos.readFile("config", "notes/log.md")).toBe("# log\n- one\n");
  expect(repos.readFile("config", "worker.ts")).toBeNull();
  expect(await workspace.gitStatus()).toEqual({
    mounts: [{ path: "/repos/config", repo: "config", changes: [] }],
    unmounted: [{ path: "/workspace/scratch.md", change: "added" }],
  });
  expect(await workspace.readFile("/repos/config/notes/log.md")).toBe("# log\n- one\n");
  expect(await workspace.listAllFiles()).toEqual([
    "/repos/config/notes/log.md",
    "/workspace/scratch.md",
  ]);
  expect(
    (await workspace.gitLog({ scope: "/repos/config" })).map((c: FakeCommit) => c.message),
  ).toEqual(["notes + drop the worker", "seed"]);
  expect((await rejection(workspace.gitCommit({ message: "again" }))).message).toMatch(
    /nothing to commit/,
  );
});

test("deleteFile whites a repo file out until committed; revert lifts the whiteout, and a shadowing write", async () => {
  const { workspace } = await workspaceOverFakeRepos("three");
  expect(await workspace.deleteFile("/repos/config/worker.ts")).toBe(true);
  expect(await workspace.readFile("/repos/config/worker.ts")).toBeNull();
  expect(await workspace.listAllFiles()).toEqual(["/repos/config/notes/log.md"]);
  expect(await workspace.deleteFile("/repos/config/worker.ts")).toBe(false); // already gone from the view
  await workspace.revert("/repos/config/worker.ts");
  expect(await workspace.readFile("/repos/config/worker.ts")).toBe("export default 1;\n");
  await workspace.writeFile("/repos/config/worker.ts", "changed");
  await workspace.revert("/repos/config/worker.ts");
  expect(await workspace.readFile("/repos/config/worker.ts")).toBe("export default 1;\n");
  expect(await workspace.deleteFile("/nowhere.txt")).toBe(false);
});

test("configure mounts a repo at a second path — ONE workspace/configured event, reduced by the workspace processor; a commit names its mount with scope; scratch at a mount point stays scratch", async () => {
  const { itx, workspace, repos } = await workspaceOverFakeRepos("four");
  // Scratch written where a mount will later be: a mount point is a directory, never a file, so
  // this row stays scratch after the mount appears — unmounted in status, never committed as "".
  await workspace.writeFile("/vendor/cfg", "scratch at a future mount point");
  expect(await workspace.configure({ mounts: { "/vendor/cfg": { repo: "config" } } })).toEqual({
    "/repos/config": { repo: "config" },
    "/vendor/cfg": { repo: "config" },
  });
  expect(await itx.cd("/workspaces/four").facets.get("workspace").snapshot()).toMatchObject({
    state: { mounts: { "/vendor/cfg": { repo: "config" } } },
  });
  expect(await workspace.listAllFiles()).toEqual([
    "/repos/config/notes/log.md",
    "/repos/config/worker.ts",
    "/vendor/cfg",
    "/vendor/cfg/notes/log.md",
    "/vendor/cfg/worker.ts",
  ]);
  await workspace.writeFile("/vendor/cfg/a.txt", "a");
  await workspace.writeFile("/repos/config/b.txt", "b");
  expect((await rejection(workspace.gitCommit({ message: "both" }))).message).toMatch(
    /span 2 mounts/,
  );
  const commit = await workspace.gitCommit({ message: "a", scope: "/vendor/cfg" });
  expect(commit.changedPaths).toEqual(["/vendor/cfg/a.txt"]);
  expect(repos.readFile("config", "a.txt")).toBe("a");
  expect(await workspace.gitStatus()).toMatchObject({
    mounts: [
      { path: "/repos/config", changes: [{ path: "/repos/config/b.txt", change: "added" }] },
      { path: "/vendor/cfg", changes: [] },
    ],
    unmounted: [{ path: "/vendor/cfg", change: "added" }],
  });
  expect(await workspace.configure({ mounts: { "/vendor/cfg": null } })).toEqual({
    "/repos/config": { repo: "config" },
  });
  const events = await readAll(itx.cd("/workspaces/four"));
  expect(events.filter((e) => e.type === "events.iterate.com/workspace/configured")).toHaveLength(
    2,
  );
});

test("a nested mount wins beneath its path: the listing, reads and status all route to the longest mount", async () => {
  const itx = openItx(freshCtx("ws"));
  await itx
    .cd("/workspaces/nested")
    .provide(
      "itx.repos",
      new FakeRepos({
        config: { "worker.ts": "w", "vendor/x.txt": "from config" },
        lib: { "y.txt": "from lib" },
      }),
    );
  const workspace = itx.workspaces.get("/workspaces/nested");
  await workspace.configure({ mounts: { "/repos/config/vendor": { repo: "lib" } } });
  expect(await workspace.listAllFiles()).toEqual([
    "/repos/config/vendor/y.txt",
    "/repos/config/worker.ts",
    "/repos/lib/y.txt",
  ]);
  expect(await workspace.readFile("/repos/config/vendor/x.txt")).toBeNull(); // routes to lib, which has no x.txt
  expect(await workspace.readFile("/repos/config/vendor/y.txt")).toBe("from lib");
  await workspace.writeFile("/repos/config/vendor/z.txt", "z");
  expect(
    (await workspace.gitStatus()).mounts.map((m: { path: string; changes: { path: string }[] }) => [
      m.path,
      m.changes.map((c) => c.path),
    ]),
  ).toEqual([
    ["/repos/config", []],
    ["/repos/lib", []],
    ["/repos/config/vendor", ["/repos/config/vendor/z.txt"]],
  ]);
});

test("a workspace is its path: a second session opens the same overlay, uncommitted work included", async () => {
  const ctx = freshCtx("ws");
  const itx = openItx(ctx);
  await itx.cd("/workspaces/five").provide("itx.repos", new FakeRepos(SEED));
  await itx.workspaces.get("/workspaces/five").writeFile("/workspace/draft.md", "draft");
  const again = openItx(ctx);
  expect(await again.workspaces.get("/workspaces/five").readFile("/workspace/draft.md")).toBe(
    "draft",
  );
  expect(await again.workspaces.get("/workspaces/five").listAllFiles()).toEqual([
    "/repos/config/notes/log.md",
    "/repos/config/worker.ts",
    "/workspace/draft.md",
  ]);
});

deployedOnly(
  "against real Artifacts: nested paths through the workspace — a repo file read at the tip, a nested write committed as one commit, a delete committed, the repo's log",
  async () => {
    const itx = openItx(freshCtx("wsrepo"));
    try {
      await itx.repos.writeFile("config", "worker.ts", "export default 1;\n");
      const workspace = itx.workspaces.get("/workspaces/deployed");
      expect(await workspace.readFile("/repos/config/worker.ts")).toBe("export default 1;\n");
      await workspace.writeFile("/repos/config/notes/log.md", "# log\n");
      await workspace.writeFile("/repos/config/worker.ts", "export default 2;\n");
      const commit = await workspace.gitCommit({ message: "notes" });
      expect(commit.changedPaths).toEqual([
        "/repos/config/notes/log.md",
        "/repos/config/worker.ts",
      ]);
      expect(await itx.repos.readFile("config", "notes/log.md")).toBe("# log\n");
      expect(await itx.repos.listFiles("config")).toEqual({
        commitOid: commit.commitOid,
        paths: ["notes/log.md", "worker.ts"],
      });
      expect(await workspace.listAllFiles()).toEqual([
        "/repos/config/notes/log.md",
        "/repos/config/worker.ts",
      ]);
      expect(await workspace.gitStatus()).toEqual({
        mounts: [{ path: "/repos/config", repo: "config", changes: [] }],
        unmounted: [],
      });
      await workspace.deleteFile("/repos/config/worker.ts");
      await workspace.gitCommit({ message: "drop the worker" });
      expect(await itx.repos.listFiles("config")).toMatchObject({ paths: ["notes/log.md"] });
      expect(
        (await workspace.gitLog({ scope: "/repos/config" })).map((c: FakeCommit) => c.message),
      ).toEqual(["drop the worker", "notes", "itx.repos: write worker.ts"]);
    } finally {
      await itx.cfArtifacts.delete("config"); // teardown — cfArtifacts and repos address the same repo
    }
  },
  120_000,
);
