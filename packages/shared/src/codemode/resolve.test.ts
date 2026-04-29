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
    executeToolFunction: {
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
      callable: descriptor.executeToolFunction,
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

  // --- describe with callable ---

  it("dispatches describeToolFunctions callable and returns typeDefinitions", async () => {
    const descriptor = makeDescriptor({
      describeToolFunctions: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "TestBridge",
        },
        rpcMethod: "describeToolFunctions",
      },
    });

    mockDispatch.mockResolvedValueOnce({
      typeDefinitions: "declare const mcp: { test: { createIssue: () => void } }",
    });

    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);
    const result = await provider.describeToolFunctions();

    expect(mockDispatch).toHaveBeenCalledWith({
      callable: descriptor.describeToolFunctions,
      payload: {},
      ctx: fakeCtx,
    });
    expect(result.typeDefinitions).toBe("declare const mcp: { test: { createIssue: () => void } }");
  });

  // --- describe fallback (no describeToolFunctions callable) ---

  it("returns a fallback type definition when no describeToolFunctions callable is provided", async () => {
    const descriptor = makeDescriptor({ describeToolFunctions: undefined });
    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);

    const result = await provider.describeToolFunctions();

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(result.typeDefinitions).toContain("mcp.test");
    expect(result.typeDefinitions).toContain("has not provided type information");
  });

  it("uses the full dotted path label in the fallback", async () => {
    const descriptor = makeDescriptor({
      path: ["openapi", "petstore", "v2"],
      describeToolFunctions: undefined,
    });
    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);

    const result = await provider.describeToolFunctions();

    expect(result.typeDefinitions).toContain("openapi.petstore.v2");
  });

  // --- describe fallback (malformed data from describe callable) ---

  it("returns fallback when describeToolFunctions returns null", async () => {
    const descriptor = makeDescriptor({
      describeToolFunctions: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "TestBridge",
        },
        rpcMethod: "describeToolFunctions",
      },
    });

    mockDispatch.mockResolvedValueOnce(null);
    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);
    const result = await provider.describeToolFunctions();

    expect(result.typeDefinitions).toBe("(...args: unknown[]) => Promise<unknown>");
  });

  it("returns fallback when describeToolFunctions returns a non-object", async () => {
    const descriptor = makeDescriptor({
      describeToolFunctions: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "TestBridge",
        },
        rpcMethod: "describeToolFunctions",
      },
    });

    mockDispatch.mockResolvedValueOnce("not an object");
    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);
    const result = await provider.describeToolFunctions();

    expect(result.typeDefinitions).toBe("(...args: unknown[]) => Promise<unknown>");
  });

  it("returns fallback when describeToolFunctions returns object without typeDefinitions", async () => {
    const descriptor = makeDescriptor({
      describeToolFunctions: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "TestBridge",
        },
        rpcMethod: "describeToolFunctions",
      },
    });

    mockDispatch.mockResolvedValueOnce({ something: "else" });
    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);
    const result = await provider.describeToolFunctions();

    expect(result.typeDefinitions).toBe("(...args: unknown[]) => Promise<unknown>");
  });

  it("returns fallback when typeDefinitions is not a string", async () => {
    const descriptor = makeDescriptor({
      describeToolFunctions: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "TestBridge",
        },
        rpcMethod: "describeToolFunctions",
      },
    });

    mockDispatch.mockResolvedValueOnce({ typeDefinitions: 42 });
    const provider = resolveToolProviderDescriptor(descriptor, fakeCtx);
    const result = await provider.describeToolFunctions();

    expect(result.typeDefinitions).toBe("(...args: unknown[]) => Promise<unknown>");
  });
});
