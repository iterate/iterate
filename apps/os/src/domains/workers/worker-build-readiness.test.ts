import { describe, expect, it, vi } from "vitest";
import { workerBuildReadinessResponse } from "./worker-build-readiness.ts";

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("workerBuildReadinessResponse", () => {
  it("keeps unversioned local and manual deployments self-contained", async () => {
    const readDeployment = vi.fn();
    const response = await workerBuildReadinessResponse({
      expectedDeploymentId: "unversioned",
      readDeployment,
      version: "local-version",
    });

    expect(response.status).toBe(200);
    expect(readDeployment).not.toHaveBeenCalled();
    expect(await body(response)).toMatchObject({
      ok: true,
      workerBuildDeploymentId: "unversioned",
    });
  });

  it("is ready only when the sidecar answers with the same immutable identity", async () => {
    const matching = await workerBuildReadinessResponse({
      expectedDeploymentId: "commit-123",
      readDeployment: async () => ({ deploymentId: "commit-123" }),
      version: "worker-version",
    });
    expect(matching.status).toBe(200);
    expect(matching.headers.get("x-iterate-worker-version")).toBe("worker-version");

    const stale = await workerBuildReadinessResponse({
      expectedDeploymentId: "commit-123",
      readDeployment: async () => ({ deploymentId: "old-commit" }),
      version: "worker-version",
    });
    expect(stale.status).toBe(503);
    expect(await body(stale)).toMatchObject({
      ok: false,
      workerBuildDeploymentId: "old-commit",
      expectedWorkerBuildDeploymentId: "commit-123",
    });
  });

  it("stays unready when the sidecar RPC is unavailable", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await workerBuildReadinessResponse({
      expectedDeploymentId: "commit-123",
      readDeployment: async () => {
        throw new Error("sidecar unavailable");
      },
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
});
