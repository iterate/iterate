/**
 * Tests for tool name/path sanitization utilities.
 *
 * Adapted from @cloudflare/codemode (cloudflare/agents):
 * https://github.com/cloudflare/agents/blob/main/packages/codemode/src/tests/utils.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  sanitizeToolName,
  sanitizeToolPath,
  quoteProp,
  toPascalCase,
  escapeStringLiteral,
  escapeJsDoc,
} from "./utils.ts";

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

  it("preserves double dollar signs", () => {
    expect(sanitizeToolName("$$ref")).toBe("$$ref");
  });

  it("leaves valid identifiers unchanged", () => {
    expect(sanitizeToolName("getWeather")).toBe("getWeather");
    expect(sanitizeToolName("_private")).toBe("_private");
    expect(sanitizeToolName("$jquery")).toBe("$jquery");
  });

  it("handles string with only special characters", () => {
    // $ is a valid identifier character, so "@#$" keeps "$"
    expect(sanitizeToolName("@#$")).toBe("$");
    expect(sanitizeToolName("@#!")).toBe("_");
  });

  it("replaces spaces with underscores", () => {
    expect(sanitizeToolName("my tool")).toBe("my_tool");
  });

  it("appends underscore to delete reserved word", () => {
    expect(sanitizeToolName("delete")).toBe("delete_");
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

  it("sanitizes dotted paths segment-by-segment", () => {
    expect(sanitizeToolPath("foo-bar.baz-qux")).toBe("foo_bar.baz_qux");
  });

  it("preserves nesting dots", () => {
    expect(sanitizeToolPath("bla.bla.doIt")).toBe("bla.bla.doIt");
  });

  it("falls back to a valid identifier for empty paths", () => {
    expect(sanitizeToolPath("")).toBe("_");
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

  it("escapes newlines and tabs", () => {
    expect(quoteProp("has\nnewline")).toBe('"has\\nnewline"');
    expect(quoteProp("has\ttab")).toBe('"has\\ttab"');
  });

  it("handles empty string", () => {
    expect(quoteProp("")).toBe('""');
  });
});

describe("toPascalCase", () => {
  it("capitalizes the first letter", () => {
    expect(toPascalCase("hello")).toBe("Hello");
  });

  it("converts underscore-separated segments", () => {
    expect(toPascalCase("get_weather")).toBe("GetWeather");
  });

  it("handles already PascalCase input", () => {
    expect(toPascalCase("GetWeather")).toBe("GetWeather");
  });

  it("handles single character", () => {
    expect(toPascalCase("a")).toBe("A");
  });

  it("converts multi-underscore segments", () => {
    expect(toPascalCase("create_github_issue")).toBe("CreateGithubIssue");
  });
});

describe("escapeStringLiteral", () => {
  it("escapes double quotes", () => {
    expect(escapeStringLiteral('say "hello"')).toBe('say \\"hello\\"');
  });

  it("escapes backslashes", () => {
    expect(escapeStringLiteral("back\\slash")).toBe("back\\\\slash");
  });

  it("escapes newlines and tabs", () => {
    expect(escapeStringLiteral("line\none")).toBe("line\\none");
    expect(escapeStringLiteral("tab\there")).toBe("tab\\there");
  });

  it("escapes carriage returns", () => {
    expect(escapeStringLiteral("cr\rhere")).toBe("cr\\rhere");
  });

  it("passes through simple strings unchanged", () => {
    expect(escapeStringLiteral("hello world")).toBe("hello world");
  });
});

describe("escapeJsDoc", () => {
  it("escapes */ sequences", () => {
    expect(escapeJsDoc("value */ breaks")).toBe("value *\\/ breaks");
  });

  it("passes through text without */", () => {
    expect(escapeJsDoc("normal text")).toBe("normal text");
  });

  it("handles multiple */ occurrences", () => {
    expect(escapeJsDoc("a */ b */ c")).toBe("a *\\/ b *\\/ c");
  });
});
