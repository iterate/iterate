import { describe, expect, it } from "vitest";
import { isInvalidWorkerLoaderCloneError, workerLoaderCacheKey } from "./worker-loader.ts";

describe("Worker Loader infrastructure errors", () => {
  it("recognizes only Cloudflare's invalid retained-clone failure", () => {
    expect(
      isInvalidWorkerLoaderCloneError(
        new Error("Unable to deserialize cloned data due to invalid or unsupported version."),
      ),
    ).toBe(true);
    expect(isInvalidWorkerLoaderCloneError(new Error("processEvent rejected payload"))).toBe(false);
    expect(isInvalidWorkerLoaderCloneError({ message: "Unable to serialize cloned data." })).toBe(
      false,
    );
  });
});

describe("Worker Loader cache identity", () => {
  it("is opaque and shared across export selections for one artifact and authority scope", async () => {
    const privateMarker = "customer@example.com/private-worker";
    const input = {
      projectId: `prj_${privateMarker}`,
      resolved: {
        cacheKey: "artifact-v1",
        mainModule: "worker.js",
        modules: { "worker.js": "export default {}" },
      },
      scopePath: `/${privateMarker}`,
    };

    const first = await workerLoaderCacheKey(input);
    const sameIdentity = await workerLoaderCacheKey(input);
    const otherArtifact = await workerLoaderCacheKey({
      ...input,
      resolved: { ...input.resolved, cacheKey: "artifact-v2" },
    });
    const otherScope = await workerLoaderCacheKey({ ...input, scopePath: "/other" });

    expect(first).toBe(sameIdentity);
    expect(otherArtifact).not.toBe(first);
    expect(otherScope).not.toBe(first);
    expect(first).toMatch(/^worker-loader:[0-9a-f]{64}$/);
    expect(first).not.toContain(privateMarker);
  });
});
