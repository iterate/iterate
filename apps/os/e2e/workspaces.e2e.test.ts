// workspaces.e2e.test.ts — THE WORKSPACE of any context, at most one per path: the `workspace` facet
// (src/workspace/durable-object.ts) on `itx.cd(path)`, addressed as `itx.workspaces.get(path)`
// (src/library.ts, nothing appended to get it) and born through the collection,
// `itx.workspaces.create(path)` (src/project/collection.ts): it enables the `workspace` processor
// row on that path (a `stream/subscription-configured` fact), lands `workspace/create-requested` there
// and waits for the terminal fact. The processor (src/workspace/processor.ts) runs the saga from state
// at head — nothing to provision, so it lands `workspace/created`, the birth certificate, on `/` (the
// catalog `itx.workspaces.list()` reads) and on the path; a create on a created workspace answers at
// once, appending nothing, and every other method refuses until the certificate. The facet is ONE
// private overlay over the mount table — every repo in the project catalog at its own path
// (`itx.repos.list()`); reads fall through to a mount's repo facet at its tip; a write shadows until
// `gitCommit` lands ONE mount's changes on its repo's `main`; a delete is a whiteout until then;
// `/workspace/…` is scratch — never committed. Locally the physical tier is a fake git REMOTE
// (support/fake-git-server.ts) behind a FAKE `itx.cfArtifacts` proxy lent to each repo's context
// (support/fake-artifacts.ts), keyed by the repo's PATH as the real one is — the repo facet speaks
// the real wire codec to it. Those rows are `localOnly` — the fake remote listens on THIS machine's
// loopback, which a deployed worker's egress cannot reach (403); against the deployed worker the
// last test runs the same story on real Artifacts (`WORKER_BASE_URL=https://os.iterate.com pnpm e2e
// workspaces`).

import { expect, test } from "vitest";
import { freshCtx, openItx, processorNames, readAll, rejection } from "./support/client.ts";
import { FakeArtifacts, type FakeCommit } from "./support/fake-artifacts.ts";
import { localOnly } from "./support/project-host.ts";

/** A log as its repo facts' short type names, in order (the processor row, a `stream/…` fact, is
 *  not one). */
const types = (log: { type: string }[]) =>
  log
    .filter((e) => e.type.startsWith("events.iterate.com/repo"))
    .map((e) => e.type.replace("events.iterate.com/", ""));
/** The same for the workspace's own facts. */
const workspaceTypes = (log: { type: string }[]) =>
  log
    .filter((e) => e.type.startsWith("events.iterate.com/workspace"))
    .map((e) => e.type.replace("events.iterate.com/", ""));

const SEED = { "/repos/config": { "worker.ts": "export default 1;\n", "notes/log.md": "# log\n" } };

/** A fresh project whose repos (seeded by PATH) are CREATED over one fake `itx.cfArtifacts` lent to
 *  each repo's context, and the workspace at `/workspaces/<name>`, created too. */
async function workspaceOverFakeArtifacts(
  name: string,
  seed: Record<string, Record<string, string>> = SEED,
) {
  const itx = openItx(freshCtx("ws"));
  const artifacts = await FakeArtifacts.start(seed);
  for (const path of Object.keys(seed)) {
    await itx.cd(path).provide("itx.cfArtifacts", artifacts);
    await itx.repos.create(path);
  }
  await itx.workspaces.create(`/workspaces/${name}`);
  const workspace = itx.workspaces.get(`/workspaces/${name}`);
  return { itx, artifacts, workspace };
}

localOnly(
  "reads fall through to the mounted repo at its tip; a write shadows; the merged listing and the status say which is which",
  async () => {
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
  },
);

localOnly(
  "gitCommit lands one mount's changes as ONE commit on its repo and clears the overlay; the fall-through then reads the new tip; gitLog shows it",
  async () => {
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
    expect(artifacts.remoteFiles("/repos/config")).toEqual({ "notes/log.md": "# log\n- one\n" }); // the remote agrees
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
  },
);

localOnly(
  "deleteFile whites a repo file out until committed; revert lifts the whiteout, and a shadowing write",
  async () => {
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
  },
);

test("itx.workspaces.create(path) lands the request and ONE certificate on its path, the same certificate on /, and the catalog lists it; a workspace not created refuses before it stores anything", async () => {
  const { itx } = await workspaceOverFakeArtifacts("four");
  const events = await readAll(itx.cd("/workspaces/four"));
  const born = (log: { type: string; payload?: unknown }[]) =>
    log.filter((e) => e.type === "events.iterate.com/workspace/created").map((e) => e.payload);
  expect(born(events)).toEqual([{ path: "/workspaces/four" }]);
  expect(
    events.filter((e) => e.type === "events.iterate.com/workspace/create-requested"),
  ).toHaveLength(1);
  // The processor row `create` enabled, on the path, named after the facet.
  expect(
    events
      .filter((e) => e.type === "events.iterate.com/stream/subscription-configured")
      .map((e) => e.payload?.name),
  ).toEqual(["workspace"]);
  // The state references the certificate by OFFSET, never by copied payload.
  expect(await itx.cd("/workspaces/four").facets.get("workspace").snapshot()).toMatchObject({
    state: {
      creation: {
        status: "created",
        offset: events.find((e) => e.type === "events.iterate.com/workspace/created").offset,
      },
    },
  });
  expect(born(await readAll(itx))).toEqual([{ path: "/workspaces/four" }]);
  expect(await itx.workspaces.list()).toEqual([
    { path: "/workspaces/four", createdAt: expect.any(String) },
  ]);
  expect((await itx.repos.list()).map((r: { path: string }) => r.path)).toEqual(["/repos/config"]);
  // Created once: a second create answers at once, appends nothing.
  expect(await itx.workspaces.create("/workspaces/four")).toEqual({ path: "/workspaces/four" });
  expect(await readAll(itx.cd("/workspaces/four"))).toHaveLength(events.length);

  const never = itx.workspaces.get("/workspaces/never");
  expect((await rejection(never.readFile("/x"))).message).toMatch(
    /not created — itx\.workspaces\.create\("\/workspaces\/never"\) first/,
  );
  expect((await rejection(never.writeFile("/x", "x"))).message).toMatch(/not created/);
  expect((await rejection(never.gitStatus())).message).toMatch(/not created/);
  expect(
    (await readAll(itx.cd("/workspaces/never"))).filter((e) =>
      e.type.startsWith("events.iterate.com/workspace/"),
    ),
  ).toEqual([]);
});

localOnly(
  "a repo beneath another's path wins beneath it: the listing, reads and status route to the longest mount; a commit never spans mounts",
  async () => {
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
      (await workspace.gitStatus()).mounts.map(
        (m: { path: string; changes: { path: string }[] }) => [
          m.path,
          m.changes.map((c) => c.path),
        ],
      ),
    ).toEqual([
      ["/repos/config", ["/repos/config/b.txt"]],
      ["/repos/config/vendor", ["/repos/config/vendor/z.txt"]],
    ]);
    expect((await rejection(workspace.gitCommit({ message: "both" }))).message).toMatch(
      /span 2 mounts/,
    );
    const commit = await workspace.gitCommit({ message: "z", scope: "/repos/config/vendor" });
    expect(commit.changedPaths).toEqual(["/repos/config/vendor/z.txt"]);
    expect(artifacts.remoteFiles("/repos/config/vendor")).toEqual({
      "y.txt": "from lib",
      "z.txt": "z",
    });
    expect(artifacts.remoteFiles("/repos/config")).toEqual({
      "worker.ts": "w",
      "vendor/x.txt": "from config",
    });
  },
);

localOnly(
  "a workspace is its path: a second session opens the same overlay, uncommitted work included",
  async () => {
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
  },
);

localOnly(
  "the Notes app's story, spelled as apps/notes spells it: create the repo and the workspace (idempotent), read the file through the workspace, write it and commit ONE commit on the repo's main",
  async () => {
    const itx = openItx(freshCtx("notes"));
    const artifacts = await FakeArtifacts.start();
    await itx.cd("/repos/config").provide("itx.cfArtifacts", artifacts);
    const REPO = "/repos/config";
    const WORKSPACE = "/workspaces/notes";
    const FILE = `${REPO}/notes/log.md`;
    // The loader, on every page load — a created repo and workspace answer at once.
    const load = async () => {
      await itx.invoke(["itx", "repos", ["create", REPO]]);
      await itx.invoke(["itx", "workspaces", ["create", WORKSPACE]]);
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
    expect(artifacts.remoteFiles("/repos/config")).toEqual({ "notes/log.md": "# log\n- one\n" });
    // The next load reads the committed file at the new tip; nothing more was appended by the loads.
    expect(await load()).toEqual({ note: "# log\n- one\n", tip: committed.commitOid });
    expect(types(await readAll(itx.cd(REPO)))).toEqual([
      "repo/create-requested",
      "repo/created",
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
      (await itx.invoke(["itx", "repos", ["get", REPO], ["log"]])).map(
        (c: FakeCommit) => c.message,
      ),
    ).toEqual(["notes: save"]);
  },
);

test("against real Artifacts: nested paths through the workspace — a repo file read at the tip, a nested write committed as one commit, a delete committed, the repo's log", async () => {
  const itx = openItx(freshCtx("wsrepo"));
  try {
    await itx.repos.create("/repos/config");
    const repo = itx.repos.get("/repos/config");
    await repo.writeFile("worker.ts", "export default 1;\n");
    await itx.workspaces.create("/workspaces/deployed");
    const workspace = itx.workspaces.get("/workspaces/deployed");
    expect(await workspace.readFile("/repos/config/worker.ts")).toBe("export default 1;\n");
    await workspace.writeFile("/repos/config/notes/log.md", "# log\n");
    await workspace.writeFile("/repos/config/worker.ts", "export default 2;\n");
    const commit = await workspace.gitCommit({ message: "notes" });
    expect(commit.changedPaths).toEqual(["/repos/config/notes/log.md", "/repos/config/worker.ts"]);
    expect(await repo.readFile("notes/log.md")).toBe("# log\n");
    expect(await repo.readFile("worker.ts")).toBe("export default 2;\n"); // the repo, at the new tip, agrees
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
}, 120_000);

test("itx.workspaces.delete(path) lands the request and the death certificate on the workspace's path AND on /, drops the processor row and the overlay with it; the verbs refuse; a second delete answers at once; never created, nothing to delete; deleted, not re-creatable", async () => {
  const itx = openItx(freshCtx("ws"));
  const workspace = itx.workspaces.get("/workspaces/gone");

  expect((await rejection(itx.workspaces.delete("/workspaces/gone"))).message).toMatch(
    /workspace \/workspaces\/gone: not created — nothing to delete/,
  );
  expect(await itx.workspaces.create("/workspaces/gone")).toEqual({ path: "/workspaces/gone" });
  expect(await processorNames(itx.cd("/workspaces/gone"))).toEqual(["workspace"]);
  await workspace.writeFile("/workspace/scratch.md", "mine"); // the overlay holds a row
  expect(await workspace.readFile("/workspace/scratch.md")).toBe("mine");

  expect(await itx.workspaces.delete("/workspaces/gone")).toEqual({ path: "/workspaces/gone" });
  const own = await readAll(itx.cd("/workspaces/gone"));
  expect(workspaceTypes(own)).toEqual([
    "workspace/create-requested",
    "workspace/created",
    "workspace/delete-requested",
    "workspace/deleted",
  ]);
  expect(
    own.filter((e) => e.type === "events.iterate.com/workspace/deleted").map((e) => e.payload),
  ).toEqual([{ path: "/workspaces/gone" }]);
  expect(workspaceTypes(await readAll(itx))).toEqual(["workspace/created", "workspace/deleted"]); // both certificates cross to /
  expect(await processorNames(itx.cd("/workspaces/gone"))).toEqual([]); // the row went
  // The verbs refuse — and the overlay went with the facet: a read tries the overlay BEFORE the
  // guard, so "mine" would have answered had the row survived; it refuses as deleted instead.
  expect((await rejection(workspace.mounts())).message).toMatch(
    /workspace \/workspaces\/gone: deleted/,
  );
  expect((await rejection(workspace.readFile("/workspace/scratch.md"))).message).toMatch(/deleted/);
  expect((await rejection(workspace.writeFile("/workspace/x.md", "x"))).message).toMatch(/deleted/);
  expect(await itx.cd("/workspaces/gone").facets.get("workspace").snapshot()).toMatchObject({
    state: {
      creation: { status: "created" },
      deletion: {
        status: "deleted",
        offset: own.find((e) => e.type === "events.iterate.com/workspace/deleted").offset,
      },
    },
  });
  // Dies once: a second delete answers at once and appends nothing; not re-creatable.
  expect(await itx.workspaces.delete("/workspaces/gone")).toEqual({ path: "/workspaces/gone" });
  expect(await readAll(itx.cd("/workspaces/gone"))).toHaveLength(own.length);
  expect((await rejection(itx.workspaces.create("/workspaces/gone"))).message).toMatch(
    /workspace \/workspaces\/gone: deleted — not re-creatable/,
  );
  expect(await readAll(itx.cd("/workspaces/gone"))).toHaveLength(own.length);
});
