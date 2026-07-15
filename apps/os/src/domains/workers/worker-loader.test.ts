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
  it("is opaque, stable within a deploy, and changes across parent deploys", async () => {
    const privateMarker = "customer@example.com/private-worker";
    const input = {
      deploymentVersion: "deploy-a",
      projectId: `prj_${privateMarker}`,
      ref: {
        entrypoint: privateMarker,
        path: `/${privateMarker}`,
        source: {
          files: { files: { "worker.js": "export default {}" }, type: "inline" as const },
        },
        type: "stateless" as const,
      },
      resolved: {
        cacheKey: "artifact-v1",
        mainModule: "worker.js",
        modules: { "worker.js": "export default {}" },
      },
      scopePath: `/${privateMarker}`,
    };

    const first = await workerLoaderCacheKey(input);
    const sameDeploy = await workerLoaderCacheKey(input);
    const nextDeploy = await workerLoaderCacheKey({ ...input, deploymentVersion: "deploy-b" });

    expect(first).toBe(sameDeploy);
    expect(nextDeploy).not.toBe(first);
    expect(first).toMatch(/^worker-loader:[0-9a-f]{64}$/);
    expect(first).not.toContain(privateMarker);
  });
});
