import { describe, expect, it, vi } from "vitest";
import { StreamIdMismatchError, streamIdMismatchMessage } from "iterate/processors";
import { MemoryStream } from "iterate/processors/testing";
import {
  SCRIPT_EXTERNAL_CLEANUP_GRACE_MS,
  appendScriptExecutionSettlement,
  sandboxExecTimeout,
  settlementFromScriptInvocation,
  scriptWorkerRef,
} from "./script-execution-entrypoint.ts";

describe("sandboxExecTimeout", () => {
  const base = {
    executionDeadline: 30_000,
    externalCleanupGraceMs: 5_000,
    nowMs: 10_000,
  };

  it("caps a requested timeout to the execution budget", () => {
    expect(sandboxExecTimeout({ ...base, requestedTimeout: 60_000 })).toBe(15_000);
  });

  it("preserves a shorter positive timeout", () => {
    expect(sandboxExecTimeout({ ...base, requestedTimeout: 2_500 })).toBe(2_500);
  });

  it.each([undefined, "2500", 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "uses the remaining budget for invalid timeout %s",
    (requestedTimeout) => {
      expect(sandboxExecTimeout({ ...base, requestedTimeout })).toBe(15_000);
    },
  );

  it("refuses to start when cleanup no longer fits before the deadline", () => {
    expect(() => sandboxExecTimeout({ ...base, nowMs: 25_000, requestedTimeout: 1 })).toThrow(
      /no time to start/,
    );
  });
});

describe("scriptWorkerRef", () => {
  it("caps sandbox exec and rejects unbounded streaming exec inside scripts", () => {
    const expiresAt = 1_783_012_500_000;
    const ref = scriptWorkerRef({
      code: "async (itx) => itx.sandboxes.get('/sandboxes/test')",
      expiresAt,
      scopePath: "/agents/test",
    });

    if (!("createWorker" in ref.source) || ref.source.createWorker.files.type !== "inline")
      throw new Error("expected inline createWorker source");
    const main = ref.source.createWorker.files.files["main.js"];
    expect(main).toContain(`const executionDeadline = ${expiresAt}`);
    expect(main).toContain(`const externalCleanupGraceMs = ${SCRIPT_EXTERNAL_CLEANUP_GRACE_MS}`);
    expect(main).toContain("const sandboxExecTimeout = ");
    expect(main).toContain("function receiverSafeProperty(target, property)");
    expect(main).toContain("return new Proxy(value");
    expect(main).toContain("Reflect.apply(callable, target, args)");
    expect(main).toContain("receiverSafeProperty(callable, childProperty)");
    expect(main).toContain('if (property === "then")');
    expect(main).toContain("if (resolved) return undefined");
    expect(main).toContain("onFulfilled(sandboxWithExecutionDeadline(value, true))");
    expect(main).toContain("requestedTimeout: options.timeout");
    expect(main).toContain(
      "return Reflect.apply(exec, target, [command, { ...options, timeout }])",
    );
    expect(main).toContain('if (property === "execStream")');
    expect(main).toContain("sandbox.execStream is unavailable inside scripts");
    expect(main).toContain("sandboxWithExecutionDeadline(Reflect.apply(get, target, args))");
    expect(main).not.toContain("target.get(...args)");
    expect(main).not.toContain("target.exec(command");
    expect(main).not.toContain("sandboxWithExecutionDeadline(await target.get(...args))");
  });
});

describe("executor-owned durable settlement", () => {
  const projectId = "prj_test";
  const scopePath = "/agents/test";

  it("replays one keyed append after a Stream DO lifecycle reset and commits once", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const stream = new MemoryStream(scopePath);
      let attempts = 0;
      await appendScriptExecutionSettlement({
        executionId: "exec-retry",
        getStream: () => ({
          appendIfStreamId: (input) => {
            attempts += 1;
            if (attempts === 1) {
              throw Object.assign(new Error("storage reset"), { durableObjectReset: true });
            }
            return stream.appendIfStreamId(input);
          },
          getEvent: (input) => stream.getEvent(input),
        }),
        projectId,
        scopePath,
        settlement: { status: "succeeded", result: 42 },
        settlementExpiresAt: Date.now() + 60_000,
        streamId: stream.streamId,
      });

      expect(attempts).toBe(2);
      expect(stream.events).toMatchObject([
        {
          idempotencyKey: "capability-host/script-run-settled@exec-retry",
          payload: {
            executionId: "exec-retry",
            settlement: { status: "succeeded", result: 42 },
          },
          source: {
            processor: {
              slug: "capability-host",
              stream: { path: scopePath, projectId, streamId: stream.streamId },
            },
          },
        },
      ]);
      expect(consoleWarn).toHaveBeenCalledWith(
        "[script-execution] retrying keyed settlement append",
        expect.objectContaining({ attempt: 1, executionId: "exec-retry", maxAttempts: 2 }),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("accepts the durable winner when a deadline orphan beats a late executor result", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const stream = new MemoryStream(scopePath);
      await stream.append({
        type: "events.iterate.com/capability-host/script-run-settled",
        idempotencyKey: "capability-host/script-run-settled@exec-late",
        payload: {
          executionId: "exec-late",
          settlement: {
            status: "failed",
            error: "deadline orphan",
            failureKind: "orphaned",
            phase: "recovery",
            executionMayHaveOccurred: true,
            cancellation: "external-work-may-continue",
          },
        },
      });

      await appendScriptExecutionSettlement({
        executionId: "exec-late",
        getStream: () => stream,
        projectId,
        scopePath,
        settlement: { status: "succeeded", result: "too late" },
        settlementExpiresAt: Date.now() + 60_000,
        streamId: stream.streamId,
      });

      expect(stream.events).toHaveLength(1);
      expect(consoleInfo).toHaveBeenCalledWith(
        "[script-execution] late settlement superseded by durable outcome",
        expect.objectContaining({
          attemptedStatus: "succeeded",
          durableFailureKind: "orphaned",
          executionId: "exec-late",
        }),
      );
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("does not leak an old executor result into a recreated stream lifetime", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const oldStreamId = "11111111-1111-4111-8111-111111111111";
      const newStreamId = "22222222-2222-4222-8222-222222222222";
      await appendScriptExecutionSettlement({
        executionId: "exec-old-lifetime",
        getStream: () => ({
          appendIfStreamId: () => {
            throw new StreamIdMismatchError(streamIdMismatchMessage(oldStreamId, newStreamId));
          },
          getEvent: () => undefined,
        }),
        projectId,
        scopePath,
        settlement: { status: "succeeded", result: "stale" },
        settlementExpiresAt: Date.now() + 60_000,
        streamId: oldStreamId,
      });

      expect(consoleInfo).toHaveBeenCalledWith(
        "[script-execution] settlement abandoned with replaced stream lifetime",
        expect.objectContaining({ executionId: "exec-old-lifetime", streamId: oldStreamId }),
      );
    } finally {
      consoleInfo.mockRestore();
    }
  });
});

describe("settlementFromScriptInvocation", () => {
  it("normalizes successful JSON results", async () => {
    await expect(
      settlementFromScriptInvocation(
        Promise.resolve({ at: new Date("2026-07-28T12:00:00Z") }),
        Date.now() + 1_000,
      ),
    ).resolves.toEqual({
      status: "succeeded",
      result: { at: "2026-07-28T12:00:00.000Z" },
    });
  });

  it("classifies rejected and unserializable results as execution failures", async () => {
    await expect(
      settlementFromScriptInvocation(Promise.reject(new Error("worker broke")), Date.now() + 1_000),
    ).resolves.toMatchObject({
      status: "failed",
      error: "worker broke",
      failureKind: "runtime",
      phase: "execution",
    });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      settlementFromScriptInvocation(Promise.resolve(cyclic), Date.now() + 1_000),
    ).resolves.toMatchObject({
      status: "failed",
      failureKind: "runtime",
      phase: "execution",
    });
  });

  it("classifies an exhausted execution deadline without replaying the invocation", async () => {
    await expect(
      settlementFromScriptInvocation(new Promise<never>(() => {}), Date.now() - 1),
    ).resolves.toMatchObject({
      status: "failed",
      failureKind: "deadline",
      phase: "execution",
      executionMayHaveOccurred: true,
    });
  });
});
