import { describe, expect, it, vi } from "vitest";
import type { executeWorkerBuild } from "./build-backend.ts";
import type { WorkerBuildRequest } from "./worker-build-capability.ts";

const h = vi.hoisted(() => ({
  execute: vi.fn<typeof executeWorkerBuild>(),
}));

vi.mock("./build-backend.ts", () => ({ executeWorkerBuild: h.execute }));

import { executeCoordinatedWorkerBuild } from "./worker-build-capability.ts";

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

const built = {
  assetManifest: {},
  assets: {},
  mainModule: "worker.js",
  modules: { "worker.js": "built" },
  warnings: [],
};

function buildEnv(put: () => Promise<void>) {
  const cache = {
    get: vi.fn(async () => null),
    put: vi.fn(put),
  };
  return {
    cache,
    env: {
      WORKER_BUILD_CACHE: {
        get: cache.get,
        put: cache.put,
      },
      WORKER_BUNDLER: {},
    } as never,
  };
}

describe("executeCoordinatedWorkerBuild artifact persistence", () => {
  it("returns the artifact while the coordinator-owned immutable cache write is pending", async () => {
    const persisted = Promise.withResolvers<void>();
    const { cache, env } = buildEnv(async () => await persisted.promise);
    h.execute.mockResolvedValueOnce({ ok: true, output: built });
    const background: Promise<unknown>[] = [];

    await expect(
      executeCoordinatedWorkerBuild(request, env, {
        waitUntil: (work) => background.push(work),
      }),
    ).resolves.toMatchObject({ artifact: { buildKey: request.buildKey }, ok: true });

    expect(cache.put).toHaveBeenCalledOnce();
    expect(background).toHaveLength(1);
    persisted.resolve();
    await expect(background[0]).resolves.toBeUndefined();
  });

  it("logs cache persistence failures without hiding them behind the built artifact", async () => {
    const persisted = Promise.withResolvers<void>();
    const { cache, env } = buildEnv(async () => await persisted.promise);
    h.execute.mockResolvedValueOnce({ ok: true, output: built });
    const background: Promise<unknown>[] = [];
    const error = new Error("KV unavailable");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      executeCoordinatedWorkerBuild(request, env, {
        waitUntil: (work) => background.push(work),
      }),
    ).resolves.toMatchObject({ artifact: { buildKey: request.buildKey }, ok: true });

    expect(cache.put).toHaveBeenCalledOnce();
    persisted.reject(error);
    await expect(background[0]).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledWith("dynamic worker artifact cache persistence failed", {
      buildKey: request.buildKey,
      error,
    });
    errorLog.mockRestore();
  });
});
