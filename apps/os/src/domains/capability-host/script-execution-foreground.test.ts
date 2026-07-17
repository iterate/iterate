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
  it("returns only after the exact durable event is observed", async () => {
    const commit = vi.fn(async () => undefined);
    const event = { offset: 42 };

    await expect(
      commitForegroundScriptSettlement({ commit, observe: () => Promise.resolve(event) }),
    ).resolves.toBe(event);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("accepts an observed durable event when the commit acknowledgement is lost", async () => {
    const acknowledgement = Promise.withResolvers<void>();
    const event = { offset: 42 };
    const onCommitFailure = vi.fn();
    const result = commitForegroundScriptSettlement({
      commit: () => acknowledgement.promise,
      observe: () => Promise.resolve(event),
      onCommitFailure,
    });

    await expect(result).resolves.toBe(event);
    acknowledgement.reject(new Error("host reset after append"));
    await vi.waitFor(() => expect(onCommitFailure).toHaveBeenCalledOnce());
  });

  it("retries only the idempotent settlement handoff, never userspace", async () => {
    const onCommitFailure = vi.fn();
    const observation = Promise.withResolvers<{ offset: number }>();
    const commit = vi.fn(async () => {
      if (commit.mock.calls.length === 1) throw new Error("lost acknowledgement");
      observation.resolve({ offset: 42 });
    });

    await expect(
      commitForegroundScriptSettlement({
        commit,
        observe: () => observation.promise,
        onCommitFailure,
      }),
    ).resolves.toEqual({ offset: 42 });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(onCommitFailure).toHaveBeenCalledOnce();
  });

  it("fails explicitly after the bounded settlement attempts are exhausted", async () => {
    const observation = Promise.withResolvers<never>();
    const commit = vi.fn(async () => {
      throw new Error("host unavailable");
    });

    await expect(
      commitForegroundScriptSettlement({
        commit,
        maxAttempts: 3,
        observe: () => observation.promise,
      }),
    ).rejects.toThrow(
      "Script settlement commit failed after 3 bounded idempotent attempts: host unavailable",
    );
    expect(commit).toHaveBeenCalledTimes(3);
    observation.reject(new Error("test cleanup"));
    await Promise.resolve();
  });

  it("surfaces an exact-observation failure without leaving commit rejection unhandled", async () => {
    const acknowledgement = Promise.withResolvers<void>();
    const result = commitForegroundScriptSettlement({
      commit: () => acknowledgement.promise,
      observe: () => Promise.reject(new Error("observer protocol defect")),
    });

    await expect(result).rejects.toThrow("observer protocol defect");
    acknowledgement.reject(new Error("late acknowledgement failure"));
    await Promise.resolve();
  });

  it("dispatches the settlement commit before opening its long-lived observer", async () => {
    const order: string[] = [];

    await expect(
      commitForegroundScriptSettlement({
        commit: () => {
          order.push("commit");
          return Promise.resolve();
        },
        observe: () => {
          order.push("observe");
          return Promise.resolve({ offset: 42 });
        },
      }),
    ).resolves.toEqual({ offset: 42 });

    expect(order).toEqual(["commit", "observe"]);
  });
});
