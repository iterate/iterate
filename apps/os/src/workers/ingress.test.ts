import { describe, expect, it } from "vitest";
import { rewriteMcpHostRequest } from "./ingress.ts";

describe("rewriteMcpHostRequest", () => {
  it.each([
    [
      "https://mcp.iterate.com/.well-known/oauth-protected-resource",
      "https://os.iterate.com/api/mcp/.well-known/oauth-protected-resource",
    ],
    [
      "https://mcp.iterate.com/api/mcp/.well-known/oauth-protected-resource",
      "https://os.iterate.com/api/mcp/.well-known/oauth-protected-resource",
    ],
  ])("rewrites the distinct MCP host %s", (input, expected) => {
    const request = rewriteMcpHostRequest({
      config: {
        baseUrl: "https://os.iterate.com",
        mcp: { baseUrl: "https://mcp.iterate.com" },
      },
      request: new Request(input),
    });

    expect(request?.url).toBe(expected);
    expect(request?.headers.get("x-forwarded-host")).toBe("mcp.iterate.com");
    expect(request?.headers.get("x-forwarded-proto")).toBe("https");
  });

  it.each([
    [
      "http://localhost:5176",
      "http://localhost:5176/api/mcp",
      "http://localhost:5176/api/mcp/.well-known/oauth-protected-resource",
    ],
    ["https://os.iterate.com", "https://mcp.iterate.com", "https://os.iterate.com/api/mcp"],
  ])("does not rewrite %s for %s", (baseUrl, mcpBaseUrl, requestUrl) => {
    expect(
      rewriteMcpHostRequest({
        config: { baseUrl, mcp: { baseUrl: mcpBaseUrl } },
        request: new Request(requestUrl),
      }),
    ).toBeNull();
  });
});
