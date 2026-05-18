import { describe, expect, test } from "vitest";
import { sanitizeToolName, uniqueSanitizedToolKey } from "./codemode-tool-key.ts";

describe("sanitizeToolName", () => {
  test("matches codemode OpenAPI operationIds (dots → one identifier)", () => {
    expect(sanitizeToolName("__internal.health")).toBe("__internal_health");
    expect(sanitizeToolName("secrets.list")).toBe("secrets_list");
    expect(sanitizeToolName("getStreamState")).toBe("getStreamState");
  });

  test("matches MCP tool names (hyphens / dots)", () => {
    expect(sanitizeToolName("search.cloudflare")).toBe("search_cloudflare");
    expect(sanitizeToolName("browse-docs")).toBe("browse_docs");
    expect(sanitizeToolName("cloudflare-docs")).toBe("cloudflare_docs");
  });
});

describe("uniqueSanitizedToolKey", () => {
  test("dedupes collisions after sanitization", () => {
    const used = new Set<string>();
    const a = uniqueSanitizedToolKey("a.b", used);
    const b = uniqueSanitizedToolKey("a-b", used);
    expect(a).toBe("a_b");
    expect(b).toBe("a_b__2");
  });
});
