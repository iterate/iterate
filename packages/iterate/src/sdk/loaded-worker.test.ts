// sdk/loaded-worker.test.ts — what every loaded worker evaluates first, on the `cloudflare:workers`
// shim's base class. In a loaded isolate: apps/os __workers-tests__/loop-guard.test.ts.
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
