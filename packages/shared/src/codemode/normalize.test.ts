/**
 * Tests for code normalization.
 *
 * Adapted from @cloudflare/codemode (cloudflare/agents):
 * https://github.com/cloudflare/agents/blob/main/packages/codemode/src/tests/normalize.test.ts
 */

import { describe, it, expect } from "vitest";
import { normalizeCode } from "./normalize.ts";

describe("normalizeCode", () => {
  it("passes through an async arrow function", () => {
    const code = "async () => { return 42; }";
    expect(normalizeCode(code)).toBe(code);
  });

  it("wraps a bare expression in an async arrow", () => {
    const result = normalizeCode("42");
    expect(result).toContain("async () =>");
    expect(result).toContain("return (42)");
  });

  it("wraps multi-statement code, returning last expression", () => {
    const result = normalizeCode("const x = 1;\nx + 1");
    expect(result).toContain("async () =>");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("return (x + 1)");
  });

  it("strips markdown code fences", () => {
    const result = normalizeCode("```js\n42\n```");
    expect(result).toContain("return (42)");
    expect(result).not.toContain("```");
  });

  it("strips typescript code fences", () => {
    const result = normalizeCode("```typescript\nasync () => 42\n```");
    expect(result).toBe("async () => 42");
  });

  it("handles empty input", () => {
    expect(normalizeCode("")).toBe("async () => {}");
    expect(normalizeCode("   ")).toBe("async () => {}");
  });

  it("wraps a named function declaration", () => {
    const result = normalizeCode("function hello() { return 'hi'; }");
    expect(result).toContain("async () =>");
    expect(result).toContain("function hello()");
    expect(result).toContain("return hello()");
  });

  it("handles export default arrow function", () => {
    const result = normalizeCode("export default async () => 42");
    expect(result).toBe("async () => 42");
  });

  it("handles template literals", () => {
    const result = normalizeCode('`hello ${"world"}`');
    expect(result).toContain("return (`hello");
  });
});
