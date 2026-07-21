import { describe, expect, it, vi } from "vitest";
import {
  deploymentReadinessProbeIndexes,
  deploymentReadinessProbeWave,
  deploymentReadinessRequestAuthorized,
  deploymentReadinessResponse,
} from "./deployment-readiness.ts";

describe("deployment readiness probe waves", () => {
  it("accepts only the ten canonical waves of eight placements", () => {
    expect(deploymentReadinessProbeWave(null)).toBeNull();
    expect(deploymentReadinessProbeWave("not-a-number")).toBeNull();
    expect(deploymentReadinessProbeWave("10")).toBeNull();
    expect(deploymentReadinessProbeWave("17")).toBeNull();
    expect(deploymentReadinessProbeWave("7")).toBe(7);
    expect(deploymentReadinessProbeIndexes(7)).toEqual([56, 57, 58, 59, 60, 61, 62, 63]);
    expect(() => deploymentReadinessProbeIndexes(17)).toThrow(/from 0 to 9/);
  });
});

describe("deployment readiness authorization", () => {
  const request = (authorization?: string) =>
    new Request("https://os.example/api/health?deployment-probe=0", {
      headers: authorization ? { authorization } : undefined,
    });

  it("requires the exact configured bearer", () => {
    expect(deploymentReadinessRequestAuthorized(request("Bearer correct"), "correct")).toBe(true);
    expect(deploymentReadinessRequestAuthorized(request("Bearer wrong"), "correct")).toBe(false);
    expect(deploymentReadinessRequestAuthorized(request(), "correct")).toBe(false);
    expect(deploymentReadinessRequestAuthorized(request("Bearer correct"), undefined)).toBe(false);
  });
});

describe("deploymentReadinessResponse", () => {
  const probes = (...versions: string[]) =>
    versions.map((version, index) => ({
      name: `probe-${index}`,
      readVersion: async () => version,
    }));

  it("requires every sampled Durable Object to run the edge version", async () => {
    const stale = await deploymentReadinessResponse({
      app: "os",
      probes: probes("new-version", "old-version"),
      version: "new-version",
      wave: 3,
    });
    expect(stale.status).toBe(503);
    await expect(stale.json()).resolves.toMatchObject({ settlingReason: "version-mismatch" });

    const ready = await deploymentReadinessResponse({
      app: "os",
      probes: probes("new-version", "new-version"),
      version: "new-version",
      wave: 3,
    });
    expect(ready.status).toBe(200);
    expect(ready.headers.get("x-iterate-worker-version")).toBe("new-version");
    await expect(ready.json()).resolves.toMatchObject({
      ok: true,
      deploymentProbeWave: 3,
      deploymentProbeWaveCount: 10,
      durableObjectProbeCount: 2,
      durableObjectProbes: [
        { name: "probe-0", version: "new-version" },
        { name: "probe-1", version: "new-version" },
      ],
    });
  });

  it("models only a flagged rollout RPC rejection as an observable settling response", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const reset = Object.assign(new Error("Durable Object reset because its code was updated."), {
      durableObjectReset: true,
    });
    const response = await deploymentReadinessResponse({
      app: "os",
      probes: [{ name: "PROJECT", readVersion: async () => await Promise.reject(reset) }],
      version: "new-version",
      wave: 0,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      durableObjectProbes: [{ name: "PROJECT", version: null }],
      settlingReason: "durable-object-lifecycle",
    });
    expect(info).toHaveBeenCalledOnce();
    info.mockRestore();
  });

  it("does not hide an arbitrary Durable Object exception as rollout settling", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        deploymentReadinessResponse({
          app: "os",
          probes: [
            {
              name: "PROJECT",
              readVersion: async () => {
                throw new Error("application bug");
              },
            },
          ],
          version: "new-version",
          wave: 0,
        }),
      ).rejects.toThrow("application bug");
      expect(error).toHaveBeenCalledWith(
        "Durable Object deployment readiness probe failed unexpectedly",
        {
          app: "os",
          errorMessage: "application bug",
          errorName: "Error",
          probe: "PROJECT",
          wave: 0,
        },
      );
    } finally {
      error.mockRestore();
    }
  });
});
