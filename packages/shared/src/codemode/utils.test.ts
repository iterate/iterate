/**
 * Tests for tool name/path sanitization utilities.
 *
 * Adapted from @cloudflare/codemode (cloudflare/agents):
 * https://github.com/cloudflare/agents/blob/main/packages/codemode/src/tests/utils.test.ts
 */

import { describe, it, expect } from "vitest";
import { sanitizeToolName, sanitizeToolPath, quoteProp } from "./utils.ts";

describe("sanitizeToolName", () => {
  it("passes through a valid identifier", () => {
    expect(sanitizeToolName("hello")).toBe("hello");
  });

  it("replaces hyphens with underscores", () => {
    expect(sanitizeToolName("list-issues")).toBe("list_issues");
  });

  it("replaces dots with underscores", () => {
    expect(sanitizeToolName("files.read")).toBe("files_read");
  });

  it("prefixes digit-leading names", () => {
    expect(sanitizeToolName("123abc")).toBe("_123abc");
  });

  it("appends underscore to reserved words", () => {
    expect(sanitizeToolName("class")).toBe("class_");
    expect(sanitizeToolName("return")).toBe("return_");
  });

  it("handles empty string", () => {
    expect(sanitizeToolName("")).toBe("_");
  });

  it("strips non-identifier chars", () => {
    expect(sanitizeToolName("hello@world!")).toBe("helloworld");
  });
});

describe("sanitizeToolPath", () => {
  it("sanitizes each segment independently", () => {
    expect(sanitizeToolPath("mcp.some-server")).toBe("mcp.some_server");
  });

  it("handles single segment", () => {
    expect(sanitizeToolPath("hello")).toBe("hello");
  });

  it("filters empty segments", () => {
    expect(sanitizeToolPath("a..b")).toBe("a.b");
  });
});

describe("quoteProp", () => {
  it("returns simple names unquoted", () => {
    expect(quoteProp("hello")).toBe("hello");
  });

  it("quotes names with hyphens", () => {
    expect(quoteProp("list-issues")).toBe('"list-issues"');
  });

  it("quotes names starting with digits", () => {
    expect(quoteProp("123")).toBe('"123"');
  });

  it("escapes special characters", () => {
    expect(quoteProp('a"b')).toBe('"a\\"b"');
  });
});
