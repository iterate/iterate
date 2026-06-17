import { describe, expect, it } from "vitest";
import {
  copyMissingSearchParams,
  expandOAuthResourceAudienceVariants,
  normalizeOAuthResourceUrl,
  oauthResourceAudienceVariants,
} from "./oauth-resource.ts";

describe("OAuth resource helpers", () => {
  it("adds root URL slash variants for resource audiences", () => {
    expect(oauthResourceAudienceVariants("https://mcp.iterate.com")).toEqual([
      "https://mcp.iterate.com",
      "https://mcp.iterate.com/",
    ]);
  });

  it("does not add slash variants for resource audiences with paths", () => {
    expect(oauthResourceAudienceVariants("http://localhost:7301/api/mcp/")).toEqual([
      "http://localhost:7301/api/mcp",
    ]);
  });

  it("deduplicates expanded resource audience variants", () => {
    expect(
      expandOAuthResourceAudienceVariants(["https://mcp.iterate.com", "https://mcp.iterate.com/"]),
    ).toEqual(["https://mcp.iterate.com", "https://mcp.iterate.com/"]);
  });

  it("normalizes resource URLs before comparing audiences", () => {
    expect(normalizeOAuthResourceUrl("https://mcp.iterate.com/?ignored=true#fragment")).toBe(
      "https://mcp.iterate.com",
    );
  });

  it("copies missing search params without overwriting existing target params", () => {
    const url = copyMissingSearchParams({
      targetUrl: "/continue?resource=https%3A%2F%2Fexisting.example",
      sourceSearch:
        "?resource=https%3A%2F%2Fmcp.iterate.com&resource=https%3A%2F%2Fmcp.iterate.com%2F&state=abc",
      paramNames: ["resource", "state"],
      baseUrl: "https://auth.iterate.com",
    });

    expect(url.href).toBe(
      "https://auth.iterate.com/continue?resource=https%3A%2F%2Fexisting.example&state=abc",
    );
  });

  it("copies all source values when the target is missing a search param", () => {
    const url = copyMissingSearchParams({
      targetUrl: "/continue",
      sourceSearch:
        "?resource=https%3A%2F%2Fmcp.iterate.com&resource=https%3A%2F%2Fmcp.iterate.com%2F",
      paramNames: ["resource"],
      baseUrl: "https://auth.iterate.com",
    });

    expect(url.searchParams.getAll("resource")).toEqual([
      "https://mcp.iterate.com",
      "https://mcp.iterate.com/",
    ]);
  });
});
