import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "iterate/processors";
import {
  driveScriptExecution,
  scriptExecutionExpiresAt,
  type ScriptExecutionHandoff,
  type ScriptExecutionHost,
  type ScriptExecutionIntent,
} from "./script-execution-driver.ts";
import { DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS } from "./capability-host-processor-contract.ts";

const intent: ScriptExecutionIntent = {
  code: "async () => 42",
  executionId: "exec-test",
  expiresAt: 120_000,
};
const authority = {
  ownerWorkerName: "os-preview-3",
  projectId: "prj_test",
  scopePath: "/agents/test",
};

function completion(settlement: unknown): StreamEvent {
  return {
    type: "events.iterate.com/capability-host/script-run-settled",
    idempotencyKey: "capability-host/script-run-settled@exec-test",
    payload: { executionId: intent.executionId, settlement },
    createdAt: "1970-01-01T00:00:00.000Z",
    offset: 3,
    path: authority.scopePath,
  };
}

function hostWith(handoff: ScriptExecutionHandoff) {
  const settleScriptExecution = vi.fn<ScriptExecutionHost["settleScriptExecution"]>(
    async ({ settlement }) => completion(settlement),
  );
  return {
    host: {
      requestScript: vi.fn(async () => handoff),
      settleScriptExecution,
    } satisfies ScriptExecutionHost,
    settleScriptExecution,
  };
}

describe("script execution driver", () => {
  it("executes only a ready handoff and returns its exact durable settlement", async () => {
    const { host, settleScriptExecution } = hostWith({
      completionIdempotencyKey: "capability-host/script-run-settled@exec-test",
      executionId: intent.executionId,
      expiresAt: intent.expiresAt,
      preparation: { status: "ready", code: intent.code },
    });
    const run = vi.fn(async () => ({ status: "succeeded" as const, result: 42 }));
    const completedEvent = completion({ status: "succeeded", result: 42 });
    const observeCompletion = vi.fn(async () => completedEvent);

    await expect(
      driveScriptExecution({
        authority,
        executor: { run },
        host,
        intent,
        now: () => 1_000,
        observeCompletion,
      }),
    ).resolves.toEqual({
      completedEvent,
      executionId: intent.executionId,
      settlement: { status: "succeeded", result: 42 },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(settleScriptExecution).toHaveBeenCalledWith({
      executionId: intent.executionId,
      settlement: { status: "succeeded", result: 42 },
    });
    expect(observeCompletion).not.toHaveBeenCalled();
  });

  it("observes a replayed handoff without invoking or settling userspace again", async () => {
    const { host, settleScriptExecution } = hostWith({
      completionIdempotencyKey: "capability-host/script-run-settled@exec-test",
      executionId: intent.executionId,
      expiresAt: intent.expiresAt,
      preparation: { status: "observe" },
    });
    const run = vi.fn(async () => ({ status: "succeeded" as const }));
    const settlement = {
      status: "failed" as const,
      error: "script failed",
      failureKind: "runtime" as const,
      phase: "execution" as const,
      executionMayHaveOccurred: true,
      cancellation: "external-work-may-continue" as const,
    };

    await expect(
      driveScriptExecution({
        authority,
        executor: { run },
        host,
        intent,
        now: () => 1_000,
        observeCompletion: async () => completion(settlement),
      }),
    ).resolves.toMatchObject({ settlement });
    expect(run).not.toHaveBeenCalled();
    expect(settleScriptExecution).not.toHaveBeenCalled();
  });
});

describe("script execution expiry", () => {
  it("uses the bounded platform lifetime by default and accepts a shorter explicit timeout", () => {
    expect(scriptExecutionExpiresAt(1_000)).toBe(1_000 + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS);
    expect(scriptExecutionExpiresAt(1_000, 60_000)).toBe(61_000);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects an invalid or overlong timeout (%s)",
    (timeoutMs) => {
      expect(() => scriptExecutionExpiresAt(1_000, timeoutMs)).toThrow(
        `script timeoutMs must be a positive safe integer no greater than ${DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS}`,
      );
    },
  );
});
