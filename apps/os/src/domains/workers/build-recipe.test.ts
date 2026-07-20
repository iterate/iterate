import { describe, expect, it } from "vitest";
import {
  applyRootDir,
  assertSafeSourcePath,
  BUILD_TOOLCHAIN_VERSION,
  canonicalWorkerBuildOptions,
  prepareWorkerBuild,
  WORKER_BUNDLER_VERSION,
} from "./build-recipe.ts";

describe("prepareWorkerBuild", () => {
  it("prepares a plain worker entry", () => {
    const prepared = prepareWorkerBuild({
      files: {
        "worker.ts": "export default {};",
        "lib/helper.ts": "export const x = 1;",
      },
      options: { entryPoint: "worker.ts" },
    });
    expect(prepared.kind).toBe("worker");
    if (prepared.kind !== "worker") throw new Error("expected worker");
    expect(prepared.entryPoint).toBe("worker.ts");
    expect(prepared.files["worker.ts"]).toBe("export default {};");
    expect(prepared.files["lib/helper.ts"]).toBe("export const x = 1;");
    expect(prepared.minify).toBe(false);
  });

  it("materialises platform virtual modules into node_modules", () => {
    const prepared = prepareWorkerBuild({
      files: { "worker.ts": 'import "iterate/sdk"; export default {};' },
      options: {
        entryPoint: "worker.ts",
        virtualModules: { "iterate/sdk": "export const ready = true;" },
      },
    });
    expect(prepared.files["node_modules/iterate/sdk.js"]).toBe("export const ready = true;");
    expect(JSON.parse(prepared.files["node_modules/iterate/package.json"]!)).toMatchObject({
      name: "iterate",
      exports: { "./sdk": "./sdk.js" },
    });
  });

  it("prepares a full-stack app when client is set", () => {
    const prepared = prepareWorkerBuild({
      files: {
        "src/server.tsx": "export default {};",
        "src/client.tsx": "console.log('hi');",
      },
      options: {
        client: "src/client.tsx",
        entryPoint: "src/server.tsx",
        minify: true,
      },
    });
    expect(prepared.kind).toBe("app");
    if (prepared.kind !== "app") throw new Error("expected app");
    expect(prepared.server).toBe("src/server.tsx");
    expect(prepared.client).toBe("src/client.tsx");
    expect(prepared.minify).toBe(true);
  });

  it("re-roots under rootDir and rejects missing entries", () => {
    const prepared = prepareWorkerBuild({
      files: {
        "apps/todos/src/server.tsx": "export default {};",
        "apps/todos/src/client.tsx": "export {};",
        "elsewhere.ts": "export {};",
      },
      options: {
        client: "src/client.tsx",
        entryPoint: "src/server.tsx",
        rootDir: "apps/todos",
      },
    });
    expect(prepared.kind).toBe("app");
    if (prepared.kind !== "app") throw new Error("expected app");
    expect(Object.keys(prepared.files).sort()).toEqual(["src/client.tsx", "src/server.tsx"]);

    expect(() =>
      prepareWorkerBuild({
        files: { "worker.ts": "export default {};" },
        options: { entryPoint: "missing.ts" },
      }),
    ).toThrow(/Entry point "missing.ts"/);
  });
});

describe("canonicalWorkerBuildOptions", () => {
  it("defaults the entry and injects platform virtual modules", () => {
    const options = canonicalWorkerBuildOptions({});
    expect(options.entryPoint).toBe("worker.ts");
    expect(options.virtualModules?.["iterate/sdk"]).toContain("export");
    expect(options.virtualModules?.["iterate/processors"]).toContain("export");
    expect(options.virtualModules?.["iterate/live-state"]).toContain("export");
  });

  it("lets the source override a platform virtual module", () => {
    const options = canonicalWorkerBuildOptions({
      virtualModules: { "iterate/sdk": "export const custom = 1;" },
    });
    expect(options.virtualModules?.["iterate/sdk"]).toBe("export const custom = 1;");
  });
});

describe("path helpers", () => {
  it("applyRootDir drops files outside the root", () => {
    expect(
      applyRootDir(
        {
          "apps/a/worker.ts": "a",
          "apps/b/worker.ts": "b",
        },
        "apps/a",
      ),
    ).toEqual({ "worker.ts": "a" });
  });

  it("assertSafeSourcePath rejects traversal", () => {
    expect(() => assertSafeSourcePath("../secret.ts")).toThrow(/must not traverse/);
    expect(() => assertSafeSourcePath("/abs.ts")).toThrow(/must be relative/);
  });
});

describe("toolchain pin", () => {
  it("names the worker-bundler package version", () => {
    expect(BUILD_TOOLCHAIN_VERSION).toBe(`@cloudflare/worker-bundler@${WORKER_BUNDLER_VERSION}`);
    expect(WORKER_BUNDLER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
