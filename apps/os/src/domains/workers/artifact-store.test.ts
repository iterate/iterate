import { describe, expect, it } from "vitest";
import {
  KvWorkerBuildArtifactStore,
  WORKER_BUILD_ARTIFACT_SCHEMA_VERSION,
  type WorkerBuildArtifact,
} from "./artifact-store.ts";

const PREFIX = `worker-build/v${WORKER_BUILD_ARTIFACT_SCHEMA_VERSION}`;

/** Just enough of KVNamespace for the store: ordered writes + typed reads. */
class FakeKv {
  readonly data = new Map<string, string>();
  readonly putOrder: string[] = [];

  async get(key: string, type?: string): Promise<unknown> {
    const value = this.data.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string, _options?: { expirationTtl?: number }): Promise<void> {
    this.putOrder.push(key);
    this.data.set(key, value);
  }
}

const artifact: WorkerBuildArtifact = {
  buildKey: "abc123",
  compatibilityDate: "2026-05-01",
  compatibilityFlags: ["nodejs_compat"],
  mainModule: "worker.js",
  modules: {
    "worker.js": "export default {};",
    "lib/helper.js": "export const x = 1;",
  },
};

function store(kv: FakeKv) {
  return new KvWorkerBuildArtifactStore(kv as unknown as KVNamespace);
}

describe("KvWorkerBuildArtifactStore", () => {
  it("round-trips an artifact and writes the manifest last", async () => {
    const kv = new FakeKv();
    await store(kv).put(artifact);

    const manifestKey = kv.putOrder.at(-1)!;
    expect(manifestKey).toBe(`${PREFIX}/abc123/manifest.json`);
    expect(kv.putOrder.slice(0, -1)).toEqual(
      expect.arrayContaining([
        `${PREFIX}/abc123/modules/worker.js`,
        `${PREFIX}/abc123/modules/${encodeURIComponent("lib/helper.js")}`,
      ]),
    );

    expect(await store(kv).get("abc123")).toEqual(artifact);
  });

  it("misses when there is no manifest, even if modules exist", async () => {
    const kv = new FakeKv();
    await kv.put(`${PREFIX}/abc123/modules/worker.js`, "export default {};");
    expect(await store(kv).get("abc123")).toBeNull();
  });

  it("treats a manifest with a missing module as a cache miss", async () => {
    const kv = new FakeKv();
    await store(kv).put(artifact);
    kv.data.delete(`${PREFIX}/abc123/modules/${encodeURIComponent("lib/helper.js")}`);
    expect(await store(kv).get("abc123")).toBeNull();
  });

  it("ignores manifests from other schema versions or keys", async () => {
    const kv = new FakeKv();
    await store(kv).put(artifact);
    const manifestKey = `${PREFIX}/abc123/manifest.json`;
    const manifest = JSON.parse(kv.data.get(manifestKey)!) as Record<string, unknown>;
    await kv.put(manifestKey, JSON.stringify({ ...manifest, schemaVersion: 999 }));
    expect(await store(kv).get("abc123")).toBeNull();
  });
});
