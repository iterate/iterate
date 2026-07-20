import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyRootDir, canonicalWorkerBuildOptions, executeWorkerBuild } from "./build-backend.ts";

const { createApp, createWorker } = vi.hoisted(() => ({
  createApp: vi.fn(),
  createWorker: vi.fn(),
}));

vi.mock("@cloudflare/worker-bundler", () => ({ createApp, createWorker }));

beforeEach(() => {
  createApp.mockReset();
  createWorker.mockReset();
  createWorker.mockResolvedValue({ mainModule: "bundle.js", modules: { "bundle.js": "built" } });
});

describe("executeWorkerBuild", () => {
  it("uses worker-bundler directly with only the supported options", async () => {
    const options = canonicalWorkerBuildOptions({
      entryPoint: "src/index.ts",
      minify: true,
      rootDir: "apps/basic",
    });
    await expect(
      executeWorkerBuild({
        files: {
          "apps/basic/package.json": "{}",
          "apps/basic/src/index.ts": "export default {};",
          "outside.ts": "export {};",
        },
        options,
      }),
    ).resolves.toEqual({
      assets: {},
      mainModule: "bundle.js",
      modules: { "bundle.js": "built" },
    });

    expect(createWorker).toHaveBeenCalledOnce();
    expect(createWorker).toHaveBeenCalledWith({
      entryPoint: "src/index.ts",
      files: {
        "package.json": "{}",
        "src/index.ts": "export default {};",
      },
      minify: true,
      virtualModules: options.virtualModules,
    });
  });

  it("builds one external-import browser entry as a separate text asset", async () => {
    createApp.mockResolvedValue({
      assets: { "/client.js": 'import React from"https://esm.sh/react@19.2.4";' },
      mainModule: "bundle.js",
      modules: { "bundle.js": "server" },
    });
    const options = canonicalWorkerBuildOptions({
      clientEntryPoint: "client.tsx",
      entryPoint: "server.tsx",
      minify: true,
      rootDir: "apps/todo",
    });
    expect(options).toMatchObject({ bundle: false, entryPoint: "server.tsx" });
    expect(options.virtualModules).toBeUndefined();

    await expect(
      executeWorkerBuild({
        files: {
          "apps/todo/client.tsx": "export {};",
          "apps/todo/server.tsx": "export class TodoApp {};",
          "worker.ts": "outside",
        },
        options,
      }),
    ).resolves.toEqual({
      assets: { "/client.js": 'import React from"https://esm.sh/react@19.2.4";' },
      mainModule: "bundle.js",
      modules: { "bundle.js": "server" },
    });

    expect(createWorker).not.toHaveBeenCalled();
    expect(createApp).toHaveBeenCalledWith({
      bundle: false,
      client: "client.tsx",
      externals: ["https://esm.sh/"],
      files: {
        "client.tsx": "export {};",
        "server.tsx": "export class TodoApp {};",
      },
      minify: true,
      server: "server.tsx",
    });
  });

  it("keeps the app path to exactly one server and one client file", async () => {
    await expect(
      executeWorkerBuild({
        files: {
          "client.tsx": "export {};",
          "helper.ts": "export const hiddenDependency = true;",
          "server.tsx": "export class TodoApp {};",
        },
        options: canonicalWorkerBuildOptions({
          clientEntryPoint: "client.tsx",
          entryPoint: "server.tsx",
        }),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("remove: helper.ts"),
      name: "WorkerBuildFailedError",
    });
    expect(createApp).not.toHaveBeenCalled();
  });

  it("requires the conventional server entry on the app path", async () => {
    await expect(
      executeWorkerBuild({
        files: { "client.tsx": "", "worker.ts": "" },
        options: canonicalWorkerBuildOptions({
          clientEntryPoint: "client.tsx",
          entryPoint: "worker.ts",
        }),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('entryPoint: "server.tsx"'),
      name: "WorkerBuildFailedError",
    });
    expect(createApp).not.toHaveBeenCalled();
  });

  it("rejects opting the basic app path back into server bundling", async () => {
    await expect(
      executeWorkerBuild({
        files: { "client.tsx": "", "server.tsx": "" },
        options: canonicalWorkerBuildOptions({
          bundle: true,
          clientEntryPoint: "client.tsx",
          entryPoint: "server.tsx",
        }),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("requires bundle: false"),
      name: "WorkerBuildFailedError",
    });
    expect(createApp).not.toHaveBeenCalled();
  });

  it("rejects custom virtual modules on the deliberately basic app path", async () => {
    createApp.mockResolvedValue({
      assets: { "/client.js": "built" },
      mainModule: "bundle.js",
      modules: { "bundle.js": "server" },
    });
    await expect(
      executeWorkerBuild({
        files: { "client.tsx": "", "server.tsx": "" },
        options: canonicalWorkerBuildOptions({
          clientEntryPoint: "client.tsx",
          entryPoint: "server.tsx",
          virtualModules: { "custom:module": "export default 1" },
        }),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("does not support custom virtualModules"),
      name: "WorkerBuildFailedError",
    });
  });

  it("rejects binary app assets instead of silently corrupting them", async () => {
    createApp.mockResolvedValue({
      assets: { "/client.js": new ArrayBuffer(4) },
      mainModule: "bundle.js",
      modules: { "bundle.js": "server" },
    });
    await expect(
      executeWorkerBuild({
        files: { "client.tsx": "", "server.tsx": "" },
        options: canonicalWorkerBuildOptions({
          clientEntryPoint: "client.tsx",
          entryPoint: "server.tsx",
        }),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("only text client bundles are supported"),
      name: "WorkerBuildFailedError",
    });
  });

  it("rejects app output other than the one host-served client asset", async () => {
    createApp.mockResolvedValue({
      assets: { "/client.js": "built", "/extra.js": "unexpected" },
      mainModule: "bundle.js",
      modules: { "bundle.js": "server" },
    });
    await expect(
      executeWorkerBuild({
        files: { "client.tsx": "", "server.tsx": "" },
        options: canonicalWorkerBuildOptions({
          clientEntryPoint: "client.tsx",
          entryPoint: "server.tsx",
        }),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("exactly /client.js"),
      name: "WorkerBuildFailedError",
    });
  });

  it("classifies every bundler warning as a build failure", async () => {
    createWorker.mockResolvedValue({
      mainModule: "bundle.js",
      modules: { "bundle.js": "built" },
      warnings: ["dependency could not be installed"],
    });
    await expect(
      executeWorkerBuild({
        files: { "worker.ts": "export default {};" },
        options: canonicalWorkerBuildOptions({}),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("dependency could not be installed"),
      name: "WorkerBuildFailedError",
    });
  });

  it("rejects non-inline bundle:false instead of ignoring virtual modules", async () => {
    await expect(
      executeWorkerBuild({
        files: { "worker.ts": "export default {};" },
        options: canonicalWorkerBuildOptions({ bundle: false }),
      }),
    ).rejects.toMatchObject({ name: "WorkerBuildFailedError" });
    expect(createWorker).not.toHaveBeenCalled();
  });
});

describe("applyRootDir", () => {
  it("drops files outside the selected app and re-roots matching files", () => {
    expect(
      applyRootDir(
        {
          "apps/todo/package.json": "{}",
          "apps/todo/src/worker.ts": "source",
          "worker.ts": "outside",
        },
        "/apps/todo/",
      ),
    ).toEqual({ "package.json": "{}", "src/worker.ts": "source" });
  });

  it.each(["", "/", "../todo", "apps/./todo", "apps\\todo"])(
    "rejects unsafe rootDir %j",
    (rootDir) => {
      expect(() => applyRootDir({ "worker.ts": "" }, rootDir)).toThrow(/safe relative directory/);
    },
  );

  it("rejects a rootDir that selects no files", () => {
    expect(() => applyRootDir({ "worker.ts": "" }, "apps/missing")).toThrow(/matches no files/);
  });
});
