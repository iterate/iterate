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
    const staleDispose = vi.fn();
    const readyDispose = vi.fn();
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
        [Symbol.dispose]: staleDispose,
        commitFiles: staleCommit,
        deploymentVersion: async () => {
          throw reset;
        },
      })
      .mockReturnValueOnce({
        [Symbol.dispose]: readyDispose,
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
    expect(staleDispose).toHaveBeenCalledOnce();
    expect(readyDispose).toHaveBeenCalledOnce();
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

  it("detaches and disposes the native commit result before releasing the ready Repo stub", async () => {
    const disposeVersion = vi.fn();
    const disposeResult = vi.fn();
    const disposeRepo = vi.fn();
    const nativeVersion = { id: "version-new" };
    Object.defineProperty(nativeVersion, Symbol.dispose, { value: disposeVersion });
    const nativeResult = { ...RESULT, changedPaths: [...RESULT.changedPaths] };
    Object.defineProperty(nativeResult, Symbol.dispose, { value: disposeResult });
    const getRepo = vi.fn(() => ({
      [Symbol.dispose]: disposeRepo,
      commitFiles: async () => nativeResult,
      deploymentVersion: async () => nativeVersion,
    }));

    const result = await commitFilesOnDeploymentReadyRepo({
      commit: COMMIT,
      expectedVersion: "version-new",
      getRepo,
      path: "/repos/ide",
      projectId: "prj_test",
    });

    expect(result).toEqual(RESULT);
    expect(result).not.toBe(nativeResult);
    expect(result.changedPaths).not.toBe(nativeResult.changedPaths);
    expect(Reflect.has(result, Symbol.dispose)).toBe(false);
    expect(disposeVersion).toHaveBeenCalledOnce();
    expect(disposeResult).toHaveBeenCalledOnce();
    expect(disposeRepo).toHaveBeenCalledOnce();
  });

  it("keeps a successful commit authoritative when native cleanup fails", async () => {
    const resultDisposeError = new Error("commit result dispose failed");
    const repoDisposeError = new Error("Repo stub dispose failed");
    const nativeResult = { ...RESULT };
    Object.defineProperty(nativeResult, Symbol.dispose, {
      value: () => {
        throw resultDisposeError;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        commitFilesOnDeploymentReadyRepo({
          commit: COMMIT,
          expectedVersion: "version-new",
          getRepo: () => ({
            [Symbol.dispose]: () => {
              throw repoDisposeError;
            },
            commitFiles: async () => nativeResult,
            deploymentVersion: async () => "version-new",
          }),
          path: "/repos/ide",
          projectId: "prj_test",
        }),
      ).resolves.toEqual(RESULT);

      expect(warn).toHaveBeenCalledWith("repo commit RPC result dispose failed", {
        error: resultDisposeError,
        path: "/repos/ide",
        projectId: "prj_test",
      });
      expect(warn).toHaveBeenCalledWith("repo Durable Object stub dispose failed", {
        error: repoDisposeError,
        path: "/repos/ide",
        projectId: "prj_test",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not replay an indeterminate commit failure and still releases the ready stub", async () => {
    const mutationError = new Error("commit acknowledgement was lost");
    const disposeRepo = vi.fn();
    const commitFiles = vi.fn(async () => {
      throw mutationError;
    });
    const getRepo = vi.fn(() => ({
      [Symbol.dispose]: disposeRepo,
      commitFiles,
      deploymentVersion: async () => "version-new",
    }));

    await expect(
      commitFilesOnDeploymentReadyRepo({
        commit: COMMIT,
        expectedVersion: "version-new",
        getRepo,
        path: "/repos/ide",
        projectId: "prj_test",
      }),
    ).rejects.toBe(mutationError);

    expect(getRepo).toHaveBeenCalledOnce();
    expect(commitFiles).toHaveBeenCalledOnce();
    expect(disposeRepo).toHaveBeenCalledOnce();
  });

  it("does not send the mutation when the Repo never reaches the caller's version", async () => {
    const commitFiles = vi.fn(async () => RESULT);
    const disposals: number[] = [];
    let acquisition = 0;
    let time = 0;

    await expect(
      commitFilesOnDeploymentReadyRepo(
        {
          commit: COMMIT,
          expectedVersion: "version-new",
          getRepo: () => {
            acquisition += 1;
            const currentAcquisition = acquisition;
            return {
              [Symbol.dispose]: () => disposals.push(currentAcquisition),
              commitFiles,
              deploymentVersion: async () => "version-old",
            };
          },
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
        'version was "version-old"; retryable outcomes were lifecycle resets=0, transient ' +
        "platform failures=0, probe timeouts=0, version mismatches=2 across 2 read-only probes. " +
        "No repo mutation was sent.",
    );
    expect(commitFiles).not.toHaveBeenCalled();
    expect(disposals).toEqual([1, 2]);
  });
});
