// repos.e2e.test.ts — A REPO AS A DOMAIN OBJECT: the `repo` facet (src/repo/durable-object.ts) on the
// context at any path (`/repos/<name>` is the convention, not a rule; the physical tier,
// `itx.cfArtifacts`, knows the repo by that same path), addressed as `itx.repos.get(path)` (src/library.ts)
// and born through the collection, `itx.repos.create(path)` (src/repo/collection.ts): it enables the
// `repo` processor row on that path (a `stream/subscription-configured` fact), lands
// `repo/create-requested` there and waits for the terminal fact. The processor (src/repo/processor.ts)
// runs the saga from state at head: it provisions the Artifacts repo and lands `repo/created` — the
// birth certificate, cross-posted to `/`, where the `project` facet (src/project/) folds every
// certificate into the catalog `itx.repos.list()` reads — or `repo/create-failed` (the error the
// Artifacts proxy threw), which `create` throws; a later `create` is a new attempt, and one on a
// created repo answers at once, appending nothing. Every other method refuses until the certificate.
// Every commit that lands through the facet is a `repo/commit-completed` fact on its path. The facet
// is the ONLY thing that speaks git (git protocol v2 over HTTP, src/repo/git-wire.ts): `itx.cfArtifacts`
// — the binding proxy, by the same path — hands it a token and the remote URL; the tip's snapshot is
// memoized under its oid — one `ls-refs` per read, the pack only when the tip moved. Locally the
// physical tier is a fake git REMOTE (support/fake-git-server.ts) behind a fake `itx.cfArtifacts`
// proxy lent to the repo's context (`provide("itx.cfArtifacts", …)`, support/fake-artifacts.ts), so
// the real wire codec runs locally too. A row that reads or commits through git is `localOnly`: the
// fake remote listens on THIS machine's loopback, which a deployed worker's egress cannot reach (403);
// rows that only touch the proxy still run deployed (the fake proxy is called back over the
// WebSocket), and the last test runs the story on real Artifacts, `deployedOnly`.

import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, rejection } from "./support/client.ts";
import { FakeArtifacts, type FakeCommit } from "./support/fake-artifacts.ts";
import { deployedOnly, localOnly } from "./support/project-host.ts";

const CREATED = "events.iterate.com/repo/created";
const FAILED = "events.iterate.com/repo/create-failed";
const COMMITTED = "events.iterate.com/repo/commit-completed";
/** A log as its repo facts' short type names, in order (the processor row, a `stream/…` fact, is
 *  not one). */
const types = (log: { type: string }[]) =>
  log
    .filter((e) => e.type.startsWith("events.iterate.com/repo"))
    .map((e) => e.type.replace("events.iterate.com/", ""));

test("itx.repos.create(path) lands the request and the certificate on the repo's path AND on /, the catalog lists it; a repo not created refuses; any path can host one", async () => {
  const itx = openItx(freshCtx("repo"));
  const artifacts = await FakeArtifacts.start();
  await itx.cd("/repos/config").provide("itx.cfArtifacts", artifacts);
  const repo = itx.repos.get("/repos/config");

  expect(await itx.repos.list()).toEqual([]); // the project facet on /, hosted by this read: empty
  expect((await rejection(repo.tip())).message).toMatch(
    /not created — itx\.repos\.create\("\/repos\/config"\) first/,
  );
  expect((await rejection(repo.readFile("worker.ts"))).message).toMatch(/not created/);
  expect((await readAll(itx.cd("/repos/config"))).filter((e) => e.type === CREATED)).toHaveLength(
    0,
  );

  expect(await itx.repos.create("/repos/config")).toEqual({ path: "/repos/config" });
  expect(artifacts.created).toEqual(["/repos/config"]); // by its path
  const own = await readAll(itx.cd("/repos/config"));
  expect(types(own)).toEqual(["repo/create-requested", "repo/created"]);
  // The processor row `create` enabled, on the path, named after the facet.
  expect(
    own
      .filter((e) => e.type === "events.iterate.com/stream/subscription-configured")
      .map((e) => e.payload?.name),
  ).toEqual(["repo"]);
  expect(own.filter((e) => e.type === CREATED).map((e) => e.payload)).toEqual([
    { path: "/repos/config" },
  ]);
  const root = await readAll(itx);
  expect(types(root)).toEqual(["repo/created"]); // only the certificate crosses to /
  expect(root.filter((e) => e.type === CREATED).map((e) => e.payload)).toEqual([
    { path: "/repos/config" },
  ]);
  expect(await itx.repos.list()).toEqual([
    { path: "/repos/config", createdAt: expect.any(String) },
  ]);
  // The state references the certificate by OFFSET, never by copied payload.
  expect(await itx.cd("/repos/config").facets.get("repo").snapshot()).toMatchObject({
    state: { creation: { status: "created", offset: own.find((e) => e.type === CREATED).offset } },
  });

  // Created once: a second create answers at once, appends nothing.
  expect(await itx.repos.create("/repos/config")).toEqual({ path: "/repos/config" });
  expect(await readAll(itx.cd("/repos/config"))).toHaveLength(own.length);
  expect(types(await readAll(itx))).toEqual(["repo/created"]);
  expect(await itx.repos.list()).toHaveLength(1);

  // Any path can host a repo — /repos/ is the convention, not a rule.
  await itx.cd("/vendor/lib").provide("itx.cfArtifacts", artifacts);
  expect(await itx.repos.create("/vendor/lib")).toEqual({ path: "/vendor/lib" });
  expect(artifacts.created).toEqual(["/repos/config", "/vendor/lib"]);
  expect((await itx.repos.list()).map((r: { path: string }) => r.path)).toEqual([
    "/repos/config",
    "/vendor/lib",
  ]);
});

test("provisioning fails: create-failed lands on the repo's path with the proxy's error and create throws it; the next create is a new attempt that succeeds", async () => {
  const itx = openItx(freshCtx("repo"));
  const artifacts = await FakeArtifacts.start();
  artifacts.failCreates = 1;
  await itx.cd("/repos/flaky").provide("itx.cfArtifacts", artifacts);
  const repo = itx.repos.get("/repos/flaky");

  expect((await rejection(itx.repos.create("/repos/flaky"))).message).toMatch(
    /creation failed — artifacts down/,
  );
  const own = await readAll(itx.cd("/repos/flaky"));
  expect(types(own)).toEqual(["repo/create-requested", "repo/create-failed"]);
  // The error is ON the failure event — what the Artifacts proxy threw — never copied into state.
  expect(own.filter((e) => e.type === FAILED).map((e) => e.payload)).toEqual([
    { error: "artifacts down" },
  ]);
  expect(types(await readAll(itx))).toEqual([]); // no certificate crossed: the catalog is empty
  expect(await itx.repos.list()).toEqual([]);
  expect((await rejection(repo.tip())).message).toMatch(/not created/);
  expect(await itx.cd("/repos/flaky").facets.get("repo").snapshot()).toMatchObject({
    state: { creation: { status: "failed", offset: own.find((e) => e.type === FAILED).offset } },
  });

  expect(await itx.repos.create("/repos/flaky")).toEqual({ path: "/repos/flaky" }); // a new attempt
  const retried = await readAll(itx.cd("/repos/flaky"));
  expect(types(retried)).toEqual([
    "repo/create-requested",
    "repo/create-failed",
    "repo/create-requested",
    "repo/created",
  ]);
  expect(types(await readAll(itx))).toEqual(["repo/created"]);
  expect(await itx.cd("/repos/flaky").facets.get("repo").snapshot()).toMatchObject({
    state: {
      creation: { status: "created", offset: retried.find((e) => e.type === CREATED).offset },
    },
  });
});

localOnly(
  "commits through the facet: commit-completed on the repo's path; the memo fetches the tip once after a commit and once when a push from outside moved it",
  async () => {
    const itx = openItx(freshCtx("repo"));
    const artifacts = await FakeArtifacts.start();
    await itx.cd("/repos/config").provide("itx.cfArtifacts", artifacts);
    await itx.repos.create("/repos/config");
    const repo = itx.repos.get("/repos/config");

    // The first commit on an unborn main: an ls-refs, a push — no tip to fetch.
    const first = await repo.writeFile("worker.ts", "export default 1;\n");
    expect(first).toEqual({
      commitOid: artifacts.remoteTip("/repos/config"),
      changedPaths: ["worker.ts"],
    });
    expect(artifacts.remoteFiles("/repos/config")).toEqual({ "worker.ts": "export default 1;\n" }); // the remote agrees
    expect(artifacts.snapshots).toBe(0);
    const committed = (await readAll(itx.cd("/repos/config"))).filter((e) => e.type === COMMITTED);
    expect(committed.map((e) => e.payload)).toEqual([
      { commitOid: first.commitOid, message: "write worker.ts", changedPaths: ["worker.ts"] },
    ]);

    // The first read after a commit fetches the tip; reads at the same tip fetch nothing more (an
    // ls-refs each, which is not a fetch).
    expect(await repo.readFile("worker.ts")).toBe("export default 1;\n");
    expect(await repo.listFiles()).toEqual({ commitOid: first.commitOid, paths: ["worker.ts"] });
    expect(await repo.tip()).toBe(first.commitOid);
    expect(artifacts.snapshots).toBe(1);

    // A push from OUTSIDE the facet moves the tip: the next read sees it, with ONE more fetch.
    const outside = await artifacts.pushFromOutside("/repos/config", {
      message: "outside",
      changes: [{ path: "b.txt", content: "b" }],
    });
    expect(await repo.listFiles()).toEqual({
      commitOid: outside.commitOid,
      paths: ["b.txt", "worker.ts"],
    });
    expect(await repo.readFile("b.txt")).toBe("b");
    expect(artifacts.snapshots).toBe(2);

    // A batch through the facet: deletes before writes. The commit fetches the tip it builds on (the
    // tree its changes apply to) and drops the memo, so the next read fetches the NEW tip; the read
    // after that fetches nothing.
    const second = await repo.commitFiles({
      message: "swap",
      changes: [
        { path: "c.txt", content: "c" },
        { path: "worker.ts", delete: true },
      ],
    });
    expect(second.changedPaths).toEqual(["worker.ts", "c.txt"]);
    expect(second.commitOid).toBe(artifacts.remoteTip("/repos/config"));
    expect(artifacts.snapshots).toBe(3);
    expect(await repo.listFiles()).toEqual({
      commitOid: second.commitOid,
      paths: ["b.txt", "c.txt"],
    });
    expect(await repo.readFile("worker.ts")).toBeNull();
    expect(await repo.readFile("c.txt")).toBe("c");
    expect(artifacts.snapshots).toBe(4);
    expect(artifacts.remoteFiles("/repos/config")).toEqual({ "b.txt": "b", "c.txt": "c" });
    // log is its own shallow fetch, that deep — newest first, the outside commit in its place.
    expect((await repo.log()).map((c: FakeCommit) => c.message)).toEqual([
      "swap",
      "outside",
      "write worker.ts",
    ]);
    expect((await repo.log()).map((c: FakeCommit) => c.parents)).toEqual([
      [outside.commitOid],
      [first.commitOid],
      [],
    ]);

    // A batch that changes nothing commits nothing and appends nothing.
    expect(
      await repo.commitFiles({ message: "noop", changes: [{ path: "c.txt", content: "c" }] }),
    ).toEqual({ commitOid: second.commitOid, changedPaths: [] });
    expect(
      (await readAll(itx.cd("/repos/config"))).filter((e) => e.type === COMMITTED),
    ).toHaveLength(2);
  },
);

deployedOnly(
  "against real Artifacts: created, a nested commit, the memo, the catalog",
  async () => {
    const itx = openItx(freshCtx("realrepo"));
    try {
      expect(await itx.repos.create("/repos/config")).toEqual({ path: "/repos/config" });
      const repo = itx.repos.get("/repos/config");
      expect(types(await readAll(itx.cd("/repos/config")))).toEqual([
        "repo/create-requested",
        "repo/created",
      ]);
      expect((await itx.cfArtifacts.list()).repos).toEqual([{ path: "/repos/config" }]);
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
      expect(await repo.readFile("worker.ts")).toBe("export default 1;\n"); // the nested tree round-trips whole
      expect((await repo.log()).map((c: FakeCommit) => [c.message, c.parents])).toEqual([
        ["first", []],
      ]);
      expect(await itx.repos.list()).toEqual([
        { path: "/repos/config", createdAt: expect.any(String) },
      ]);
    } finally {
      await itx.cfArtifacts.delete("/repos/config");
    }
  },
  120_000,
);
