import { env as workerEnv } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import handler from "@tanstack/react-start/server-entry";
import { McpAgent } from "agents/mcp";
import crossws from "crossws/adapters/cloudflare";
import { createD1Client } from "sqlfu";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv,
});

const mcpHandler = McpAgent.serve("/mcp", { binding: "ITERATE_MCP_SERVER" });

function isBrowserMcpRequest(request: Request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") && !accept.includes("text/event-stream");
}

function mcpInstructionsResponse(request: Request) {
  const endpoint = new URL("/mcp", request.url).toString();
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OS MCP Server</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #ffffff;
        color: #111827;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      main {
        width: min(100%, 560px);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 20px;
        line-height: 1.25;
      }
      p {
        margin: 0 0 16px;
        color: #4b5563;
        line-height: 1.5;
      }
      pre {
        overflow-x: auto;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        background: #f9fafb;
        padding: 16px;
        font-size: 13px;
        line-height: 1.5;
      }
      code {
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>OS MCP Server</h1>
      <p>Connect an MCP client to this streamable HTTP endpoint.</p>
      <pre><code>{
  "mcpServers": {
    "os": {
      "url": "${endpoint}"
    }
  }
}</code></pre>
    </main>
  </body>
</html>`;

  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function parseProjectHostnameBases(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export default {
  async fetch(request: Request, env: Env, cfCtx: ExecutionContext) {
    return withEvlog(
      {
        request,
        manifest,
        config,
        executionCtx: cfCtx,
      },
      async ({ log }) => {
        const url = new URL(request.url);
        if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
          if (isBrowserMcpRequest(request)) {
            return mcpInstructionsResponse(request);
          }

          return mcpHandler.fetch(request, env, cfCtx);
        }

        const db = createD1Client(env.DB);
        const context: AppContext = {
          manifest,
          config,
          rawRequest: request,
          db,
          log,
          projectHostnameBases: parseProjectHostnameBases(env.PROJECT_HOSTNAME_BASES),
        };

        const response = await handler.fetch(request, {
          context,
        });
        if (response instanceof NitroWebSocketResponse) {
          return crossws({ hooks: response.crossws }).handleUpgrade(request, env, cfCtx);
        }

        return response;
      },
    );
  },
};
