// repos.e2e.test.ts — `itx.repos.get(name)`: A REPO AS A DOMAIN OBJECT — the `repo` facet
// (src/repo/durable-object.ts) on the context at `/repos/<name>`, hosted by the library root
// (src/library.ts) on its first call. Its creation is a SAGA on its own path, as in apps/os:
// `create()` appends `repos/create-requested`; the processor's effect provisions the Artifacts repo
// and lands the terminal `repos/created` — the birth certificate, cross-posted to `/`, where the
// `project` facet (src/project/) folds every certificate into the catalog `itx.repos.list()` reads —
// or `repos/create-failed`, which `create()` throws and a later `create()` retries as a new attempt.
// Every commit that lands through it is a `repo/commit-completed` fact on its path; and it keeps THE
// TIP CACHE — the tip's snapshot in its own SQLite, validated with one `itx.git.tip` per call and
// re-fetched only when the tip moved, updated in place by its own commits.
// Locally the physical tier is a FAKE lent to the repo's context (`provide("itx.git", …)`); against
// the deployed worker the last test runs the story on real Artifacts.

import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, rejection } from "./support/client.ts";
import { FakeGit, type FakeCommit } from "./support/fake-git.ts";
import { deployedOnly } from "./support/project-host.ts";

const CREATED = "events.iterate.com/repos/created";
const COMMITTED = "events.iterate.com/repo/commit-completed";
const types = (log: { type: string }[]) =>
  log
    .filter((e) => e.type.startsWith("events.iterate.com/repo"))
    .map((e) => e.type.replace("events.iterate.com/", ""));

test("the creation saga: create() requests, the effect provisions and lands the certificate on the repo's path AND on /, the catalog lists it; a read of an unrequested repo births nothing", async () => {
  const itx = openItx(freshCtx("repo"));
  const git = new FakeGit({});
  await itx.cd("/repos/config").provide("itx.git", git);
  const repo = itx.repos.get("config");

  expect(await itx.repos.list()).toEqual([]); // the project facet on /, hosted by this read: empty
  expect(await repo.tip()).toBeNull(); // addressing and reading birth nothing
  expect(await repo.readFile("worker.ts")).toBeNull();
  expect((await readAll(itx.cd("/repos/config"))).filter((e) => e.type === CREATED)).toHaveLength(
    0,
  );

  expect(await repo.create()).toEqual({ name: "config", path: "/repos/config" });
  expect(git.created).toEqual(["config"]);
  const own = await readAll(itx.cd("/repos/config"));
  expect(types(own)).toEqual(["repos/create-requested", "repos/created"]); // the saga, on the repo's path
  expect(own.filter((e) => e.type === CREATED).map((e) => e.payload)).toEqual([
    { name: "config", path: "/repos/config" },
  ]);
  const root = await readAll(itx);
  expect(types(root)).toEqual(["repos/created"]); // only the certificate crosses to /
  expect(root.filter((e) => e.type === CREATED).map((e) => e.payload)).toEqual([
    { name: "config", path: "/repos/config" },
  ]);
  expect(await itx.repos.list()).toEqual([
    { name: "config", path: "/repos/config", createdAt: expect.any(String) },
  ]);
  expect(await itx.cd("/repos/config").facets.get("repo").snapshot()).toMatchObject({
    state: { creation: "created", attempts: 1, error: null, tip: null, commits: 0 },
  });

  await repo.create(); // created once: a second create() answers at once, appends nothing
  expect(types(await readAll(itx.cd("/repos/config")))).toEqual([
    "repos/create-requested",
    "repos/created",
  ]);
  expect(types(await readAll(itx))).toEqual(["repos/created"]);
  expect(await itx.repos.list()).toHaveLength(1);
});

test("the saga's failure: provisioning fails, create-failed lands on the repo's path and create() throws it; the next create() is a new attempt that succeeds", async () => {
  const itx = openItx(freshCtx("repo"));
  const git = new FakeGit({});
  git.failCreates = 1;
  await itx.cd("/repos/flaky").provide("itx.git", git);
  const repo = itx.repos.get("flaky");

  expect((await rejection(repo.create())).message).toMatch(/creation failed — artifacts down/);
  expect(types(await readAll(itx.cd("/repos/flaky")))).toEqual([
    "repos/create-requested",
    "repos/create-failed",
  ]);
  expect(types(await readAll(itx))).toEqual([]); // no certificate crossed: the catalog is empty
  expect(await itx.repos.list()).toEqual([]);
  expect(await itx.cd("/repos/flaky").facets.get("repo").snapshot()).toMatchObject({
    state: { creation: "failed", attempts: 1, error: "artifacts down" },
  });

  expect(await repo.create()).toEqual({ name: "flaky", path: "/repos/flaky" }); // attempt 2
  expect(types(await readAll(itx.cd("/repos/flaky")))).toEqual([
    "repos/create-requested",
    "repos/create-failed",
    "repos/create-requested",
    "repos/created",
  ]);
  expect(types(await readAll(itx))).toEqual(["repos/created"]);
  expect(await itx.cd("/repos/flaky").facets.get("repo").snapshot()).toMatchObject({
    state: { creation: "created", attempts: 2, error: null },
  });
});

test("commits through the facet: commit-completed on the repo's path; the tip cache is updated in place, a push from outside is seen on the next read", async () => {
  const itx = openItx(freshCtx("repo"));
  const git = new FakeGit({});
  await itx.cd("/repos/config").provide("itx.git", git);
  const repo = itx.repos.get("config");

  const first = await repo.writeFile("worker.ts", "export default 1;\n"); // the first commit runs the saga too
  expect(first).toEqual({ commitOid: git.tip("config"), changedPaths: ["worker.ts"] });
  expect(types(await readAll(itx))).toEqual(["repos/created"]);
  const committed = (await readAll(itx.cd("/repos/config"))).filter((e) => e.type === COMMITTED);
  expect(committed.map((e) => e.payload)).toEqual([
    {
      commitOid: first.commitOid,
      parentOid: null,
      message: "write worker.ts",
      changedPaths: ["worker.ts"],
    },
  ]);

  // Read-your-writes from the cache: the tip matches, no snapshot is fetched.
  expect(await repo.readFile("worker.ts")).toBe("export default 1;\n");
  expect(await repo.listFiles()).toEqual({ commitOid: first.commitOid, paths: ["worker.ts"] });
  expect(git.snapshots).toBe(0);

  // A push from OUTSIDE the facet moves the tip: the next read sees it, with ONE snapshot.
  git.commitFiles("config", { message: "outside", changes: [{ path: "b.txt", content: "b" }] });
  expect(await repo.listFiles()).toEqual({
    commitOid: git.tip("config"),
    paths: ["b.txt", "worker.ts"],
  });
  expect(await repo.readFile("b.txt")).toBe("b");
  expect(git.snapshots).toBe(1);

  // A batch through the facet: deletes before writes, the cache updated in place again.
  const second = await repo.commitFiles({
    message: "swap",
    changes: [
      { path: "c.txt", content: "c" },
      { path: "worker.ts", delete: true },
    ],
  });
  expect(second.changedPaths).toEqual(["worker.ts", "c.txt"]);
  expect(await repo.listFiles()).toEqual({
    commitOid: second.commitOid,
    paths: ["b.txt", "c.txt"],
  });
  expect(await repo.readFile("worker.ts")).toBeNull();
  expect(git.snapshots).toBe(1);
  expect((await repo.log()).map((c: FakeCommit) => c.message)).toEqual([
    "swap",
    "outside",
    "write worker.ts",
  ]);
  expect(await itx.cd("/repos/config").facets.get("repo").snapshot()).toMatchObject({
    state: { creation: "created", tip: second.commitOid, commits: 2 },
  });
  // A write from OUTSIDE that lands between the facet's refresh and its push: the adapter refuses
  // the stale tip, the facet refreshes (one snapshot) and retries — the cache holds BOTH writes.
  git.driftOnNextCommit = { path: "d.txt", content: "drifted" };
  const third = await repo.writeFile("e.txt", "e");
  expect(third.changedPaths).toEqual(["e.txt"]);
  expect(git.snapshots).toBe(2);
  expect(await repo.listFiles()).toEqual({
    commitOid: third.commitOid,
    paths: ["b.txt", "c.txt", "d.txt", "e.txt"],
  });
  expect(await repo.readFile("d.txt")).toBe("drifted");
  expect(git.snapshots).toBe(2);
  // A batch that changes nothing commits nothing and appends nothing.
  expect(
    await repo.commitFiles({ message: "noop", changes: [{ path: "c.txt", content: "c" }] }),
  ).toEqual({
    commitOid: third.commitOid,
    changedPaths: [],
  });
  expect((await readAll(itx.cd("/repos/config"))).filter((e) => e.type === COMMITTED)).toHaveLength(
    3,
  );
});

deployedOnly(
  "against real Artifacts: born through the facet, a nested commit, the cache, the catalog",
  async () => {
    const itx = openItx(freshCtx("realrepo"));
    try {
      const repo = itx.repos.get("config");
      expect(await repo.create()).toEqual({ name: "config", path: "/repos/config" });
      expect(types(await readAll(itx.cd("/repos/config")))).toEqual([
        "repos/create-requested",
        "repos/created",
      ]);
      expect((await itx.cfArtifacts.list()).repos).toEqual([{ name: "config" }]);
      expect(await repo.tip()).toBeNull(); // unborn main
      const first = await repo.commitFiles({
        message: "first",
        changes: [
          { path: "worker.ts", content: "export default 1;\n" },
          { path: "notes/log.md", content: "# log\n" },
        ],
      });
      expect(first.changedPaths).toEqual(["worker.ts", "notes/log.md"]);
      expect(await repo.tip()).toBe(first.commitOid);
      expect(await repo.readFile("notes/log.md")).toBe("# log\n");
      expect(await repo.listFiles()).toEqual({
        commitOid: first.commitOid,
        paths: ["notes/log.md", "worker.ts"],
      });
      expect(await itx.git.readFile("config", "notes/log.md")).toBe("# log\n"); // the physical tier agrees
      expect((await repo.log()).map((c: FakeCommit) => c.message)).toEqual(["first"]);
      expect(await itx.repos.list()).toEqual([
        { name: "config", path: "/repos/config", createdAt: expect.any(String) },
      ]);
    } finally {
      await itx.cfArtifacts.delete("config");
    }
  },
  120_000,
);
