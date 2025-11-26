import { inspect } from "util";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { MockMCPAgent } from "./mock-mcp-agent.ts";
import { MockOAuthMCPAgent } from "./mock-oauth-mcp-agent.ts";
import { MockOAuthHandler } from "./mock-oauth-handler.ts";
import type { Env } from "./env.ts";
import { renderHomePage } from "./pages/home.ts";
import { verifyBearerAuth } from "./auth.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(renderHomePage(url.origin, !!env.MCP_BEARER_TOKEN), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/guide") {
      return MockOAuthHandler.fetch(request, env, ctx);
    }

    if (url.pathname === "/health") {
      const modes: Record<string, unknown> = {
        "no-auth": {
          endpoints: {
            mcp: "/mcp",
            sse: "/sse (deprecated)",
          },
          description: "No authentication required",
        },
        oauth: {
          endpoints: {
            mcp: "/oauth/mcp",
            sse: "/oauth/sse (deprecated)",
          },
          description: "OAuth 2.1 with flexible authorization modes",
        },
      };
      if (env.MCP_BEARER_TOKEN) {
        modes["bearer"] = {
          endpoints: {
            mcp: "/mcp",
            sse: "/sse (deprecated)",
          },
          description: "Bearer header authentication required",
          header: "Authorization: Bearer <token>",
        };
      }
      return new Response(JSON.stringify({
        name: "Mock MCP Server for E2E Testing",
        version: "1.0.0",
        status: "healthy",
        documentation: "/guide",
        modes,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/mcp") {
      const unauthorized = verifyBearerAuth(request, env.MCP_BEARER_TOKEN);
      if (unauthorized) return unauthorized;
      return MockMCPAgent.serve("/mcp", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
    }

    if (url.pathname === "/sse") {
      const unauthorized = verifyBearerAuth(request, env.MCP_BEARER_TOKEN);
      if (unauthorized) return unauthorized;
      return MockMCPAgent.serveSSE("/sse", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
    }

    if (
      url.pathname.startsWith("/oauth") ||
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
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
