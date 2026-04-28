import { describe, it, expect } from "vitest";
import { CallableToolProvider, CodemodeEvent } from "./types.ts";

describe("CallableToolProvider schema", () => {
  it("accepts a valid descriptor with execute only", () => {
    const result = CallableToolProvider.safeParse({
      path: ["mcp", "linear"],
      execute: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "LinearBridge",
        },
        rpcMethod: "execute",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid descriptor with execute and describe", () => {
    const result = CallableToolProvider.safeParse({
      path: ["openapi", "petstore"],
      execute: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "OpenApiBridge",
          props: { specUrl: "https://petstore.swagger.io/v2/swagger.json" },
        },
        rpcMethod: "execute",
      },
      describe: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "OpenApiBridge",
          props: { specUrl: "https://petstore.swagger.io/v2/swagger.json" },
        },
        rpcMethod: "describe",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty path", () => {
    const result = CallableToolProvider.safeParse({
      path: [],
      execute: {
        type: "fetch",
        via: { type: "url", url: "https://example.com" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing execute", () => {
    const result = CallableToolProvider.safeParse({
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

  it("accepts codemode-tool-call-requested", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-tool-call-requested",
      callId: "ccal_xyz",
      path: ["createIssue"],
      payload: { title: "Bug" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts codemode-tool-call-succeeded", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-tool-call-succeeded",
      callId: "ccal_xyz",
      result: { id: 123 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts codemode-tool-call-failed", () => {
    const result = CodemodeEvent.safeParse({
      ...base,
      type: "codemode-tool-call-failed",
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
