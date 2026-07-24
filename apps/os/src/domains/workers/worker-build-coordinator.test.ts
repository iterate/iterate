import { describe, expect, it, vi } from "vitest";
import type { WorkerBuildArtifact, WorkerBuildResult } from "./artifact-store.ts";
import type { WorkerBuildRequest } from "./worker-build-capability.ts";
import {
  WorkerBuildCoordinator,
  type WorkerBuildCoordinatorEvent,
} from "./worker-build-coordinator.ts";

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
    const build = Promise.withResolvers<WorkerBuildResult>();
    const execute = vi.fn(async () => await build.promise);
    const coordinator = new WorkerBuildCoordinator(execute);

    const leader = coordinator.build(request);
    const firstFollower = coordinator.build(request);
    const secondFollower = coordinator.build(request);
    expect(execute).toHaveBeenCalledOnce();

    build.resolve({ artifact, ok: true });
    await expect(Promise.all([leader, firstFollower, secondFollower])).resolves.toEqual([
      { artifact, ok: true },
      { artifact, ok: true },
      { artifact, ok: true },
    ]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("reuses a successful artifact after its flight settles", async () => {
    const execute = vi.fn(async () => ({ artifact, ok: true }) satisfies WorkerBuildResult);
    const events: WorkerBuildCoordinatorEvent[] = [];
    const coordinator = new WorkerBuildCoordinator(execute, {
      observe: (event) => events.push(event),
    });

    await expect(coordinator.build(request)).resolves.toEqual({ artifact, ok: true });
    await expect(coordinator.build(request)).resolves.toEqual({ artifact, ok: true });

    expect(execute).toHaveBeenCalledOnce();
    // Every event names what's building; sizes appear once the bundle exists
    // ("built" is 5 UTF-8 bytes) and replay unchanged on reuse.
    const sizes = {
      assetBytes: 0,
      assetCount: 0,
      breakdown: { "worker.js": 5 },
      moduleBytes: 5,
      moduleCount: 1,
    };
    expect(events).toMatchObject([
      { kind: "started", source: "createWorker:(default entry)" },
      { kind: "settled", outcome: "built", sizes, source: "createWorker:(default entry)" },
      { kind: "reused", sizes, source: "createWorker:(default entry)" },
    ]);
  });

  it("describes createApp builds by their server and client entries", async () => {
    const execute = vi.fn(async () => ({ artifact, ok: true }) satisfies WorkerBuildResult);
    const events: WorkerBuildCoordinatorEvent[] = [];
    const coordinator = new WorkerBuildCoordinator(execute, {
      observe: (event) => events.push(event),
    });

    await coordinator.build({
      ...request,
      source: {
        createApp: {
          client: "apps/todo/client.tsx",
          files: { files: { "worker.ts": "source" }, type: "inline" },
          server: "apps/todo/server.tsx",
        },
      },
    });

    expect(events[0]).toMatchObject({
      source: "createApp:server=apps/todo/server.tsx,client=apps/todo/client.tsx",
    });
  });

  it("fans infrastructure failure out and permits a clean retry", async () => {
    const firstBuild = Promise.withResolvers<WorkerBuildResult>();
    const execute = vi
      .fn<(input: WorkerBuildRequest) => Promise<WorkerBuildResult>>()
      .mockImplementationOnce(async () => await firstBuild.promise)
      .mockResolvedValue({ artifact, ok: true });
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
    await expect(coordinator.build(request)).resolves.toEqual({ artifact, ok: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("fans a source failure out as data and permits a clean retry", async () => {
    const firstBuild = Promise.withResolvers<WorkerBuildResult>();
    const sourceFailure = {
      failure: { kind: "source" as const, message: "invalid source" },
      ok: false as const,
    };
    const execute = vi
      .fn<(input: WorkerBuildRequest) => Promise<WorkerBuildResult>>()
      .mockImplementationOnce(async () => await firstBuild.promise)
      .mockResolvedValue({ artifact, ok: true });
    const coordinator = new WorkerBuildCoordinator(execute);

    const leader = coordinator.build(request);
    const follower = coordinator.build(request);
    firstBuild.resolve(sourceFailure);

    await expect(leader).resolves.toEqual(sourceFailure);
    await expect(follower).resolves.toEqual(sourceFailure);
    await expect(coordinator.build(request)).resolves.toEqual({ artifact, ok: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects a mismatched key instead of silently joining unrelated work", async () => {
    const build = Promise.withResolvers<WorkerBuildResult>();
    const coordinator = new WorkerBuildCoordinator(async () => await build.promise);
    const leader = coordinator.build(request);

    await expect(coordinator.build({ ...request, buildKey: "b".repeat(64) })).rejects.toThrow(
      /received/,
    );

    build.resolve({ artifact, ok: true });
    await leader;
  });

  it("rejects a mismatched key after retaining a completed artifact", async () => {
    const coordinator = new WorkerBuildCoordinator(async () => ({ artifact, ok: true }));
    await coordinator.build(request);

    await expect(coordinator.build({ ...request, buildKey: "b".repeat(64) })).rejects.toThrow(
      /received/,
    );
  });
});
