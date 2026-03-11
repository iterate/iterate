import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StreamableHTTPTransport } from "@hono/mcp";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { z } from "zod/v4";
import { MetaMcpFileStore } from "./config/file-store.ts";
import { UpstreamManager } from "./upstream-manager.ts";

async function getAvailablePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine test port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function startSlowMcpServer(params: { delayMs: number }) {
  const host = "127.0.0.1";
  const port = await getAvailablePort();
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPTransport }>();

  async function disposeSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    sessions.delete(sessionId);
    await session.server.close().catch(() => undefined);
  }

  async function createSession() {
    const server = new McpServer({
      name: "slow-server",
      version: "1.0.0",
    });

    server.registerTool(
      "slow-tool",
      {
        description: "Slow test tool",
        inputSchema: {
          city: z.string(),
        },
      },
      async ({ city }) => ({
        content: [{ type: "text" as const, text: city }],
      }),
    );

    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: async (sessionId) => {
        sessions.set(sessionId, { server, transport });
      },
      onsessionclosed: async (sessionId) => {
        await disposeSession(sessionId);
      },
    });

    await server.connect(transport);
    return { server, transport };
  }

  const app = new Hono();

  app.all("/mcp", async (c) => {
    await new Promise((resolve) => setTimeout(resolve, params.delayMs));

    const requestedSessionId = c.req.header("mcp-session-id");
    if (requestedSessionId) {
      const session = sessions.get(requestedSessionId);
      if (!session) {
        return c.json({ error: "session_not_found" }, 404);
      }

      return await session.transport.handleRequest(c);
    }

    const session = await createSession();
    try {
      return await session.transport.handleRequest(c);
    } finally {
      if (session.transport.sessionId === undefined) {
        await session.server.close().catch(() => undefined);
      }
    }
  });

  const nodeServer = serve({
    fetch: app.fetch,
    hostname: host,
    port,
  });

  return {
    url: `http://${host}:${String(port)}/mcp`,
    stop: async () => {
      await Promise.all([...sessions.keys()].map((sessionId) => disposeSession(sessionId)));
      nodeServer.close();
    },
  };
}

describe("UpstreamManager timeouts", () => {
  test("times out slow upstream discovery", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "meta-mcp-upstream-timeout-"));
    const configPath = join(tempRoot, "config.json");
    const authPath = join(tempRoot, "auth.json");
    const slowServer = await startSlowMcpServer({ delayMs: 200 });

    try {
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            servers: [
              {
                id: "slow",
                url: slowServer.url,
                transport: "auto",
                enabled: true,
                auth: { type: "none" },
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(authPath, `${JSON.stringify({ oauth: {} }, null, 2)}\n`, "utf8");

      const upstream = new UpstreamManager(
        new MetaMcpFileStore(configPath, authPath),
        "http://127.0.0.1:19070",
        {
          connectMs: 50,
          discoveryMs: 50,
          toolCallMs: 50,
        },
      );

      await expect(upstream.listAvailableServers()).resolves.toEqual([
        expect.objectContaining({
          server: expect.objectContaining({ id: "slow" }),
          tools: [],
          error: expect.stringContaining("Timed out"),
        }),
      ]);
    } finally {
      await slowServer.stop();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
