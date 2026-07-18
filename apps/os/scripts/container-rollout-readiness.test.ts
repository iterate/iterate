import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForContainerRollouts } from "./container-rollout-readiness.ts";

const healthy: {
  errors: unknown[];
  instances: { failed: number; healthy: number; scheduling: number; starting: number };
} = {
  errors: [],
  instances: { failed: 0, healthy: 7, scheduling: 0, starting: 0 },
};

function rollout(status: string, id = "rollout-a") {
  return {
    health: healthy,
    id,
    progress: {
      total_instances: 7,
      updated_instances: status === "completed" ? 7 : 1,
      version_distribution: { target_version_percentage: status === "completed" ? 100 : 10 },
    },
    status,
    steps: [{ status: status === "completed" ? "completed" : "progressing" }],
    target_version: 2,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("waitForContainerRollouts", () => {
  it("polls every active application concurrently until its rollout is complete", async () => {
    const calls: string[] = [];
    const cf = vi.fn(async (path: string) => {
      calls.push(path);
      if (path === "/containers/applications?per_page=1000") {
        return [
          { health: healthy, id: "app-a", instances: 7, name: "sandbox-a" },
          { health: healthy, id: "app-b", instances: 7, name: "sandbox-b" },
        ];
      }
      if (path === "/containers/applications/app-a/rollouts?limit=1") {
        return [rollout("progressing")];
      }
      if (path === "/containers/applications/app-b/rollouts?limit=1") {
        return [rollout("completed", "rollout-b")];
      }
      if (path === "/containers/applications/app-a/rollouts/rollout-a") {
        return rollout("completed");
      }
      throw new Error(`Unexpected path ${path}`);
    });

    await expect(
      waitForContainerRollouts({
        applicationNames: ["sandbox-b", "sandbox-a"],
        cf,
        sleep: async () => {},
      }),
    ).resolves.toEqual({ applications: 2, pendingApplications: 1 });
    expect(calls).toContain("/containers/applications/app-a/rollouts/rollout-a");
  });

  it("rejects a replaced rollout instead of treating it as settled", async () => {
    const cf = vi.fn(async (path: string) =>
      path === "/containers/applications?per_page=1000"
        ? [{ health: healthy, id: "app-a", instances: 7, name: "sandbox-a" }]
        : [rollout("replaced")],
    );

    await expect(waitForContainerRollouts({ applicationNames: ["sandbox-a"], cf })).rejects.toThrow(
      /did not complete.*replaced/,
    );
  });

  it("rejects a completed rollout with unexplained health errors", async () => {
    const unhealthy = rollout("completed");
    unhealthy.health = {
      errors: [{ code: "instance-start-failed" }],
      instances: { failed: 1, healthy: 6, scheduling: 0, starting: 0 },
    };
    const cf = vi.fn(async (path: string) =>
      path === "/containers/applications?per_page=1000"
        ? [{ health: healthy, id: "app-a", instances: 7, name: "sandbox-a" }]
        : [unhealthy],
    );

    await expect(waitForContainerRollouts({ applicationNames: ["sandbox-a"], cf })).rejects.toThrow(
      /completed unhealthily.*instance-start-failed/,
    );
  });

  it("keeps polling when a completed rollout still has an instance starting", async () => {
    const settling = rollout("completed");
    settling.health = {
      errors: [],
      instances: { failed: 0, healthy: 6, scheduling: 0, starting: 1 },
    };
    const calls: string[] = [];
    const cf = vi.fn(async (path: string) => {
      calls.push(path);
      if (path === "/containers/applications?per_page=1000") {
        return [{ health: healthy, id: "app-a", instances: 7, name: "sandbox-a" }];
      }
      if (path === "/containers/applications/app-a/rollouts?limit=1") return [settling];
      if (path === "/containers/applications/app-a/rollouts/rollout-a") {
        return rollout("completed");
      }
      throw new Error(`Unexpected path ${path}`);
    });

    await expect(
      waitForContainerRollouts({
        applicationNames: ["sandbox-a"],
        cf,
        sleep: async () => {},
      }),
    ).resolves.toEqual({ applications: 1, pendingApplications: 1 });
    expect(calls).toContain("/containers/applications/app-a/rollouts/rollout-a");
  });

  it("waits for a new application with no rollout to finish scheduling", async () => {
    const calls: string[] = [];
    const cf = vi.fn(async (path: string) => {
      calls.push(path);
      if (path === "/containers/applications?per_page=1000") {
        return [
          {
            health: {
              errors: [],
              instances: { failed: 0, healthy: 0, scheduling: 1, starting: 0 },
            },
            id: "app-a",
            instances: 1,
            name: "sandbox-a",
          },
        ];
      }
      if (path === "/containers/applications/app-a/rollouts?limit=1") return [];
      if (path === "/containers/applications/app-a") {
        return { health: healthy, id: "app-a", instances: 1, name: "sandbox-a" };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    await expect(
      waitForContainerRollouts({
        applicationNames: ["sandbox-a"],
        cf,
        sleep: async () => {},
      }),
    ).resolves.toEqual({ applications: 1, pendingApplications: 1 });
    expect(calls).toContain("/containers/applications/app-a");
  });

  it("fails with the last observed progress when a rollout does not settle", async () => {
    vi.useFakeTimers();
    const cf = vi.fn(async (path: string) =>
      path === "/containers/applications?per_page=1000"
        ? [{ health: healthy, id: "app-a", instances: 7, name: "sandbox-a" }]
        : path.endsWith("?limit=1")
          ? [rollout("progressing")]
          : rollout("progressing"),
    );
    const readiness = waitForContainerRollouts({
      applicationNames: ["sandbox-a"],
      cf,
      pollIntervalMs: 2_000,
      timeoutMs: 5_000,
    });
    const rejection = expect(readiness).rejects.toThrow(
      /did not settle within 5\.0s.*sandbox-a: progressing.*updated=1\/7/,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
  });

  it("fails when a configured application is absent", async () => {
    await expect(
      waitForContainerRollouts({ applicationNames: ["sandbox-a"], cf: async () => [] }),
    ).rejects.toThrow(/exactly one.*sandbox-a.*found 0/);
  });
});
