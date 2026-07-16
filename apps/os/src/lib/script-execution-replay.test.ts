import { describe, expect, it } from "vitest";
import { replayScriptExecution } from "./script-execution-replay.ts";

function row(
  offset: number,
  type: string,
  payload: Record<string, unknown>,
  seconds = offset,
): string {
  return JSON.stringify({
    type,
    payload,
    offset,
    createdAt: `2026-07-15T20:30:${String(seconds).padStart(2, "0")}.000Z`,
    path: "/agents/web/demo",
  });
}

describe("replayScriptExecution", () => {
  it("replays current script lifecycle facts and derives duration from started to completed", () => {
    const replay = replayScriptExecution({
      executionId: "agent-output:7",
      nowMs: Date.parse("2026-07-15T20:30:18.000Z"),
      rawEventJsons: [
        row(
          7,
          "events.iterate.com/capability-host/script-execution-requested",
          {
            code: "async () => ({ ok: true })",
            executionId: "agent-output:7",
            expiresAt: 1_789_000_000_000,
          },
          10,
        ),
        row(
          8,
          "events.iterate.com/capability-host/script-execution-started",
          {
            executionId: "agent-output:7",
          },
          12,
        ),
        row(
          9,
          "events.iterate.com/capability-host/script-execution-completed",
          {
            executionId: "agent-output:7",
            settlement: { status: "succeeded", result: { ok: true } },
          },
          17,
        ),
      ],
    });

    expect(replay).toMatchObject({
      executionId: "agent-output:7",
      code: "async () => ({ ok: true })",
      startedAt: "2026-07-15T20:30:12.000Z",
      completedAt: "2026-07-15T20:30:17.000Z",
      expiresAtMs: 1_789_000_000_000,
      outcome: {
        status: "completed",
        durationMs: 5_000,
        errorMessage: null,
        hasResult: true,
        result: { ok: true },
      },
    });
  });

  it("preserves the current error outcome and derives its duration", () => {
    const replay = replayScriptExecution({
      executionId: "failed-1",
      nowMs: Date.parse("2026-07-15T20:30:03.000Z"),
      rawEventJsons: [
        row(1, "events.iterate.com/capability-host/script-execution-requested", {
          code: "async () => boom()",
          executionId: "failed-1",
          expiresAt: Date.parse("2026-07-15T20:30:10.000Z"),
        }),
        "not json",
        row(2, "events.iterate.com/capability-host/script-execution-completed", {
          executionId: "failed-1",
          settlement: {
            status: "failed",
            error: "boom",
            failureKind: "runtime",
            phase: "execution",
            executionMayHaveOccurred: true,
            cancellation: "external-work-may-continue",
          },
        }),
      ],
    });

    expect(replay?.outcome).toEqual({
      status: "failed",
      durationMs: 1_000,
      errorMessage: "boom",
      hasResult: false,
      result: undefined,
      settlement: expect.objectContaining({ status: "failed", error: "boom" }),
    });
  });

  it("shows requested-only and started executions as queued and running", () => {
    const requested = row(1, "events.iterate.com/capability-host/script-execution-requested", {
      code: "async () => 1",
      executionId: "exec-1",
      expiresAt: Date.parse("2026-07-15T20:30:10.000Z"),
    });
    expect(
      replayScriptExecution({
        executionId: "exec-1",
        nowMs: Date.parse("2026-07-15T20:30:02.000Z"),
        rawEventJsons: [requested],
      })?.outcome,
    ).toMatchObject({ status: "queued", durationMs: 1_000 });
    expect(
      replayScriptExecution({
        executionId: "exec-1",
        nowMs: Date.parse("2026-07-15T20:30:03.000Z"),
        rawEventJsons: [
          requested,
          row(2, "events.iterate.com/capability-host/script-execution-started", {
            executionId: "exec-1",
          }),
        ],
      })?.outcome,
    ).toMatchObject({ status: "running", durationMs: 1_000 });
  });

  it("terminalizes an unstarted execution when its absolute deadline elapses", () => {
    const replay = replayScriptExecution({
      executionId: "queued-expired",
      nowMs: Date.parse("2026-07-15T20:30:10.000Z"),
      rawEventJsons: [
        row(1, "events.iterate.com/capability-host/script-execution-requested", {
          code: "async () => 1",
          executionId: "queued-expired",
          expiresAt: Date.parse("2026-07-15T20:30:06.000Z"),
        }),
      ],
    });

    expect(replay?.outcome).toMatchObject({
      status: "failed",
      durationMs: 5_000,
      errorMessage: expect.stringMatching(/did not run/i),
    });
  });

  it("terminalizes a started execution at its deadline without claiming it is safe to rerun", () => {
    const replay = replayScriptExecution({
      executionId: "started-expired",
      nowMs: Date.parse("2026-07-15T20:30:10.000Z"),
      rawEventJsons: [
        row(1, "events.iterate.com/capability-host/script-execution-requested", {
          code: "async () => chargeCard()",
          executionId: "started-expired",
          expiresAt: Date.parse("2026-07-15T20:30:06.000Z"),
        }),
        row(2, "events.iterate.com/capability-host/script-execution-started", {
          executionId: "started-expired",
        }),
      ],
    });

    expect(replay?.outcome).toMatchObject({
      status: "failed",
      durationMs: 4_000,
      errorMessage: expect.stringMatching(/partially executed.*NOT re-run/),
    });
  });

  it("returns null when the requested fact is absent", () => {
    expect(
      replayScriptExecution({ executionId: "missing", nowMs: Date.now(), rawEventJsons: [] }),
    ).toBeNull();
  });

  it("rejects a request without the required absolute deadline", () => {
    expect(
      replayScriptExecution({
        executionId: "missing-deadline",
        nowMs: Date.parse("2026-07-15T20:30:02.000Z"),
        rawEventJsons: [
          row(1, "events.iterate.com/capability-host/script-execution-requested", {
            code: "async () => 1",
            executionId: "missing-deadline",
          }),
        ],
      }),
    ).toBeNull();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a request with invalid absolute deadline %s",
    (expiresAt) => {
      expect(
        replayScriptExecution({
          executionId: "invalid-deadline",
          nowMs: Date.parse("2026-07-15T20:30:02.000Z"),
          rawEventJsons: [
            row(1, "events.iterate.com/capability-host/script-execution-requested", {
              code: "async () => 1",
              executionId: "invalid-deadline",
              expiresAt,
            }),
          ],
        }),
      ).toBeNull();
    },
  );

  it("shows a completion with a malformed settlement as an explicit failure", () => {
    const replay = replayScriptExecution({
      executionId: "malformed-completion",
      nowMs: Date.parse("2026-07-15T20:30:03.000Z"),
      rawEventJsons: [
        row(1, "events.iterate.com/capability-host/script-execution-requested", {
          code: "async () => 1",
          executionId: "malformed-completion",
          expiresAt: Date.parse("2026-07-15T20:30:10.000Z"),
        }),
        row(2, "events.iterate.com/capability-host/script-execution-completed", {
          executionId: "malformed-completion",
          settlement: { status: "failed", error: "missing classification" },
        }),
      ],
    });

    expect(replay?.outcome).toMatchObject({
      status: "failed",
      errorMessage: expect.stringMatching(/no valid settlement/i),
      settlement: null,
    });
  });
});
