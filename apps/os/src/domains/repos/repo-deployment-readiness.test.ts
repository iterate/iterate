import { describe, expect, it, vi } from "vitest";
import { WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT } from "../../env.ts";
import { commitFilesOnDeploymentReadyRepo } from "./repo-deployment-readiness.ts";

const COMMIT = {
  changes: [{ content: "<h1>Hello</h1>", path: "index.html" }],
  message: "Add index.html",
};
const RESULT = {
  branch: "main",
  changedPaths: ["index.html"],
  commitOid: "commit-new",
  noChanges: false,
};

describe("commitFilesOnDeploymentReadyRepo", () => {
  it("sends the commit only through the exact Repo stub whose version probe passed", async () => {
    const reset = Object.assign(new Error("Durable Object reset because its code was updated."), {
      durableObjectReset: true,
    });
    const staleCommit = vi.fn(async () => {
      throw new Error("must not commit through the reset stub");
    });
    const readyCommit = vi.fn(async () => RESULT);
    const unprobedCommit = vi.fn(async () => {
      throw new Error("must not re-acquire after proving readiness");
    });
    const getRepo = vi
      .fn()
      .mockReturnValueOnce({
        commitFiles: staleCommit,
        deploymentVersion: async () => {
          throw reset;
        },
      })
      .mockReturnValueOnce({
        commitFiles: readyCommit,
        deploymentVersion: async () => "version-new",
      })
      .mockReturnValue({
        commitFiles: unprobedCommit,
        deploymentVersion: async () => "version-new",
      });
    let time = 0;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(
      commitFilesOnDeploymentReadyRepo(
        {
          commit: COMMIT,
          expectedVersion: "version-new",
          getRepo,
          path: "/repos/ide",
          projectId: "prj_test",
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
    ).resolves.toEqual(RESULT);

    expect(getRepo).toHaveBeenCalledTimes(2);
    expect(staleCommit).not.toHaveBeenCalled();
    expect(readyCommit).toHaveBeenCalledOnce();
    expect(readyCommit).toHaveBeenCalledWith(COMMIT);
    expect(unprobedCommit).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      "repo deployment version converged before commitFiles",
      expect.objectContaining({
        lifecycleFailures: 1,
        path: "/repos/ide",
        probes: 2,
        projectId: "prj_test",
      }),
    );
    info.mockRestore();
  });

  it("probes the Repo before the first commit and keeps the ready fast path to one stub", async () => {
    const commitFiles = vi.fn(async () => RESULT);
    const deploymentVersion = vi.fn(async () => "version-new");
    const getRepo = vi.fn(() => ({ commitFiles, deploymentVersion }));

    await expect(
      commitFilesOnDeploymentReadyRepo({
        commit: COMMIT,
        expectedVersion: "version-new",
        getRepo,
        path: "/repos/ide",
        projectId: "prj_test",
      }),
    ).resolves.toEqual(RESULT);

    expect(getRepo).toHaveBeenCalledOnce();
    expect(deploymentVersion).toHaveBeenCalledWith(WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT);
    expect(commitFiles).toHaveBeenCalledWith(COMMIT);
  });

  it("does not send the mutation when the Repo never reaches the caller's version", async () => {
    const commitFiles = vi.fn(async () => RESULT);
    let time = 0;

    await expect(
      commitFilesOnDeploymentReadyRepo(
        {
          commit: COMMIT,
          expectedVersion: "version-new",
          getRepo: () => ({
            commitFiles,
            deploymentVersion: async () => "version-old",
          }),
          path: "/repos/ide",
          projectId: "prj_test",
        },
        {
          now: () => time,
          pollIntervalMs: 100,
          sleep: async (durationMs) => {
            time += durationMs;
          },
          timeoutMs: 200,
        },
      ),
    ).rejects.toThrow(
      'Repo at "/repos/ide" was not ready for deployment version "version-new" before ' +
        "commitFiles was requested: it did not converge within 200ms; the last observed " +
        'version was "version-old". No repo mutation was sent.',
    );
    expect(commitFiles).not.toHaveBeenCalled();
  });
});
