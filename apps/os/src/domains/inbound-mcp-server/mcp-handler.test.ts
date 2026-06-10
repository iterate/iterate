import { describe, expect, it } from "vitest";
import { matchMcpRequestUrl, publicMcpRequestUrl } from "./mcp-url-routing.ts";

describe("matchMcpRequestUrl", () => {
  it("matches the root of the configured MCP host", () => {
    expect(
      matchMcpRequestUrl({
        mcpBaseUrl: "https://mcp.iterate.com",
        requestUrl: "https://mcp.iterate.com/",
      }),
    ).toEqual({ relativePathname: "/" });
  });

  it("matches metadata paths below the canonical root mount", () => {
    expect(
      matchMcpRequestUrl({
        mcpBaseUrl: "https://mcp.iterate.com",
        requestUrl: "https://mcp.iterate.com/.well-known/oauth-protected-resource",
      }),
    ).toEqual({ relativePathname: "/.well-known/oauth-protected-resource" });
  });

  it("preserves explicit path-mounted MCP URLs", () => {
    expect(
      matchMcpRequestUrl({
        mcpBaseUrl: "https://mcp.iterate.com/mcp",
        requestUrl: "https://mcp.iterate.com/mcp/.well-known/oauth-protected-resource",
      }),
    ).toEqual({ relativePathname: "/.well-known/oauth-protected-resource" });
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

  it("treats localhost and loopback addresses as equivalent for local defaults", () => {
    expect(
      matchMcpRequestUrl({
        appBaseUrl: "http://localhost:5176",
        requestUrl: "http://127.0.0.1:5176/api/__mcp",
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

  it("matches tunnel requests using the forwarded public MCP host", () => {
    const requestUrl = publicMcpRequestUrl(
      new Request("http://localhost:5173/", {
        headers: {
          "x-forwarded-host": "mcp.iterate-dev-rahul.com",
          "x-forwarded-proto": "https",
        },
      }),
    );

    expect(requestUrl).toBe("https://mcp.iterate-dev-rahul.com/");
    expect(
      matchMcpRequestUrl({
        mcpBaseUrl: "https://mcp.iterate-dev-rahul.com",
        requestUrl,
      }),
    ).toEqual({ relativePathname: "/" });
  });
});
