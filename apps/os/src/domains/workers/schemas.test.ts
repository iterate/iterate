import { describe, expect, it } from "vitest";
import { DynamicWorkerRef, DynamicWorkerSource } from "./schemas.ts";

const inlineSource = {
  createWorker: {
    entryPoint: "worker.ts",
    files: {
      files: { "worker.ts": "export default {};" },
      type: "inline",
    },
  },
} as const;

describe("DynamicWorkerRef schema", () => {
  it("allows props on stateless entrypoint refs", () => {
    expect(
      DynamicWorkerRef.parse({
        path: "agents/alice",
        props: { answer: 42, nested: { ok: true } },
        source: inlineSource,
        type: "stateless",
      }),
    ).toMatchObject({
      path: "/agents/alice",
      props: { answer: 42, nested: { ok: true } },
      type: "stateless",
    });
  });

  it("rejects props on stateful durable worker refs", () => {
    expect(() =>
      DynamicWorkerRef.parse({
        className: "Counter",
        durableWorkerKey: "counter",
        path: "/agents/alice",
        props: { ignored: true },
        source: inlineSource,
        type: "stateful",
      }),
    ).toThrow();
  });
});

describe("DynamicWorkerSource schema", () => {
  it("accepts repo sources with branch or commit refs and glob masks", () => {
    expect(
      DynamicWorkerSource.parse({
        createWorker: {
          entryPoint: "service/src/worker.ts",
          files: {
            exclude: [".git/**"],
            include: ["service/src/**", "package.json"],
            ref: { branch: "main" },
            repoPath: "/",
            type: "repo",
          },
        },
      }),
    ).toMatchObject({
      createWorker: { files: { ref: { branch: "main" }, type: "repo" } },
    });

    expect(
      DynamicWorkerSource.parse({
        createWorker: {
          files: {
            ref: { commitOid: "a".repeat(40) },
            repoPath: "/",
            type: "repo",
          },
        },
      }),
    ).toMatchObject({ createWorker: { files: { ref: { commitOid: "a".repeat(40) } } } });
  });

  it("rejects the pre-build-pipeline source shapes", () => {
    expect(() =>
      DynamicWorkerSource.parse({
        mainModule: "worker.js",
        modules: { "worker.js": "export default {};" },
        type: "inline",
      }),
    ).toThrow();
    expect(() =>
      DynamicWorkerSource.parse({ repoPath: "/", sourcePath: "worker.js", type: "repo" }),
    ).toThrow();
  });

  it("rejects malformed commit oids and unknown build options", () => {
    expect(() =>
      DynamicWorkerSource.parse({
        createWorker: {
          files: { ref: { commitOid: "not-a-sha" }, repoPath: "/", type: "repo" },
        },
      }),
    ).toThrow();
    expect(() =>
      DynamicWorkerSource.parse({
        createWorker: { files: { files: {}, type: "inline" }, unknown: true },
      }),
    ).toThrow();
  });

  it("accepts worker-bundler app entry points and serializable build options", () => {
    expect(
      DynamicWorkerSource.parse({
        createApp: {
          assetConfig: {
            headers: { "/assets/*": { set: { "x-app": "todo" } } },
            not_found_handling: "single-page-application",
          },
          assets: { "/robots.txt": "User-agent: *" },
          bundle: true,
          client: ["apps/todo/client/index.tsx", "apps/todo/client/admin.tsx"],
          conditions: ["browser", "worker"],
          define: { __DEV__: "false" },
          externals: ["https://esm.sh/"],
          files: { repoPath: "/repos/config", type: "repo" },
          jsx: "automatic",
          jsxImportSource: "react",
          loader: { ".svg": "text" },
          minify: true,
          registry: "https://registry.npmjs.org",
          server: "apps/todo/server/index.ts",
          sourcemap: true,
          target: "es2022",
        },
      }),
    ).toMatchObject({
      createApp: {
        assets: { "/robots.txt": "User-agent: *" },
        client: ["apps/todo/client/index.tsx", "apps/todo/client/admin.tsx"],
        server: "apps/todo/server/index.ts",
      },
    });

    expect(() =>
      DynamicWorkerSource.parse({
        createApp: {
          __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [],
          files: { repoPath: "/repos/config", type: "repo" },
        },
      }),
    ).toThrow();
  });

  it("requires exactly one upstream build function", () => {
    expect(() => DynamicWorkerSource.parse({})).toThrow();
    expect(() =>
      DynamicWorkerSource.parse({
        createApp: { files: { files: {}, type: "inline" } },
        createWorker: { files: { files: {}, type: "inline" } },
      }),
    ).toThrow();
  });
});
