import { expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

/**
 * The repo lazy lane through the REAL stack: itx → repo Durable Object →
 * Artifacts remote. Proves the invariants the unit fakes cannot: the pushed
 * pack round-trips the actual gitty server, read-your-write holds at the
 * itx surface, and the clone-backed lanes (edit, log) and the lazy lanes
 * (commitFiles, readFile, listFiles) observe ONE consistent history.
 */
test("lazy commits, reads, and clone-lane writes share one history", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`repo-lazy-${crypto.randomUUID()}`).create({});

  await waitForCondition(
    async () => {
      const read = await project.repo.readFile({ path: "package.json" }).catch(() => null);
      return read !== null;
    },
    { description: "config repo to be seeded", intervalMs: 1_000, timeoutMs: 60_000 },
  );

  // -- one batched commit: adds (nested + duplicate contents + binary), a delete
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  const batch = await project.repo.commitFiles({
    message: "lazy e2e batch",
    changes: [
      { path: "tasks/alpha.md", content: "# alpha\n" },
      { path: "tasks/beta.md", content: "# alpha\n" }, // identical content — one blob
      { path: "deep/nested/dir/tasks/gamma.md", content: "# gamma\n" },
      { path: "assets/pixel.bin", contentBase64: btoa(String.fromCharCode(...bytes)) },
      { path: "README.md", delete: true },
    ],
  });
  expect(batch).toMatchObject({
    changedPaths: expect.arrayContaining([
      "tasks/alpha.md",
      "deep/nested/dir/tasks/gamma.md",
      "README.md",
    ]),
    noChanges: false,
  });

  // -- read-your-write at the itx surface, immediately
  const [alpha, gamma, gone, pixel] = await Promise.all([
    project.repo.readFile({ path: "tasks/alpha.md" }),
    project.repo.readFile({ path: "deep/nested/dir/tasks/gamma.md" }),
    project.repo.readFile({ path: "README.md" }),
    project.repo.readFile({ path: "assets/pixel.bin", encoding: "base64" }),
  ]);
  expect(alpha?.content).toBe("# alpha\n");
  expect(alpha?.commitOid).toBe(batch.commitOid);
  expect(gamma?.content).toBe("# gamma\n");
  expect(gone).toBeNull();
  expect(pixel?.content).toBe(btoa(String.fromCharCode(...bytes)));

  const listing = await project.repo.listFiles();
  expect(listing).toMatchObject({
    commitOid: batch.commitOid,
    paths: expect.arrayContaining(["tasks/alpha.md", "tasks/beta.md"]),
  });
  expect(listing.paths).not.toContain("README.md");

  // -- a second lazy commit stacks on the first
  const second = await project.repo.commitFiles({
    message: "lazy e2e second",
    changes: [
      { path: "tasks/alpha.md", content: "# alpha v2\n" },
      { path: "tasks/beta.md", delete: true },
    ],
  });
  expect((await project.repo.readFile({ path: "tasks/alpha.md" }))?.content).toBe("# alpha v2\n");
  expect(await project.repo.readFile({ path: "tasks/beta.md" })).toBeNull();

  // -- the clone-backed lanes see the lazy history…
  const log = await project.repo.log({ limit: 3 });
  expect(log.commits[0]?.oid).toBe(second.commitOid);
  expect(log.commits[0]?.message).toContain("lazy e2e second");
  expect(log.commits[1]?.oid).toBe(batch.commitOid);

  // -- …and a clone-lane WRITE (edit) interleaves cleanly with lazy reads.
  const edited = await project.repo.edit({
    path: "tasks/alpha.md",
    oldString: "# alpha v2",
    newString: "# alpha v3 (edited via the clone lane)",
    message: "clone-lane edit",
  });
  expect(edited).toMatchObject({ noChanges: false });
  const afterEdit = await project.repo.readFile({ path: "tasks/alpha.md" });
  expect(afterEdit?.content).toBe("# alpha v3 (edited via the clone lane)\n");
  expect(afterEdit?.commitOid).toBe(edited.commitOid);

  // -- and one more lazy commit on top of the clone-lane head.
  const third = await project.repo.commitFiles({
    message: "lazy after clone-lane edit",
    changes: [{ path: "tasks/alpha.md", content: "# alpha v4\n" }],
  });
  expect((await project.repo.readFile({ path: "tasks/alpha.md" }))?.content).toBe("# alpha v4\n");
  expect((await project.repo.log({ limit: 1 })).commits[0]?.oid).toBe(third.commitOid);
});
