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

  it("accepts a fully updated rollout while an updated instance is still starting", async () => {
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
    ).resolves.toEqual({ applications: 1, pendingApplications: 0 });
    expect(calls).not.toContain("/containers/applications/app-a/rollouts/rollout-a");
  });

  it("keeps polling when completed status precedes full rollout progress", async () => {
    const incomplete = rollout("completed");
    incomplete.progress.updated_instances = 6;
    incomplete.progress.version_distribution.target_version_percentage = 86;
    incomplete.steps = [{ status: "progressing" }];
    const calls: string[] = [];
    const cf = vi.fn(async (path: string) => {
      calls.push(path);
      if (path === "/containers/applications?per_page=1000") {
        return [{ health: healthy, id: "app-a", instances: 7, name: "sandbox-a" }];
      }
      if (path === "/containers/applications/app-a/rollouts?limit=1") return [incomplete];
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

  it("treats running containers as ready when they move out of the healthy bucket", async () => {
    const active = {
      errors: [],
      instances: {
        active: 4,
        assigned: 0,
        failed: 0,
        healthy: 0,
        scheduling: 0,
        starting: 0,
        stopped: 0,
      },
    };
    const cf = vi.fn(async (path: string) => {
      if (path === "/containers/applications?per_page=1000") {
        return [{ health: active, id: "app-a", instances: 4, name: "builder-pool" }];
      }
      if (path === "/containers/applications/app-a/rollouts?limit=1") return [];
      throw new Error(`Unexpected path ${path}`);
    });

    await expect(
      waitForContainerRollouts({ applicationNames: ["builder-pool"], cf }),
    ).resolves.toEqual({ applications: 1, pendingApplications: 0 });
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
