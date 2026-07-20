import { describe, expect, it } from "vitest";
import {
  buildFailureMessageFromError,
  KvWorkerBuildArtifactStore,
  WORKER_BUILD_ARTIFACT_SCHEMA_VERSION,
  type WorkerBuildArtifact,
  type WorkerBuildFailure,
} from "./artifact-store.ts";

const PREFIX = `worker-build/v${WORKER_BUILD_ARTIFACT_SCHEMA_VERSION}`;

class FakeKv {
  readonly data = new Map<string, string>();
  readonly putTtls: number[] = [];

  async get(key: string, type?: string): Promise<unknown> {
    const value = this.data.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.data.set(key, value);
    if (options?.expirationTtl !== undefined) this.putTtls.push(options.expirationTtl);
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
  status: "complete",
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

  it("round-trips a shorter-lived failure at the same key", async () => {
    const kv = new FakeKv();
    const failure: WorkerBuildFailure = {
      buildKey: "abc123",
      commitOid: "c0ffee",
      createdAt: "2026-07-20T00:00:00.000Z",
      message: "boom",
      status: "failed",
    };
    await store(kv).put(failure);

    expect([...kv.data.keys()]).toEqual([`${PREFIX}/failed/abc123.json`]);
    expect(await store(kv).get("abc123")).toEqual(failure);
    expect(kv.putTtls[0]).toBeGreaterThanOrEqual(10 * 60);
    expect(kv.putTtls[0]).toBeLessThanOrEqual(60 * 60);
  });

  it("never lets a later failed attempt replace a complete build", async () => {
    const kv = new FakeKv();
    const failure: WorkerBuildFailure = {
      buildKey: "abc123",
      createdAt: "2026-07-20T00:00:01.000Z",
      message: "transient registry failure",
      status: "failed",
    };

    await store(kv).put(artifact);
    await store(kv).put(failure);

    expect([...kv.data.keys()].sort()).toEqual([
      `${PREFIX}/complete/abc123.json`,
      `${PREFIX}/failed/abc123.json`,
    ]);
    expect(await store(kv).get("abc123")).toEqual(artifact);
  });

  it("bounds compiler messages shown on the build-failed page", () => {
    expect(buildFailureMessageFromError(new Error("short"))).toBe("short");
    expect(buildFailureMessageFromError("not an error")).toBe("not an error");
    const huge = buildFailureMessageFromError(new Error("x".repeat(100_000)));
    expect(huge.length).toBeLessThan(3_000);
    expect(huge).toContain("(truncated)");
  });
});
