import { describe, expect, it, vi } from "vitest";
import { WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT } from "../../env.ts";
import { fetchFromDeploymentReadySecret } from "./secret-deployment-readiness.ts";

describe("fetchFromDeploymentReadySecret", () => {
  it("does not forward credential-bearing egress until the Secret runs the Project version", async () => {
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
      fetchFromDeploymentReadySecret(
        {
          expectedVersion: "version-new",
          getSecret: () => ({ deploymentVersion, fetch }),
          path: "/integrations/petshop/alice",
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
      "secret deployment version converged before credential-bearing egress",
      {
        expectedDeploymentVersion: "version-new",
        lifecycleFailures: 0,
        mismatches: 1,
        observedDeploymentVersion: { id: "version-new" },
        path: "/integrations/petshop/alice",
        probeTimeouts: 0,
        probes: 2,
        projectId: "prj_test",
        targetNewer: false,
        waitedMs: 250,
      },
    );
    info.mockRestore();
  });

  it("fails at the no-side-effect boundary when the Secret stays stale", async () => {
    let time = 0;
    const fetch = vi.fn(async () => new Response("unexpected"));

    await expect(
      fetchFromDeploymentReadySecret(
        {
          expectedVersion: "version-new",
          getSecret: () => ({
            deploymentVersion: async () => "version-old",
            fetch,
          }),
          path: "/integrations/petshop/alice",
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
      'Secret at "/integrations/petshop/alice" was not ready for deployment version ' +
        '"version-new" before credential-bearing project egress was requested: it did not ' +
        'converge within 500ms; the last observed version was "version-old". The request ' +
        "was not forwarded and no credential refresh ran.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-acquires the Secret after a lifecycle reset and forwards on the ready stub", async () => {
    const reset = Object.assign(new Error("code updated"), { durableObjectReset: true });
    const staleFetch = vi.fn(async () => new Response("unexpected"));
    const readyResponse = new Response("ok");
    const readyFetch = vi.fn(async () => readyResponse);
    const getSecret = vi
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
      fetchFromDeploymentReadySecret(
        {
          expectedVersion: "version-new",
          getSecret,
          path: "/integrations/petshop/alice",
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

    expect(getSecret).toHaveBeenCalledTimes(2);
    expect(staleFetch).not.toHaveBeenCalled();
    expect(readyFetch).toHaveBeenCalledOnce();
  });
});
