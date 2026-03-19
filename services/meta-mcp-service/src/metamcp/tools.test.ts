import { describe, expect, test, vi } from "vitest";
import { normalizeServerInput, ParsedServerInput, type ServerConfig } from "../config/schema.ts";
import { MetaMcpError } from "../errors.ts";
import { createMetaMcpTools } from "./tools.ts";

function createServer(id: string): ServerConfig {
  return {
    id,
    url: `https://${id}.example.com/mcp`,
    enabled: true,
    auth: { type: "auto" },
  };
}

describe("normalizeServerInput", () => {
  test("normalizes auth shorthand strings after parsing", () => {
    expect(
      normalizeServerInput(
        ParsedServerInput.parse({
          id: "example",
          url: "https://example.com/mcp",
          auth: "oauth",
        }),
      ).auth,
    ).toEqual({ type: "oauth" });

    expect(
      normalizeServerInput(
        ParsedServerInput.parse({
          id: "example",
          url: "https://example.com/mcp",
          auth: "auto",
        }),
      ).auth,
    ).toEqual({ type: "auto" });

    expect(
      normalizeServerInput(
        ParsedServerInput.parse({
          id: "example",
          url: "https://example.com/mcp",
          auth: "none",
        }),
      ).auth,
    ).toEqual({ type: "none" });
  });
});

describe("createMetaMcpTools", () => {
  test("includes metamcp helper tools in the catalog", async () => {
    const tools = await createMetaMcpTools({
      listAvailableServers: async () => [],
      addServer: async () => ({
        server: createServer("example"),
        toolCount: 0,
      }),
      callTool: async () => null,
      startOAuth: async () => ({ ok: true }),
    });

    await expect(tools.catalog.tools({ namespace: "metamcp" })).resolves.toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ path: "metamcp.addServer" }),
        expect.objectContaining({ path: "metamcp.startOAuth" }),
      ]),
    });

    await expect(tools.discover({ query: "add remote mcp server" })).resolves.toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({
          path: "metamcp.addServer",
          inputTypeScript: expect.stringContaining("MetamcpAddServerInput"),
          outputTypeScript: expect.stringContaining("MetamcpAddServerOutput"),
        }),
      ]),
    });

    await expect(
      tools.describe.tool({ path: "metamcp.addServer", includeSchemas: true }),
    ).resolves.toMatchObject({
      path: "metamcp.addServer",
      inputTypeScript: expect.stringContaining("MetamcpAddServerInput"),
      outputTypeScript: expect.stringContaining("MetamcpAddServerOutput"),
    });

    await expect(
      tools.catalog.tools({ namespace: "metamcp", includeSchemas: true }),
    ).resolves.toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({
          path: "metamcp.addServer",
          inputTypeScript: expect.stringContaining("MetamcpAddServerInput"),
          outputTypeScript: expect.stringContaining("MetamcpAddServerOutput"),
        }),
      ]),
    });
  });

  test("refreshes namespaces during addServer", async () => {
    let availableServers: Array<{
      server: ServerConfig;
      tools: Array<{
        name: string;
        description: string;
        inputSchema: unknown;
        outputSchema: unknown;
      }>;
      error?: string;
    }> = [];
    const addServer = vi.fn(async () => {
      availableServers = [
        {
          server: createServer("weather"),
          tools: [
            {
              name: "get-forecast",
              description: "Get a forecast",
              inputSchema: { type: "object", properties: { city: { type: "string" } } },
              outputSchema: { type: "object" },
            },
          ],
        },
      ];

      return {
        server: createServer("weather"),
        toolCount: 1,
      };
    });
    const callTool = vi.fn(async () => ({ ok: true }));

    const tools = await createMetaMcpTools({
      listAvailableServers: async () => availableServers,
      addServer,
      callTool,
      startOAuth: async () => ({ ok: true }),
    });

    const added = await tools.metamcp.addServer({
      id: "weather",
      url: "https://weather.example.com/mcp",
      auth: "auto",
    });

    expect(added).toMatchObject({
      status: "added",
      toolCount: 1,
    });
    await expect(tools.catalog.tools({ namespace: "weather" })).resolves.toMatchObject({
      results: [
        expect.objectContaining({
          path: "weather.get_forecast",
        }),
      ],
    });

    const weatherNamespace = tools["weather"];
    expect(weatherNamespace).toBeTypeOf("object");
    if (!weatherNamespace || typeof weatherNamespace !== "object") {
      throw new Error("Expected weather namespace to be registered");
    }

    const getForecast = Reflect.get(weatherNamespace, "get_forecast");
    expect(getForecast).toBeTypeOf("function");
    if (typeof getForecast !== "function") {
      throw new Error("Expected get_forecast tool to be registered");
    }

    await getForecast({ city: "Pune" });

    await expect(tools.discover({ query: "forecast city" })).resolves.toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({
          path: "weather.get_forecast",
          inputTypeScript: expect.stringContaining("WeatherGetForecastInput"),
          outputTypeScript: expect.stringContaining("WeatherGetForecastOutput"),
        }),
      ]),
    });

    expect(callTool).toHaveBeenCalledWith({
      serverId: "weather",
      toolName: "get-forecast",
      args: { city: "Pune" },
    });
  });

  test("returns oauth_required when discovery needs OAuth", async () => {
    const tools = await createMetaMcpTools({
      listAvailableServers: async () => [],
      addServer: async () => {
        throw new MetaMcpError("OAUTH_REQUIRED", "OAuth required", {
          serverId: "github",
          authUrl: "https://auth.example.com",
          callbackUrl: "https://meta.example.com/oauth/callback",
          expiresAt: "2026-03-10T12:00:00.000Z",
        });
      },
      callTool: async () => null,
      startOAuth: async () => ({ ok: true }),
    });

    await expect(
      tools.metamcp.addServer({
        id: "github",
        url: "https://github.example.com/mcp",
        auth: "oauth",
      }),
    ).resolves.toEqual({
      status: "oauth_required",
      serverId: "github",
      authUrl: "https://auth.example.com",
      callbackUrl: "https://meta.example.com/oauth/callback",
      expiresAt: "2026-03-10T12:00:00.000Z",
      inferredAuthType: undefined,
    });
  });
});
