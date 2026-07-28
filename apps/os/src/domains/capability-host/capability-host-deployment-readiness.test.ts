import { describe, expect, it, vi } from "vitest";
import {
  provideCapabilityOnDeploymentReadyHost,
  waitForCapabilityHostDeploymentVersion,
} from "./capability-host-deployment-readiness.ts";
import type { ProvideCapabilityInput } from "./types.ts";

const BASE_INPUT = {
  executionId: "exec-test",
  expectedVersion: "version-new",
  path: "/",
};
const OLD_DEPLOYMENT = {
  id: "version-old",
  timestamp: "2026-07-28T12:46:58.341806Z",
};
const NEW_DEPLOYMENT = {
  id: "version-new",
  timestamp: "2026-07-28T12:48:43.221246Z",
};

describe("waitForCapabilityHostDeploymentVersion", () => {
  it("accepts a target that has already advanced beyond the caller", async () => {
    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        expectedVersion: OLD_DEPLOYMENT,
        readVersion: async () => NEW_DEPLOYMENT,
      }),
    ).resolves.toMatchObject({
      mismatches: 0,
      observedVersion: NEW_DEPLOYMENT,
      probes: 1,
      targetNewer: true,
    });
  });

  it("returns immediately when the hosting object already runs the edge version", async () => {
    const readVersion = vi.fn(async () => "version-new");

    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        readVersion,
      }),
    ).resolves.toEqual({
      lifecycleFailures: 0,
      mismatches: 0,
      observedVersion: { id: "version-new" },
      platformFailures: 0,
      probeTimeouts: 0,
      probes: 1,
      targetNewer: false,
      waitedMs: expect.any(Number),
    });
    expect(readVersion).toHaveBeenCalledOnce();
  });

  it("waits for a stale hosting object to converge before work is requested", async () => {
    let time = 0;
    const readVersion = vi
      .fn<() => Promise<{ id: string; timestamp: string }>>()
      .mockResolvedValueOnce(OLD_DEPLOYMENT)
      .mockResolvedValueOnce(NEW_DEPLOYMENT);

    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        expectedVersion: NEW_DEPLOYMENT,
        now: () => time,
        pollIntervalMs: 250,
        readVersion,
        sleep: async (durationMs) => {
          time += durationMs;
        },
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({
      lifecycleFailures: 0,
      mismatches: 1,
      observedVersion: NEW_DEPLOYMENT,
      platformFailures: 0,
      probeTimeouts: 0,
      probes: 2,
      targetNewer: false,
      waitedMs: 250,
    });
  });

  it("opens progressively longer quiet windows for a stale object to hand off", async () => {
    let time = 0;
    const sleeps: number[] = [];
    const readVersion = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("version-old")
      .mockResolvedValueOnce("version-old")
      .mockResolvedValueOnce("version-old")
      .mockResolvedValueOnce("version-old")
      .mockResolvedValueOnce("version-new");

    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        maxPollIntervalMs: 1_000,
        now: () => time,
        pollIntervalMs: 250,
        readVersion,
        sleep: async (durationMs) => {
          sleeps.push(durationMs);
          time += durationMs;
        },
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      mismatches: 4,
      probes: 5,
      waitedMs: 2_750,
    });
    expect(sleeps).toEqual([250, 500, 1_000, 1_000]);
  });

  it("waits rather than guessing the order of a legacy target id", async () => {
    let time = 0;
    const readVersion = vi
      .fn<() => Promise<string | typeof NEW_DEPLOYMENT>>()
      .mockResolvedValueOnce("version-old")
      .mockResolvedValueOnce(NEW_DEPLOYMENT);

    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        expectedVersion: NEW_DEPLOYMENT,
        now: () => time,
        pollIntervalMs: 250,
        readVersion,
        sleep: async (durationMs) => {
          time += durationMs;
        },
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      mismatches: 1,
      observedVersion: NEW_DEPLOYMENT,
      probes: 2,
      targetNewer: false,
    });
  });

  it("re-acquires after one deployment lifecycle reset", async () => {
    const reset = Object.assign(new Error("code updated"), {
      durableObjectReset: true,
    });
    let time = 0;
    const readVersion = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(reset)
      .mockResolvedValueOnce("version-new");

    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        now: () => time,
        pollIntervalMs: 100,
        readVersion,
        sleep: async (durationMs) => {
          time += durationMs;
        },
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({
      lifecycleFailures: 1,
      mismatches: 0,
      observedVersion: { id: "version-new" },
      platformFailures: 0,
      probeTimeouts: 0,
      probes: 2,
      targetNewer: false,
      waitedMs: 100,
    });
  });

  it("classifies a bounded probe timeout before convergence", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const readVersion = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(() => new Promise<string>(() => {}))
        .mockResolvedValueOnce("version-new");
      const readiness = waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        pollIntervalMs: 100,
        probeTimeoutMs: 200,
        readVersion,
        timeoutMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(300);
      await expect(readiness).resolves.toEqual({
        lifecycleFailures: 0,
        mismatches: 0,
        observedVersion: { id: "version-new" },
        platformFailures: 0,
        probeTimeouts: 1,
        probes: 2,
        targetNewer: false,
        waitedMs: 300,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a second deployment lifecycle reset terminal before journaling", async () => {
    const reset = Object.assign(new Error("code updated"), {
      durableObjectReset: true,
    });
    let time = 0;

    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        now: () => time,
        pollIntervalMs: 100,
        readVersion: async () => {
          throw reset;
        },
        sleep: async (durationMs) => {
          time += durationMs;
        },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(
      "the version probe was reset more than once. The script was not requested and did not run.",
    );
  });

  it("retries one exact transient platform failure before journaling", async () => {
    let time = 0;
    const readVersion = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("internal error; reference = s6apsm9qv3sm4n3kgq3c0uk1"))
      .mockResolvedValueOnce("version-new");

    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        now: () => time,
        pollIntervalMs: 100,
        readVersion,
        sleep: async (durationMs) => {
          time += durationMs;
        },
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({
      lifecycleFailures: 0,
      mismatches: 0,
      observedVersion: { id: "version-new" },
      platformFailures: 1,
      probeTimeouts: 0,
      probes: 2,
      targetNewer: false,
      waitedMs: 100,
    });
  });

  it("keeps a repeated transient platform failure terminal before journaling", async () => {
    const failure = new Error("internal error; reference = s6apsm9qv3sm4n3kgq3c0uk1");
    let time = 0;

    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        now: () => time,
        pollIntervalMs: 100,
        readVersion: async () => {
          throw failure;
        },
        sleep: async (durationMs) => {
          time += durationMs;
        },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(
      "the version probe returned repeated transient platform failures; latest: " +
        '"internal error; reference = s6apsm9qv3sm4n3kgq3c0uk1". ' +
        "The script was not requested and did not run.",
    );
  });

  it("does not broaden the transient classifier to similar application errors", async () => {
    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        readVersion: async () => {
          throw new Error("upstream returned internal error; reference = s6apsm9qv3sm4n3kgq3c0uk1");
        },
      }),
    ).rejects.toThrow(
      'the version probe failed with "upstream returned internal error; reference = ' +
        's6apsm9qv3sm4n3kgq3c0uk1". The script was not requested and did not run.',
    );
  });

  it("fails a persistent mismatch at the safe pre-request boundary", async () => {
    let time = 0;

    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        now: () => time,
        pollIntervalMs: 250,
        readVersion: async () => "version-old",
        sleep: async (durationMs) => {
          time += durationMs;
        },
        timeoutMs: 500,
      }),
    ).rejects.toThrow(
      'it did not converge within 500ms; the last observed version was "version-old". ' +
        "The script was not requested and did not run.",
    );
  });

  it("does not hide an application failure from the version probe", async () => {
    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
        readVersion: async () => {
          throw new Error("permission denied");
        },
      }),
    ).rejects.toThrow(
      'the version probe failed with "permission denied". ' +
        "The script was not requested and did not run.",
    );
  });
});

describe("provideCapabilityOnDeploymentReadyHost", () => {
  const capabilityInput = {
    capability: { ping: () => "pong" },
    path: ["tools", "probe"],
    type: "live",
  } satisfies ProvideCapabilityInput;

  it("provides on the exact re-acquired stub that proved readiness", async () => {
    let time = 0;
    const staleProvide = vi.fn();
    const readyProvide = vi.fn(async () => ({
      path: capabilityInput.path,
      providedAtOffset: 17,
    }));
    const getTarget = vi
      .fn()
      .mockReturnValueOnce({
        deploymentVersion: async () => "version-old",
        provideCapability: staleProvide,
      })
      .mockReturnValueOnce({
        deploymentVersion: async () => "version-new",
        provideCapability: readyProvide,
      });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      provideCapabilityOnDeploymentReadyHost(
        {
          expectedVersion: "version-new",
          getTarget,
          input: capabilityInput,
          path: "/",
          projectId: "prj_test",
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
      provision: { providedAtOffset: 17 },
      readiness: { mismatches: 1, probes: 2 },
    });
    expect(staleProvide).not.toHaveBeenCalled();
    expect(readyProvide).toHaveBeenCalledOnce();
    expect(readyProvide).toHaveBeenCalledWith(capabilityInput);
    info.mockRestore();
  });

  it("does not retain or provide a live target when convergence fails", async () => {
    let time = 0;
    const provideCapability = vi.fn();

    await expect(
      provideCapabilityOnDeploymentReadyHost(
        {
          expectedVersion: "version-new",
          getTarget: () => ({
            deploymentVersion: async () => "version-old",
            provideCapability,
          }),
          input: capabilityInput,
          path: "/agents/test",
          projectId: "prj_test",
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
      'Capability host at "/agents/test" was not ready for deployment version "version-new" ' +
        'before capability "tools.probe" was provided: it did not converge within 500ms; the ' +
        'last observed version was "version-old". The capability was not mounted and its ' +
        "provider was not retained.",
    );
    expect(provideCapability).not.toHaveBeenCalled();
  });
});
