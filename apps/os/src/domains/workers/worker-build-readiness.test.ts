import { describe, expect, it, vi } from "vitest";
import { workerBuildReadinessResponse } from "./worker-build-readiness.ts";

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("workerBuildReadinessResponse", () => {
  it("keeps unversioned local and manual deployments self-contained", async () => {
    const readDeployment = vi.fn();
    const readDurableObjectVersion = vi.fn(async () => "local-version");
    const response = await workerBuildReadinessResponse({
      expectedDeploymentId: "unversioned",
      readDeployment,
      readDurableObjectVersion,
      version: "local-version",
    });

    expect(response.status).toBe(200);
    expect(readDeployment).not.toHaveBeenCalled();
    expect(readDurableObjectVersion).toHaveBeenCalledOnce();
    expect(await body(response)).toMatchObject({
      ok: true,
      durableObjectVersion: "local-version",
      workerBuildDeploymentId: "unversioned",
    });
  });

  it("is ready only when the sidecar and capability-host answer with current identities", async () => {
    const matching = await workerBuildReadinessResponse({
      expectedDeploymentId: "commit-123",
      readDeployment: async () => ({ deploymentId: "commit-123" }),
      readDurableObjectVersion: async () => "worker-version",
      version: "worker-version",
    });
    expect(matching.status).toBe(200);
    expect(matching.headers.get("x-iterate-worker-version")).toBe("worker-version");

    const stale = await workerBuildReadinessResponse({
      expectedDeploymentId: "commit-123",
      readDeployment: async () => ({ deploymentId: "old-commit" }),
      readDurableObjectVersion: async () => "worker-version",
      version: "worker-version",
    });
    expect(stale.status).toBe(503);
    expect(await body(stale)).toMatchObject({
      ok: false,
      workerBuildDeploymentId: "old-commit",
      expectedWorkerBuildDeploymentId: "commit-123",
    });
  });

  it("stays unready while the capability-host Durable Object still runs old code", async () => {
    const response = await workerBuildReadinessResponse({
      expectedDeploymentId: "commit-123",
      readDeployment: async () => ({ deploymentId: "commit-123" }),
      readDurableObjectVersion: async () => "old-worker-version",
      version: "worker-version",
    });

    expect(response.status).toBe(503);
    expect(await body(response)).toMatchObject({
      ok: false,
      durableObjectVersion: "old-worker-version",
      expectedDurableObjectVersion: "worker-version",
      workerBuildDeploymentId: "commit-123",
    });
  });

  it("stays unready when the sidecar RPC is unavailable", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await workerBuildReadinessResponse({
      expectedDeploymentId: "commit-123",
      readDeployment: async () => {
        throw new Error("sidecar unavailable");
      },
      readDurableObjectVersion: async () => "worker-version",
      version: "worker-version",
    });

    expect(response.status).toBe(503);
    expect(errorLog).toHaveBeenCalledWith(
      "worker-build sidecar readiness RPC failed",
      expect.any(Error),
    );
    expect(await body(response)).toMatchObject({
      ok: false,
      workerBuildDeploymentId: null,
      expectedWorkerBuildDeploymentId: "commit-123",
    });
    errorLog.mockRestore();
  });

  it("stays unready when the capability-host readiness RPC is unavailable", async () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await workerBuildReadinessResponse({
      expectedDeploymentId: "commit-123",
      readDeployment: async () => ({ deploymentId: "commit-123" }),
      readDurableObjectVersion: async () => {
        throw new Error("old code has no readiness method");
      },
      version: "worker-version",
    });

    expect(response.status).toBe(503);
    expect(infoLog).toHaveBeenCalledWith(
      "capability-host deployment readiness RPC is still settling",
      expect.any(Error),
    );
    expect(await body(response)).toMatchObject({
      ok: false,
      durableObjectVersion: null,
      expectedDurableObjectVersion: "worker-version",
      workerBuildDeploymentId: "commit-123",
    });
    infoLog.mockRestore();
  });
});
