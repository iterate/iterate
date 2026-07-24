import { describe, expect, it, vi } from "vitest";
import type { WorkerBuildArtifact } from "./artifact-store.ts";
import type { WorkerBuildRequest } from "./worker-build-capability.ts";
import { WorkerBuildCoordinator } from "./worker-build-coordinator.ts";

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
  createdAt: "2026-07-21T00:00:00.000Z",
  mainModule: "worker.js",
  modules: { "worker.js": "built" },
};

describe("WorkerBuildCoordinator", () => {
  it("gives concurrent followers their own answer from one build", async () => {
    const build = Promise.withResolvers<WorkerBuildArtifact>();
    const execute = vi.fn(async () => await build.promise);
    const coordinator = new WorkerBuildCoordinator(execute);

    const leader = coordinator.build(request);
    const firstFollower = coordinator.build(request);
    const secondFollower = coordinator.build(request);
    expect(execute).toHaveBeenCalledOnce();

    build.resolve(artifact);
    await expect(Promise.all([leader, firstFollower, secondFollower])).resolves.toEqual([
      artifact,
      artifact,
      artifact,
    ]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("reuses a successful artifact after its flight settles", async () => {
    const execute = vi.fn(async () => artifact);
    const events: string[] = [];
    const coordinator = new WorkerBuildCoordinator(execute, {
      observe: (event) => events.push(event.kind),
    });

    await expect(coordinator.build(request)).resolves.toBe(artifact);
    await expect(coordinator.build(request)).resolves.toBe(artifact);

    expect(execute).toHaveBeenCalledOnce();
    expect(events).toEqual(["started", "settled", "reused"]);
  });

  it("fans infrastructure failure out and permits a clean retry", async () => {
    const firstBuild = Promise.withResolvers<WorkerBuildArtifact>();
    const execute = vi
      .fn<(input: WorkerBuildRequest) => Promise<WorkerBuildArtifact>>()
      .mockImplementationOnce(async () => await firstBuild.promise)
      .mockResolvedValue(artifact);
    const coordinator = new WorkerBuildCoordinator(execute);

    const leader = coordinator.build(request);
    const follower = coordinator.build(request);
    const failure = new Error("bundler unavailable");
    failure.name = "WorkerBuildTransportError";
    firstBuild.reject(failure);

    await expect(leader).rejects.toMatchObject({
      message: "bundler unavailable",
      name: "WorkerBuildTransportError",
    });
    await expect(follower).rejects.toMatchObject({
      message: "bundler unavailable",
      name: "WorkerBuildTransportError",
    });
    await expect(coordinator.build(request)).resolves.toBe(artifact);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects a mismatched key instead of silently joining unrelated work", async () => {
    const build = Promise.withResolvers<WorkerBuildArtifact>();
    const coordinator = new WorkerBuildCoordinator(async () => await build.promise);
    const leader = coordinator.build(request);

    await expect(coordinator.build({ ...request, buildKey: "b".repeat(64) })).rejects.toThrow(
      /received/,
    );

    build.resolve(artifact);
    await leader;
  });

  it("rejects a mismatched key after retaining a completed artifact", async () => {
    const coordinator = new WorkerBuildCoordinator(async () => artifact);
    await coordinator.build(request);

    await expect(coordinator.build({ ...request, buildKey: "b".repeat(64) })).rejects.toThrow(
      /received/,
    );
  });
});
