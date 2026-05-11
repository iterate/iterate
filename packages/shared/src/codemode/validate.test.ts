import { describe, it, expect } from "vitest";
import { validateProviderPaths } from "./validate.ts";

describe("validateProviderPaths", () => {
  it("accepts a single provider", () => {
    expect(validateProviderPaths([{ path: ["health"] }])).toBeNull();
  });

  it("accepts multiple non-conflicting providers", () => {
    expect(
      validateProviderPaths([
        { path: ["internal", "health"] },
        { path: ["mcp", "linear"] },
        { path: ["someTool"] },
      ]),
    ).toBeNull();
  });

  it("accepts providers that share a prefix segment but are disjoint", () => {
    expect(
      validateProviderPaths([{ path: ["mcp", "linear"] }, { path: ["mcp", "github"] }]),
    ).toBeNull();
  });

  it("rejects duplicate paths", () => {
    const result = validateProviderPaths([
      { path: ["mcp", "linear"] },
      { path: ["mcp", "linear"] },
    ]);
    expect(result).toContain("Duplicate");
  });

  it("rejects path that is prefix of another", () => {
    const result = validateProviderPaths([{ path: ["mcp"] }, { path: ["mcp", "linear"] }]);
    expect(result).toContain("conflicts");
    expect(result).toContain("namespace");
  });

  it("rejects path that is suffix of another", () => {
    const result = validateProviderPaths([{ path: ["mcp", "linear"] }, { path: ["mcp"] }]);
    expect(result).toContain("conflicts");
  });

  it("rejects empty path", () => {
    const result = validateProviderPaths([{ path: [] }]);
    expect(result).toContain("at least one segment");
  });

  it("rejects empty string segment", () => {
    const result = validateProviderPaths([{ path: ["mcp", ""] }]);
    expect(result).toContain("non-empty");
  });

  it("rejects reserved segment __dispatchers", () => {
    const result = validateProviderPaths([{ path: ["__dispatchers"] }]);
    expect(result).toContain("reserved");
  });

  it("rejects reserved segment __logger", () => {
    const result = validateProviderPaths([{ path: ["foo", "__logger"] }]);
    expect(result).toContain("reserved");
  });

  it("accepts empty array", () => {
    expect(validateProviderPaths([])).toBeNull();
  });
});
