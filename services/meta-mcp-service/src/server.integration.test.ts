import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { StreamableHTTPTransport } from "@hono/mcp";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod/v4";

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

async function waitForOk(url: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function startFakeMcpServer() {
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
      name: "fake-weather-server",
      version: "1.0.0",
    });

    server.registerTool(
      "get-forecast",
      {
        description: "Get a weather forecast for a city",
        inputSchema: {
          city: z.string().describe("City name"),
          units: z.enum(["metric", "imperial"]).optional(),
        },
        outputSchema: {
          summary: z.string(),
          high: z.number(),
          low: z.number(),
        },
      },
      async ({ city, units }) => ({
        content: [
          {
            type: "text" as const,
            text: `${city} forecast`,
          },
        ],
        structuredContent: {
          summary: `Forecast for ${city} in ${units ?? "metric"}`,
          high: 31,
          low: 22,
        },
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

  app.get("/healthz", (c) => c.text("ok"));

  app.all("/mcp", async (c) => {
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

  const url = `http://${host}:${String(port)}/mcp`;
  await waitForOk(`http://${host}:${String(port)}/healthz`);

  return {
    url,
    stop: async () => {
      await Promise.all([...sessions.keys()].map((sessionId) => disposeSession(sessionId)));
      nodeServer.close();
    },
  };
}

async function withMetaMcpEnvironment<T>(
  fn: (paths: { serversPath: string; authPath: string; publicUrl: string }) => Promise<T>,
) {
  const tempRoot = await mkdtemp(join(tmpdir(), "meta-mcp-service-test-"));
  const serversPath = join(tempRoot, "servers.json");
  const authPath = join(tempRoot, "auth.json");

  const previous = {
    META_MCP_SERVICE_SERVERS_PATH: process.env.META_MCP_SERVICE_SERVERS_PATH,
    META_MCP_SERVICE_CONFIG_PATH: process.env.META_MCP_SERVICE_CONFIG_PATH,
    META_MCP_SERVICE_AUTH_PATH: process.env.META_MCP_SERVICE_AUTH_PATH,
    META_MCP_SERVICE_PUBLIC_URL: process.env.META_MCP_SERVICE_PUBLIC_URL,
    ITERATE_PROJECT_BASE_URL: process.env.ITERATE_PROJECT_BASE_URL,
  };

  try {
    await writeFile(
      authPath,
      `${JSON.stringify(
        { version: "1.0.0", oauth: {}, clientInformation: {}, tokens: {} },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const port = await getAvailablePort();
    const publicUrl = `http://127.0.0.1:${String(port)}`;
    process.env.META_MCP_SERVICE_SERVERS_PATH = serversPath;
    delete process.env.META_MCP_SERVICE_CONFIG_PATH;
    process.env.META_MCP_SERVICE_AUTH_PATH = authPath;
    process.env.META_MCP_SERVICE_PUBLIC_URL = publicUrl;
    process.env.ITERATE_PROJECT_BASE_URL = publicUrl;

    return await fn({ serversPath, authPath, publicUrl });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function startMetaMcpService(options?: { host?: string; port?: number }) {
  vi.resetModules();
  const { startMetaMcpServer } = await import("./metamcp/server.ts");
  const nodeServer = startMetaMcpServer(options);

  return {
    stop: async () => {
      nodeServer.close();
    },
  };
}

async function createMetaMcpClient(url: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({
    name: "meta-mcp-service-integration-test",
    version: "1.0.0",
  });

  await client.connect(transport);

  return {
    client,
    transport,
    close: async () => {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
  };
}

async function executeCode(client: Client, code: string) {
  const result = await client.callTool({
    name: "execute",
    arguments: {
      code,
    },
  });

  return result.structuredContent as {
    result: unknown;
    logs: string[];
    error?: unknown;
  };
}

describe.sequential("meta-mcp-service integration", () => {
  test("redirects local mcp auth links to the saved provider URL", async () => {
    await withMetaMcpEnvironment(async ({ serversPath, authPath, publicUrl }) => {
      await writeFile(
        serversPath,
        `${JSON.stringify(
          {
            servers: [
              {
                id: "cloudflare-observability",
                url: "https://cloudflare.example.com/mcp",
                enabled: true,
                auth: { type: "oauth" },
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        authPath,
        `${JSON.stringify(
          {
            version: "1.0.0",
            oauth: {
              "cloudflare-observability": {
                authorization: {
                  authUrl: `${publicUrl}/auth/start/test-state`,
                  providerAuthUrl: "https://provider.example.com/oauth/authorize",
                  callbackUrl: `${publicUrl}/auth/finish`,
                  redirectUrl: `${publicUrl}/auth/finish`,
                  localAuthState: "test-state",
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
              },
            },
            clientInformation: {},
            tokens: {},
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const port = await getAvailablePort();
      const service = await startMetaMcpService({
        host: "127.0.0.1",
        port,
      });

      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/auth/start/test-state`, {
          redirect: "manual",
        });

        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(
          "https://provider.example.com/oauth/authorize",
        );
      } finally {
        await service.stop();
      }
    });
  });

  test("returns a helpful message for invalid auth start state", async () => {
    await withMetaMcpEnvironment(async ({ serversPath }) => {
      await writeFile(serversPath, `${JSON.stringify({ servers: [] }, null, 2)}\n`, "utf8");

      const port = await getAvailablePort();
      const service = await startMetaMcpService({
        host: "127.0.0.1",
        port,
      });

      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/auth/start/does-not-exist`);

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain(
          "No saved info found to initiate this OAuth authorization",
        );
      } finally {
        await service.stop();
      }
    });
  });

  test("returns a helpful message for invalid auth finish state", async () => {
    await withMetaMcpEnvironment(async ({ serversPath }) => {
      await writeFile(serversPath, `${JSON.stringify({ servers: [] }, null, 2)}\n`, "utf8");

      const port = await getAvailablePort();
      const service = await startMetaMcpService({
        host: "127.0.0.1",
        port,
      });

      try {
        const response = await fetch(
          `http://127.0.0.1:${String(port)}/auth/finish?state=does-not-exist&code=test-code`,
        );

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain(
          "No saved info found to finish this OAuth authorization",
        );
      } finally {
        await service.stop();
      }
    });
  });

  test("reports waiting OAuth servers and reuses the saved auth state in api status", async () => {
    await withMetaMcpEnvironment(async ({ serversPath, authPath, publicUrl }) => {
      await writeFile(
        serversPath,
        `${JSON.stringify(
          {
            servers: [
              {
                id: "github",
                url: "https://github.example.com/mcp",
                enabled: true,
                auth: { type: "oauth" },
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        authPath,
        `${JSON.stringify(
          {
            version: "1.0.0",
            oauth: {
              github: {
                authorization: {
                  authUrl: `${publicUrl}/auth/start/existing-state`,
                  providerAuthUrl: "https://provider.example.com/oauth/authorize",
                  callbackUrl: `${publicUrl}/auth/finish`,
                  redirectUrl: `${publicUrl}/auth/finish`,
                  localAuthState: "existing-state",
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
              },
            },
            clientInformation: {},
            tokens: {},
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const port = await getAvailablePort();
      const service = await startMetaMcpService({
        host: "127.0.0.1",
        port,
      });

      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/api/status`);
        const body = (await response.json()) as {
          publicBaseUrl: string;
          servers: Array<{
            id: string;
            auth: {
              type: string;
              connected: boolean;
              waitingForOAuth: boolean;
              startOAuthUrl: string | null;
              pendingAuthUrl: string | null;
              callbackUrl: string | null;
              expiresAt: string | null;
            };
          }>;
        };

        expect(response.status).toBe(200);
        expect(body.publicBaseUrl).toBe(publicUrl);
        expect(body.servers).toMatchObject([
          {
            id: "github",
            auth: {
              type: "oauth",
              connected: false,
              waitingForOAuth: true,
              startOAuthUrl: `${publicUrl}/auth/start/existing-state`,
              pendingAuthUrl: "https://provider.example.com/oauth/authorize",
              callbackUrl: `${publicUrl}/auth/finish`,
              expiresAt: expect.any(String),
            },
          },
        ]);
      } finally {
        await service.stop();
      }
    });
  });

  test("reports connected OAuth servers without generating a new auth state", async () => {
    await withMetaMcpEnvironment(async ({ serversPath, authPath, publicUrl }) => {
      await writeFile(
        serversPath,
        `${JSON.stringify(
          {
            servers: [
              {
                id: "github",
                url: "https://github.example.com/mcp",
                enabled: true,
                auth: { type: "oauth" },
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        authPath,
        `${JSON.stringify(
          {
            version: "1.0.0",
            oauth: {},
            clientInformation: {},
            tokens: {
              github: {
                accessToken: "test-access-token",
                tokenType: "Bearer",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const port = await getAvailablePort();
      const service = await startMetaMcpService({
        host: "127.0.0.1",
        port,
      });

      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/api/status`);
        const body = (await response.json()) as {
          publicBaseUrl: string;
          servers: Array<{
            id: string;
            auth: {
              type: string;
              connected: boolean;
              waitingForOAuth: boolean;
              startOAuthUrl: string | null;
              pendingAuthUrl: string | null;
              callbackUrl: string | null;
              expiresAt: string | null;
            };
          }>;
        };

        expect(response.status).toBe(200);
        expect(body.publicBaseUrl).toBe(publicUrl);
        expect(body.servers).toMatchObject([
          {
            id: "github",
            auth: {
              type: "oauth",
              connected: true,
              waitingForOAuth: false,
              startOAuthUrl: null,
              pendingAuthUrl: null,
              callbackUrl: null,
            },
          },
        ]);
      } finally {
        await service.stop();
      }
    });
  });

  test("discovers fake upstream tools with rendered types over the real MCP transport", async () => {
    const fakeServer = await startFakeMcpServer();

    try {
      await withMetaMcpEnvironment(async ({ serversPath }) => {
        await writeFile(
          serversPath,
          `${JSON.stringify(
            {
              servers: [
                {
                  id: "weather",
                  url: fakeServer.url,
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

        const port = await getAvailablePort();
        const service = await startMetaMcpService({
          host: "127.0.0.1",
          port,
        });
        const client = await createMetaMcpClient(`http://127.0.0.1:${String(port)}/mcp`);

        try {
          const execution = await executeCode(
            client.client,
            'return await tools.discover({ query: "forecast city" });',
          );

          expect(execution.error).toBeUndefined();
          expect(execution.result).toMatchObject({
            bestPath: "weather.get_forecast",
            results: [
              expect.objectContaining({
                path: "weather.get_forecast",
                inputTypeScript: expect.stringContaining("WeatherGetForecastInput"),
                outputTypeScript: expect.stringContaining("WeatherGetForecastOutput"),
              }),
            ],
          });
        } finally {
          await client.close();
          await service.stop();
        }
      });
    } finally {
      await fakeServer.stop();
    }
  });

  test("adds a fake upstream server and calls its tool end to end", async () => {
    const fakeServer = await startFakeMcpServer();

    try {
      await withMetaMcpEnvironment(async ({ serversPath }) => {
        await writeFile(serversPath, `${JSON.stringify({ servers: [] }, null, 2)}\n`, "utf8");

        const port = await getAvailablePort();
        const service = await startMetaMcpService({
          host: "127.0.0.1",
          port,
        });
        const client = await createMetaMcpClient(`http://127.0.0.1:${String(port)}/mcp`);

        try {
          const execution = await executeCode(
            client.client,
            `
              const added = await tools.metamcp.addServer({
                id: "weather",
                url: ${JSON.stringify(fakeServer.url)},
                auth: "none"
              });
              const discovered = await tools.discover({ query: "forecast city" });
              const forecast = await tools.weather.get_forecast({ city: "Pune", units: "metric" });
              return { added, discovered, forecast };
            `,
          );

          expect(execution.error).toBeUndefined();
          expect(execution.result).toMatchObject({
            added: {
              status: "added",
              toolCount: 1,
            },
            discovered: {
              bestPath: "weather.get_forecast",
              results: [
                expect.objectContaining({
                  inputTypeScript: expect.stringContaining("WeatherGetForecastInput"),
                }),
              ],
            },
            forecast: {
              structuredContent: {
                summary: "Forecast for Pune in metric",
                high: 31,
                low: 22,
              },
            },
          });
        } finally {
          await client.close();
          await service.stop();
        }
      });
    } finally {
      await fakeServer.stop();
    }
  });
});
