import { inspect } from "util";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { MockMCPAgent } from "./mock-mcp-agent.ts";
import { MockOAuthMCPAgent } from "./mock-oauth-mcp-agent.ts";
import { MockOAuthHandler } from "./mock-oauth-handler.ts";
import type { Env } from "./env.ts";
import { renderHomePage } from "./pages/home.ts";
import { verifyBearerAuth, verifyBearerHeaderPresent } from "./auth.ts";
import { MCPClientManager } from "agents/mcp/client";

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
      modes["bearer"] = {
        endpoints: {
          mcp: "/bearer/mcp",
          sse: "/bearer/sse (deprecated)",
        },
        description:
          "Bearer header authentication. Use ?expected=token to require a specific token. If ?expected is not set, any Bearer token is accepted.",
        header: "Authorization: Bearer <token>",
      };
      return new Response(
        JSON.stringify({
          name: "Mock MCP Server for E2E Testing",
          version: "1.0.0",
          status: "healthy",
          documentation: "/guide",
          modes,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.pathname === "/mcp") {
      return MockMCPAgent.serve("/mcp", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
    }

    if (url.pathname === "/sse") {
      return MockMCPAgent.serveSSE("/sse", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
    }

    if (url.pathname === "/bearer/mcp") {
      const expected = url.searchParams.get("expected") ?? undefined;
      const unauthorized =
        expected === undefined
          ? verifyBearerHeaderPresent(request)
          : verifyBearerAuth(request, expected);
      if (unauthorized) return unauthorized;
      return MockMCPAgent.serve("/bearer/mcp", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
    }

    // Simple HTTP endpoint to create a note inside the same MCP server storage
    // Usage: POST /bearer/notes?expected=token
    // Headers: Authorization: Bearer <token>
    // Body: { "title": string, "content": string }
    if (url.pathname === "/bearer/notes" && request.method.toUpperCase() === "POST") {
      const expected = url.searchParams.get("expected") ?? undefined;
      const unauthorized =
        expected === undefined
          ? verifyBearerHeaderPresent(request)
          : verifyBearerAuth(request, expected);
      if (unauthorized) return unauthorized;

      let payload: any;
      try {
        payload = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const title = String(payload?.title || "");
      const content = String(payload?.content || "");
      if (!title || !content) {
        return new Response(JSON.stringify({ error: "Missing title or content" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const auth = request.headers.get("Authorization") || "";
      const mcpUrl = new URL(`${url.origin}/bearer/mcp`);
      if (expected) mcpUrl.searchParams.set("expected", expected);

      const manager = new MCPClientManager("mock-http-writer", "1.0.0");
      try {
        const { id: serverId } = await (async () => {
          const result = await manager.connect(mcpUrl.toString(), {
            transport: {
              type: "auto",
              requestInit: {
                headers: { Authorization: auth },
              },
            },
          });
          return result;
        })();

        const toolResult = await manager.callTool({
          serverId,
          name: "mock_create_note",
          arguments: { title, content },
        });

        // Optionally close the connection
        try {
          await manager.closeConnection(serverId);
        } catch {}

        return new Response(JSON.stringify({ ok: true, result: toolResult }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: String(error?.message || error) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname === "/bearer/sse") {
      const expected = url.searchParams.get("expected") ?? undefined;
      const unauthorized =
        expected === undefined
          ? verifyBearerHeaderPresent(request)
          : verifyBearerAuth(request, expected);
      if (unauthorized) return unauthorized;
      return MockMCPAgent.serveSSE("/bearer/sse", { binding: "MCP_OBJECT" }).fetch(
        request,
        env,
        ctx,
      );
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
