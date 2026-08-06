import { expect, test, vi } from "vitest";
import { waitForProjectBirthDeploymentVersion } from "./project-birth-deployment-readiness.ts";

test("returns the exact Project Durable Object stub that reports the current deployment", async () => {
  const deploymentVersion = vi.fn(async () => "version-new");
  const target = disposableTarget({ deploymentVersion });

  await expect(
    waitForProjectBirthDeploymentVersion({
      expectedVersion: "version-new",
      getTarget: () => target,
      projectId: "prj_test",
      targetKind: "Project Durable Object",
    }),
  ).resolves.toMatchObject({
    readiness: { probes: 1 },
    target,
  });
  expect(deploymentVersion).toHaveBeenCalledOnce();
});

test("releases stale stubs and backs off until the root Stream reaches the deployment", async () => {
  const disposals: number[] = [];
  let acquisition = 0;
  let time = 0;
  const readyStream = disposableTarget({
    dispose: () => disposals.push(3),
    deploymentVersion: async () => "version-new",
  });
  const getTarget = vi.fn(() => {
    acquisition += 1;
    if (acquisition === 3) return readyStream;
    const currentAcquisition = acquisition;
    return disposableTarget({
      dispose: () => disposals.push(currentAcquisition),
      deploymentVersion: async () => "version-old",
    });
  });
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
        pollIntervalMs: 100,
        sleep: async (durationMs) => {
          time += durationMs;
        },
        timeoutMs: 1_000,
      },
    ),
  ).resolves.toMatchObject({
    readiness: { mismatches: 2, probes: 3, waitedMs: 300 },
    target: readyStream,
  });
  expect(disposals).toEqual([1, 2]);
  expect(info).toHaveBeenCalledWith(
    "project birth Durable Object deployment version converged before append",
    expect.objectContaining({
      mismatches: 2,
      probes: 3,
      targetKind: "Stream Durable Object",
    }),
  );
  info.mockRestore();
});

test("bounds lifecycle and platform convergence without accepting application failures", async () => {
  const reset = Object.assign(new Error("code updated"), { durableObjectReset: true });
  const internal = new Error("internal error; reference = abcdef0123456789");
  const applicationFailure = new Error("processor invariant failed");
  let acquisition = 0;
  let time = 0;

  await expect(
    waitForProjectBirthDeploymentVersion(
      {
        expectedVersion: "version-new",
        getTarget: () => {
          acquisition += 1;
          const error = acquisition === 1 ? reset : internal;
          return disposableTarget({ deploymentVersion: async () => Promise.reject(error) });
        },
        projectId: "prj_test",
        targetKind: "Project Durable Object",
      },
      {
        now: () => time,
        pollIntervalMs: 100,
        sleep: async (durationMs) => {
          time += durationMs;
        },
        timeoutMs: 300,
      },
    ),
  ).rejects.toThrow(
    "retryable outcomes were lifecycle resets=1, transient platform failures=1, " +
      "probe timeouts=0, version mismatches=0 across 2 read-only probes",
  );

  await expect(
    waitForProjectBirthDeploymentVersion({
      expectedVersion: "version-new",
      getTarget: () =>
        disposableTarget({ deploymentVersion: async () => Promise.reject(applicationFailure) }),
      projectId: "prj_test",
      targetKind: "Project Durable Object",
    }),
  ).rejects.toThrow('the version probe failed with "processor invariant failed"');
});

test("retries after each invocation-free handoff during a short platform failure burst", async () => {
  const internal = new Error("internal error; reference = abcdef0123456789");
  let acquisition = 0;
  let time = 0;
  const getTarget = vi.fn(() => {
    acquisition += 1;
    return disposableTarget({
      deploymentVersion: async () => {
        if (acquisition <= 3) throw internal;
        return "version-new";
      },
    });
  });

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
        sleep: async (durationMs) => {
          time += durationMs;
        },
      },
    ),
  ).resolves.toMatchObject({
    readiness: { platformFailures: 3, probes: 4, waitedMs: 15_000 },
  });
  expect(getTarget).toHaveBeenCalledTimes(4);
});

test("releases a hung version probe and retries after an invocation-free handoff", async () => {
  vi.useFakeTimers();
  try {
    const disposals: number[] = [];
    let acquisition = 0;
    const getTarget = vi.fn(() => {
      acquisition += 1;
      if (acquisition === 2) {
        return disposableTarget({ deploymentVersion: async () => "version-new" });
      }
      return disposableTarget({
        dispose: () => disposals.push(acquisition),
        deploymentVersion: () => new Promise<string>(() => undefined),
      });
    });
    const readiness = waitForProjectBirthDeploymentVersion(
      {
        expectedVersion: "version-new",
        getTarget,
        projectId: "prj_test",
        targetKind: "Stream Durable Object",
      },
      { pollIntervalMs: 1_000, probeTimeoutMs: 2_000, timeoutMs: 10_000 },
    );

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(readiness).resolves.toMatchObject({
      readiness: { probeTimeouts: 1, probes: 2, waitedMs: 3_000 },
    });
    expect(disposals).toEqual([1]);
    expect(getTarget).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

function disposableTarget(input: {
  deploymentVersion: () => Promise<string>;
  dispose?: () => void;
}) {
  return {
    [Symbol.dispose]: input.dispose || (() => undefined),
    deploymentVersion: input.deploymentVersion,
  };
}
