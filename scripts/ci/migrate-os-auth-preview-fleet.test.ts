import { describe, expect, it, vi } from "vitest";
import {
  cutoverLeaseRequest,
  drainLegacyPreviewChecks,
  listPreviewChecksForRefs,
  migratePreviewFleet,
  previewFleetTargets,
  withGitHubSecondaryRateLimitRetry,
  type PreviewFleetMigrationDependencies,
} from "./migrate-os-auth-preview-fleet.ts";

function dependencies(
  overrides: Partial<PreviewFleetMigrationDependencies> = {},
): PreviewFleetMigrationDependencies {
  return {
    acquireSlot: vi.fn(async (target) => ({ leaseId: `lease-${target.envName}` })),
    deployAuth: vi.fn(async () => undefined),
    deployOs: vi.fn(async () => undefined),
    drainLegacyPreviewChecks: vi.fn(async () => undefined),
    enforceRetirement: vi.fn(async () => undefined),
    releaseSlot: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("migratePreviewFleet", () => {
  it("drains, force-leases, migrates, verifies, and only then releases the whole fleet", async () => {
    const events: string[] = [];
    const deps = dependencies({
      drainLegacyPreviewChecks: vi.fn(async () => {
        events.push("drain");
      }),
      acquireSlot: vi.fn(async (target) => {
        events.push(`acquire:${target.envName}`);
        return { leaseId: `lease-${target.envName}` };
      }),
      deployAuth: vi.fn(async (target) => {
        events.push(`auth:${target.envName}`);
      }),
      deployOs: vi.fn(async (target) => {
        events.push(`os:${target.envName}`);
      }),
      enforceRetirement: vi.fn(async (target) => {
        events.push(`verify:${target.envName}`);
      }),
      releaseSlot: vi.fn(async (target) => {
        events.push(`release:${target.envName}`);
      }),
    });

    const result = await migratePreviewFleet(deps);

    expect(result.migrated).toEqual(previewFleetTargets.map((target) => target.envName));
    expect(events[0]).toBe("drain");
    const firstAcquire = events.findIndex((event) => event.startsWith("acquire:"));
    const firstDeploy = events.findIndex((event) => event.startsWith("auth:"));
    const firstVerify = events.findIndex((event) => event.startsWith("verify:"));
    const firstRelease = events.findIndex((event) => event.startsWith("release:"));
    expect(events.slice(firstAcquire, firstDeploy)).toEqual(
      previewFleetTargets.map((target) => `acquire:${target.envName}`),
    );
    expect(events.slice(firstDeploy, firstVerify)).toEqual(
      previewFleetTargets.flatMap((target) => [`auth:${target.envName}`, `os:${target.envName}`]),
    );
    expect(events.slice(firstVerify, firstRelease)).toEqual(
      previewFleetTargets.map((target) => `verify:${target.envName}`),
    );
    expect(events.slice(firstRelease)).toEqual(
      previewFleetTargets.map((target) => `release:${target.envName}`),
    );
  });

  it("retains every cutover lease when a deployment fails", async () => {
    const releaseSlot = vi.fn(async () => undefined);
    const enforceRetirement = vi.fn(async () => undefined);
    const deps = dependencies({
      deployAuth: vi.fn(async () => {
        throw new Error("deploy failed");
      }),
      releaseSlot,
      enforceRetirement,
    });

    await expect(migratePreviewFleet(deps)).rejects.toThrow("deploy failed");
    expect(releaseSlot).not.toHaveBeenCalled();
    expect(enforceRetirement).not.toHaveBeenCalled();
    expect(deps.acquireSlot).toHaveBeenCalledTimes(previewFleetTargets.length);
  });

  it("unwinds a partial lease acquisition before any code deploy starts", async () => {
    const releaseSlot = vi.fn(async () => undefined);
    const deps = dependencies({
      acquireSlot: vi.fn(async (target) => {
        if (target.envName === "preview_3") throw new Error("lease acquisition failed");
        return { leaseId: `lease-${target.envName}` };
      }),
      releaseSlot,
    });

    await expect(migratePreviewFleet(deps)).rejects.toThrow("lease acquisition failed");
    expect(deps.deployAuth).not.toHaveBeenCalled();
    expect(deps.deployOs).not.toHaveBeenCalled();
    expect(releaseSlot.mock.calls).toEqual([
      [previewFleetTargets[0], "lease-preview_1"],
      [previewFleetTargets[1], "lease-preview_2"],
    ]);
  });
});

describe("cutoverLeaseRequest", () => {
  it("force-acquires the existing environment lease under one attributable bounded holder", () => {
    expect(cutoverLeaseRequest(previewFleetTargets[3])).toEqual({
      type: "environment-config-lease",
      slug: "preview-4",
      leaseMs: 3 * 60 * 60_000,
      holder: "main-auth-rpc-security-cutover",
      force: true,
    });
  });
});

describe("GitHub check discovery", () => {
  it("deduplicates refs, keeps one request in flight, and honors Retry-After", async () => {
    const calls: string[] = [];
    const sleep = vi.fn(async () => undefined);
    let active = 0;
    let maxActive = 0;
    let firstRefAttempts = 0;

    const checks = await listPreviewChecksForRefs({
      refs: ["first", "first", "second"],
      sleep,
      listChecksForRef: async (ref) => {
        calls.push(ref);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (ref === "first" && firstRefAttempts++ === 0) {
            throw Object.assign(new Error("You have exceeded a secondary rate limit."), {
              status: 403,
              response: { headers: { "retry-after": "1" } },
            });
          }
          await Promise.resolve();
          return [{ id: calls.length, name: ref, status: "completed" }];
        } finally {
          active -= 1;
        }
      },
    });

    expect(calls).toEqual(["first", "first", "second"]);
    expect(maxActive).toBe(1);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(checks.map((check) => check.name)).toEqual(["first", "second"]);
  });

  it("does not retry an ordinary authorization failure", async () => {
    const forbidden = Object.assign(new Error("Resource not accessible by integration"), {
      status: 403,
      response: { headers: {} },
    });
    const operation = vi.fn(async () => {
      throw forbidden;
    });
    const sleep = vi.fn(async () => undefined);

    await expect(withGitHubSecondaryRateLimitRetry(operation, { sleep })).rejects.toBe(forbidden);
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("drainLegacyPreviewChecks", () => {
  it("drains running legacy checks without deadlocking on epoch-aware checks queued behind its gate", async () => {
    const statuses = new Map([[11, ["in_progress", "completed"]]]);
    const readCheck = vi.fn(async (id: number) => {
      const sequence = statuses.get(id);
      if (!sequence) throw new Error(`unexpected check ${id}`);
      return {
        id,
        name: "Cloudflare Previews (Depot CI) / Preview / deploy + e2e",
        status: sequence.shift() ?? "completed",
      };
    });
    let now = 0;

    await drainLegacyPreviewChecks({
      listBlockingChecks: async () => [
        {
          id: 11,
          name: "Cloudflare Previews (Depot CI) / Preview / deploy + e2e",
          status: "in_progress",
        },
        {
          id: 12,
          name: "Cloudflare Preview Cleanup (Depot CI) / Preview / cleanup",
          status: "queued",
        },
        { id: 13, name: "Test / test", status: "in_progress" },
      ],
      readCheck,
      now: () => now,
      sleep: async () => {
        now += 1;
      },
      timeoutMs: 10,
      pollMs: 1,
    });

    expect(readCheck).toHaveBeenCalledTimes(2);
    expect(readCheck).toHaveBeenCalledWith(11);
    expect(readCheck).not.toHaveBeenCalledWith(12);
  });

  it("fails closed when a snapshotted preview check does not drain", async () => {
    let now = 0;
    await expect(
      drainLegacyPreviewChecks({
        listBlockingChecks: async () => [
          {
            id: 11,
            name: "Cloudflare Previews (Depot CI) / Preview / deploy + e2e",
            status: "in_progress",
          },
        ],
        readCheck: async () => ({
          id: 11,
          name: "Cloudflare Previews (Depot CI) / Preview / deploy + e2e",
          status: "in_progress",
        }),
        now: () => now,
        sleep: async () => {
          now += 5;
        },
        timeoutMs: 5,
        pollMs: 1,
      }),
    ).rejects.toThrow("Timed out draining pre-cutover preview checks");
  });
});
