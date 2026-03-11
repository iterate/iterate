import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MetaMcpError } from "./errors.ts";
import { logInfo, logWarn } from "./logger.ts";
import { MetaMcpFileStore } from "./config/file-store.ts";
import {
  type AuthStore,
  type MetaMcpConfig,
  ParsedServerInput,
  ServerConfig,
} from "./config/schema.ts";
import {
  beginOAuthAuthorization,
  completeOAuthAuthorization,
  createOAuthClientProvider,
  resolveHeaders,
  supportsOAuth,
} from "./auth/oauth.ts";

export interface NormalizedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

interface ManagedClient {
  server: ServerConfig;
  client: Client;
  connected: boolean;
  authMode: "none" | "oauth";
}

type UpstreamTimeouts = {
  connectMs: number;
  discoveryMs: number;
  toolCallMs: number;
};

const DEFAULT_TIMEOUTS: UpstreamTimeouts = {
  connectMs: 10_000,
  discoveryMs: 15_000,
  toolCallMs: 30_000,
};

function normalizeTool(tool: Record<string, unknown>): NormalizedTool {
  return {
    name: String(tool.name ?? ""),
    description: String(tool.description ?? ""),
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  };
}

function createManagedClient(server: ServerConfig): ManagedClient {
  return {
    server,
    client: new Client({
      name: "iterate-meta-mcp-service",
      version: "0.0.1",
    }),
    connected: false,
    authMode: server.auth.type === "oauth" ? "oauth" : "none",
  };
}

function isOAuthRequiredError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) {
    return true;
  }

  if (typeof error === "object" && error !== null && "code" in error && error.code === 401) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("invalid_token") ||
    message.includes("unauthorized") ||
    message.includes("authentication failed")
  );
}

function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("epipe") ||
    message.includes("socket hang up") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("aborted")
  );
}

export class UpstreamManager {
  private clients = new Map<string, ManagedClient>();
  private toolCache = new Map<string, NormalizedTool[]>();
  private inflightToolLoads = new Map<string, Promise<NormalizedTool[]>>();
  private catalogRevision = 0;

  constructor(
    private readonly fileStore: MetaMcpFileStore,
    private readonly publicBaseUrl: string,
    private readonly timeouts: UpstreamTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  private async withTimeout<T>(params: {
    promise: Promise<T>;
    timeoutMs: number;
    serverId: string;
    operation: string;
  }): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new MetaMcpError(
            "UPSTREAM_TIMEOUT",
            `Timed out after ${String(params.timeoutMs)}ms during upstream ${params.operation} for '${params.serverId}'`,
            {
              serverId: params.serverId,
              operation: params.operation,
              timeoutMs: params.timeoutMs,
            },
          ),
        );
      }, params.timeoutMs);

      void params.promise.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  private async loadState(): Promise<{ config: MetaMcpConfig; authStore: AuthStore }> {
    const [config, authStore] = await Promise.all([
      this.fileStore.loadConfig(),
      this.fileStore.loadAuthStore(),
    ]);

    logInfo("loaded runtime state", {
      serverCount: config.servers.length,
    });

    return { config, authStore };
  }

  getRevision() {
    return this.catalogRevision;
  }

  private invalidateConfigCache(nextConfig?: MetaMcpConfig) {
    this.catalogRevision += 1;
    logInfo("invalidated catalog revision", {
      revision: this.catalogRevision,
      serverCount: nextConfig?.servers.length,
    });
  }

  private invalidateAuthStoreCache() {
    this.resetAllServers();
  }

  private async createTransport(params: {
    server: ServerConfig;
    authStore: AuthStore;
    useOAuth: boolean;
  }) {
    if (params.useOAuth) {
      return new StreamableHTTPClientTransport(new URL(params.server.url), {
        authProvider: createOAuthClientProvider({
          server: params.server,
          fileStore: this.fileStore,
          publicBaseUrl: this.publicBaseUrl,
        }),
      });
    }

    return new StreamableHTTPClientTransport(new URL(params.server.url), {
      requestInit: {
        headers: await resolveHeaders({
          server: params.server,
          authStore: params.authStore,
        }),
      },
    });
  }

  private async throwOAuthRequired(server: ServerConfig) {
    const authorization = await beginOAuthAuthorization({
      server,
      fileStore: this.fileStore,
      publicBaseUrl: this.publicBaseUrl,
    });

    throw new MetaMcpError("OAUTH_REQUIRED", `OAuth required for server '${server.id}'`, {
      serverId: server.id,
      authUrl: authorization.authUrl,
      callbackUrl: authorization.callbackUrl,
      expiresAt: authorization.expiresAt,
      ...(server.auth.type === "auto" ? { inferredAuthType: "oauth" as const } : {}),
    });
  }

  private async connectManagedClient(params: {
    managed: ManagedClient;
    authStore: AuthStore;
    preferredAuthMode?: "none" | "oauth";
  }): Promise<void> {
    const { managed, authStore } = params;
    const initialAuthMode =
      params.preferredAuthMode ?? (managed.server.auth.type === "oauth" ? "oauth" : "none");

    try {
      const transport = await this.createTransport({
        server: managed.server,
        authStore,
        useOAuth: initialAuthMode === "oauth",
      });
      await this.withTimeout({
        promise: managed.client.connect(transport),
        timeoutMs: this.timeouts.connectMs,
        serverId: managed.server.id,
        operation: "connect",
      });
      managed.authMode = initialAuthMode;
      return;
    } catch (error) {
      if (!isOAuthRequiredError(error)) {
        throw error;
      }

      if (managed.server.auth.type === "auto") {
        const transport = await this.createTransport({
          server: managed.server,
          authStore,
          useOAuth: true,
        });

        try {
          await this.withTimeout({
            promise: managed.client.connect(transport),
            timeoutMs: this.timeouts.connectMs,
            serverId: managed.server.id,
            operation: "oauth connect",
          });
          managed.authMode = "oauth";
          return;
        } catch (oauthError) {
          if (!isOAuthRequiredError(oauthError)) {
            throw oauthError;
          }
        }
      }

      if (supportsOAuth(managed.server)) {
        await this.throwOAuthRequired(managed.server);
      }

      throw error;
    }
  }

  private async reconnectWithOAuth(params: {
    managed: ManagedClient;
    authStore: AuthStore;
  }): Promise<void> {
    await params.managed.client.close().catch(() => undefined);
    params.managed.connected = false;
    await this.connectManagedClient({
      managed: params.managed,
      authStore: params.authStore,
      preferredAuthMode: "oauth",
    });
    params.managed.connected = true;
  }

  private async withOAuthRetry<T>(managed: ManagedClient, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (
        !isOAuthRequiredError(error) ||
        managed.server.auth.type !== "auto" ||
        managed.authMode === "oauth"
      ) {
        throw error;
      }

      const { authStore } = await this.getEnabledServer(managed.server.id);
      await this.reconnectWithOAuth({ managed, authStore });
      return await fn();
    }
  }

  private async probeServer(server: ServerConfig): Promise<{ tools: NormalizedTool[] }> {
    const managed = createManagedClient(server);
    const authStore = await this.fileStore.loadAuthStore();

    try {
      await this.connectManagedClient({ managed, authStore });
      const listToolsResult = await this.withOAuthRetry(managed, () =>
        this.withTimeout({
          promise: managed.client.listTools(),
          timeoutMs: this.timeouts.discoveryMs,
          serverId: managed.server.id,
          operation: "tool discovery",
        }),
      );
      return {
        tools: listToolsResult.tools.map((tool) => normalizeTool(tool as Record<string, unknown>)),
      };
    } finally {
      await managed.client.close().catch(() => undefined);
    }
  }

  private resetAllServers() {
    for (const serverId of this.clients.keys()) {
      this.resetServer(serverId);
    }
  }

  private async getEnabledServer(
    serverId: string,
  ): Promise<{ server: ServerConfig; authStore: AuthStore }> {
    const { config, authStore } = await this.loadState();
    const server = config.servers.find((item) => item.id === serverId && item.enabled);
    if (!server) {
      throw new MetaMcpError("SERVER_NOT_FOUND", `Unknown enabled server '${serverId}'`, {
        serverId,
      });
    }

    return { server, authStore };
  }

  private async ensureConnected(serverId: string): Promise<ManagedClient> {
    const { server, authStore } = await this.getEnabledServer(serverId);
    const current = this.clients.get(serverId);
    if (current?.connected && current.server.url === server.url) {
      logInfo("reusing upstream client", {
        serverId,
        url: server.url,
      });
      return current;
    }

    const managed = createManagedClient(server);
    logInfo("connecting upstream client", {
      serverId,
      url: server.url,
      transport: server.transport,
      authType: server.auth.type,
    });
    await this.connectManagedClient({ managed, authStore });

    managed.connected = true;
    this.clients.set(serverId, managed);
    logInfo("connected upstream client", {
      serverId,
      url: server.url,
    });
    return managed;
  }

  private resetServer(serverId: string) {
    logInfo("resetting upstream server state", {
      serverId,
      hadClient: this.clients.has(serverId),
      hadToolCache: this.toolCache.has(serverId),
      hadInflightLoad: this.inflightToolLoads.has(serverId),
    });
    this.clients.delete(serverId);
    this.toolCache.delete(serverId);
    this.inflightToolLoads.delete(serverId);
  }

  async listServers(): Promise<ServerConfig[]> {
    const { config } = await this.loadState();
    const servers = config.servers.filter((server) => server.enabled);
    logInfo("listed enabled servers", {
      enabledServerCount: servers.length,
      serverIds: servers.map((server) => server.id),
    });
    return servers;
  }

  async listTools(serverId: string): Promise<NormalizedTool[]> {
    const cached = this.toolCache.get(serverId);
    if (cached) {
      logInfo("using cached upstream tools", {
        serverId,
        toolCount: cached.length,
      });
      return cached;
    }

    const inflight = this.inflightToolLoads.get(serverId);
    if (inflight) {
      logInfo("waiting for inflight upstream tool load", {
        serverId,
      });
      return await inflight;
    }

    logInfo("loading upstream tools", {
      serverId,
    });
    const promise = this.loadTools(serverId);
    this.inflightToolLoads.set(serverId, promise);
    return await promise;
  }

  private async loadTools(serverId: string): Promise<NormalizedTool[]> {
    try {
      const managed = await this.ensureConnected(serverId);
      logInfo("requesting upstream listTools", {
        serverId,
        url: managed.server.url,
      });
      const result = await this.withOAuthRetry(managed, () =>
        this.withTimeout({
          promise: managed.client.listTools(),
          timeoutMs: this.timeouts.discoveryMs,
          serverId,
          operation: "tool discovery",
        }),
      );

      const tools = result.tools.map((tool) => normalizeTool(tool as Record<string, unknown>));
      this.toolCache.set(serverId, tools);
      logInfo("loaded upstream tools", {
        serverId,
        toolCount: tools.length,
      });
      return tools;
    } catch (error) {
      logWarn("failed to load upstream tools", {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.resetServer(serverId);
      throw error;
    } finally {
      this.inflightToolLoads.delete(serverId);
    }
  }

  async listAvailableServers(): Promise<
    Array<{ server: ServerConfig; tools: NormalizedTool[]; error?: string }>
  > {
    const servers = await this.listServers();
    logInfo("refreshing available server catalog", {
      serverCount: servers.length,
    });
    const results = await Promise.all(
      servers.map(async (server) => {
        try {
          logInfo("loading server tools for catalog", {
            serverId: server.id,
          });
          return {
            server,
            tools: await this.listTools(server.id),
          };
        } catch (error) {
          logWarn("failed to load server tools for catalog", {
            serverId: server.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            server,
            tools: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    logInfo("refreshed available server catalog", {
      serverCount: results.length,
      availableToolCount: results.reduce((total, result) => total + result.tools.length, 0),
      erroredServers: results.filter((result) => result.error).map((result) => result.server.id),
    });
    return results;
  }

  async callTool(params: {
    serverId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }): Promise<unknown> {
    logInfo("calling upstream tool", {
      serverId: params.serverId,
      toolName: params.toolName,
      argKeys: Object.keys(params.args ?? {}),
    });
    const callFn = (managed: ManagedClient) =>
      this.withTimeout({
        promise: managed.client.callTool({ name: params.toolName, arguments: params.args }),
        timeoutMs: this.timeouts.toolCallMs,
        serverId: params.serverId,
        operation: `tool call (${params.toolName})`,
      });

    try {
      const managed = await this.ensureConnected(params.serverId);
      const result = await this.withOAuthRetry(managed, () => callFn(managed));
      logInfo("upstream tool call completed", {
        serverId: params.serverId,
        toolName: params.toolName,
      });
      return result;
    } catch (error) {
      if (!isTransportError(error)) {
        throw error;
      }

      logWarn("upstream tool call failed on transport, retrying with fresh client", {
        serverId: params.serverId,
        toolName: params.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      this.resetServer(params.serverId);
      const managed = await this.ensureConnected(params.serverId);
      const result = await callFn(managed);
      logInfo("upstream tool call completed after retry", {
        serverId: params.serverId,
        toolName: params.toolName,
      });
      return result;
    }
  }

  async addServer(input: unknown): Promise<{ server: ServerConfig; toolCount: number }> {
    const parsedInput = ParsedServerInput.parse(input);
    const server = ServerConfig.parse({
      ...parsedInput,
      auth: parsedInput.auth ?? { type: "auto" },
    });

    logInfo("probing new MCP server", { serverId: server.id, url: server.url });

    try {
      const probeResult = await this.probeServer(server);
      const nextConfig = await this.fileStore.updateConfig((config) => ({
        ...config,
        servers: [...config.servers.filter((existing) => existing.id !== server.id), server],
      }));
      this.resetServer(server.id);
      this.invalidateConfigCache(nextConfig);
      logInfo("upserted MCP server", { serverId: server.id, toolCount: probeResult.tools.length });
      return {
        server,
        toolCount: probeResult.tools.length,
      };
    } catch (error) {
      if (error instanceof MetaMcpError && error.code === "OAUTH_REQUIRED") {
        const nextConfig = await this.fileStore.updateConfig((config) => ({
          ...config,
          servers: [...config.servers.filter((existing) => existing.id !== server.id), server],
        }));
        this.resetServer(server.id);
        this.invalidateConfigCache(nextConfig);
      }

      throw error;
    }
  }

  async startOAuth(
    serverId: string,
  ): Promise<{ serverId: string; authUrl: string; callbackUrl: string; expiresAt: string }> {
    const { server } = await this.getEnabledServer(serverId);
    if (!supportsOAuth(server)) {
      throw new MetaMcpError("INVALID_CONFIG", `Server '${serverId}' does not use OAuth`, {
        serverId,
      });
    }

    const authorization = await beginOAuthAuthorization({
      server,
      fileStore: this.fileStore,
      publicBaseUrl: this.publicBaseUrl,
    });

    return {
      serverId,
      authUrl: authorization.authUrl,
      callbackUrl: authorization.callbackUrl,
      expiresAt: authorization.expiresAt,
    };
  }

  async finishOAuth(params: { serverId: string; authorizationCode: string }): Promise<void> {
    const { server } = await this.getEnabledServer(params.serverId);
    if (!supportsOAuth(server)) {
      throw new MetaMcpError("INVALID_CONFIG", `Server '${params.serverId}' does not use OAuth`, {
        serverId: params.serverId,
      });
    }

    await completeOAuthAuthorization({
      server,
      fileStore: this.fileStore,
      publicBaseUrl: this.publicBaseUrl,
      authorizationCode: params.authorizationCode,
    });

    this.invalidateAuthStoreCache();
    this.resetServer(params.serverId);
  }
}
