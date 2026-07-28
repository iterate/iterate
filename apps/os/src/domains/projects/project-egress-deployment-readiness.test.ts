import { describe, expect, it, vi } from "vitest";
import { WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT } from "../../env.ts";
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
          getProject: () => ({ deploymentVersion, fetch }),
          projectId: "prj_test",
          request: new Request("https://petshop.example/api/me"),
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
    expect(deploymentVersion).toHaveBeenCalledWith(WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT);
    expect(fetch).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "project deployment version converged before outbound egress",
      {
        expectedDeploymentVersion: "version-new",
        lifecycleFailures: 0,
        mismatches: 1,
        observedDeploymentVersion: { id: "version-new" },
        probeTimeouts: 0,
        probes: 2,
        projectId: "prj_test",
        targetNewer: false,
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
          getProject: () => ({
            deploymentVersion: async () => "version-old",
            fetch,
          }),
          projectId: "prj_test",
          request: new Request("https://petshop.example/api/me"),
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

  it("re-acquires the Project after a lifecycle reset and forwards on the ready stub", async () => {
    const reset = Object.assign(new Error("code updated"), { durableObjectReset: true });
    const staleFetch = vi.fn(async () => new Response("unexpected"));
    const readyResponse = new Response("ok");
    const readyFetch = vi.fn(async () => readyResponse);
    const getProject = vi
      .fn()
      .mockReturnValueOnce({
        deploymentVersion: async () => {
          throw reset;
        },
        fetch: staleFetch,
      })
      .mockReturnValueOnce({
        deploymentVersion: async () => "version-new",
        fetch: readyFetch,
      });
    let time = 0;

    await expect(
      fetchFromDeploymentReadyProject(
        {
          expectedVersion: "version-new",
          getProject,
          projectId: "prj_test",
          request: new Request("https://petshop.example/api/me"),
        },
        {
          now: () => time,
          pollIntervalMs: 100,
          sleep: async (durationMs) => {
            time += durationMs;
          },
          timeoutMs: 1_000,
        },
      ),
    ).resolves.toBe(readyResponse);

    expect(getProject).toHaveBeenCalledTimes(2);
    expect(staleFetch).not.toHaveBeenCalled();
    expect(readyFetch).toHaveBeenCalledOnce();
  });
});
