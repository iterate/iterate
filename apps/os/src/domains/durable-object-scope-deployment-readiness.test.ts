import { describe, expect, it, vi } from "vitest";
import { WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT } from "../env.ts";
import { waitForCreatedScopeDeploymentVersion } from "./durable-object-scope-deployment-readiness.ts";

const BASE_INPUT = {
  expectedVersion: "version-new",
  projectId: "prj_test",
  scopeKind: "agent",
  scopePath: "/agents/test",
};

describe("waitForCreatedScopeDeploymentVersion", () => {
  it("proves every exact object is ready before acknowledging creation", async () => {
    const agentVersion = vi.fn(async () => "version-new");
    const hostVersion = vi.fn(async () => "version-new");

    await expect(
      waitForCreatedScopeDeploymentVersion({
        ...BASE_INPUT,
        targets: [
          {
            getTarget: () => ({ deploymentVersion: agentVersion }),
            kind: "Agent Durable Object",
          },
          {
            getTarget: () => ({ deploymentVersion: hostVersion }),
            kind: "CapabilityHost Durable Object",
          },
        ],
      }),
    ).resolves.toMatchObject([
      { kind: "Agent Durable Object", readiness: { probes: 1 } },
      { kind: "CapabilityHost Durable Object", readiness: { probes: 1 } },
    ]);
    expect(agentVersion).toHaveBeenCalledWith(WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT);
    expect(hostVersion).toHaveBeenCalledWith(WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT);
  });

  it("re-acquires only the stale object until it joins the deployment", async () => {
    let time = 0;
    const oldAgent = { deploymentVersion: vi.fn(async () => "version-old") };
    const newAgent = { deploymentVersion: vi.fn(async () => "version-new") };
    const getAgent = vi.fn().mockReturnValueOnce(oldAgent).mockReturnValueOnce(newAgent);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      waitForCreatedScopeDeploymentVersion(
        {
          ...BASE_INPUT,
          targets: [{ getTarget: getAgent, kind: "Agent Durable Object" }],
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
    ).resolves.toMatchObject([
      {
        kind: "Agent Durable Object",
        readiness: { mismatches: 1, probes: 2, waitedMs: 250 },
      },
    ]);
    expect(getAgent).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(
      "created durable scope deployment versions converged before create returned",
      expect.objectContaining({
        projectId: "prj_test",
        scopeKind: "agent",
        scopePath: "/agents/test",
        targets: [
          expect.objectContaining({
            kind: "Agent Durable Object",
            mismatches: 1,
            probes: 2,
          }),
        ],
      }),
    );
    info.mockRestore();
  });

  it("keeps failed convergence explicit while preserving the durable retry contract", async () => {
    let time = 0;

    await expect(
      waitForCreatedScopeDeploymentVersion(
        {
          ...BASE_INPUT,
          targets: [
            {
              getTarget: () => ({ deploymentVersion: async () => "version-old" }),
              kind: "Agent Durable Object",
            },
          ],
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
      'agent scope at "/agents/test" completed durable creation, but its Agent Durable Object ' +
        'was not ready for deployment version "version-new" before create returned: it did not ' +
        'converge within 500ms; the last observed version was "version-old". The creation facts ' +
        "remain committed; an identical create call safely rejoins the same scope.",
    );
  });
});
