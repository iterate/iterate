import { describe, expect, test, vi } from "vitest";
import { createCodemodeContext, type CodemodeSessionCapability } from "./context-proxy.ts";

describe("createCodemodeContext", () => {
  test("calls nested tool function paths through the session capability", async () => {
    const capability = fakeCapability();
    const ctx = createCodemodeContext({
      codemodeSessionCapability: capability,
      scriptExecutionRequestedOffset: 42,
    });

    await ctx.linear.issues.create({ title: "hello" });

    expect(capability.callToolFunction).toHaveBeenCalledWith({
      path: ["linear", "issues", "create"],
      payload: { title: "hello" },
      scriptExecutionRequestedOffset: 42,
    });
  });

  test("supports leaf tool functions", async () => {
    const capability = fakeCapability();
    const ctx = createCodemodeContext({ codemodeSessionCapability: capability });

    await ctx.rollDice({ sides: 20 });

    expect(capability.callToolFunction).toHaveBeenCalledWith({
      path: ["rollDice"],
      payload: { sides: 20 },
      scriptExecutionRequestedOffset: undefined,
    });
  });

  test("keeps codemode controls separate from tool function calls", async () => {
    const abortController = new AbortController();
    const capability = fakeCapability();
    const ctx = createCodemodeContext({
      abortSignal: abortController.signal,
      codemodeSessionCapability: capability,
    });

    const appended = await ctx.codemode.append({
      type: "events.iterate.com/codemode/test-event",
      payload: {},
    });

    expect(appended.offset).toBe(1);
    expect(ctx.codemode.abortSignal).toBe(abortController.signal);
    expect(capability.append).toHaveBeenCalledWith({
      type: "events.iterate.com/codemode/test-event",
      payload: {},
    });
    expect(capability.callToolFunction).not.toHaveBeenCalled();
  });
});

function fakeCapability(): CodemodeSessionCapability {
  return {
    append: vi.fn(async (input) => ({
      ...input,
      createdAt: "2026-01-01T00:00:00.000Z",
      offset: 1,
      streamPath: "/codemode-sessions/test",
    })),
    callToolFunction: vi.fn(async () => ({ ok: true })),
    executeScript: vi.fn(async (input) => ({
      createdAt: "2026-01-01T00:00:00.000Z",
      offset: 2,
      payload: input,
      streamPath: "/codemode-sessions/test",
      type: "events.iterate.com/codemode/script-execution-requested",
    })),
    getStreamPath: vi.fn(async () => "/codemode-sessions/test"),
  };
}
