// repos.e2e.test.ts — `itx.repos.get(path)`: A REPO AS A DOMAIN OBJECT — the `repo` facet
// (src/repo/durable-object.ts) on the context at any path (`/repos/<name>` is the convention, not a
// rule; the Artifacts repo's name derives from the path), hosted by the library root (src/library.ts)
// on its first call. `create()` lands `repos/create-requested` on its path, provisions the Artifacts
// repo, and lands `repos/created` — the birth certificate, cross-posted to `/`, where the `project`
// facet (src/project/) folds every certificate into the catalog `itx.repos.list()` reads — or
// `repos/create-failed`, thrown; a later `create()` is a new attempt. Every other method refuses until
// then. Every commit that lands through it is a `repo/commit-completed` fact on its path; the tip's
// snapshot is memoized under its oid — one `itx.git.tip` per read, the pack only when the tip moved.
// Locally the physical tier is a FAKE lent to the repo's context (`provide("itx.git", …)`); against
// the deployed worker the last test runs the story on real Artifacts.

import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, rejection } from "./support/client.ts";
import { FakeGit, type FakeCommit } from "./support/fake-git.ts";
import { deployedOnly } from "./support/project-host.ts";

const CREATED = "events.iterate.com/repos/created";
const COMMITTED = "events.iterate.com/repo/commit-completed";
/** A log as its repo facts' short type names, in order. */
const types = (log: { type: string }[]) =>
  log
    .filter((e) => e.type.startsWith("events.iterate.com/repo"))
    .map((e) => e.type.replace("events.iterate.com/", ""));

test("create() lands the request and the certificate on the repo's path AND on /, the catalog lists it; a repo not created refuses; any path can host one", async () => {
  const itx = openItx(freshCtx("repo"));
  const git = new FakeGit({});
  await itx.cd("/repos/config").provide("itx.git", git);
  const repo = itx.repos.get("/repos/config");

  expect(await itx.repos.list()).toEqual([]); // the project facet on /, hosted by this read: empty
  expect((await rejection(repo.tip())).message).toMatch(/not created — call create\(\) first/);
  expect((await rejection(repo.readFile("worker.ts"))).message).toMatch(/not created/);
  expect((await readAll(itx.cd("/repos/config"))).filter((e) => e.type === CREATED)).toHaveLength(
    0,
  );

  expect(await repo.create()).toEqual({ path: "/repos/config" });
  expect(git.created).toEqual(["repos--config"]); // the path's Artifacts name
  const own = await readAll(itx.cd("/repos/config"));
  expect(types(own)).toEqual(["repos/create-requested", "repos/created"]);
  expect(own.filter((e) => e.type === CREATED).map((e) => e.payload)).toEqual([
    { path: "/repos/config" },
  ]);
  const root = await readAll(itx);
  expect(types(root)).toEqual(["repos/created"]); // only the certificate crosses to /
  expect(root.filter((e) => e.type === CREATED).map((e) => e.payload)).toEqual([
    { path: "/repos/config" },
  ]);
  expect(await itx.repos.list()).toEqual([
    { path: "/repos/config", createdAt: expect.any(String) },
  ]);
  expect(await itx.cd("/repos/config").facets.get("repo").snapshot()).toMatchObject({
    state: { path: "/repos/config", creation: "created", error: null },
  });

  await repo.create(); // created once: a second create() answers at once, appends nothing
  expect(types(await readAll(itx.cd("/repos/config")))).toEqual([
    "repos/create-requested",
    "repos/created",
  ]);
  expect(types(await readAll(itx))).toEqual(["repos/created"]);
  expect(await itx.repos.list()).toHaveLength(1);

  // Any path can host a repo — /repos/ is the convention, not a rule.
  await itx.cd("/vendor/lib").provide("itx.git", git);
  expect(await itx.repos.get("/vendor/lib").create()).toEqual({ path: "/vendor/lib" });
  expect(git.created).toEqual(["repos--config", "vendor--lib"]);
  expect((await itx.repos.list()).map((r: { path: string }) => r.path)).toEqual([
    "/repos/config",
    "/vendor/lib",
  ]);
});

test("provisioning fails: create-failed lands on the repo's path and create() throws it; the next create() is a new attempt that succeeds", async () => {
  const itx = openItx(freshCtx("repo"));
  const git = new FakeGit({});
  git.failCreates = 1;
  await itx.cd("/repos/flaky").provide("itx.git", git);
  const repo = itx.repos.get("/repos/flaky");

  expect((await rejection(repo.create())).message).toMatch(/creation failed — artifacts down/);
  expect(types(await readAll(itx.cd("/repos/flaky")))).toEqual([
    "repos/create-requested",
    "repos/create-failed",
  ]);
  expect(types(await readAll(itx))).toEqual([]); // no certificate crossed: the catalog is empty
  expect(await itx.repos.list()).toEqual([]);
  expect((await rejection(repo.tip())).message).toMatch(/not created/);
  expect(await itx.cd("/repos/flaky").facets.get("repo").snapshot()).toMatchObject({
    state: { creation: "failed", error: "artifacts down" },
  });

  expect(await repo.create()).toEqual({ path: "/repos/flaky" }); // a new attempt
  expect(types(await readAll(itx.cd("/repos/flaky")))).toEqual([
    "repos/create-requested",
    "repos/create-failed",
    "repos/create-requested",
    "repos/created",
  ]);
  expect(types(await readAll(itx))).toEqual(["repos/created"]);
  expect(await itx.cd("/repos/flaky").facets.get("repo").snapshot()).toMatchObject({
    state: { creation: "created", error: null },
  });
});

test("commits through the facet: commit-completed on the repo's path; the memo fetches the tip once after a commit and once when a push from outside moved it", async () => {
  const itx = openItx(freshCtx("repo"));
  const git = new FakeGit({});
  await itx.cd("/repos/config").provide("itx.git", git);
  const repo = itx.repos.get("/repos/config");
  await repo.create();

  const first = await repo.writeFile("worker.ts", "export default 1;\n");
  expect(first).toEqual({ commitOid: git.tip("repos--config"), changedPaths: ["worker.ts"] });
  const committed = (await readAll(itx.cd("/repos/config"))).filter((e) => e.type === COMMITTED);
  expect(committed.map((e) => e.payload)).toEqual([
    { commitOid: first.commitOid, message: "write worker.ts", changedPaths: ["worker.ts"] },
  ]);

  // The first read after a commit fetches the tip; reads at the same tip fetch nothing more.
  expect(await repo.readFile("worker.ts")).toBe("export default 1;\n");
  expect(await repo.listFiles()).toEqual({ commitOid: first.commitOid, paths: ["worker.ts"] });
  expect(await repo.tip()).toBe(first.commitOid);
  expect(git.snapshots).toBe(1);

  // A push from OUTSIDE the facet moves the tip: the next read sees it, with ONE more fetch.
  git.commitFiles("repos--config", {
    message: "outside",
    changes: [{ path: "b.txt", content: "b" }],
  });
  expect(await repo.listFiles()).toEqual({
    commitOid: git.tip("repos--config"),
    paths: ["b.txt", "worker.ts"],
  });
  expect(await repo.readFile("b.txt")).toBe("b");
  expect(git.snapshots).toBe(2);

  // A batch through the facet: deletes before writes; the memo is dropped, the next read re-fetches.
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
  expect(git.snapshots).toBe(3);
  expect((await repo.log()).map((c: FakeCommit) => c.message)).toEqual([
    "swap",
    "outside",
    "write worker.ts",
  ]);

  // A batch that changes nothing commits nothing and appends nothing.
  expect(
    await repo.commitFiles({ message: "noop", changes: [{ path: "c.txt", content: "c" }] }),
  ).toEqual({ commitOid: second.commitOid, changedPaths: [] });
  expect((await readAll(itx.cd("/repos/config"))).filter((e) => e.type === COMMITTED)).toHaveLength(
    2,
  );
});

deployedOnly(
  "against real Artifacts: created, a nested commit, the memo, the catalog",
  async () => {
    const itx = openItx(freshCtx("realrepo"));
    try {
      const repo = itx.repos.get("/repos/config");
      expect(await repo.create()).toEqual({ path: "/repos/config" });
      expect(types(await readAll(itx.cd("/repos/config")))).toEqual([
        "repos/create-requested",
        "repos/created",
      ]);
      expect((await itx.cfArtifacts.list()).repos).toEqual([{ name: "repos--config" }]);
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
      expect(await itx.git.snapshot("repos--config")).toEqual({
        commitOid: first.commitOid,
        files: { "worker.ts": "export default 1;\n", "notes/log.md": "# log\n" },
      }); // the physical tier agrees
      expect((await repo.log()).map((c: FakeCommit) => c.message)).toEqual(["first"]);
      expect(await itx.repos.list()).toEqual([
        { path: "/repos/config", createdAt: expect.any(String) },
      ]);
    } finally {
      await itx.cfArtifacts.delete("repos--config");
    }
  },
  120_000,
);
