import { describe, expect, it, vi } from "vitest";
import { fetchFromDeploymentReadyProject } from "./project-egress-deployment-readiness.ts";

describe("fetchFromDeploymentReadyProject", () => {
  it("does not forward egress until the Project runs the edge version", async () => {
    let time = 0;
    const callOrder: string[] = [];
    const versions = ["version-old", "version-new"];
    const response = new Response("ok");
    const deploymentVersion = vi.fn(async () => {
      const version = versions.shift()!;
      callOrder.push(version);
      return version;
    });
    const fetch = vi.fn(async () => {
      callOrder.push("fetch");
      return response;
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      fetchFromDeploymentReadyProject(
        {
          expectedVersion: "version-new",
          projectId: "prj_test",
          request: new Request("https://petshop.example/api/me"),
          project: { deploymentVersion, fetch },
        },
        {
          now: () => time,
          pollIntervalMs: 250,
          sleep: async (durationMs) => {
            time += durationMs;
          },
          timeoutMs: 1_000,
        },
      ),
    ).resolves.toBe(response);

    expect(callOrder).toEqual(["version-old", "version-new", "fetch"]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "project deployment version converged before outbound egress",
      {
        expectedDeploymentVersion: "version-new",
        lifecycleFailures: 0,
        mismatches: 1,
        probeTimeouts: 0,
        probes: 2,
        projectId: "prj_test",
        waitedMs: 250,
      },
    );
    info.mockRestore();
  });

  it("fails before forwarding when the Project stays stale", async () => {
    let time = 0;
    const fetch = vi.fn(async () => new Response("unexpected"));

    await expect(
      fetchFromDeploymentReadyProject(
        {
          expectedVersion: "version-new",
          projectId: "prj_test",
          request: new Request("https://petshop.example/api/me"),
          project: {
            deploymentVersion: async () => "version-old",
            fetch,
          },
        },
        {
          now: () => time,
          pollIntervalMs: 250,
          sleep: async (durationMs) => {
            time += durationMs;
          },
          timeoutMs: 500,
        },
      ),
    ).rejects.toThrow(
      'Project "prj_test" was not ready for deployment version "version-new" before outbound ' +
        "egress was requested: it did not converge within 500ms; the last observed version " +
        'was "version-old". The request was not forwarded and no external side effect ran.',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
