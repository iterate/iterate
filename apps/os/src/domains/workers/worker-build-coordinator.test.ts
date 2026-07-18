import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkerBuildBackend,
  WorkerBuildOutcome,
  WorkerBuildRequest,
} from "./worker-build-contract.ts";
import {
  WorkerBuildCoordinator,
  WorkerBuildQueueFullError,
  WorkerBuildQueueTimeoutError,
} from "./worker-build-coordinator.ts";

const built: WorkerBuildOutcome = {
  status: "built",
  output: { mainModule: "worker.js", modules: { "worker.js": "export default {};" } },
};

function request(digit: string): WorkerBuildRequest {
  return {
    buildKey: digit.repeat(64),
    files: { "worker.ts": "export default {};" },
    options: { entryPoint: "worker.ts" },
  };
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

afterEach(() => vi.useRealTimers());

describe("WorkerBuildCoordinator", () => {
  it("never exceeds its distinct-build concurrency ceiling", async () => {
    const calls: ReturnType<typeof deferred<WorkerBuildOutcome>>[] = [];
    let active = 0;
    let peak = 0;
    const backend: WorkerBuildBackend = {
      async build() {
        active += 1;
        peak = Math.max(peak, active);
        const call = deferred<WorkerBuildOutcome>();
        calls.push(call);
        try {
          return await call.promise;
        } finally {
          active -= 1;
        }
      },
    };
    const coordinator = new WorkerBuildCoordinator(backend, {
      maxConcurrent: 2,
      maxQueued: 2,
      queueTimeoutMs: 1_000,
    });

    const first = coordinator.build(request("a"));
    const second = coordinator.build(request("b"));
    const third = coordinator.build(request("c"));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(peak).toBe(2);

    calls[0]!.resolve(built);
    await first;
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(peak).toBe(2);

    calls[1]!.resolve(built);
    calls[2]!.resolve(built);
    await expect(Promise.all([second, third])).resolves.toEqual([built, built]);
  });

  it("coalesces concurrent requests for the same content key", async () => {
    const call = deferred<WorkerBuildOutcome>();
    const build = vi.fn(async () => await call.promise);
    const coordinator = new WorkerBuildCoordinator(
      { build },
      {
        maxConcurrent: 2,
        maxQueued: 2,
        queueTimeoutMs: 1_000,
      },
    );

    const leader = coordinator.build(request("a"));
    const follower = coordinator.build(request("a"));
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));

    call.resolve(built);
    await expect(Promise.all([leader, follower])).resolves.toEqual([built, built]);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("rejects new distinct work when its bounded queue is full", async () => {
    const calls: ReturnType<typeof deferred<WorkerBuildOutcome>>[] = [];
    const coordinator = new WorkerBuildCoordinator(
      {
        async build() {
          const call = deferred<WorkerBuildOutcome>();
          calls.push(call);
          return await call.promise;
        },
      },
      { maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 1_000 },
    );

    const active = coordinator.build(request("a"));
    const queued = coordinator.build(request("b"));
    await expect(coordinator.build(request("c"))).rejects.toBeInstanceOf(WorkerBuildQueueFullError);

    calls[0]!.resolve(built);
    await active;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1]!.resolve(built);
    await queued;
  });

  it("times queued work out instead of waiting indefinitely", async () => {
    vi.useFakeTimers();
    const call = deferred<WorkerBuildOutcome>();
    const coordinator = new WorkerBuildCoordinator(
      { build: async () => await call.promise },
      { maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 100 },
    );

    const active = coordinator.build(request("a"));
    const queued = coordinator.build(request("b"));
    const timedOut = expect(queued).rejects.toBeInstanceOf(WorkerBuildQueueTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;

    call.resolve(built);
    await active;
  });

  it("shares a modeled source-build failure without turning it into infrastructure failure", async () => {
    const call = deferred<WorkerBuildOutcome>();
    const build = vi.fn(async () => await call.promise);
    const coordinator = new WorkerBuildCoordinator(
      { build },
      {
        maxConcurrent: 1,
        maxQueued: 1,
        queueTimeoutMs: 1_000,
      },
    );
    const failure: WorkerBuildOutcome = { status: "build-failed", message: "syntax error" };

    const leader = coordinator.build(request("a"));
    const follower = coordinator.build(request("a"));
    call.resolve(failure);

    await expect(Promise.all([leader, follower])).resolves.toEqual([failure, failure]);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("rejects every follower on infrastructure failure and permits a clean retry", async () => {
    const call = deferred<WorkerBuildOutcome>();
    const build = vi
      .fn<WorkerBuildBackend["build"]>()
      .mockImplementationOnce(async () => await call.promise)
      .mockResolvedValue(built);
    const coordinator = new WorkerBuildCoordinator(
      { build },
      {
        maxConcurrent: 1,
        maxQueued: 1,
        queueTimeoutMs: 1_000,
      },
    );

    const leader = coordinator.build(request("a"));
    const follower = coordinator.build(request("a"));
    call.reject(new Error("container unavailable"));

    await expect(leader).rejects.toThrow("container unavailable");
    await expect(follower).rejects.toThrow("container unavailable");
    await expect(coordinator.build(request("a"))).resolves.toEqual(built);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("rejects keys that are not canonical SHA-256 digests", async () => {
    const coordinator = new WorkerBuildCoordinator(
      { build: async () => built },
      {
        maxConcurrent: 1,
        maxQueued: 0,
        queueTimeoutMs: 1_000,
      },
    );

    await expect(coordinator.build({ ...request("a"), buildKey: "not-a-key" })).rejects.toThrow(
      /lowercase SHA-256/,
    );
  });
});
