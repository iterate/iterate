import { describe, expect, it, vi } from "vitest";
import { WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT } from "../../env.ts";
import { waitForProjectBirthDeploymentVersion } from "./project-birth-deployment-readiness.ts";

describe("waitForProjectBirthDeploymentVersion", () => {
  it("proves the Project Durable Object is current before birth facts can be appended", async () => {
    const deploymentVersion = vi.fn(async () => "version-new");

    await expect(
      waitForProjectBirthDeploymentVersion({
        expectedVersion: "version-new",
        getTarget: () => ({ deploymentVersion }),
        projectId: "prj_test",
        targetKind: "Project Durable Object",
      }),
    ).resolves.toMatchObject({
      readiness: { probes: 1, targetNewer: false },
      target: { deploymentVersion },
    });
    expect(deploymentVersion).toHaveBeenCalledWith(WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT);
  });

  it("re-acquires a stale Project Durable Object until it joins the deployment", async () => {
    let time = 0;
    const oldProject = { deploymentVersion: vi.fn(async () => "version-old") };
    const newProject = { deploymentVersion: vi.fn(async () => "version-new") };
    const getTarget = vi.fn().mockReturnValueOnce(oldProject).mockReturnValueOnce(newProject);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(
      waitForProjectBirthDeploymentVersion(
        {
          expectedVersion: "version-new",
          getTarget,
          projectId: "prj_test",
          targetKind: "Stream Durable Object",
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
    ).resolves.toMatchObject({
      readiness: { mismatches: 1, probes: 2, waitedMs: 250 },
      target: newProject,
    });
    expect(getTarget).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(
      "project birth Durable Object deployment version converged before append",
      expect.objectContaining({
        mismatches: 1,
        probes: 2,
        projectId: "prj_test",
        targetKind: "Stream Durable Object",
      }),
    );
    info.mockRestore();
  });

  it("fails before birth with an explicit, safely retryable state description", async () => {
    let time = 0;

    await expect(
      waitForProjectBirthDeploymentVersion(
        {
          expectedVersion: "version-new",
          getTarget: () => ({ deploymentVersion: async () => "version-old" }),
          projectId: "prj_test",
          targetKind: "Stream Durable Object",
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
      'Project "prj_test" has an identity and directory entry, but its Stream Durable Object ' +
        'was not ready for deployment version "version-new" before this create attempt appended ' +
        "root birth facts: it did not converge within 500ms; the last observed version was " +
        '"version-old". This attempt appended no new birth facts; facts from any earlier identical ' +
        "call remain authoritative, and another identical create call safely rejoins the " +
        "registered project.",
    );
  });
});
