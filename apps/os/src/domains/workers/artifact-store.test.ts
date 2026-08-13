import { describe, expect, it } from "vitest";
import {
  buildFailureMessageFromError,
  KvWorkerBuildArtifactStore,
  WORKER_BUILD_ARTIFACT_SCHEMA_VERSION,
  workerBuildArtifactSizes,
  type WorkerBuildArtifact,
} from "./artifact-store.ts";

const PREFIX = `worker-build/v${WORKER_BUILD_ARTIFACT_SCHEMA_VERSION}`;

class FakeKv {
  readonly data = new Map<string, string>();
  readonly putTtls: number[] = [];

  async get(key: string, type?: string): Promise<unknown> {
    const value = this.data.get(key);
    if (!value) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.data.set(key, value);
    if (Number.isFinite(options?.expirationTtl)) this.putTtls.push(options.expirationTtl);
  }
}

const artifact: WorkerBuildArtifact = {
  assetManifest: {
    "/client.js": { contentType: "application/javascript", etag: "deadbeef" },
  },
  assets: { "/client.js": "console.log('browser');" },
  buildKey: "abc123",
  createdAt: "2026-07-20T00:00:00.000Z",
  mainModule: "worker.js",
  modules: { "worker.js": "export default {};" },
  wranglerConfig: {
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat_v2"],
  },
};

function store(kv: FakeKv): KvWorkerBuildArtifactStore {
  return new KvWorkerBuildArtifactStore(kv as unknown as KVNamespace);
}

describe("KvWorkerBuildArtifactStore", () => {
  it("round-trips a complete build as one expiring JSON record", async () => {
    const kv = new FakeKv();
    await store(kv).put(artifact);

    expect([...kv.data.keys()]).toEqual([`${PREFIX}/complete/abc123.json`]);
    expect(await store(kv).get("abc123")).toEqual(artifact);
    expect(kv.putTtls[0]).toBeGreaterThan(0);
  });

  it("bounds compiler messages shown on the build-failed page", () => {
    expect(buildFailureMessageFromError(new Error("short"))).toBe("short");
    expect(buildFailureMessageFromError("not an error")).toBe("not an error");
    const huge = buildFailureMessageFromError(new Error("x".repeat(100_000)));
    expect(huge.length).toBeLessThan(3_000);
    expect(huge).toContain("(truncated)");
  });
});

describe("workerBuildArtifactSizes", () => {
  it("weighs every module representation and asset in UTF-8 bytes", () => {
    expect(
      workerBuildArtifactSizes({
        ...artifact,
        // "é" is 1 UTF-16 code unit but 2 UTF-8 bytes — .length would undercount.
        assets: { "/client.js": "é" },
        modules: {
          "worker.js": "12345",
          "chunk.js": { cjs: "123", js: "4567" },
          "notes.txt": { text: "12" },
          "data.json": { json: { a: 1 } }, // {"a":1} → 7 bytes
        },
      }),
    ).toEqual({
      assetBytes: 2,
      assetCount: 1,
      breakdown: { "chunk.js": 7, "data.json": 7, "notes.txt": 2, "worker.js": 5 },
      moduleBytes: 21,
      moduleCount: 4,
    });
  });

  it("attributes bundled code to packages via esbuild section comments", () => {
    const bundle = [
      '"use strict";', // before any section comment → the module's own bucket
      "// worker.ts",
      "const app = 1;",
      "// node_modules/zod/v4/core/schemas.js",
      "class Schema {}",
      "const parse = () => new Schema();",
      "// ../.store/x@1/node_modules/@scope/pkg/index.mjs",
      "export {};",
    ].join("\n");
    // Section-comment lines weigh into the section they open; the pnpm-store
    // path still resolves to its scoped package name.
    expect(
      workerBuildArtifactSizes({ ...artifact, assets: {}, modules: { "bundle.js": bundle } })
        .breakdown,
    ).toEqual({
      "@scope/pkg": 61,
      "bundle.js": 14,
      "worker.ts": 28,
      zod: 89,
    });
  });

  it("rolls buckets past the cap into (other), largest kept", () => {
    const modules = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`chunk-${i}.js`, "x".repeat(i + 1)]),
    );
    const { breakdown } = workerBuildArtifactSizes({ ...artifact, assets: {}, modules });
    expect(Object.keys(breakdown)).toHaveLength(8);
    expect(breakdown["chunk-11.js"]).toBe(12);
    expect(breakdown["(other)"]).toBe(1 + 2 + 3 + 4 + 5); // the five smallest
  });
});
