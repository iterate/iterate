import { describe, expect, it, vi } from "vitest";
import {
  deploymentReadinessProbeIndexes,
  deploymentReadinessProbeWave,
  deploymentReadinessResponse,
} from "./deployment-readiness.ts";

describe("deployment readiness probe waves", () => {
  it("maps an untrusted sequence into ten bounded waves of eight placements", () => {
    expect(deploymentReadinessProbeWave(null)).toBe(0);
    expect(deploymentReadinessProbeWave("not-a-number")).toBe(0);
    expect(deploymentReadinessProbeWave("10")).toBe(0);
    expect(deploymentReadinessProbeWave("17")).toBe(7);
    expect(deploymentReadinessProbeIndexes(7)).toEqual([56, 57, 58, 59, 60, 61, 62, 63]);
    expect(deploymentReadinessProbeIndexes(17)).toEqual([56, 57, 58, 59, 60, 61, 62, 63]);
  });
});

describe("deploymentReadinessResponse", () => {
  it("requires every sampled Durable Object to run the edge version", async () => {
    const stale = await deploymentReadinessResponse({
      app: "os",
      version: "new-version",
      readDurableObjectVersions: async () => ["new-version", "old-version"],
    });
    expect(stale.status).toBe(503);

    const ready = await deploymentReadinessResponse({
      app: "os",
      version: "new-version",
      readDurableObjectVersions: async () => ["new-version", "new-version"],
    });
    expect(ready.status).toBe(200);
    expect(ready.headers.get("x-iterate-worker-version")).toBe("new-version");
    await expect(ready.json()).resolves.toMatchObject({
      ok: true,
      durableObjectProbeCount: 2,
      durableObjectVersions: ["new-version", "new-version"],
    });
  });

  it("models a rollout RPC rejection as an observable settling response", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await deploymentReadinessResponse({
      app: "os",
      version: "new-version",
      readDurableObjectVersions: async () => {
        throw new Error("Durable Object reset because its code was updated.");
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      durableObjectVersions: null,
      settlingReason: "Durable Object reset because its code was updated.",
    });
    expect(info).toHaveBeenCalledOnce();
    info.mockRestore();
  });
});
