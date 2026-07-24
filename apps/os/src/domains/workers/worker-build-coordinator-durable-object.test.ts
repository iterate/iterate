import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../env.ts";
import { WorkerBuildFailedError, type WorkerBuildArtifact } from "./artifact-store.ts";
import type { WorkerBuildRequest } from "./worker-build-capability.ts";

const h = vi.hoisted(() => ({
  execute: vi.fn<(request: WorkerBuildRequest, env: Env) => Promise<WorkerBuildArtifact>>(),
}));

vi.mock("../../env.ts", () => ({ workerVersion: () => "test-version" }));
vi.mock("./worker-build-capability.ts", () => ({
  executeCoordinatedWorkerBuild: h.execute,
}));

const { WorkerBuildCoordinatorDurableObject } =
  await import("./worker-build-coordinator-durable-object.ts");

const request: WorkerBuildRequest = {
  buildKey: "a".repeat(64),
  projectId: "prj_test",
  resolved: { files: { "worker.ts": "source" }, type: "inline" },
  source: {
    createWorker: {
      files: { files: { "worker.ts": "source" }, type: "inline" },
    },
  },
};

const artifact: WorkerBuildArtifact = {
  assetManifest: {},
  assets: {},
  buildKey: request.buildKey,
  createdAt: "2026-07-22T00:00:00.000Z",
  mainModule: "worker.js",
  modules: { "worker.js": "built" },
};

function coordinator(records: Map<string, unknown>) {
  h.execute.mockReset().mockResolvedValue(artifact);
  const setAlarm = vi.fn(async () => undefined);
  const ctx = {
    id: { name: request.buildKey },
    storage: {
      kv: {
        delete: (key: string) => records.delete(key),
        get: <T>(key: string) => records.get(key) as T | undefined,
        put: (key: string, value: unknown) => records.set(key, value),
      },
      setAlarm,
    },
  } as unknown as DurableObjectState;
  const value = new WorkerBuildCoordinatorDurableObject(ctx, {} as Env);
  return { records, setAlarm, value };
}

describe("WorkerBuildCoordinatorDurableObject background handoff", () => {
  it("serves a zero-budget follower from the settled coordinator artifact", async () => {
    const { records, setAlarm, value } = coordinator(new Map());

    await expect(value.build(request)).resolves.toBe(artifact);
    await expect(value.build(request, 0)).resolves.toBe(artifact);

    expect(h.execute).toHaveBeenCalledOnce();
    expect(records.size).toBe(0);
    expect(setAlarm).not.toHaveBeenCalled();
  });

  it("persists an alarm handoff before a budgeted build call returns", async () => {
    const { records, setAlarm, value } = coordinator(new Map());
    const build = Promise.withResolvers<WorkerBuildArtifact>();
    h.execute.mockImplementationOnce(async () => await build.promise);

    await expect(value.build(request, 0)).rejects.toMatchObject({
      name: "WorkerBuildInProgressError",
    });

    expect([...records.values()]).toEqual([request]);
    expect(setAlarm).toHaveBeenCalledOnce();

    build.resolve(artifact);
    await value.alarm();
    expect(records.size).toBe(0);
  });

  it("persists and arms without starting the build in the caller RPC", async () => {
    const { records, setAlarm, value } = coordinator(new Map());

    await value.enqueue(request);

    expect(h.execute).not.toHaveBeenCalled();
    expect([...records.values()]).toEqual([request]);
    expect(setAlarm).toHaveBeenCalledOnce();

    await value.alarm();

    expect(h.execute).toHaveBeenCalledWith(request, expect.anything());
    expect(records.size).toBe(0);
  });

  it("leaves durable work queued when infrastructure fails for native alarm retry", async () => {
    const { records, value } = coordinator(new Map());
    const failure = new Error("worker bundler unavailable");
    h.execute.mockRejectedValueOnce(failure);
    await value.enqueue(request);

    await expect(value.alarm()).rejects.toBe(failure);
    expect([...records.values()]).toEqual([request]);

    await expect(value.alarm()).resolves.toBeUndefined();
    expect(records.size).toBe(0);
  });

  it("classifies invalid source as terminal instead of starting an alarm retry storm", async () => {
    const { records, value } = coordinator(new Map());
    h.execute.mockRejectedValueOnce(new WorkerBuildFailedError("invalid source"));
    await value.enqueue(request);

    await expect(value.alarm()).resolves.toBeUndefined();
    expect([...records.values()]).toEqual([
      { message: "invalid source", name: "WorkerBuildFailedError" },
    ]);
  });

  it("does not replay a terminal failure already delivered to a foreground caller", async () => {
    const { records, value } = coordinator(new Map());
    h.execute.mockRejectedValueOnce(new WorkerBuildFailedError("invalid source"));

    await expect(value.build(request)).rejects.toMatchObject({
      message: "invalid source",
      name: "WorkerBuildFailedError",
    });
    expect(records.size).toBe(0);

    await expect(value.build(request)).resolves.toBe(artifact);
    expect(h.execute).toHaveBeenCalledTimes(2);
  });

  it("surfaces an alarm's terminal source failure after coordinator eviction", async () => {
    const records = new Map<string, unknown>();
    const first = coordinator(records);
    h.execute.mockRejectedValueOnce(
      new WorkerBuildFailedError(
        'Entry point "github-ai-linter-worker.ts" was not found in files.',
      ),
    );
    await first.value.enqueue(request);
    await first.value.alarm();

    const nextIncarnation = coordinator(records);
    await expect(nextIncarnation.value.build(request, 0)).rejects.toMatchObject({
      name: "WorkerBuildFailedError",
      message: 'Entry point "github-ai-linter-worker.ts" was not found in files.',
    });
    expect(h.execute).not.toHaveBeenCalled();
    expect(nextIncarnation.setAlarm).not.toHaveBeenCalled();
    expect(records.size).toBe(0);

    await expect(nextIncarnation.value.build(request)).resolves.toBe(artifact);
    expect(h.execute).toHaveBeenCalledOnce();
  });
});
