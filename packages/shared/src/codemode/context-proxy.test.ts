import { describe, expect, test, vi } from "vitest";
import { createCodemodeContext, type CodemodeSessionCapability } from "./context-proxy.ts";

describe("createCodemodeContext", () => {
  test("calls nested function paths through the session capability", async () => {
    const capability = fakeCapability();
    const ctx = createCodemodeContext({
      codemodeSessionCapability: capability,
      scriptExecutionId: "script-42",
    });

    await ctx.linear.issues.create({ title: "hello" });

    expect(capability.callFunction).toHaveBeenCalledWith({
      input: { title: "hello" },
      path: ["linear", "issues", "create"],
      scriptExecutionId: "script-42",
    });
  });

  test("supports leaf functions", async () => {
    const capability = fakeCapability();
    const ctx = createCodemodeContext({ codemodeSessionCapability: capability });

    await ctx.rollDice({ sides: 20 });

    expect(capability.callFunction).toHaveBeenCalledWith({
      input: { sides: 20 },
      path: ["rollDice"],
      scriptExecutionId: undefined,
    });
  });

  test("does not treat promise inspection keys as function path segments", () => {
    const capability = fakeCapability();
    const ctx = createCodemodeContext({ codemodeSessionCapability: capability });

    expect(ctx.linear.then).toBeUndefined();
    expect(ctx.linear.catch).toBeUndefined();
    expect(ctx.linear.finally).toBeUndefined();
    expect(capability.callFunction).not.toHaveBeenCalled();
  });

  test("exposes abort signal without creating a function call", () => {
    const abortController = new AbortController();
    const capability = fakeCapability();
    const ctx = createCodemodeContext({
      abortSignal: abortController.signal,
      codemodeSessionCapability: capability,
    });

    expect(ctx.abortSignal).toBe(abortController.signal);
    expect(capability.callFunction).not.toHaveBeenCalled();
  });
});

function fakeCapability(): CodemodeSessionCapability {
  return {
    callFunction: vi.fn(async () => ({ ok: true })),
  };
}
