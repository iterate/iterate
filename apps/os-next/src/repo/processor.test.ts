// src/repo/processor.test.ts — the RepoProcessor's executable spec: the reduce as declarative
// `{ events → view }` rows (stream/test-support.ts `reduceProcessor`), then THE SAGA on the node
// engine harness (`memoryStream` + `memoryStorage`, the real `ProcessorEngine`): a request drives the
// effect and lands the certificate on the repo's path AND on `/`; a failing effect lands
// `create-failed` and a later request is a new attempt; an owed request is re-driven by the at-head
// pass of a fresh engine over the same log (the eviction case).

import { describe, expect, test } from "vitest";
import { ProcessorEngine, type StreamEventInput } from "../stream/processor.ts";
import { memoryStorage, memoryStream, reduceProcessor } from "../stream/test-support.ts";
import { RepoProcessor, type RepoEffects } from "./processor.ts";
import { repoArtifactName, type RepoView } from "./contract.ts";

const identity = { path: "/repos/config" };
const requested = { type: "events.iterate.com/repos/create-requested", payload: identity };
const created = { type: "events.iterate.com/repos/created", payload: identity };
const failed = {
  type: "events.iterate.com/repos/create-failed",
  payload: { ...identity, error: "boom" },
};
const committed = (commitOid: string, parentOid: string | null) => ({
  type: "events.iterate.com/repo/commit-completed",
  payload: { commitOid, parentOid, message: "m", changedPaths: ["worker.ts"] },
});
const initial: RepoView = {
  path: null,
  creation: null,
  attempts: 0,
  error: null,
  tip: null,
  commits: 0,
};
const noEffects: RepoEffects = {
  createRepo: async () => undefined,
  crossPost: async () => undefined,
};

describe("repoArtifactName — the Artifacts repo a path is backed by", () => {
  test("segments joined with `--`; the convention and any other path alike", () => {
    expect(repoArtifactName("/repos/config")).toBe("repos--config");
    expect(repoArtifactName("/vendor/lib")).toBe("vendor--lib");
    expect(repoArtifactName("/a/b.c/d_e-f")).toBe("a--b.c--d_e-f");
  });
  test("injective: a segment may not contain `--`; the grammar and the root are refused", () => {
    expect(() => repoArtifactName("/repos/a--b")).toThrow(/without "--"/);
    expect(() => repoArtifactName("/repos/with space")).toThrow(/a path segment is/);
    expect(() => repoArtifactName("/")).toThrow(/root context is not a repo/);
    expect(() => repoArtifactName("/.hidden")).toThrow(/start with a letter or digit/);
  });
});

describe("RepoProcessor — the reduce", () => {
  const rows: { name: string; events: { type: string; payload?: unknown }[]; view: RepoView }[] = [
    { name: "the empty view", events: [], view: initial },
    {
      name: "a request opens the saga",
      events: [requested],
      view: { ...initial, path: "/repos/config", creation: "requested", attempts: 1 },
    },
    {
      name: "the certificate closes it",
      events: [requested, created],
      view: { ...initial, path: "/repos/config", creation: "created", attempts: 1 },
    },
    {
      name: "a failure closes the attempt with its error; a new request is a new attempt and clears it",
      events: [requested, failed, requested],
      view: { ...initial, path: "/repos/config", creation: "requested", attempts: 2 },
    },
    {
      name: "commits advance the tip and count; an unrelated event leaves the view as it was",
      events: [requested, created, committed("a", null), { type: "note" }, committed("b", "a")],
      view: {
        ...initial,
        path: "/repos/config",
        creation: "created",
        attempts: 1,
        tip: "b",
        commits: 2,
      },
    },
    {
      name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
      events: [
        { type: "events.iterate.com/repo/commit-completed", payload: { commitOid: 1 } },
        requested,
      ],
      view: { ...initial, path: "/repos/config", creation: "requested", attempts: 1 },
    },
  ];
  for (const { name, events, view } of rows)
    test(name, () => expect(reduceProcessor(new RepoProcessor(noEffects), events)).toEqual(view));
});

describe("RepoProcessor — the creation saga on the engine", () => {
  /** A repo's log, a recording `/`, and effects whose `createRepo` can be made to fail. */
  function world(options: { failCreates?: number } = {}) {
    const log = memoryStream("/repos/config");
    const root: StreamEventInput[] = [];
    const created: string[] = [];
    let failuresLeft = options.failCreates ?? 0;
    const effects: RepoEffects = {
      createRepo: async (name) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("artifacts down");
        }
        created.push(name);
      },
      crossPost: async (event) => {
        root.push(event);
      },
    };
    const engine = () =>
      new ProcessorEngine(new RepoProcessor(effects), {
        stream: log.stream,
        storage: memoryStorage(),
      });
    /** The repo's log as short type names, in order. */
    const types = () => log.events.map((e) => e.type.replace("events.iterate.com/", ""));
    return { log, root, created, effects, engine, types };
  }

  test("a request drives the effect: the certificate lands on / first, then on the repo's path", async () => {
    const { log, root, created, engine, types } = world();
    log.stream.append({ ...requested, idempotencyKey: "repos/create-requested:/repos/config:0" });
    // The effect lands the terminal fact DURING the catch-up that reads the request, one page past
    // it — the host's `create()` re-reads for that; here, the second `snapshot()` is that re-read.
    const first = engine();
    await first.snapshot();
    const { state } = await first.snapshot();
    expect(state).toMatchObject({ creation: "created", attempts: 1, error: null });
    expect(created).toEqual(["repos--config"]);
    expect(types()).toEqual(["repos/create-requested", "repos/created"]);
    expect(root).toEqual([
      {
        type: "events.iterate.com/repos/created",
        payload: identity,
        idempotencyKey: "repos/created:/repos/config",
      },
    ]);
  });

  test("a cross-post that fails leaves the request OWED: nothing lands on the repo's path, and the next head re-drives both", async () => {
    const { log, root, created, effects, engine, types } = world();
    let crossPostsLeftToFail = 1;
    const crossPost = effects.crossPost;
    effects.crossPost = async (event) => {
      if (crossPostsLeftToFail > 0) {
        crossPostsLeftToFail -= 1;
        throw new Error("/ unreachable");
      }
      return crossPost(event);
    };
    log.stream.append({ ...requested, idempotencyKey: "repos/create-requested:/repos/config:0" });
    const first = engine();
    await expect(first.snapshot()).rejects.toThrow("/ unreachable"); // the blocking effect fails the batch
    expect(types()).toEqual(["repos/create-requested"]); // no certificate anywhere: still owed
    expect(root).toEqual([]);
    await first.snapshot(); // the next catch-up re-drives at head
    await first.snapshot();
    expect((await first.snapshot()).state).toMatchObject({ creation: "created", attempts: 1 });
    expect(created).toEqual(["repos--config", "repos--config"]); // provisioning ran twice — idempotent by design
    expect(root).toHaveLength(1);
    expect(types()).toEqual(["repos/create-requested", "repos/created"]);
  });

  test("a failing effect lands create-failed with the error; a new request is a new attempt that succeeds", async () => {
    const { log, root, engine, types } = world({ failCreates: 1 });
    log.stream.append({ ...requested, idempotencyKey: "repos/create-requested:/repos/config:0" });
    const first = engine();
    await first.snapshot();
    expect((await first.snapshot()).state).toMatchObject({
      creation: "failed",
      attempts: 1,
      error: "artifacts down",
    });
    expect(types()).toEqual(["repos/create-requested", "repos/create-failed"]);
    expect(root).toEqual([]);
    log.stream.append({ ...requested, idempotencyKey: "repos/create-requested:/repos/config:1" });
    await first.snapshot();
    expect((await first.snapshot()).state).toMatchObject({
      creation: "created",
      attempts: 2,
      error: null,
    });
    expect(types()).toEqual([
      "repos/create-requested",
      "repos/create-failed",
      "repos/create-requested",
      "repos/created",
    ]);
    expect(root).toHaveLength(1);
  });

  test("an owed request survives an eviction: a fresh engine over the same log re-drives it at head", async () => {
    // The first incarnation dies before its effect lands anything: the log holds only the request.
    const { log, root, created, engine, types } = world({ failCreates: 0 });
    log.stream.append({ ...requested, idempotencyKey: "repos/create-requested:/repos/config:0" });
    // A NEW engine (fresh memory, the same log) catches up: the reduce sees "requested" with no
    // terminal, and the at-head pass re-drives the effect.
    const fresh = engine();
    await fresh.snapshot();
    expect((await fresh.snapshot()).state).toMatchObject({ creation: "created", attempts: 1 });
    expect(created).toEqual(["repos--config"]);
    expect(types()).toEqual(["repos/create-requested", "repos/created"]);
    expect(root).toHaveLength(1);
    // And once created, further catch-ups drive nothing.
    expect((await engine().snapshot()).state).toMatchObject({ creation: "created" });
    expect(created).toEqual(["repos--config"]);
    expect(types()).toEqual(["repos/create-requested", "repos/created"]);
  });
});
