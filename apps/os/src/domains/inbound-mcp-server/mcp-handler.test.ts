import { describe, expect, it } from "vitest";
import {
  acceptedMcpResourceAudiences,
  isMcpProtectedResourceMetadataPath,
  mcpChallengeHeader,
  publicMcpResourceUrl,
} from "./mcp-auth-metadata.ts";

function mcpInput(request: Request) {
  return {
    context: {
      config: {
        baseUrl: "https://os.iterate.com",
        mcp: { baseUrl: "https://mcp.iterate.com" },
      },
    },
    request,
  } as Parameters<typeof publicMcpResourceUrl>[0];
}

describe("inbound MCP auth metadata", () => {
  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp",
    "/api/mcp/.well-known/oauth-protected-resource",
    "/api/mcp/.well-known/oauth-protected-resource/api/mcp",
  ])("serves protected-resource metadata at %s", (pathname) => {
    expect(isMcpProtectedResourceMetadataPath(pathname)).toBe(true);
  });

  it("advertises the app MCP endpoint for direct app-host MCP discovery", () => {
    expect(publicMcpResourceUrl(mcpInput(new Request("https://os.iterate.com/api/mcp")))).toBe(
      "https://os.iterate.com/api/mcp",
    );
  });

  it("advertises the canonical MCP endpoint for ingress-rewritten MCP-host discovery", () => {
    const request = new Request(
      "https://os.iterate.com/api/mcp/.well-known/oauth-protected-resource",
      {
        headers: {
          "x-forwarded-host": "mcp.iterate.com",
          "x-forwarded-proto": "https",
        },
      },
    );

    expect(publicMcpResourceUrl(mcpInput(request))).toBe("https://mcp.iterate.com");
  });

  it("accepts tokens minted for the canonical MCP host or the app MCP endpoint", () => {
    expect(
      acceptedMcpResourceAudiences(mcpInput(new Request("https://os.iterate.com/api/mcp"))),
    ).toEqual([
      "https://mcp.iterate.com",
      "https://mcp.iterate.com/",
      "https://os.iterate.com/api/mcp",
    ]);
  });

  it("includes OAuth error fields and scope hints in the bearer challenge", () => {
    expect(
      mcpChallengeHeader({
        error: "invalid_token",
        errorDescription: "Missing or invalid bearer token",
        metadataUrl: "https://mcp.iterate.com/.well-known/oauth-protected-resource",
      }),
    ).toBe(
      'Bearer error="invalid_token", error_description="Missing or invalid bearer token", resource_metadata="https://mcp.iterate.com/.well-known/oauth-protected-resource", scope="openid profile email offline_access project"',
    );
  });
});
