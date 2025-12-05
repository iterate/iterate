import { inspect } from "util";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { MockMCPAgent } from "./mock-mcp-agent.ts";
import { MockOAuthMCPAgent } from "./mock-oauth-mcp-agent.ts";
import { MockOAuthHandler } from "./mock-oauth-handler.ts";
import type { Env } from "./env.ts";
import { renderHomePage } from "./pages/home.ts";
import { verifyBearerAuth, verifyBearerHeaderPresent } from "./auth.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(renderHomePage(url.origin), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/guide") {
      return MockOAuthHandler.fetch(request, env, ctx);
    }

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          name: "Mock MCP Server for E2E Testing",
          version: "1.0.0",
          status: "healthy",
          documentation: "/guide",
          modes: {
            "no-auth": {
              endpoints: {
                mcp: "/no-auth",
                sse: "/sse (deprecated)",
              },
              description: "No authentication required",
            },
            bearer: {
              endpoints: {
                mcp: "/bearer",
                sse: "/sse (deprecated)",
              },
              description: "Bearer token required in Authorization header",
            },
            oauth: {
              endpoints: {
                mcp: "/oauth",
                sse: "/oauth/sse (deprecated)",
              },
              description: "OAuth 2.1 with flexible authorization modes",
            },
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.pathname === "/no-auth") {
      return MockMCPAgent.serve("/no-auth", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
    }

    if (url.pathname === "/sse") {
      return MockMCPAgent.serveSSE("/sse", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
    }

    if (url.pathname === "/bearer") {
      // If an expected token is provided, enforce exact match, otherwise require presence of any Bearer token
      const expected = url.searchParams.get("expected") || undefined;
      const authResponse =
        expected !== undefined
          ? verifyBearerAuth(request, expected)
          : verifyBearerHeaderPresent(request);
      if (authResponse) return authResponse;
      return MockMCPAgent.serve("/bearer", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
    }

    // Handle /oauth as a shorthand for /oauth/mcp (the OAuth-protected MCP endpoint)
    if (url.pathname === "/oauth") {
      // Rewrite the URL to /oauth/mcp and pass through the OAuth provider
      const newUrl = new URL(request.url);
      newUrl.pathname = "/oauth/mcp";
      const newRequest = new Request(newUrl.toString(), request);
      return oauthProvider.fetch(newRequest, env, ctx);
    }

    if (url.pathname.startsWith("/oauth") || url.pathname.startsWith("/.well-known/oauth")) {
      return oauthProvider.fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};

const oauthProvider = new OAuthProvider({
  apiHandlers: {
    "/oauth/sse": MockOAuthMCPAgent.serveSSE("/oauth/sse", { binding: "MCP_OAUTH_OBJECT" }),
    "/oauth/mcp": MockOAuthMCPAgent.serve("/oauth/mcp", { binding: "MCP_OAUTH_OBJECT" }),
  },
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  defaultHandler: MockOAuthHandler as any,
  tokenExchangeCallback(options) {
    console.log("Token exchange callback:", inspect(options, { depth: null, colors: true }));
    if ("expiresIn" in options.props && typeof options.props.expiresIn === "number") {
      return {
        accessTokenTTL: options.props.expiresIn,
      };
    }
  },
});

export { MockMCPAgent, MockOAuthMCPAgent };
