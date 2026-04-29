/**
 * Tests for resolveCallableToolProvider.
 *
 * The resolve module converts a CallableToolProvider (wire format) into a
 * ToolProvider (runtime interface) by dispatching callables. We mock
 * dispatchCallable to avoid needing real Worker bindings.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../callable/runtime.ts", () => ({
  dispatchCallable: vi.fn(),
}));

import { resolveCallableToolProvider } from "./resolve.ts";
import { dispatchCallable } from "../callable/runtime.ts";
import type { CallableContext } from "../callable/types.ts";
import type { CallableToolProvider } from "./types.ts";

const mockDispatch = vi.mocked(dispatchCallable);

const fakeCtx: CallableContext = {
  env: {},
  exports: {},
};

function makeDescriptor(overrides?: Partial<CallableToolProvider>): CallableToolProvider {
  return {
    path: ["mcp", "test"],
    execute: {
      type: "workers-rpc",
      via: {
        type: "loopback-binding",
        bindingType: "service",
        exportName: "TestBridge",
      },
      rpcMethod: "execute",
    },
    ...overrides,
  };
}

describe("resolveCallableToolProvider", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
  });

  // --- execute ---

  it("delegates execute to dispatchCallable with path and payload", async () => {
    mockDispatch.mockResolvedValueOnce({ result: "ok" });
    const descriptor = makeDescriptor();
    const provider = resolveCallableToolProvider(descriptor, fakeCtx);

    const result = await provider.execute(["createIssue"], { title: "Bug" });

    expect(mockDispatch).toHaveBeenCalledOnce();
    expect(mockDispatch).toHaveBeenCalledWith({
      callable: descriptor.execute,
      payload: { path: ["createIssue"], payload: { title: "Bug" } },
      ctx: fakeCtx,
    });
    expect(result).toEqual({ result: "ok" });
  });

  it("propagates errors from execute dispatch", async () => {
    mockDispatch.mockRejectedValueOnce(new Error("dispatch failed"));
    const provider = resolveCallableToolProvider(makeDescriptor(), fakeCtx);

    await expect(provider.execute(["tool"], {})).rejects.toThrow("dispatch failed");
  });

  // --- describe with callable ---

  it("dispatches describe callable and returns typeDefinitions", async () => {
    const descriptor = makeDescriptor({
      describe: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "TestBridge",
        },
        rpcMethod: "describe",
      },
    });

    mockDispatch.mockResolvedValueOnce({
      typeDefinitions: "declare const mcp: { test: { createIssue: () => void } }",
    });

    const provider = resolveCallableToolProvider(descriptor, fakeCtx);
    const result = await provider.describe();

    expect(mockDispatch).toHaveBeenCalledWith({
      callable: descriptor.describe,
      payload: {},
      ctx: fakeCtx,
    });
    expect(result.typeDefinitions).toBe("declare const mcp: { test: { createIssue: () => void } }");
  });

  // --- describe fallback (no describe callable) ---

  it("returns a fallback type definition when no describe callable is provided", async () => {
    const descriptor = makeDescriptor({ describe: undefined });
    const provider = resolveCallableToolProvider(descriptor, fakeCtx);

    const result = await provider.describe();

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(result.typeDefinitions).toContain("mcp.test");
    expect(result.typeDefinitions).toContain("has not provided type information");
  });

  it("uses the full dotted path label in the fallback", async () => {
    const descriptor = makeDescriptor({
      path: ["openapi", "petstore", "v2"],
      describe: undefined,
    });
    const provider = resolveCallableToolProvider(descriptor, fakeCtx);

    const result = await provider.describe();

    expect(result.typeDefinitions).toContain("openapi.petstore.v2");
  });

  // --- describe fallback (malformed data from describe callable) ---

  it("returns fallback when describe returns null", async () => {
    const descriptor = makeDescriptor({
      describe: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "TestBridge",
        },
        rpcMethod: "describe",
      },
    });

    mockDispatch.mockResolvedValueOnce(null);
    const provider = resolveCallableToolProvider(descriptor, fakeCtx);
    const result = await provider.describe();

    expect(result.typeDefinitions).toBe("(...args: unknown[]) => Promise<unknown>");
  });

  it("returns fallback when describe returns a non-object", async () => {
    const descriptor = makeDescriptor({
      describe: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "TestBridge",
        },
        rpcMethod: "describe",
      },
    });

    mockDispatch.mockResolvedValueOnce("not an object");
    const provider = resolveCallableToolProvider(descriptor, fakeCtx);
    const result = await provider.describe();

    expect(result.typeDefinitions).toBe("(...args: unknown[]) => Promise<unknown>");
  });

  it("returns fallback when describe returns object without typeDefinitions", async () => {
    const descriptor = makeDescriptor({
      describe: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "TestBridge",
        },
        rpcMethod: "describe",
      },
    });

    mockDispatch.mockResolvedValueOnce({ something: "else" });
    const provider = resolveCallableToolProvider(descriptor, fakeCtx);
    const result = await provider.describe();

    expect(result.typeDefinitions).toBe("(...args: unknown[]) => Promise<unknown>");
  });

  it("returns fallback when typeDefinitions is not a string", async () => {
    const descriptor = makeDescriptor({
      describe: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "TestBridge",
        },
        rpcMethod: "describe",
      },
    });

    mockDispatch.mockResolvedValueOnce({ typeDefinitions: 42 });
    const provider = resolveCallableToolProvider(descriptor, fakeCtx);
    const result = await provider.describe();

    expect(result.typeDefinitions).toBe("(...args: unknown[]) => Promise<unknown>");
  });
});
