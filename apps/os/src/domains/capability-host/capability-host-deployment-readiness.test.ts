import { describe, expect, it, vi } from "vitest";
import { waitForCapabilityHostDeploymentVersion } from "./capability-host-deployment-readiness.ts";

const BASE_INPUT = {
  executionId: "exec-test",
  expectedVersion: "version-new",
  path: "/",
};

describe("waitForCapabilityHostDeploymentVersion", () => {
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
      probes: 1,
      waitedMs: expect.any(Number),
    });
    expect(readVersion).toHaveBeenCalledOnce();
  });

  it("waits for a stale hosting object to converge before work is requested", async () => {
    let time = 0;
    const readVersion = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("version-old")
      .mockResolvedValueOnce("version-new");

    await expect(
      waitForCapabilityHostDeploymentVersion({
        ...BASE_INPUT,
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
      probes: 2,
      waitedMs: 250,
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
      probes: 2,
      waitedMs: 100,
    });
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
