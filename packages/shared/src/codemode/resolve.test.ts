/**
 * Tests for resolveToolProviderDescriptor.
 *
 * The resolve module converts a ToolProviderDescriptor (wire format) into a
 * ToolProvider (runtime interface) by dispatching callables. We mock
 * dispatchCallable to avoid needing real Worker bindings.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../callable/runtime.ts", () => ({
  dispatchCallable: vi.fn(),
}));

import { dispatchCallable } from "../callable/runtime.ts";
import type { CallableContext } from "../callable/types.ts";
import { resolveToolProviderDescriptor } from "./resolve.ts";
import type { ToolProviderDescriptor } from "./types.ts";

const mockDispatch = vi.mocked(dispatchCallable);

const fakeCtx: CallableContext = {
  env: {},
  exports: {},
};

function makeDescriptor(overrides?: Partial<ToolProviderDescriptor>): ToolProviderDescriptor {
  return {
    path: ["mcp", "test"],
    callable: {
      type: "workers-rpc",
      via: {
        type: "loopback-binding",
        bindingType: "service",
        exportName: "TestBridge",
      },
      rpcMethod: "executeToolFunction",
    },
    ...overrides,
  };
}

describe("resolveToolProviderDescriptor", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
  });

  // --- execute ---

  it("delegates callToolFunction to dispatchCallable with path and payload", async () => {
    mockDispatch.mockResolvedValueOnce({ result: "ok" });
    const descriptor = makeDescriptor();
    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);

    const result = await provider.executeToolFunction(["createIssue"], { title: "Bug" });

    expect(mockDispatch).toHaveBeenCalledOnce();
    expect(mockDispatch).toHaveBeenCalledWith({
      callable: descriptor.callable,
      payload: { path: ["createIssue"], payload: { title: "Bug" } },
      ctx: fakeCtx,
    });
    expect(result).toEqual({ result: "ok" });
  });

  it("propagates errors from executeToolFunction dispatch", async () => {
    mockDispatch.mockRejectedValueOnce(new Error("dispatch failed"));
    const provider = resolveToolProviderDescriptor(makeDescriptor(), fakeCtx);

    await expect(provider.executeToolFunction(["tool"], {})).rejects.toThrow("dispatch failed");
  });

  // --- describe through the same callable ---

  it("dispatches __describe through the provider callable and returns typeDefinitions", async () => {
    const descriptor = makeDescriptor();

    mockDispatch.mockResolvedValueOnce({
      typeDefinitions: "declare const mcp: { test: { createIssue: () => void } }",
    });

    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);
    const result = await provider.describeToolFunctions();

    expect(mockDispatch).toHaveBeenCalledWith({
      callable: descriptor.callable,
      payload: { path: ["__describe"], payload: {} },
      ctx: fakeCtx,
    });
    expect(result.typeDefinitions).toBe("declare const mcp: { test: { createIssue: () => void } }");
  });

  // --- describe fallback (malformed data from callable) ---

  it("returns fallback when __describe returns null", async () => {
    const descriptor = makeDescriptor();

    mockDispatch.mockResolvedValueOnce(null);
    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);
    const result = await provider.describeToolFunctions();

    expect(result.typeDefinitions).toContain("mcp.test");
    expect(result.typeDefinitions).toContain("__describe");
  });

  it("returns fallback when __describe returns a non-object", async () => {
    const descriptor = makeDescriptor();

    mockDispatch.mockResolvedValueOnce("not an object");
    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);
    const result = await provider.describeToolFunctions();

    expect(result.typeDefinitions).toContain("__describe");
  });

  it("returns fallback when __describe returns object without typeDefinitions", async () => {
    const descriptor = makeDescriptor();

    mockDispatch.mockResolvedValueOnce({ something: "else" });
    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);
    const result = await provider.describeToolFunctions();

    expect(result.typeDefinitions).toContain("__describe");
  });

  it("returns fallback when typeDefinitions is not a string", async () => {
    const descriptor = makeDescriptor();

    mockDispatch.mockResolvedValueOnce({ typeDefinitions: 42 });
    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);
    const result = await provider.describeToolFunctions();

    expect(result.typeDefinitions).toContain("__describe");
  });
});
