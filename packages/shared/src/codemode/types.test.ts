import { describe, it, expect } from "vitest";
import { ToolProviderDescriptor, CodemodeEvent } from "./types.ts";

describe("ToolProviderDescriptor schema", () => {
  it("accepts a valid descriptor with one callable", () => {
    const result = ToolProviderDescriptor.safeParse({
      path: ["mcp", "linear"],
      callable: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "LinearBridge",
        },
        rpcMethod: "executeToolFunction",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a legacy descriptor with separate execute and describe callables", () => {
    const result = ToolProviderDescriptor.safeParse({
      path: ["openapi", "petstore"],
      executeToolFunction: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "OpenApiBridge",
          props: { specUrl: "https://petstore.swagger.io/v2/swagger.json" },
        },
        rpcMethod: "executeToolFunction",
      },
      describeToolFunctions: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "OpenApiBridge",
          props: { specUrl: "https://petstore.swagger.io/v2/swagger.json" },
        },
        rpcMethod: "describeToolFunctions",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra descriptor callables", () => {
    const result = ToolProviderDescriptor.safeParse({
      path: ["openapi", "petstore"],
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://example.com" },
      },
      describeToolFunctions: {
        type: "fetch",
        via: { type: "url", url: "https://example.com" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty path", () => {
    const result = ToolProviderDescriptor.safeParse({
      path: [],
      callable: {
        type: "fetch",
        via: { type: "url", url: "https://example.com" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing callable", () => {
    const result = ToolProviderDescriptor.safeParse({
      path: ["foo"],
    });
    expect(result.success).toBe(false);
  });
});

describe("CodemodeEvent schema", () => {
  const base = { blockId: "cblk_abc123", timestamp: "2026-01-01T00:00:00Z" };

  it("accepts codemode-block-added", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-block-added",
      code: "async () => 42",
    });
    expect(result.success).toBe(true);
  });

  it("accepts codemode-log-emitted", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-log-emitted",
      level: "warn",
      message: "something happened",
    });
    expect(result.success).toBe(true);
  });

  it("accepts codemode-tool-function-call-requested", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-tool-function-call-requested",
      callId: "ccal_xyz",
      path: ["createIssue"],
      payload: { title: "Bug" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts codemode-tool-function-call-succeeded", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-tool-function-call-succeeded",
      callId: "ccal_xyz",
      result: { id: 123 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts codemode-tool-function-call-failed", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-tool-function-call-failed",
      callId: "ccal_xyz",
      error: "not found",
    });
    expect(result.success).toBe(true);
  });

  it("accepts codemode-block-result-added", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-block-result-added",
      result: 42,
    });
    expect(result.success).toBe(true);
  });

  it("accepts codemode-block-result-added with error", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-block-result-added",
      result: undefined,
      error: "execution timed out",
    });
    expect(result.success).toBe(true);
  });

  it("accepts codemode-tool-provider-registered", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-tool-provider-registered",
      path: ["mcp", "linear"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts codemode-tool-provider-described", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-tool-provider-described",
      path: ["mcp", "linear"],
      typeDefinitions: "declare const linear: { createIssue: ... }",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown event type", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-unknown-event",
    });
    expect(result.success).toBe(false);
  });
});
