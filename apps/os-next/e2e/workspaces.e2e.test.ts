// workspaces.e2e.test.ts — `itx.workspaces.get(path)`: THE WORKSPACE of any context, at most one per
// path, nothing appended to get it — the `workspace` facet (src/workspace/durable-object.ts) hosted
// on `itx.cd(path)` by the library root (src/library.ts). ONE private overlay over the mount table —
// every repo in the project catalog at its own path (`itx.repos.list()`); reads fall through to a
// mount's repo facet at its tip; a write shadows until `gitCommit` lands ONE mount's changes on its
// repo's `main`; a delete is a whiteout until then; `/workspace/…` is scratch — never committed.
// `create()` lands the creation facts: the certificate on its path, cross-posted to `/`, so
// `itx.workspaces.list()` knows it. Locally the physical tier is a FAKE `itx.cfArtifacts` lent to each
// repo's context (support/fake-artifacts.ts), keyed by the repo's PATH as the real one is; against the
// deployed worker the last test runs the same story on real Artifacts
// (`WORKER_BASE_URL=https://os.iterate2.com pnpm e2e workspaces`).

import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, rejection } from "./support/client.ts";
import { FakeArtifacts, type FakeCommit } from "./support/fake-artifacts.ts";
import { deployedOnly } from "./support/project-host.ts";

/** A log as its repo facts' short type names, in order. */
const types = (log: { type: string }[]) =>
  log
    .filter((e) => e.type.startsWith("events.iterate.com/repo"))
    .map((e) => e.type.replace("events.iterate.com/", ""));

const SEED = { "/repos/config": { "worker.ts": "export default 1;\n", "notes/log.md": "# log\n" } };

/** A fresh project whose repos (seeded by PATH) are CREATED over one fake `itx.cfArtifacts` lent to
 *  each repo's context, and the workspace at `/workspaces/<name>`, created too. */
async function workspaceOverFakeArtifacts(
  name: string,
  seed: Record<string, Record<string, string>> = SEED,
) {
  const itx = openItx(freshCtx("ws"));
  const artifacts = new FakeArtifacts(seed);
  for (const path of Object.keys(seed)) {
    await itx.cd(path).provide("itx.cfArtifacts", artifacts);
    await itx.repos.get(path).create();
  }
  const workspace = itx.workspaces.get(`/workspaces/${name}`);
  await workspace.create();
  return { itx, artifacts, workspace };
}

test("reads fall through to the mounted repo at its tip; a write shadows; the merged listing and the status say which is which", async () => {
  const { workspace } = await workspaceOverFakeArtifacts("one");
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
  expect((await rejection(workspace.readFile("repos/config/worker.ts"))).message).toMatch(
    /not an absolute path/,
  );
});

test("gitCommit lands one mount's changes as ONE commit on its repo and clears the overlay; the fall-through then reads the new tip; gitLog shows it", async () => {
  const { workspace, artifacts } = await workspaceOverFakeArtifacts("two");
  await workspace.writeFile("/repos/config/notes/log.md", "# log\n- one\n");
  await workspace.deleteFile("/repos/config/worker.ts");
  await workspace.writeFile("/workspace/scratch.md", "mine"); // scratch never commits
  const commit = await workspace.gitCommit({ message: "notes + drop the worker" });
  expect(commit).toMatchObject({
    mount: "/repos/config",
    repo: "/repos/config",
    changedPaths: ["/repos/config/worker.ts", "/repos/config/notes/log.md"], // deletes land first
  });
  expect(artifacts.snapshot("/repos/config")?.files).toEqual({ "notes/log.md": "# log\n- one\n" });
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
  const { workspace } = await workspaceOverFakeArtifacts("three");
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

test("create() lands the request and ONE certificate on its path, the same certificate on /, and the catalog lists it; a workspace not created refuses before it stores anything", async () => {
  const { itx } = await workspaceOverFakeArtifacts("four");
  const events = await readAll(itx.cd("/workspaces/four"));
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
  await itx.workspaces.get("/workspaces/four").create(); // created once: answers at once, appends nothing
  expect(await readAll(itx.cd("/workspaces/four"))).toHaveLength(events.length);

  const never = itx.workspaces.get("/workspaces/never");
  expect((await rejection(never.readFile("/x"))).message).toMatch(
    /not created — call create\(\) first/,
  );
  expect((await rejection(never.writeFile("/x", "x"))).message).toMatch(/not created/);
  expect((await rejection(never.gitStatus())).message).toMatch(/not created/);
  expect(
    (await readAll(itx.cd("/workspaces/never"))).filter((e) =>
      e.type.startsWith("events.iterate.com/workspace/"),
    ),
  ).toEqual([]);
});

test("a repo beneath another's path wins beneath it: the listing, reads and status route to the longest mount; a commit never spans mounts", async () => {
  const { workspace, artifacts } = await workspaceOverFakeArtifacts("nested", {
    "/repos/config": { "worker.ts": "w", "vendor/x.txt": "from config" },
    "/repos/config/vendor": { "y.txt": "from lib" },
  });
  expect(await workspace.listAllFiles()).toEqual([
    "/repos/config/vendor/y.txt",
    "/repos/config/worker.ts",
  ]);
  expect(await workspace.readFile("/repos/config/vendor/x.txt")).toBeNull(); // routes to the nested repo, which has no x.txt
  expect(await workspace.readFile("/repos/config/vendor/y.txt")).toBe("from lib");
  await workspace.writeFile("/repos/config/vendor/z.txt", "z");
  await workspace.writeFile("/repos/config/b.txt", "b");
  expect(
    (await workspace.gitStatus()).mounts.map((m: { path: string; changes: { path: string }[] }) => [
      m.path,
      m.changes.map((c) => c.path),
    ]),
  ).toEqual([
    ["/repos/config", ["/repos/config/b.txt"]],
    ["/repos/config/vendor", ["/repos/config/vendor/z.txt"]],
  ]);
  expect((await rejection(workspace.gitCommit({ message: "both" }))).message).toMatch(
    /span 2 mounts/,
  );
  const commit = await workspace.gitCommit({ message: "z", scope: "/repos/config/vendor" });
  expect(commit.changedPaths).toEqual(["/repos/config/vendor/z.txt"]);
  expect(artifacts.snapshot("/repos/config/vendor")?.files).toEqual({
    "y.txt": "from lib",
    "z.txt": "z",
  });
  expect(artifacts.snapshot("/repos/config")?.files).toEqual({
    "worker.ts": "w",
    "vendor/x.txt": "from config",
  });
});

test("a workspace is its path: a second session opens the same overlay, uncommitted work included", async () => {
  const { itx } = await workspaceOverFakeArtifacts("five");
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

test("the Notes app's story, spelled as apps/notes spells it: create the repo and the workspace (idempotent), read the file through the workspace, write it and commit ONE commit on the repo's main", async () => {
  const itx = openItx(freshCtx("notes"));
  const artifacts = new FakeArtifacts({});
  await itx.cd("/repos/config").provide("itx.cfArtifacts", artifacts);
  const REPO = "/repos/config";
  const WORKSPACE = "/workspaces/notes";
  const FILE = `${REPO}/notes/log.md`;
  // The loader, on every page load — a created repo and workspace answer at once.
  const load = async () => {
    await itx.invoke(["itx", "repos", ["get", REPO], ["create"]]);
    await itx.invoke(["itx", "workspaces", ["get", WORKSPACE], ["create"]]);
    return {
      note: await itx.invoke(["itx", "workspaces", ["get", WORKSPACE], ["readFile", FILE]]),
      tip: await itx.invoke(["itx", "repos", ["get", REPO], ["tip"]]),
    };
  };
  expect(await load()).toEqual({ note: null, tip: null }); // an unborn repo: no note yet
  expect(artifacts.created).toEqual(["/repos/config"]);
  // Save and commit.
  await itx.invoke([
    "itx",
    "workspaces",
    ["get", WORKSPACE],
    ["writeFile", FILE, "# log\n- one\n"],
  ]);
  const committed = await itx.invoke([
    "itx",
    "workspaces",
    ["get", WORKSPACE],
    ["gitCommit", { message: "notes: save", scope: REPO }],
  ]);
  expect(committed).toMatchObject({ mount: REPO, repo: REPO, changedPaths: [FILE] });
  expect(artifacts.snapshot("/repos/config")?.files).toEqual({ "notes/log.md": "# log\n- one\n" });
  // The next load reads the committed file at the new tip; nothing more was appended by the loads.
  expect(await load()).toEqual({ note: "# log\n- one\n", tip: committed.commitOid });
  expect(types(await readAll(itx.cd(REPO)))).toEqual([
    "repos/create-requested",
    "repos/created",
    "repo/commit-completed",
  ]);
  // Saving the same text again commits nothing.
  await itx.invoke([
    "itx",
    "workspaces",
    ["get", WORKSPACE],
    ["writeFile", FILE, "# log\n- one\n"],
  ]);
  expect(
    await itx.invoke([
      "itx",
      "workspaces",
      ["get", WORKSPACE],
      ["gitCommit", { message: "notes: save", scope: REPO }],
    ]),
  ).toMatchObject({ commitOid: committed.commitOid, changedPaths: [] });
  expect(
    (await itx.invoke(["itx", "repos", ["get", REPO], ["log"]])).map((c: FakeCommit) => c.message),
  ).toEqual(["notes: save"]);
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
      expect((await itx.cfArtifacts.snapshot("/repos/config")).files).toEqual({
        "notes/log.md": "# log\n",
        "worker.ts": "export default 2;\n",
      }); // the physical tier agrees
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
      await itx.cfArtifacts.delete("/repos/config"); // teardown — the repo, by its path
    }
  },
  120_000,
);
