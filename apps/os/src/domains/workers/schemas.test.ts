import { describe, expect, it } from "vitest";
import { DynamicWorkerRef, DynamicWorkerSource } from "./schemas.ts";

const inlineSource = {
  files: {
    files: { "worker.ts": "export default {};" },
    type: "inline",
  },
  options: { entryPoint: "worker.ts" },
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
        files: {
          exclude: [".git/**"],
          include: ["src/**", "package.json"],
          ref: { branch: "main" },
          repoPath: "/",
          type: "repo",
        },
        options: { entryPoint: "src/worker.ts", minify: true },
      }),
    ).toMatchObject({ files: { ref: { branch: "main" }, type: "repo" } });

    expect(
      DynamicWorkerSource.parse({
        files: {
          ref: { commitOid: "a".repeat(40) },
          repoPath: "/",
          type: "repo",
        },
      }),
    ).toMatchObject({ files: { ref: { commitOid: "a".repeat(40) } } });
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
        files: { ref: { commitOid: "not-a-sha" }, repoPath: "/", type: "repo" },
      }),
    ).toThrow();
    expect(() =>
      DynamicWorkerSource.parse({
        files: { files: {}, type: "inline" },
        options: { files: {} },
      }),
    ).toThrow();
  });
});
