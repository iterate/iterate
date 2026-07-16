import { describe, expect, it } from "vitest";
import {
  SCRIPT_EXTERNAL_CLEANUP_GRACE_MS,
  sandboxExecTimeout,
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
  it("caps sandbox exec inside the absolute script deadline", () => {
    const expiresAt = 1_783_012_500_000;
    const ref = scriptWorkerRef({
      code: "async (itx) => itx.sandboxes.get('/sandboxes/test')",
      expiresAt,
      scopePath: "/agents/test",
    });

    if (ref.source.files.type !== "inline") throw new Error("expected inline script worker source");
    const main = ref.source.files.files["main.js"];
    expect(main).toContain(`const executionDeadline = ${expiresAt}`);
    expect(main).toContain(`const externalCleanupGraceMs = ${SCRIPT_EXTERNAL_CLEANUP_GRACE_MS}`);
    expect(main).toContain("const sandboxExecTimeout = ");
    expect(main).toContain("requestedTimeout: options.timeout");
    expect(main).toContain("return target.exec(command, { ...options, timeout })");
  });
});
