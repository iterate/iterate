import { describe, expect, it, vi } from "vitest";
import { SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS } from "./script-execution-settlement.ts";
import {
  commitForegroundScriptSettlement,
  executeForegroundScript,
} from "./script-execution-foreground.ts";

const authority = {
  ownerWorkerName: "os-preview-3",
  projectId: "prj_test",
  scopePath: "/agents/test",
};

describe("foreground script execution", () => {
  it("invokes the executor with the settlement reserve removed from its deadline", async () => {
    const now = 100_000;
    const run = vi.fn(async () => ({ status: "succeeded" as const, result: 42 }));

    await expect(
      executeForegroundScript({
        authority,
        executor: { run },
        now: () => now,
        preparation: {
          code: "async () => 42",
          emittedJs: "export default async () => 42",
          expiresAt: now + SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS + 5_000,
        },
      }),
    ).resolves.toEqual({ status: "succeeded", result: 42 });

    expect(run).toHaveBeenCalledWith({
      authority,
      code: "async () => 42",
      emittedJs: "export default async () => 42",
      expiresAt: now + 5_000,
    });
  });

  it("never invokes userspace when preparation consumed the execution window", async () => {
    const now = 100_000;
    const run = vi.fn(async () => ({ status: "succeeded" as const }));

    await expect(
      executeForegroundScript({
        authority,
        executor: { run },
        now: () => now,
        preparation: {
          code: "async () => null",
          expiresAt: now + SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS,
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      failureKind: "deadline",
      phase: "before-execution",
      executionMayHaveOccurred: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("classifies an executor RPC rejection without replaying it", async () => {
    const now = 100_000;
    const run = vi.fn(async () => {
      throw new Error("executor disconnected");
    });

    await expect(
      executeForegroundScript({
        authority,
        executor: { run },
        now: () => now,
        preparation: {
          code: "async () => null",
          expiresAt: now + SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS + 5_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: "executor disconnected",
      failureKind: "runtime",
      executionMayHaveOccurred: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("foreground script settlement commit", () => {
  it("returns the acknowledged durable event without opening an observer", async () => {
    const event = { offset: 42 };
    const commit = vi.fn(async () => event);
    const observe = vi.fn(async () => {
      throw new Error("the healthy path must not observe");
    });

    await expect(commitForegroundScriptSettlement({ commit, observe })).resolves.toBe(event);
    expect(commit).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
  });

  it("accepts an observed durable event when the commit acknowledgement is lost", async () => {
    const event = { offset: 42 };
    const onCommitFailure = vi.fn();
    const commit = vi.fn(async () => {
      throw new Error("host reset after append");
    });

    await expect(
      commitForegroundScriptSettlement({
        commit,
        maxAttempts: 2,
        observe: () => Promise.resolve(event),
        onCommitFailure,
      }),
    ).resolves.toBe(event);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(onCommitFailure).toHaveBeenCalledTimes(2);
  });

  it("retries only the idempotent settlement handoff, never userspace", async () => {
    const event = { offset: 42 };
    const onCommitFailure = vi.fn();
    const observe = vi.fn(async () => event);
    const commit = vi.fn(async () => {
      if (commit.mock.calls.length === 1) throw new Error("lost acknowledgement");
      return event;
    });

    await expect(
      commitForegroundScriptSettlement({
        commit,
        observe,
        onCommitFailure,
      }),
    ).resolves.toBe(event);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(onCommitFailure).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
  });

  it("fails explicitly when bounded commits and exact observation both fail", async () => {
    const commit = vi.fn(async () => {
      throw new Error("host unavailable");
    });

    await expect(
      commitForegroundScriptSettlement({
        commit,
        maxAttempts: 3,
        observe: () => Promise.reject(new Error("event unavailable")),
      }),
    ).rejects.toThrow(
      "Script settlement commit failed after 3 bounded idempotent attempts (host unavailable), and its exact durable outcome could not be observed: event unavailable",
    );
    expect(commit).toHaveBeenCalledTimes(3);
  });

  it("does not observe until every bounded commit acknowledgement has failed", async () => {
    const order: string[] = [];

    await expect(
      commitForegroundScriptSettlement({
        commit: async () => {
          order.push("commit");
          throw new Error("lost acknowledgement");
        },
        maxAttempts: 2,
        observe: async () => {
          order.push("observe");
          return { offset: 42 };
        },
      }),
    ).resolves.toEqual({ offset: 42 });

    expect(order).toEqual(["commit", "commit", "observe"]);
  });
});
