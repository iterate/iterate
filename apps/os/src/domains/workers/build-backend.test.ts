import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeWorkerBuild } from "./build-backend.ts";
import type { DynamicWorkerSource } from "./schemas.ts";

const createApp = vi.fn();
const createWorker = vi.fn();
const workerBundler = { createApp, createWorker };
const inlineFiles = { files: { "worker.ts": "source" }, type: "inline" } as const;

beforeEach(() => {
  createApp.mockReset();
  createWorker.mockReset();
  createWorker.mockResolvedValue({
    mainModule: "bundle.js",
    modules: { "bundle.js": "built" },
    warnings: [],
    wranglerConfig: { compatibilityDate: "2026-07-01" },
  });
});

function execute(
  files: Record<string, string>,
  source: DynamicWorkerSource = {
    createWorker: { entryPoint: "worker.ts", files: inlineFiles },
  },
) {
  return executeWorkerBuild({ files, source, workerBundler });
}

describe("executeWorkerBuild", () => {
  it("calls createWorker with the resolved file map and platform virtual modules", async () => {
    const source: DynamicWorkerSource = {
      createWorker: {
        bundle: false,
        conditions: ["workerd"],
        entryPoint: "apps/basic/src/index.ts",
        files: { repoPath: "/repos/config", type: "repo" },
        virtualModules: { "virtual:user": "export const user = true;" },
      },
    };
    const files = {
      "apps/basic/package.json": JSON.stringify({ dependencies: { hono: "latest" } }),
      "apps/basic/src/helper.ts": "export const value = 1;",
      "apps/basic/src/index.ts": "export default {};",
      "outside.ts": "export {};",
    };

    await expect(execute(files, source)).resolves.toEqual({
      assetManifest: {},
      assets: {},
      mainModule: "bundle.js",
      modules: { "bundle.js": "built" },
      warnings: [],
      wranglerConfig: { compatibilityDate: "2026-07-01" },
    });
    expect(createWorker).toHaveBeenCalledWith({
      bundle: false,
      conditions: ["workerd"],
      entryPoint: "apps/basic/src/index.ts",
      files,
      virtualModules: {
        "@iterate-com/capnweb": expect.any(String),
        "iterate/live-state": expect.any(String),
        "iterate/processors": expect.any(String),
        "iterate/processors/cloudflare": expect.any(String),
        "iterate/sdk": expect.any(String),
        "virtual:user": "export const user = true;",
      },
    });
    expect(createApp).not.toHaveBeenCalled();
  });

  it("calls createApp with an arbitrary repo tree and package.json unchanged", async () => {
    createApp.mockResolvedValue({
      assetManifest: {
        "/client.js": { contentType: "application/javascript", etag: "abc" },
      },
      assets: { "/client.js": "client" },
      mainModule: "bundle.js",
      modules: { "bundle.js": "server", "shared.js": "shared" },
      warnings: ["upstream warning"],
    });
    const source: DynamicWorkerSource = {
      createApp: {
        client: "apps/todo/client/index.tsx",
        files: { repoPath: "/repos/config", type: "repo" },
        jsx: "automatic",
        server: "apps/todo/server/index.ts",
      },
    };
    const files = {
      "apps/todo/client/index.tsx": "client",
      "apps/todo/package.json": JSON.stringify({ dependencies: { react: "latest" } }),
      "apps/todo/server/index.ts": "server",
      "apps/todo/shared/model.ts": "shared",
      "worker.ts": "outside",
    };

    await expect(execute(files, source)).resolves.toMatchObject({
      assets: { "/client.js": "client" },
      warnings: ["upstream warning"],
    });
    expect(createApp).toHaveBeenCalledWith({
      client: "apps/todo/client/index.tsx",
      files,
      jsx: "automatic",
      server: "apps/todo/server/index.ts",
    });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("does not pre-parse package.json", async () => {
    await execute({ "package.json": "worker-bundler gets to decide", "worker.ts": "source" });
    expect(createWorker).toHaveBeenCalledOnce();
  });

  it("classifies only named sidecar build errors as deterministic failures", async () => {
    const buildFailure = new Error("Could not resolve package");
    buildFailure.name = "WorkerBundlerBuildError";
    createWorker.mockRejectedValueOnce(buildFailure);
    await expect(execute({ "worker.ts": "export default {};" })).rejects.toMatchObject({
      message: "Could not resolve package",
      name: "WorkerBuildFailedError",
    });

    const transportFailure = new Error("service binding disconnected");
    createWorker.mockRejectedValueOnce(transportFailure);
    await expect(execute({ "worker.ts": "export default {};" })).rejects.toBe(transportFailure);
  });
});
