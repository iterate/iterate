// workspaces.e2e.test.ts — `itx.workspaces.get(path)`: THE WORKSPACE of any context, at most one per
// path, nothing appended to get it — the `workspace` facet (src/workspace/durable-object.ts) hosted
// on `itx.cd(path)` by the library root (src/library.ts). ONE private overlay over a table of repo
// mounts: every repo in the project catalog at its own path (`itx.repos.list()`) plus what
// `configure` adds; reads fall through to a mount's repo facet at its tip; a write shadows until
// `gitCommit` lands ONE mount's changes on its repo's `main`; a delete is a whiteout until then;
// `/workspace/…` is scratch — never committed. `create()` runs the creation saga: the certificate
// on its path, cross-posted to `/`, so `itx.workspaces.list()` knows it. Locally
// the physical tier is a FAKE `itx.git` lent to each repo's context (support/fake-git.ts); against
// the deployed worker the last test runs the same story on real Artifacts
// (`WORKER_BASE_URL=https://os.iterate2.com pnpm e2e workspaces`).

import { expect, test } from "vitest";
import { repoArtifactName } from "../src/repo/contract.ts";
import { freshCtx, openItx, readAll, rejection } from "./support/client.ts";
import { FakeGit, type FakeCommit } from "./support/fake-git.ts";
import { deployedOnly } from "./support/project-host.ts";

const SEED = { "/repos/config": { "worker.ts": "export default 1;\n", "notes/log.md": "# log\n" } };

/** A fresh project whose repos (seeded by PATH) are CREATED — the saga run — over one fake `itx.git`
 *  lent to each repo's context, and the workspace at `/workspaces/<name>`, created too. */
async function workspaceOverFakeGit(
  name: string,
  seed: Record<string, Record<string, string>> = SEED,
) {
  const itx = openItx(freshCtx("ws"));
  const git = new FakeGit(
    Object.fromEntries(
      Object.entries(seed).map(([path, files]) => [repoArtifactName(path), files]),
    ),
  );
  for (const path of Object.keys(seed)) {
    await itx.cd(path).provide("itx.git", git);
    await itx.repos.get(path).create();
  }
  const workspace = itx.workspaces.get(`/workspaces/${name}`);
  await workspace.create();
  return { itx, git, workspace };
}

test("reads fall through to the mounted repo at its tip; a write shadows; the merged listing and the status say which is which", async () => {
  const { workspace } = await workspaceOverFakeGit("one");
  expect(await workspace.mounts()).toEqual({ "/repos/config": { repo: "/repos/config" } });
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
        repo: "/repos/config",
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
  const { workspace, git } = await workspaceOverFakeGit("two");
  await workspace.writeFile("/repos/config/notes/log.md", "# log\n- one\n");
  await workspace.deleteFile("/repos/config/worker.ts");
  await workspace.writeFile("/workspace/scratch.md", "mine"); // scratch never commits
  const commit = await workspace.gitCommit({ message: "notes + drop the worker" });
  expect(commit).toMatchObject({
    mount: "/repos/config",
    repo: "/repos/config",
    changedPaths: ["/repos/config/worker.ts", "/repos/config/notes/log.md"], // deletes land first
  });
  expect(git.readFile("repos--config", "notes/log.md")).toBe("# log\n- one\n");
  expect(git.readFile("repos--config", "worker.ts")).toBeNull();
  expect(await workspace.gitStatus()).toEqual({
    mounts: [{ path: "/repos/config", repo: "/repos/config", changes: [] }],
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
  const { workspace } = await workspaceOverFakeGit("three");
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
  const { itx, workspace, git } = await workspaceOverFakeGit("four");
  // Scratch written where a mount will later be: a mount point is a directory, never a file, so
  // this row stays scratch after the mount appears — unmounted in status, never committed as "".
  await workspace.writeFile("/vendor/cfg", "scratch at a future mount point");
  expect(
    await workspace.configure({ mounts: { "/vendor/cfg": { repo: "/repos/config" } } }),
  ).toEqual({
    "/repos/config": { repo: "/repos/config" },
    "/vendor/cfg": { repo: "/repos/config" },
  });
  expect(await itx.cd("/workspaces/four").facets.get("workspace").snapshot()).toMatchObject({
    state: { creation: "created", mounts: { "/vendor/cfg": { repo: "/repos/config" } } },
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
  expect(git.readFile("repos--config", "a.txt")).toBe("a");
  expect(await workspace.gitStatus()).toMatchObject({
    mounts: [
      { path: "/repos/config", changes: [{ path: "/repos/config/b.txt", change: "added" }] },
      { path: "/vendor/cfg", changes: [] },
    ],
    unmounted: [{ path: "/vendor/cfg", change: "added" }],
  });
  expect(await workspace.configure({ mounts: { "/vendor/cfg": null } })).toEqual({
    "/repos/config": { repo: "/repos/config" },
  });
  const events = await readAll(itx.cd("/workspaces/four"));
  expect(events.filter((e) => e.type === "events.iterate.com/workspace/configured")).toHaveLength(
    2,
  );
  // Created through the saga: the request and ONE certificate on its own path, the same certificate
  // cross-posted to /, and the catalog — beside the repo the setup created — lists it.
  const born = (log: { type: string; payload?: unknown }[]) =>
    log.filter((e) => e.type === "events.iterate.com/workspace/created").map((e) => e.payload);
  expect(born(events)).toEqual([{ path: "/workspaces/four" }]);
  expect(
    events.filter((e) => e.type === "events.iterate.com/workspace/create-requested"),
  ).toHaveLength(1);
  expect(born(await readAll(itx))).toEqual([{ path: "/workspaces/four" }]);
  expect(await itx.workspaces.list()).toEqual([
    { path: "/workspaces/four", createdAt: expect.any(String) },
  ]);
  expect((await itx.repos.list()).map((r: { path: string }) => r.path)).toEqual(["/repos/config"]);
  // A workspace the saga has not created refuses.
  expect((await rejection(itx.workspaces.get("/workspaces/never").readFile("/x"))).message).toMatch(
    /not created — call create\(\) first/,
  );
});

test("a nested mount wins beneath its path: the listing, reads and status all route to the longest mount", async () => {
  const { workspace } = await workspaceOverFakeGit("nested", {
    "/repos/config": { "worker.ts": "w", "vendor/x.txt": "from config" },
    "/repos/lib": { "y.txt": "from lib" },
  });
  await workspace.configure({ mounts: { "/repos/config/vendor": { repo: "/repos/lib" } } });
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
  const { itx } = await workspaceOverFakeGit("five");
  await itx.workspaces.get("/workspaces/five").writeFile("/workspace/draft.md", "draft");
  const again = openItx((await itx.whoami()).projectId);
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
      const repo = itx.repos.get("/repos/config");
      await repo.create();
      await repo.writeFile("worker.ts", "export default 1;\n");
      const workspace = itx.workspaces.get("/workspaces/deployed");
      await workspace.create();
      expect(await workspace.readFile("/repos/config/worker.ts")).toBe("export default 1;\n");
      await workspace.writeFile("/repos/config/notes/log.md", "# log\n");
      await workspace.writeFile("/repos/config/worker.ts", "export default 2;\n");
      const commit = await workspace.gitCommit({ message: "notes" });
      expect(commit.changedPaths).toEqual([
        "/repos/config/notes/log.md",
        "/repos/config/worker.ts",
      ]);
      expect(await repo.readFile("notes/log.md")).toBe("# log\n");
      expect(await itx.git.readFile("repos--config", "notes/log.md")).toBe("# log\n"); // the physical tier agrees
      expect(await repo.listFiles()).toEqual({
        commitOid: commit.commitOid,
        paths: ["notes/log.md", "worker.ts"],
      });
      expect(await workspace.listAllFiles()).toEqual([
        "/repos/config/notes/log.md",
        "/repos/config/worker.ts",
      ]);
      expect(await workspace.gitStatus()).toEqual({
        mounts: [{ path: "/repos/config", repo: "/repos/config", changes: [] }],
        unmounted: [],
      });
      await workspace.deleteFile("/repos/config/worker.ts");
      await workspace.gitCommit({ message: "drop the worker" });
      expect(await repo.listFiles()).toMatchObject({ paths: ["notes/log.md"] });
      expect(
        (await workspace.gitLog({ scope: "/repos/config" })).map((c: FakeCommit) => c.message),
      ).toEqual(["drop the worker", "notes", "write worker.ts"]);
      expect((await itx.repos.list()).map((r: { path: string }) => r.path)).toEqual([
        "/repos/config",
      ]);
      expect((await itx.workspaces.list()).map((w: { path: string }) => w.path)).toEqual([
        "/workspaces/deployed",
      ]);
    } finally {
      await itx.cfArtifacts.delete("repos--config"); // teardown — the path's Artifacts name
    }
  },
  120_000,
);
