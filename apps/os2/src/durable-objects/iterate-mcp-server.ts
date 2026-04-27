import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import packageJson from "../../package.json" with { type: "json" };

const helloWorldResourceUri = "ui://hello-world/widget.html";
const mcpAppHtmlMimeType = "text/html;profile=mcp-app";

const helloWorldHtml = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hello world</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: var(--font-sans, system-ui, sans-serif);
        color: var(--color-text-primary, CanvasText);
        background: var(--color-background-primary, Canvas);
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
      }

      main {
        padding: 24px;
        text-align: center;
      }

      h1 {
        margin: 0;
        font-size: var(--font-heading-lg-size, 24px);
        line-height: 1.2;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Hello world</h1>
    </main>
  </body>
</html>`;

export class IterateMcpServer extends McpAgent {
  server = new McpServer({
    name: "os2",
    version: packageJson.version,
  });

  async init() {
    this.server.registerResource(
      "hello-world-widget",
      helloWorldResourceUri,
      {
        title: "Hello world",
        description: "A minimal MCP Apps HTML widget.",
        mimeType: mcpAppHtmlMimeType,
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.toString(),
            mimeType: mcpAppHtmlMimeType,
            text: helloWorldHtml,
          },
        ],
      }),
    );

    this.server.registerTool(
      "hello_world",
      {
        title: "Hello world",
        description: "Return a hello world message and render a minimal MCP Apps widget.",
        _meta: {
          ui: {
            resourceUri: helloWorldResourceUri,
          },
        },
      },
      async () => ({
        content: [{ type: "text", text: "Hello world from os2." }],
        structuredContent: { message: "Hello world" },
      }),
    );
  }
}

export default {
  fetch() {
    return new Response("ok");
  },
} satisfies ExportedHandler;
