import { describe, expect, it } from "vitest";
import {
  buildFailureMessageFromError,
  KvWorkerBuildArtifactStore,
  WORKER_BUILD_ARTIFACT_SCHEMA_VERSION,
  type WorkerBuildArtifact,
} from "./artifact-store.ts";

const PREFIX = `worker-build/v${WORKER_BUILD_ARTIFACT_SCHEMA_VERSION}`;

/** Just enough of KVNamespace for the store: ordered writes + typed reads. */
class FakeKv {
  readonly data = new Map<string, string>();
  readonly putOrder: string[] = [];
  readonly putTtls: (number | undefined)[] = [];

  async get(key: string, type?: string): Promise<unknown> {
    const value = this.data.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.putOrder.push(key);
    this.putTtls.push(options?.expirationTtl);
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

const artifact: WorkerBuildArtifact = {
  buildKey: "abc123",
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

    // Expiry is the only cleanup mechanism the cache has — every write must
    // carry it or an artifact lives forever.
    expect(kv.putTtls).toHaveLength(3);
    for (const ttl of kv.putTtls) expect(ttl).toBeGreaterThan(0);
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

  it("namespaces every key under the schema version prefix", async () => {
    // The version prefix IS the cross-version isolation: a schema bump makes
    // every old entry unreachable without any manifest-body checks.
    const kv = new FakeKv();
    await store(kv).put(artifact);
    for (const key of kv.data.keys()) {
      expect(key.startsWith(`${PREFIX}/`)).toBe(true);
    }
  });

  it("a failed build clears the in-flight marker so callers never outwait a dead build", async () => {
    const kv = new FakeKv();
    await store(kv).markBuildInFlight("abc123");
    expect(await store(kv).isBuildInFlight("abc123")).toBe(true);
    await store(kv).clearBuildInFlight("abc123");
    expect(await store(kv).isBuildInFlight("abc123")).toBe(false);
  });

  it("round-trips a build failure with a short TTL", async () => {
    const kv = new FakeKv();
    const failure = { at: "2026-07-17T00:00:00.000Z", commitOid: "c0ffee", message: "boom" };
    expect(await store(kv).getBuildFailure("abc123")).toBeNull();
    await store(kv).putBuildFailure("abc123", failure);
    expect(await store(kv).getBuildFailure("abc123")).toEqual(failure);
    // Deliberately short-lived: a transient failure must heal on its own.
    expect(kv.putTtls[0]).toBeLessThanOrEqual(10 * 60);
    expect(kv.putTtls[0]).toBeGreaterThan(0);
  });

  it("bounds failure messages — they travel in a response header per request", () => {
    expect(buildFailureMessageFromError(new Error("short"))).toBe("short");
    expect(buildFailureMessageFromError("not an error")).toBe("not an error");
    const huge = buildFailureMessageFromError(new Error("x".repeat(100_000)));
    expect(huge.length).toBeLessThan(3_000);
    expect(huge).toContain("(truncated)");
  });

  it("round-trips the last-good pointer with cache-lifetime TTL", async () => {
    const kv = new FakeKv();
    const record = { at: "2026-07-17T00:00:00.000Z", buildKey: "abc123", commitOid: "c0ffee" };
    expect(await store(kv).getLastGood("worker-x")).toBeNull();
    await store(kv).putLastGood("worker-x", record);
    expect(await store(kv).getLastGood("worker-x")).toEqual(record);
    // The pointer must not outlive the artifacts it can point at, and must
    // not be immortal either.
    expect(kv.putTtls[0]).toBeGreaterThan(0);
  });
});
