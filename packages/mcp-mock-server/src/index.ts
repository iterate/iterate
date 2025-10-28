import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { MockMCPAgent } from "./mock-mcp-agent.ts";
import { MockOAuthMCPAgent } from "./mock-oauth-mcp-agent.ts";
import { MockOAuthHandler } from "./mock-oauth-handler.ts";
import type { Env } from "./env.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(renderLandingPage(url.origin), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          name: "Mock MCP Server for E2E Testing",
          version: "1.0.0",
          status: "healthy",
          modes: {
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
              description: "OAuth 2.1 - auto-approves with auto-generated mock users",
            },
          },
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

    if (
      url.pathname.startsWith("/oauth") ||
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      return oauthProvider.fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};

function renderLandingPage(origin: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>iterate | mock-mcp-server</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
      background: #ffffff;
      color: #000;
      padding: 2rem;
      line-height: 1.6;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: normal;
      margin-bottom: 0.5rem;
    }
    .subtitle {
      color: #666;
      margin-bottom: 2rem;
      font-size: 0.9rem;
    }
    .section {
      border: 1px solid #000;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .section h2 {
      font-size: 1rem;
      font-weight: bold;
      margin-bottom: 1rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .section p {
      margin-bottom: 1rem;
      color: #333;
    }
    .url {
      background: #f5f5f5;
      border: 1px solid #ddd;
      padding: 0.5rem;
      font-size: 0.9rem;
      margin: 1rem 0;
      user-select: all;
    }
    .label {
      font-size: 0.75rem;
      text-transform: uppercase;
      color: #666;
      margin-bottom: 0.25rem;
      letter-spacing: 0.05em;
    }
    ul {
      margin: 1rem 0;
      padding-left: 1.5rem;
    }
    li {
      margin: 0.5rem 0;
      color: #333;
    }
    pre {
      background: #f5f5f5;
      border: 1px solid #ddd;
      padding: 1rem;
      overflow-x: auto;
      font-size: 0.85rem;
    }
    a {
      color: #000;
      text-decoration: underline;
    }
    .footer {
      margin-top: 2rem;
      padding-top: 1rem;
      border-top: 1px solid #ddd;
      font-size: 0.85rem;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>iterate | mock-mcp-server</h1>
    <div class="subtitle">model context protocol testing server</div>

    <div class="section">
      <h2>no-auth mode</h2>
      <p>direct mcp connection, no authentication</p>
      <div class="label">endpoint</div>
      <div class="url">${origin}/mcp</div>
      <div class="label">tools</div>
      <ul>
        <li>add(a, b) - basic arithmetic</li>
        <li>echo(message) - echo back</li>
        <li>getCurrentTime() - server time</li>
        <li>throwError() - error simulation</li>
        <li>delayedResponse(delayMs) - async testing</li>
      </ul>
    </div>

    <div class="section">
      <h2>oauth mode</h2>
      <p>full oauth 2.1 + pkce flow, auto-approves with generated mock users</p>
      <div class="label">endpoint</div>
      <div class="url">${origin}/oauth/mcp</div>
      <div class="label">behavior</div>
      <ul>
        <li>client registration: automatic</li>
        <li>user authorization: auto-approved</li>
        <li>token exchange: standard oauth</li>
        <li>mock user: auto-generated on each connection</li>
      </ul>
      <div class="label">oauth-specific tools</div>
      <ul>
        <li>userInfo() - authenticated user data</li>
        <li>greet(formal?) - personalized greeting</li>
        <li>adminAction(action) - permission demo</li>
      </ul>
    </div>

    <div class="footer">
      <a href="/health">health check (json)</a> | 
      <a href="https://github.com/modelcontextprotocol/inspector" target="_blank">mcp inspector</a> |
      <a href="https://modelcontextprotocol.io" target="_blank">mcp spec</a>
    </div>
  </div>
</body>
</html>`;
}

const oauthProvider = new OAuthProvider({
  apiHandlers: {
    "/oauth/sse": MockOAuthMCPAgent.serveSSE("/oauth/sse", { binding: "MCP_OAUTH_OBJECT" }),
    "/oauth/mcp": MockOAuthMCPAgent.serve("/oauth/mcp", { binding: "MCP_OAUTH_OBJECT" }),
  },
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  defaultHandler: MockOAuthHandler as any,
});

export { MockMCPAgent, MockOAuthMCPAgent };
