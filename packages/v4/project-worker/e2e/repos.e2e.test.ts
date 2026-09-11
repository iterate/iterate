// repos.e2e.test.ts — immutable, context-scoped source revisions through the public ITX door.
// The repository is an event-backed projection: a successful commit returns the committed event's
// offset, and a stale parent rejects without advancing either the head or the log.

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { append, codeOf, freshCtx, openItx, readAll, rejection } from "./support/client.ts";

test("a repository commits immutable revisions and advances its head by CAS", async () => {
  const itx = openItx(freshCtx("repo"));
  const repo = itx.repos.get("/site");

  const first = await repo.commit({
    files: { "src/index.js": "export default 1" },
    parent: null,
    message: "initial source",
  });
  expect(await repo.head()).toEqual(first);
  expect(await repo.read()).toEqual({
    ...first,
    files: { "src/index.js": "export default 1" },
  });

  const stale = await rejection(
    repo.commit({
      files: { "src/index.js": "export default 2" },
      parent: null,
      message: "stale write",
    }),
    "a stale repository parent",
  );
  expect(stale.code).toBe("REPO_HEAD_CONFLICT");
  expect(await repo.head()).toEqual(first);
  expect(
    (await readAll(itx)).filter((event) => event.type === "events.iterate.com/repo/committed"),
  ).toHaveLength(1);

  const second = await repo.commit({
    files: { "src/index.js": "export default 2" },
    parent: first.revision,
    message: "next source",
  });
  expect(second.parent).toBe(first.revision);
  expect(await repo.read(first.revision)).toEqual({
    ...first,
    files: { "src/index.js": "export default 1" },
  });
  expect(await repo.read()).toEqual({
    ...second,
    files: { "src/index.js": "export default 2" },
  });
  expect(await repo.list()).toEqual([second, first]);
});

test("an idempotent repository retry returns its original commit without re-projecting it", async () => {
  const itx = openItx(freshCtx("repo-idempotency"));
  const repo = itx.repos.get("/site");
  const input = {
    files: { "src/index.js": "export default 'once'" },
    parent: null,
    message: "one durable source fact",
    idempotencyKey: "initial-source",
  };

  const first = await repo.commit(input);
  const retry = await repo.commit(input);

  expect(retry).toEqual(first);
  expect(await repo.list()).toEqual([first]);
  expect(
    (await readAll(itx)).filter((event) => event.type === "events.iterate.com/repo/committed"),
  ).toHaveLength(1);
});

test("a stale repository fact rolls back its whole raw append batch", async () => {
  const itx = openItx(freshCtx("repo-batch"));
  const repo = itx.repos.get("/site");
  const base = await repo.commit({
    files: { "src/index.js": "export default 'base'" },
    parent: null,
    message: "base",
  });
  const committed = (files: Record<string, string>, parent: string | null, message: string) => ({
    type: "events.iterate.com/repo/committed",
    payload: {
      repoPath: "/site",
      files,
      parent,
      message,
      revision: createHash("sha256")
        .update(JSON.stringify({ files, parent, message }))
        .digest("hex"),
    },
  });

  const error = await rejection(
    append(
      itx,
      committed({ "src/index.js": "export default 'next'" }, base.revision, "next"),
      committed({ "src/index.js": "export default 'stale'" }, null, "stale"),
    ),
    "a batch with one stale repository fact",
  );

  expect(error.code).toBe("REPO_HEAD_CONFLICT");
  expect(await repo.head()).toEqual(base);
  expect(await repo.list()).toEqual([base]);
  expect(
    (await readAll(itx)).filter((event) => event.type === "events.iterate.com/repo/committed"),
  ).toHaveLength(1);
});

test("simultaneous commits from one parent admit exactly one head transition", async () => {
  const itx = openItx(freshCtx("repo-race"));
  const repo = itx.repos.get("/site");
  const base = await repo.commit({
    files: { "src/index.js": "export default 'base'" },
    parent: null,
    message: "base",
  });

  const results = await Promise.allSettled([
    repo.commit({
      files: { "src/index.js": "export default 'left'" },
      parent: base.revision,
      message: "left contender",
    }),
    repo.commit({
      files: { "src/index.js": "export default 'right'" },
      parent: base.revision,
      message: "right contender",
    }),
  ]);
  const accepted = results.filter(
    (result): result is PromiseFulfilledResult<{ revision: string }> =>
      result.status === "fulfilled",
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  expect(accepted).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(codeOf(rejected[0].reason)).toBe("REPO_HEAD_CONFLICT");
  expect((await repo.head())?.revision).toBe(accepted[0].value.revision);
  expect(await repo.list()).toHaveLength(2);
});

test("the same repository path is isolated by its Iterate context", async () => {
  const left = openItx(freshCtx("repo-left")).repos.get("/site");
  const right = openItx(freshCtx("repo-right")).repos.get("/site");

  const [leftHead, rightHead] = await Promise.all([
    left.commit({
      files: { "src/index.js": "export default 'left context'" },
      parent: null,
      message: "left root",
    }),
    right.commit({
      files: { "src/index.js": "export default 'right context'" },
      parent: null,
      message: "right root",
    }),
  ]);

  expect(leftHead.revision).not.toBe(rightHead.revision);
  expect((await left.read()).files).toEqual({ "src/index.js": "export default 'left context'" });
  expect((await right.read()).files).toEqual({
    "src/index.js": "export default 'right context'",
  });
});

test("a raw repository append cannot claim a revision it did not hash", async () => {
  const itx = openItx(freshCtx("repo-proof"));

  const error = await rejection(
    append(itx, {
      type: "events.iterate.com/repo/committed",
      payload: {
        repoPath: "/site",
        files: { "src/index.js": "export default 'forged'" },
        parent: null,
        message: "forged revision",
        revision: "0".repeat(64),
      },
    }),
    "a forged repository revision",
  );

  expect(error.code).toBe("REPO_REVISION");
  expect(await itx.repos.get("/site").head()).toBeNull();
  expect(
    (await readAll(itx)).filter((event) => event.type === "events.iterate.com/repo/committed"),
  ).toHaveLength(0);
});
