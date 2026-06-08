import { describe, expect, it } from "vitest";
import { matchMcpRequestUrl } from "./mcp-url-routing.ts";

describe("matchMcpRequestUrl", () => {
  it("matches the root of the configured MCP host", () => {
    expect(
      matchMcpRequestUrl({
        mcpBaseUrl: "https://mcp.iterate.com",
        requestUrl: "https://mcp.iterate.com/",
      }),
    ).toEqual({ relativePathname: "/" });
  });

  it("matches paths relative to a path-mounted MCP base URL", () => {
    expect(
      matchMcpRequestUrl({
        mcpBaseUrl: "http://localhost:5176/api/__mcp",
        requestUrl: "http://localhost:5176/api/__mcp/.well-known/oauth-protected-resource",
      }),
    ).toEqual({ relativePathname: "/.well-known/oauth-protected-resource" });
  });

  it("defaults localhost app URLs to /api/__mcp", () => {
    expect(
      matchMcpRequestUrl({
        appBaseUrl: "http://localhost:5176",
        requestUrl: "http://localhost:5176/api/__mcp",
      }),
    ).toEqual({ relativePathname: "/" });
  });

  it("does not match the old dashboard /mcp URL unless it is explicitly configured", () => {
    expect(
      matchMcpRequestUrl({
        mcpBaseUrl: "https://mcp.iterate.com",
        requestUrl: "https://os.iterate.com/mcp",
      }),
    ).toBeNull();
  });
});
