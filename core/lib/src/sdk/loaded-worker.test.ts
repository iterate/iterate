// sdk/loaded-worker.test.ts — what every loaded worker evaluates first, on the `cloudflare:workers`
// shim's base class. In a loaded isolate: core/os test/vitest/os-workers/loop-guard.test.ts.
import "./loaded-worker.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { expect, test } from "vitest";
import { currentCause } from "../cause.ts";

test("every WorkerEntrypoint gets callWithCause and getItx, never enumerable: the walk runs a method under its call's cause, `using this.getItx()` releases, and a caller naming either is refused", async () => {
  const log: unknown[] = [];
  const env = {
    ITX: {
      get: (cause: unknown) => {
        log.push({ get: cause });
        return { append: () => log.push("append"), [Symbol.dispose]: () => log.push("dispose") };
      },
    },
  };
  const entrypoint = new Plain({} as never, env);
  // the shim's base class keeps no constructor arguments; the runtime's sets `env` from them
  Object.assign(entrypoint, { env });
  expect(Object.keys(WorkerEntrypoint.prototype)).toEqual([]);
  const cause = { chain: "a test's chain", depth: 1 };
  expect(await entrypoint.callWithCause(cause, [["act"]])).toBe(cause);
  expect(log).toEqual([{ get: cause }, "append", "dispose"]);
  for (const name of ["callWithCause", "getItx"])
    await expect(entrypoint.callWithCause(cause, [[name]])).rejects.toMatchObject({
      code: "NOT_A_METHOD",
    });
});

test("code outside any call runs under the newest cause its isolate saw, parent and all, never what only a call needs", async () => {
  const env = { ITX: { get: () => ({ append() {}, [Symbol.dispose]() {} }) } };
  const entrypoint = Object.assign(new Plain({} as never, env), { env });
  const cause = { chain: "a test's chain", depth: 2, parent: "/x@4", hops: 3, writeKey: "k" };
  await entrypoint.callWithCause(cause, [["act"]]);
  expect(currentCause()).toEqual({ chain: "a test's chain", depth: 2, parent: "/x@4" });
});

/** A WorkerEntrypoint that is no SDK host: `act` reaches its context through `getItx`. */
class Plain extends WorkerEntrypoint<{ ITX: object }> {
  // what loaded-worker.ts puts on every WorkerEntrypoint, typed for this test
  declare callWithCause: (cause: unknown, steps: [string][]) => Promise<unknown>;
  declare getItx: () => { append(): void } & Disposable;
  act() {
    using itx = this.getItx();
    itx.append();
    return currentCause();
  }
}
