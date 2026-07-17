import { describe, expect, it } from "vitest";
import {
  SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS,
  scriptSettlementFromEvent,
  scriptCompletionInput,
  settlementAppendDeadline,
  settlementForLostForegroundRequest,
  settlementForUndrivenScript,
  settlementFromWorkerOutcome,
} from "./script-execution-settlement.ts";

describe("script execution settlement policy", () => {
  it("classifies undriven requests separately from orphaned executions", () => {
    expect(settlementForLostForegroundRequest()).toMatchObject({
      status: "failed",
      failureKind: "orphaned",
      phase: "recovery",
      executionMayHaveOccurred: false,
      cancellation: "not-applicable",
    });
    expect(settlementForUndrivenScript("requested")).toMatchObject({
      status: "failed",
      failureKind: "expired",
      phase: "before-execution",
      executionMayHaveOccurred: false,
      cancellation: "not-applicable",
    });
    expect(settlementForUndrivenScript("started")).toMatchObject({
      status: "failed",
      failureKind: "orphaned",
      phase: "recovery",
      executionMayHaveOccurred: true,
      cancellation: "external-work-may-continue",
    });
  });

  it("accepts only the canonical worker settlement", () => {
    expect(
      settlementFromWorkerOutcome({
        status: "fulfilled",
        value: { status: "succeeded", result: { ok: true } },
      }),
    ).toEqual({ status: "succeeded", result: { ok: true } });
    expect(
      settlementFromWorkerOutcome({
        status: "fulfilled",
        value: { status: "succeeded", result: 1, extra: "not canonical" },
      }),
    ).toMatchObject({
      status: "failed",
      failureKind: "runtime",
      phase: "execution",
      executionMayHaveOccurred: true,
    });
    expect(
      settlementFromWorkerOutcome({
        status: "fulfilled",
        value: { status: "succeeded", result: new Date("2026-07-16T00:00:00Z") },
      }),
    ).toMatchObject({
      status: "failed",
      failureKind: "runtime",
      phase: "execution",
      executionMayHaveOccurred: true,
    });
  });

  it("preserves deadline and rejection evidence", () => {
    expect(settlementFromWorkerOutcome({ status: "deadline" })).toMatchObject({
      status: "failed",
      failureKind: "deadline",
      phase: "execution",
      executionMayHaveOccurred: true,
      cancellation: "external-work-may-continue",
    });
    expect(
      settlementFromWorkerOutcome({ status: "rejected", error: new Error("worker broke") }),
    ).toMatchObject({
      status: "failed",
      error: "worker broke",
      failureKind: "runtime",
      phase: "execution",
      executionMayHaveOccurred: true,
    });
  });

  it("bounds a settlement append by the earliest active execution", () => {
    const now = 100_000;
    expect(
      settlementAppendDeadline([{ expiresAt: now + 5_000 }, { expiresAt: now + 60_000 }], now),
    ).toBe(now + 5_000);
    expect(settlementAppendDeadline([{ expiresAt: now - 1 }], now)).toBe(
      now + SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS,
    );
    expect(() => settlementAppendDeadline([], now)).toThrow(/at least one input/);
  });

  it("omits an undefined result while retaining an explicit JSON result", () => {
    expect(
      scriptCompletionInput({
        executionId: "exec-1",
        idempotencyKey: "completion@exec-1",
        settlement: { status: "succeeded" },
      }),
    ).toEqual({
      type: "events.iterate.com/capability-host/script-run-settled",
      idempotencyKey: "completion@exec-1",
      payload: { executionId: "exec-1", settlement: { status: "succeeded" } },
    });
    expect(
      scriptCompletionInput({
        executionId: "exec-2",
        idempotencyKey: "completion@exec-2",
        settlement: { status: "succeeded", result: { ok: true } },
      }).payload.settlement,
    ).toEqual({ status: "succeeded", result: { ok: true } });
  });

  it("matches only the valid settlement for the requested execution", () => {
    const completed = {
      type: "events.iterate.com/capability-host/script-run-settled",
      createdAt: "2026-07-17T00:00:00.000Z",
      offset: 3,
      path: "/",
      payload: {
        executionId: "exec-1",
        settlement: { status: "succeeded", result: { ok: true } },
      },
    };
    expect(scriptSettlementFromEvent(completed, "exec-1")).toEqual({
      status: "succeeded",
      result: { ok: true },
    });
    expect(scriptSettlementFromEvent(completed, "exec-other")).toBeUndefined();
    expect(
      scriptSettlementFromEvent(
        { ...completed, payload: { executionId: "exec-1", settlement: { status: "wat" } } },
        "exec-1",
      ),
    ).toBeUndefined();
  });
});
