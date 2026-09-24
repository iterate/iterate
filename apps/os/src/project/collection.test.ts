// src/project/collection.test.ts — THE TERMINAL WAIT of `itx.repos.create` / `itx.workspaces.create`
// (collection.ts `#terminalFact`), driven with a fake context: the entity's certificate is waited for
// 30 s in 5 s slices, each a fresh call, so a wait the platform left on a replaced instance — which
// never sees the new instance's appends — costs one slice, not the creation. The sagas themselves
// are the e2e's (e2e/repos.e2e.test.ts, e2e/workspaces.e2e.test.ts).

import { errorCode } from "iterate/lib";
import { expect, onTestFinished, test, vi } from "vitest";
import { EntityCollectionRpcTarget } from "./collection.ts";

const path = "/repos/config";
const created = { type: "events.iterate.com/repo/created", offset: 9, payload: { path } };
const terminal = ["events.iterate.com/repo/created", "events.iterate.com/repo/create-failed"];

test("a wait left on a replaced instance times out one slice; the next call finds the new incarnation, the warn names it, and the certificate settles the create", async () => {
  const context = fakeContext([
    "timeout", // the replaced instance's waiter: never sees the new instance's appends
    woken(8, 2), // the fresh call reaches the active instance, born after the request
    created,
  ]);
  const warns = spy("warn");
  await expect(collection(context).create(path, { creator: "/" })).resolves.toEqual({ path });
  expect(context).toMatchObject({
    waits: [
      { type: [...terminal, "events.iterate.com/stream/woken"], afterOffset: 7, timeoutMs: 5_000 },
      { type: [...terminal, "events.iterate.com/stream/woken"], afterOffset: 7, timeoutMs: 5_000 },
      { type: [...terminal, "events.iterate.com/stream/woken"], afterOffset: 8, timeoutMs: 5_000 },
    ],
  });
  expect(warns).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      event: "iterate-context.platform-failure-wait-moved",
      path,
      slicesTimedOut: 1,
      incarnation: 2,
      reason: "request",
    }),
  );
});

test("a wake already on the log when a creation is joined is no platform failure: skipped, unlogged", async () => {
  const context = fakeContext([woken(8, 2), created], { requestedAt: 7 });
  const warns = spy("warn");
  await expect(collection(context).create(path, { creator: "/" })).resolves.toEqual({ path });
  expect(context).toMatchObject({ appended: [] }); // joined, never requested again
  expect(context.waits.map((wait) => wait.afterOffset)).toEqual([7, 8]);
  expect(warns).not.toHaveBeenCalled();
});

test("the whole wait stays 30 s: six slices that find nothing, then WAIT_TIMEOUT naming the entity", async () => {
  const context = fakeContext(Array.from({ length: 6 }, () => "timeout" as const));
  const error = await collection(context)
    .create(path, { creator: "/" })
    .catch((caught: unknown) => caught);
  expect({ code: errorCode(error), message: String(error) }).toEqual({
    code: "WAIT_TIMEOUT",
    message: expect.stringContaining(
      `repo ${path}: no events.iterate.com/repo/created or events.iterate.com/repo/create-failed after offset 7 within 30000ms`,
    ),
  });
  expect(context.waits).toHaveLength(6);
});

test("a failure is the creation's answer, thrown with its error", async () => {
  const context = fakeContext([
    { type: "events.iterate.com/repo/create-failed", offset: 8, payload: { error: "boom" } },
  ]);
  await expect(collection(context).create(path, { creator: "/" })).rejects.toThrow(
    `repo ${path}: creation failed — boom`,
  );
});

/** The context's wake record: an incarnation's first event. */
function woken(offset: number, incarnation: number) {
  return {
    type: "events.iterate.com/stream/woken",
    offset,
    payload: { incarnation, reason: "request" },
  };
}

/** The collection over a fake `withItx` whose every `cd` is `context`, with a clock that each
 *  timed-out slice moves on by its own `timeoutMs`. */
function collection(context: ReturnType<typeof fakeContext>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const itx = { cd: () => context };
  return new EntityCollectionRpcTarget(
    "repo",
    (call) => Promise.resolve(call(itx as never)) as never,
    () => Promise.reject(new Error("the create reads no catalog")),
  );
}

/** The entity's context: its creation state (none, or a request already open at `requestedAt`),
 *  the append that lands the request at offset 7, and one answer per `waitForEvent` call — an
 *  event, or "timeout": the slice times out after its `timeoutMs`, and the clock moves on by it. */
function fakeContext(
  answers: ({ type: string; offset: number; payload: object } | "timeout")[],
  { requestedAt }: { requestedAt?: number } = {},
) {
  const waits: { type: string[]; afterOffset: number; timeoutMs: number }[] = [];
  const appended: unknown[] = [];
  return {
    waits,
    appended,
    invoke: async () => ({
      state: {
        creation: requestedAt ? { status: "requested", offset: requestedAt } : null,
        deletion: null,
      },
    }),
    processors: { enable: async () => {} },
    append: async (...events: unknown[]) => {
      appended.push(...events);
      return events.map((_event, i) => ({ offset: 7 - events.length + 1 + i }));
    },
    waitForEvent: async (filter: { type: string[]; afterOffset: number; timeoutMs: number }) => {
      waits.push(filter);
      const answer = answers.shift();
      if (!answer) throw new Error("no answer left for this wait");
      if (answer !== "timeout") return answer;
      vi.setSystemTime(Date.now() + filter.timeoutMs);
      throw Object.assign(new Error("waitForEvent: no event within the slice"), {
        code: "WAIT_TIMEOUT",
      });
    },
  };
}

function spy(level: "warn") {
  const logged = vi.spyOn(console, level).mockImplementation(() => {});
  onTestFinished(() => {
    logged.mockRestore();
  });
  return logged;
}
