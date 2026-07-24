import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeWorkerBuild, type FirstPartyPackageSpecs } from "./build-backend.ts";
import type { DynamicWorkerSource } from "./schemas.ts";

const createApp = vi.fn();
const createWorker = vi.fn();
const workerBundler = { createApp, createWorker };
const inlineFiles = { files: { "worker.ts": "source" }, type: "inline" } as const;

beforeEach(() => {
  createApp.mockReset();
  createWorker.mockReset();
  createWorker.mockResolvedValue({
    result: {
      mainModule: "bundle.js",
      modules: { "bundle.js": "built" },
      warnings: [],
      wranglerConfig: { compatibilityDate: "2026-07-01" },
    },
  });
});

function execute(
  files: Record<string, string>,
  source: DynamicWorkerSource = {
    createWorker: { entryPoint: "worker.ts", files: inlineFiles },
  },
  packageSpecs: FirstPartyPackageSpecs = { iterate: undefined, tasks: undefined },
) {
  return executeWorkerBuild({ files, packageSpecs, source, workerBundler });
}

describe("executeWorkerBuild", () => {
  it("calls createWorker with the resolved file map and caller virtual modules", async () => {
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
        "virtual:user": "export const user = true;",
      },
    });
    expect(createApp).not.toHaveBeenCalled();
  });

  it("calls createApp with an arbitrary repo tree and package.json unchanged", async () => {
    createApp.mockResolvedValue({
      result: {
        assetManifest: {
          "/client.js": { contentType: "application/javascript", etag: "abc" },
        },
        assets: { "/client.js": "client" },
        mainModule: "bundle.js",
        modules: { "bundle.js": "server", "shared.js": "shared" },
        warnings: ["upstream warning"],
      },
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

  it("repoints the root iterate declarations and promotes one for installation", async () => {
    const iterateSpec = "https://pkg.pr.new/iterate/iterate@abc123";
    const tasksSpec = "https://pkg.pr.new/iterate/iterate/@iterate-com/tasks@abc123";
    const source: DynamicWorkerSource = {
      createApp: {
        client: "apps/guestbook/client.tsx",
        files: { repoPath: "/repos/config", type: "repo" },
        server: "apps/guestbook/server.tsx",
      },
    };
    createApp.mockResolvedValue({
      result: {
        assetManifest: {},
        assets: {},
        mainModule: "bundle.js",
        modules: { "bundle.js": "built" },
        warnings: [],
      },
    });
    const files = {
      "apps/guestbook/package.json": JSON.stringify({
        dependencies: { iterate: "old-app-spec", react: "19.2.4" },
      }),
      "package.json": JSON.stringify({
        dependencies: { "@iterate-com/tasks": "old-tasks-spec", zod: "4.3.6" },
        devDependencies: { iterate: "old-root-spec", typescript: "5.9.3" },
      }),
    };

    await execute(files, source, { iterate: iterateSpec, tasks: tasksSpec });

    const buildFiles = createApp.mock.calls[0]?.[0].files as Record<string, string>;
    expect(JSON.parse(buildFiles["package.json"] ?? "null")).toEqual({
      dependencies: {
        "@iterate-com/tasks": tasksSpec,
        iterate: iterateSpec,
        zod: "4.3.6",
      },
      devDependencies: { iterate: iterateSpec, typescript: "5.9.3" },
    });
    expect(JSON.parse(buildFiles["apps/guestbook/package.json"] ?? "null")).toEqual({
      dependencies: { iterate: "old-app-spec", react: "19.2.4" },
    });
    expect(files["package.json"]).toContain("old-root-spec");
  });

  it("promotes an existing root devDependency even without a deployment override", async () => {
    const files = {
      "package.json": JSON.stringify({
        devDependencies: {
          "@iterate-com/tasks": "https://pkg.pr.new/iterate/iterate/@iterate-com/tasks@main",
          iterate: "https://pkg.pr.new/iterate/iterate@main",
        },
      }),
      "worker.ts": "export default {};",
    };

    await execute(files);

    const buildFiles = createWorker.mock.calls[0]?.[0].files as Record<string, string>;
    expect(JSON.parse(buildFiles["package.json"] ?? "null")).toEqual({
      dependencies: {
        "@iterate-com/tasks": "https://pkg.pr.new/iterate/iterate/@iterate-com/tasks@main",
        iterate: "https://pkg.pr.new/iterate/iterate@main",
      },
      devDependencies: {
        "@iterate-com/tasks": "https://pkg.pr.new/iterate/iterate/@iterate-com/tasks@main",
        iterate: "https://pkg.pr.new/iterate/iterate@main",
      },
    });
  });

  it("classifies returned build errors while transport failures remain retryable", async () => {
    createWorker.mockResolvedValueOnce({ error: "Could not resolve package" });
    await expect(execute({ "worker.ts": "export default {};" })).rejects.toMatchObject({
      message: "Could not resolve package",
      name: "WorkerBuildFailedError",
    });

    const transportFailure = new Error("service binding disconnected");
    createWorker.mockRejectedValueOnce(transportFailure);
    await expect(execute({ "worker.ts": "export default {};" })).rejects.toBe(transportFailure);
  });

  it.each([
    "Failed to parse package.json: Unexpected token",
    "Could not resolve version for example@next",
    "Version 9.9.9 not found for example",
    "Failed to install iterate: Failed to fetch tarball: 404 Not Found",
  ])("rejects unusable output after a dependency-install warning: %s", async (warning) => {
    createWorker.mockResolvedValueOnce({
      result: {
        mainModule: "bundle.js",
        modules: { "bundle.js": 'export * from "iterate/sdk";' },
        warnings: [warning],
      },
    });

    await expect(execute({ "worker.ts": 'export * from "iterate/sdk";' })).rejects.toMatchObject({
      message: warning,
      name: "WorkerBuildFailedError",
    });
  });

  it("preserves ordinary compiler warnings on a usable build", async () => {
    createWorker.mockResolvedValueOnce({
      result: {
        mainModule: "bundle.js",
        modules: { "bundle.js": "export default {};" },
        warnings: ["This comparison is always false"],
      },
    });

    await expect(execute({ "worker.ts": "export default {};" })).resolves.toMatchObject({
      warnings: ["This comparison is always false"],
    });
  });

  it.each([
    // The incident shape: installed package whose entry the import no longer matches.
    "Failed to resolve 'iterate/live-state' from worker.ts: the installed 'iterate' package does not provide this entry (kept as an external import)",
    // Never-installed package (not declared in package.json).
    "Failed to resolve 'lodash' from worker.ts: package 'lodash' is not installed (kept as an external import)",
    // Scoped package subpath.
    "Failed to resolve '@acme/sdk/deep' from apps/todo/server.tsx: the installed '@acme/sdk' package does not provide this entry (kept as an external import)",
    // The transform lane's stock message shape (bundle: false).
    "Failed to resolve './missing.ts' from main.js: Cannot resolve relative import './missing.ts' from 'main.js'",
    // A traversed file the transform lane could not read.
    "File not found: apps/todo/shared/model.ts",
  ])(
    "rejects output whose imports would fail at startup with No such module: %s",
    async (warning) => {
      createWorker.mockResolvedValueOnce({
        result: {
          mainModule: "bundle.js",
          modules: { "bundle.js": 'import "whatever";' },
          warnings: [warning],
        },
      });

      const error = await execute({ "worker.ts": "source" }).then(
        () => Promise.reject(new Error("build unexpectedly succeeded")),
        (thrown: Error) => thrown,
      );
      expect(error).toMatchObject({ name: "WorkerBuildFailedError" });
      expect(error.message).toContain(warning);
      expect(error.message).toContain("No such module");
    },
  );

  it.each([
    // nodejs_compat provides bare node builtins at runtime — external is correct.
    "Failed to resolve 'fs' from worker.ts: package 'fs' is not installed (kept as an external import)",
    "Failed to resolve 'stream/web' from worker.ts: package 'stream' is not installed (kept as an external import)",
    // Scheme'd specifiers are runtime modules (defense in depth: the patched
    // resolver does not warn about these in the first place).
    "Failed to resolve 'cloudflare:workers' from worker.ts: package 'cloudflare:workers' is not installed (kept as an external import)",
    "Failed to resolve 'node:fs' from worker.ts: package 'node:fs' is not installed (kept as an external import)",
  ])("keeps runtime-provided externals as ordinary warnings: %s", async (warning) => {
    createWorker.mockResolvedValueOnce({
      result: {
        mainModule: "bundle.js",
        modules: { "bundle.js": "export default {};" },
        warnings: [warning],
      },
    });

    await expect(execute({ "worker.ts": "source" })).resolves.toMatchObject({
      warnings: [warning],
    });
  });
});
