import { expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test("log, commitDetails and pinned readFile over a few commits", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `repo-history-${crypto.randomUUID()}` });

  // The project repo seeds asynchronously after project creation; readFile
  // THROWS (not null) until the repo artifact exists, so swallow errors
  // while polling.
  await waitForCondition(
    async () => {
      const read = await project.repo.readFile({ path: "package.json" }).catch(() => null);
      return read !== null;
    },
    { description: "project repo to be seeded", intervalMs: 1_000, timeoutMs: 60_000 },
  );

  const first = await project.repo.commitFiles({
    message: "Add notes",
    author: { name: "History Tester", email: "history@example.com" },
    changes: [{ path: "notes.md", content: "one\ntwo\nthree\n" }],
  });
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  const second = await project.repo.commitFiles({
    message: "Edit notes, add a pixel\n\nSecond line of the body.",
    changes: [
      { path: "notes.md", content: "one\nTWO\nthree\nfour\n" },
      { path: "pixel.png", contentBase64: btoa(String.fromCharCode(...png)) },
    ],
  });
  const third = await project.repo.commitFiles({
    message: "Drop notes",
    changes: [{ path: "notes.md", delete: true }],
  });

  // ── log: newest first, parents chain, author + epoch-ms timestamp ──────
  const log = await project.repo.log({});
  expect(log.branch).toBe("main");
  expect(log.commits.length).toBeGreaterThanOrEqual(4); // seed + 3
  expect(log.commits[0]).toMatchObject({
    oid: third.commitOid,
    message: "Drop notes",
    parents: [second.commitOid],
  });
  expect(log.commits[1]).toMatchObject({
    oid: second.commitOid,
    message: "Edit notes, add a pixel\n\nSecond line of the body.",
  });
  expect(log.commits[2]).toMatchObject({
    oid: first.commitOid,
    author: { name: "History Tester", email: "history@example.com" },
  });
  const rootCommit = log.commits[log.commits.length - 1]!;
  expect(rootCommit.parents).toEqual([]);
  // epoch milliseconds, not git's seconds
  expect(log.commits[0]!.timestamp).toBeGreaterThan(Date.now() - 15 * 60_000);
  expect(log.commits[0]!.timestamp).toBeLessThan(Date.now() + 5 * 60_000);

  const limited = await project.repo.log({ limit: 2 });
  expect(limited.commits.map((commit) => commit.oid)).toEqual([third.commitOid, second.commitOid]);

  // ── commitDetails: numstat-shaped stats vs the first parent ────────────
  const secondDetails = await project.repo.commitDetails({ commitOid: second.commitOid });
  expect(secondDetails).toMatchObject({
    oid: second.commitOid,
    parentOid: first.commitOid,
    files: [
      { path: "notes.md", status: "modified", additions: 2, deletions: 1, binary: false },
      { path: "pixel.png", status: "added", additions: 0, deletions: 0, binary: true },
    ],
  });

  const thirdDetails = await project.repo.commitDetails({ commitOid: third.commitOid });
  expect(thirdDetails.files).toEqual([
    { path: "notes.md", status: "deleted", additions: 0, deletions: 4, binary: false },
  ]);

  // Root commit: the whole seeded tree reads as added.
  const rootDetails = await project.repo.commitDetails({ commitOid: rootCommit.oid });
  expect(rootDetails.parentOid).toBeNull();
  expect(rootDetails.files.length).toBeGreaterThan(0);
  expect(rootDetails.files.every((file) => file.status === "added")).toBe(true);

  // ── pinned reads: the diff view's content source ────────────────────────
  const pinnedFirst = await project.repo.readFile({
    path: "notes.md",
    commitOid: first.commitOid,
  });
  expect(pinnedFirst).toMatchObject({
    commitOid: first.commitOid,
    content: "one\ntwo\nthree\n",
  });
  const pinnedSecond = await project.repo.readFile({
    path: "notes.md",
    commitOid: second.commitOid,
  });
  expect(pinnedSecond).toMatchObject({ content: "one\nTWO\nthree\nfour\n" });
  // Deleted at the third commit — a pinned read there is null.
  expect(await project.repo.readFile({ path: "notes.md", commitOid: third.commitOid })).toBeNull();

  // ── input validation ────────────────────────────────────────────────────
  await expect(project.repo.commitDetails({ commitOid: "main" })).rejects.toThrow(
    /full 40-character hex sha/,
  );
  await expect(project.repo.log({ limit: 0 })).rejects.toThrow(/between 1 and/);
});
