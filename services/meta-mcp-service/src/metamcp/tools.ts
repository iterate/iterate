import { z } from "zod/v4";
import {
  buildCatalog,
  catalogNamespaces,
  catalogTools,
  describeTool,
  discoverCatalog,
} from "../catalog.ts";
import { serializeError } from "../errors.ts";
import { ParsedServerInput } from "../config/schema.ts";
import type { UpstreamManager } from "../upstream-manager.ts";

export const StartOAuthInput = z.object({
  serverId: z.string().min(1),
});

const AddServerCatalogInput = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  namespace: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  auth: z
    .union([
      z.enum(["auto", "oauth", "none"]),
      z.object({
        type: z.literal("bearer"),
        env: z.string().min(1),
      }),
    ])
    .optional(),
});

export interface MetaMcpTools {
  discover: (input: {
    query: string;
    limit?: number;
    includeSchemas?: boolean;
  }) => Promise<unknown>;
  describe: {
    tool: (input: { path: string; includeSchemas?: boolean }) => Promise<unknown>;
  };
  catalog: {
    namespaces: (input?: { limit?: number }) => Promise<unknown>;
    tools: (input?: {
      namespace?: string;
      query?: string;
      limit?: number;
      includeSchemas?: boolean;
    }) => Promise<unknown>;
  };
  metamcp: {
    addServer: (server: unknown) => Promise<unknown>;
    getSchema: (input: { tool: "addServer" | "startOAuth" }) => Promise<unknown>;
    startOAuth: (input: { serverId: string }) => Promise<unknown>;
  };
  [namespace: string]: unknown;
}

interface MetaMcpToolUpstream {
  listAvailableServers(): ReturnType<UpstreamManager["listAvailableServers"]>;
  addServer(input: unknown): ReturnType<UpstreamManager["addServer"]>;
  callTool(params: {
    serverId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }): Promise<unknown>;
  startOAuth(serverId: string): Promise<unknown>;
}

function getBuiltinCatalogEntries() {
  return [
    {
      namespace: "metamcp",
      sourceKey: "metamcp",
      tools: [
        {
          name: "addServer",
          callableName: "addServer",
          description:
            "Add a remote MCP server. Probes it immediately, discovers tools, and returns oauth_required with authUrl when authorization is needed.",
          inputSchema: z.toJSONSchema(AddServerCatalogInput),
          outputSchema: {
            type: "object",
            properties: {
              status: { type: "string" },
              server: { type: "object" },
              toolCount: { type: "number" },
              serverId: { type: "string" },
              authUrl: { type: "string" },
              callbackUrl: { type: "string" },
              expiresAt: { type: "string" },
              inferredAuthType: { type: "string" },
            },
          },
        },
        {
          name: "getSchema",
          callableName: "getSchema",
          description: "Return the exact input schema for a Meta MCP helper tool.",
          inputSchema: z.toJSONSchema(
            z.object({
              tool: z.enum(["addServer", "startOAuth"]),
            }),
          ),
          outputSchema: {
            type: "object",
            properties: {
              tool: { type: "string" },
              inputSchema: { type: "object" },
            },
          },
        },
        {
          name: "startOAuth",
          callableName: "startOAuth",
          description:
            "Start the OAuth flow for an already-configured server and return authUrl, callbackUrl, and expiry details.",
          inputSchema: z.toJSONSchema(StartOAuthInput),
          outputSchema: {
            type: "object",
            properties: {
              serverId: { type: "string" },
              authUrl: { type: "string" },
              callbackUrl: { type: "string" },
              expiresAt: { type: "string" },
            },
          },
        },
      ],
    },
  ];
}

export async function createMetaMcpTools(upstream: MetaMcpToolUpstream): Promise<MetaMcpTools> {
  let catalog = buildCatalog({
    servers: await upstream.listAvailableServers(),
    builtins: getBuiltinCatalogEntries(),
  });

  const tools: MetaMcpTools = {
    discover: async (input: { query: string; limit?: number; includeSchemas?: boolean }) =>
      discoverCatalog({
        catalog,
        query: input.query,
        limit: input.limit,
        includeSchemas: input.includeSchemas,
      }),
    describe: {
      tool: async (input: { path: string; includeSchemas?: boolean }) =>
        describeTool({
          catalog,
          path: input.path,
          includeSchemas: input.includeSchemas,
        }),
    },
    catalog: {
      namespaces: async (input?: { limit?: number }) =>
        catalogNamespaces({
          catalog,
          limit: input?.limit,
        }),
      tools: async (input?: {
        namespace?: string;
        query?: string;
        limit?: number;
        includeSchemas?: boolean;
      }) =>
        catalogTools({
          catalog,
          namespace: input?.namespace,
          query: input?.query,
          limit: input?.limit,
          includeSchemas: input?.includeSchemas,
        }),
    },
    metamcp: {
      addServer: async (server: unknown) => {
        const parsedServer = ParsedServerInput.parse(server);

        try {
          const added = await upstream.addServer(parsedServer);
          await refreshToolNamespaces();
          return {
            status: "added" as const,
            server: added.server,
            toolCount: added.toolCount,
          };
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }

          const serialized = serializeError(error);
          if (serialized.code !== "OAUTH_REQUIRED") {
            throw error;
          }

          const details =
            typeof serialized.details === "object" && serialized.details !== null
              ? (serialized.details as Record<string, unknown>)
              : {};

          console.log("oauth_required", details);
          return {
            status: "oauth_required" as const,
            serverId: typeof details.serverId === "string" ? details.serverId : parsedServer.id,
            authUrl: details.authUrl,
            callbackUrl: details.callbackUrl,
            expiresAt: details.expiresAt,
            inferredAuthType: details.inferredAuthType,
          };
        }
      },
      getSchema: async (input: { tool: "addServer" | "startOAuth" }) => ({
        tool: input.tool,
        inputSchema:
          input.tool === "addServer"
            ? z.toJSONSchema(ParsedServerInput)
            : z.toJSONSchema(StartOAuthInput),
      }),
      startOAuth: async (input: { serverId: string }) =>
        await upstream.startOAuth(StartOAuthInput.parse(input).serverId),
    },
  };

  async function refreshToolNamespaces() {
    catalog = buildCatalog({
      servers: await upstream.listAvailableServers(),
      builtins: getBuiltinCatalogEntries(),
    });

    for (const key of Object.keys(tools)) {
      if (!["discover", "describe", "catalog", "metamcp"].includes(key)) {
        delete tools[key];
      }
    }

    for (const namespaceRecord of catalog.namespaces) {
      if (namespaceRecord.namespace === "metamcp") {
        continue;
      }
      tools[namespaceRecord.namespace] = Object.fromEntries(
        namespaceRecord.tools.map((tool) => [
          tool.callableName,
          async (args?: unknown) => {
            if (args !== undefined && (typeof args !== "object" || Array.isArray(args))) {
              throw new Error(`Expected object args for ${tool.path}`);
            }

            return await upstream.callTool({
              serverId: namespaceRecord.serverId,
              toolName: tool.toolName,
              args: (args ?? {}) as Record<string, unknown>,
            });
          },
        ]),
      );
    }
  }

  await refreshToolNamespaces();

  return tools;
}
