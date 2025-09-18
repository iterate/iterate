import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MergedStateForSlices } from "../agent-core.ts";
import type { CoreAgentSlices } from "../iterate-agent.ts";
import {
  type MCPConnection,
  MCPConnectionKey,
  type MCPConnectRequestEvent,
  type MCPDisconnectRequestEvent,
} from "./mcp-slice.ts";
import {
  mcpManagerCache,
  runMCPEventHooks,
  connectionQueues,
  getConnectionQueue,
  abortPendingConnections,
} from "./mcp-event-hooks.ts";

// Mock dependencies
vi.mock("agents/mcp/client", () => ({
  MCPClientManager: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    listTools: vi.fn().mockReturnValue([]),
    listPrompts: vi.fn().mockReturnValue([]),
    listResources: vi.fn().mockReturnValue([]),
    closeConnection: vi.fn(),
  })),
}));

vi.mock("./mcp-oauth-provider.ts", () => ({
  MCPOAuthProvider: vi.fn().mockImplementation(() => ({
    authUrl: null,
    clearTokens: vi.fn(),
    tokens: vi.fn().mockResolvedValue({}),
    setupOAuthFlow: vi.fn().mockResolvedValue({}),
  })),
}));

vi.stubEnv("VITE_PUBLIC_URL", "https://test.iterate.com");

vi.mock("../../integrations/dependency-formatter.ts", () => ({
  formatStringWithDependencyFromIntegrationSystem: vi.fn().mockResolvedValue({
    formattedString: "https://formatted.example.com",
    missingDependencies: [],
  }),
}));

vi.mock("../../integrations/slug-generator.ts", () => ({
  getIntegrationSlugFromServerUrl: vi.fn().mockReturnValue("test-integration"),
}));

vi.mock("../../trpc/trpc.ts", () => ({
  serverTrpc: {
    integrations: {
      getIntegrationSecrets: {
        query: vi.fn().mockResolvedValue([]),
      },
    },
  },
}));

// Mock imports
const { MCPClientManager } = await import("agents/mcp/client");
const { MCPOAuthProvider } = await import("./mcp-oauth-provider.ts");

describe("mcp-event-hooks", () => {
  // Helper to create properly typed events
  const createEvent = <T extends { type: string; data: any }>(
    event: Omit<T, "createdAt" | "eventIndex">,
  ): T =>
    ({
      ...event,
      createdAt: "2024-01-01T00:00:00.000Z",
      eventIndex: 1,
    }) as unknown as T;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpManagerCache.managers.clear();
    // Clear connection queues between tests
    connectionQueues.clear();
  });

  describe("mcpManagerCache", () => {
    it("should start with empty cache", () => {
      expect(mcpManagerCache.managers.size).toBe(0);
    });
  });

  describe("runMCPEventHooks", () => {
    const createMockState = (overrides?: Partial<MergedStateForSlices<CoreAgentSlices>>) =>
      ({
        participants: {},
        toolSpecs: [],
        mcpConnections: {},
        ...overrides,
      }) as MergedStateForSlices<CoreAgentSlices>;

    const createMockGetFinalRedirectUrl = () =>
      vi.fn().mockResolvedValue("https://test.iterate.com/oauth/callback");

    const createMockConnection = (overrides?: Partial<MCPConnection>): MCPConnection => ({
      integrationSlug: "github",
      serverId: "server-1",
      serverUrl: "https://github.com/mcp",
      serverName: "GitHub",
      mode: "company" as const,
      connectedAt: "2024-01-01T00:00:00.000Z",
      tools: [],
      prompts: [],
      resources: [],
      ...overrides,
    });

    describe("MCP:CONNECT_REQUEST", () => {
      it("should return error for personal connection without userId", async () => {
        const event = createEvent<MCPConnectRequestEvent>({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "personal",
            integrationSlug: "github",
            requiresAuth: true,
            triggerLLMRequestOnEstablishedConnection: false,
          },
          metadata: {},
          triggerLLMRequest: false,
        });

        const result = await runMCPEventHooks({
          event,
          reducedState: createMockState(),
          agentDurableObjectId: "agent123",
          agentDurableObjectName: "agent123",
          getFinalRedirectUrl: createMockGetFinalRedirectUrl(),
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          type: "MCP:CONNECTION_ERROR",
          data: {
            serverUrl: "https://github.com/mcp",
            error: "Personal connections require userId",
          },
        });
      });

      it("should skip if already connected", async () => {
        const event = createEvent<MCPConnectRequestEvent>({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "company",
            integrationSlug: "github",
            requiresAuth: true,
            triggerLLMRequestOnEstablishedConnection: false,
          },
          metadata: {},
          triggerLLMRequest: false,
        });

        const connectionKey = MCPConnectionKey.parse("https://github.com/mcp::company");
        const reducedState = createMockState({
          mcpConnections: {
            [connectionKey as string]: createMockConnection({
              mode: "company",
            }),
          },
        });

        // Add a mock manager to the cache so it's not treated as a rehydration
        const mockManager = {
          connect: vi.fn(),
          listTools: vi.fn().mockReturnValue([]),
          listPrompts: vi.fn().mockReturnValue([]),
          listResources: vi.fn().mockReturnValue([]),
          closeConnection: vi.fn(),
        };
        mcpManagerCache.managers.set(connectionKey, mockManager as any);

        const result = await runMCPEventHooks({
          event,
          reducedState,

          getFinalRedirectUrl: createMockGetFinalRedirectUrl(),
          agentDurableObjectId: "agent123",
          agentDurableObjectName: "agent123",
        });

        expect(result).toHaveLength(0);
      });

      it("should establish successful connection", async () => {
        const mockManager = {
          connect: vi.fn().mockResolvedValue({
            id: "server-123",
            authUrl: null,
          }),
          listTools: vi.fn().mockReturnValue([{ name: "search_repos", serverId: "server-123" }]),
          listPrompts: vi.fn().mockReturnValue([{ name: "repo_prompt", serverId: "server-123" }]),
          listResources: vi.fn().mockReturnValue([{ uri: "repo://test", serverId: "server-123" }]),
          mcpConnections: {
            "server-123": {
              client: {
                getServerVersion: vi.fn().mockReturnValue({ name: "Test Server" }),
              },
            },
          },
        };

        vi.mocked(MCPClientManager).mockImplementation(() => mockManager as any);

        const event = createEvent<MCPConnectRequestEvent>({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "company",
            integrationSlug: "github",
            allowedTools: ["search_repos"],
            requiresAuth: false,
            triggerLLMRequestOnEstablishedConnection: true,
          },
          metadata: {},
          triggerLLMRequest: false,
        });

        const mockGetFinalRedirectUrl = createMockGetFinalRedirectUrl();

        const result = await runMCPEventHooks({
          event,
          reducedState: createMockState(),
          agentDurableObjectId: "agent123",
          agentDurableObjectName: "agent123",
          getFinalRedirectUrl: mockGetFinalRedirectUrl,
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey: "https://github.com/mcp::company",
            serverId: "server-123",
            serverUrl: "https://github.com/mcp",
            mode: "company",
            integrationSlug: "github",
            tools: [{ name: "search_repos", serverId: "server-123" }],
            prompts: [{ name: "repo_prompt", serverId: "server-123" }],
            resources: [{ uri: "repo://test", serverId: "server-123" }],
          },
          triggerLLMRequest: true,
        });

        expect(mockManager.connect).toHaveBeenCalledWith("https://github.com/mcp", {
          transport: {
            authProvider: undefined,
            requestInit: {
              headers: {},
            },
            type: "auto",
          },
        });
        expect(mockGetFinalRedirectUrl).toHaveBeenCalledWith({
          durableObjectInstanceName: "agent123",
          reducedState: createMockState(),
        });
      });

      it("should call getFinalRedirectUrl dependency correctly", async () => {
        const mockManager = {
          connect: vi.fn().mockResolvedValue({
            id: "server-123",
            authUrl: null,
          }),
          listTools: vi.fn().mockReturnValue([]),
          listPrompts: vi.fn().mockReturnValue([]),
          listResources: vi.fn().mockReturnValue([]),
          mcpConnections: {
            "server-123": {
              client: {
                getServerVersion: vi.fn().mockReturnValue({ name: "Test Server" }),
              },
            },
          },
        };

        const mockGetFinalRedirectUrl = createMockGetFinalRedirectUrl();

        vi.mocked(MCPClientManager).mockImplementation(() => mockManager as any);

        const event = createEvent<MCPConnectRequestEvent>({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "company",
            integrationSlug: "github",
            requiresAuth: false,
            triggerLLMRequestOnEstablishedConnection: false,
          },
          metadata: {},
          triggerLLMRequest: false,
        });

        await runMCPEventHooks({
          event,
          reducedState: createMockState(),
          agentDurableObjectId: "agent123",
          agentDurableObjectName: "agent123",
          getFinalRedirectUrl: mockGetFinalRedirectUrl,
        });

        expect(mockGetFinalRedirectUrl).toHaveBeenCalledWith({
          durableObjectInstanceName: "agent123",
          reducedState: createMockState(),
        });
      });

      it("should handle OAuth required scenario", async () => {
        const mockManager = {
          connect: vi.fn().mockResolvedValue({
            id: "server-123",
            authUrl: "https://github.com/oauth/authorize",
          }),
          listTools: vi.fn().mockReturnValue([]),
          listPrompts: vi.fn().mockReturnValue([]),
          listResources: vi.fn().mockReturnValue([]),
        };

        vi.mocked(MCPClientManager).mockImplementation(() => mockManager as any);

        const event = createEvent<MCPConnectRequestEvent>({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "personal",
            userId: "user123",
            integrationSlug: "github",
            requiresAuth: true,
            triggerLLMRequestOnEstablishedConnection: false,
          },
          metadata: {},
          triggerLLMRequest: false,
        });

        const result = await runMCPEventHooks({
          event,
          reducedState: createMockState(),
          agentDurableObjectId: "agent123",
          agentDurableObjectName: "agent123",
          getFinalRedirectUrl: createMockGetFinalRedirectUrl(),
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          type: "MCP:OAUTH_REQUIRED",
          data: {
            connectionKey: "https://github.com/mcp::personal::user123",
            serverUrl: "https://github.com/mcp",
            mode: "personal",
            userId: "user123",
            integrationSlug: "github",
            oauthUrl: "https://github.com/oauth/authorize",
          },
        });
      });

      it("should handle connection timeout error", async () => {
        const mockManager = {
          connect: vi
            .fn()
            .mockRejectedValue(
              new Error("MCP connection timeout - authentication may have expired"),
            ),
          listTools: vi.fn().mockReturnValue([]),
          listPrompts: vi.fn().mockReturnValue([]),
          listResources: vi.fn().mockReturnValue([]),
        };

        const mockOAuthProvider = {
          authUrl: "https://github.com/oauth/authorize",
          clearTokens: vi.fn(),
          tokens: vi.fn().mockResolvedValue({}),
          setupOAuthFlow: vi.fn().mockResolvedValue({}),
        };

        const mockGetFinalRedirectUrl = createMockGetFinalRedirectUrl();

        vi.mocked(MCPClientManager).mockImplementation(() => mockManager as any);
        vi.mocked(MCPOAuthProvider).mockImplementation(() => mockOAuthProvider as any);

        const event = createEvent<MCPConnectRequestEvent>({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "personal",
            userId: "user123",
            integrationSlug: "github",
            requiresAuth: true,
            triggerLLMRequestOnEstablishedConnection: false,
          },
          metadata: {},
          triggerLLMRequest: false,
        });

        const result = await runMCPEventHooks({
          event,
          reducedState: createMockState(),
          agentDurableObjectId: "agent123",
          agentDurableObjectName: "agent123",
          getFinalRedirectUrl: mockGetFinalRedirectUrl,
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          type: "MCP:OAUTH_REQUIRED",
          data: {
            connectionKey: "https://github.com/mcp::personal::user123",
            oauthUrl: "https://github.com/oauth/authorize",
          },
        });

        expect(mockOAuthProvider.clearTokens).toHaveBeenCalled();
      });

      it("should filter tools, prompts, and resources by allowedLists", async () => {
        const mockManager = {
          connect: vi.fn().mockResolvedValue({
            id: "server-123",
            authUrl: null,
          }),
          listTools: vi.fn().mockReturnValue([
            { name: "search_repos", serverId: "server-123" },
            { name: "create_issue", serverId: "server-123" },
            { name: "list_pulls", serverId: "server-123" },
          ]),
          listPrompts: vi.fn().mockReturnValue([
            { name: "repo_prompt", serverId: "server-123" },
            { name: "issue_prompt", serverId: "server-123" },
          ]),
          listResources: vi.fn().mockReturnValue([
            { uri: "repo://test", serverId: "server-123" },
            { uri: "issues://test", serverId: "server-123" },
          ]),
          mcpConnections: {
            "server-123": {
              client: {
                getServerVersion: vi.fn().mockReturnValue({ name: "Test Server" }),
              },
            },
          },
        };

        vi.mocked(MCPClientManager).mockImplementation(() => mockManager as any);

        const event = createEvent<MCPConnectRequestEvent>({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "company",
            integrationSlug: "github",
            allowedTools: ["search_repos", "create_issue"],
            allowedPrompts: ["repo_prompt"],
            allowedResources: ["repo://test"],
            requiresAuth: false,
            triggerLLMRequestOnEstablishedConnection: false,
          },
          metadata: {},
          triggerLLMRequest: false,
        });

        const result = await runMCPEventHooks({
          event,
          reducedState: createMockState(),
          agentDurableObjectId: "agent123",
          agentDurableObjectName: "agent123",
          getFinalRedirectUrl: createMockGetFinalRedirectUrl(),
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            tools: [
              { name: "search_repos", serverId: "server-123" },
              { name: "create_issue", serverId: "server-123" },
            ],
            prompts: [{ name: "repo_prompt", serverId: "server-123" }],
            resources: [{ uri: "repo://test", serverId: "server-123" }],
          },
        });
      });
    });

    describe("MCP:DISCONNECT_REQUEST", () => {
      // Make connection keys available to all tests
      const cachedConnectionKey1 = MCPConnectionKey.parse("https://github.com/mcp::company");
      const cachedConnectionKey2 = MCPConnectionKey.parse(
        "https://slack.com/mcp::personal::user123",
      );

      // Define mock functions outside so we can check them after managers are removed from cache
      let mockCloseConnection1: ReturnType<typeof vi.fn>;
      let mockCloseConnection2: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        // Create fresh mock functions for each test
        mockCloseConnection1 = vi.fn();
        mockCloseConnection2 = vi.fn();

        // Setup mock managers in the cache with our mock functions
        const mockManager1 = { closeConnection: mockCloseConnection1 };
        const mockManager2 = { closeConnection: mockCloseConnection2 };

        mcpManagerCache.managers.set(cachedConnectionKey1, mockManager1 as any);
        mcpManagerCache.managers.set(cachedConnectionKey2, mockManager2 as any);
      });

      it("should disconnect by connection key", async () => {
        const connectionKey = MCPConnectionKey.parse("https://github.com/mcp::company");
        const event = createEvent<MCPDisconnectRequestEvent>({
          type: "MCP:DISCONNECT_REQUEST",
          data: { connectionKey },
          metadata: {},
          triggerLLMRequest: false,
        });

        const reducedState = createMockState({
          mcpConnections: {
            [connectionKey as string]: createMockConnection({
              mode: "company",
            }),
          },
        });

        const result = await runMCPEventHooks({
          event,
          reducedState,
          getFinalRedirectUrl: createMockGetFinalRedirectUrl(),
          agentDurableObjectId: "agent123",
          agentDurableObjectName: "agent123",
        });

        expect(result).toEqual([]);

        // Check that closeConnection was called with the correct serverId
        expect(mockCloseConnection1).toHaveBeenCalledWith("server-1");
        // Verify the manager was removed from cache after disconnection
        expect(mcpManagerCache.managers.has(cachedConnectionKey1)).toBe(false);
      });

      it("should disconnect by serverUrl and userId", async () => {
        const event = createEvent<MCPDisconnectRequestEvent>({
          type: "MCP:DISCONNECT_REQUEST",
          data: {
            serverUrl: "https://slack.com/mcp",
            userId: "user123",
          },
          metadata: {},
          triggerLLMRequest: false,
        });

        const reducedState = createMockState({
          mcpConnections: {
            [cachedConnectionKey2 as string]: createMockConnection({
              integrationSlug: "slack",
              serverId: "server-2",
              serverUrl: "https://slack.com/mcp",
              mode: "personal",
              userId: "user123",
            }),
          },
        });

        const result = await runMCPEventHooks({
          event,
          reducedState,
          getFinalRedirectUrl: createMockGetFinalRedirectUrl(),
          agentDurableObjectId: "agent123",
          agentDurableObjectName: "agent123",
        });

        expect(result).toEqual([]);

        // Check that closeConnection was called with the correct serverId
        expect(mockCloseConnection2).toHaveBeenCalledWith("server-2");
        // Verify the manager was removed from cache after disconnection
        expect(mcpManagerCache.managers.has(cachedConnectionKey2)).toBe(false);
      });

      it("should disconnect all connections by serverUrl", async () => {
        const event = createEvent<MCPDisconnectRequestEvent>({
          type: "MCP:DISCONNECT_REQUEST",
          data: { serverUrl: "https://github.com/mcp" },
          metadata: {},
          triggerLLMRequest: false,
        });

        const connectionKey2 = MCPConnectionKey.parse("https://github.com/mcp::personal::user456");
        const reducedState = createMockState({
          mcpConnections: {
            [cachedConnectionKey1 as string]: createMockConnection({
              mode: "company",
            }),
            [connectionKey2 as string]: createMockConnection({
              serverId: "server-3",
              mode: "personal",
              userId: "user456",
            }),
          },
        });

        // Add the second connection to cache with its own mock function
        const mockCloseConnection3 = vi.fn();
        const mockManager3 = { closeConnection: mockCloseConnection3 };
        mcpManagerCache.managers.set(connectionKey2, mockManager3 as any);

        await runMCPEventHooks({
          event,
          reducedState,

          getFinalRedirectUrl: createMockGetFinalRedirectUrl(),
          agentDurableObjectId: "agent123",
          agentDurableObjectName: "agent123",
        });

        // Check that both managers had their closeConnection methods called
        expect(mockCloseConnection1).toHaveBeenCalledWith("server-1");
        expect(mockCloseConnection3).toHaveBeenCalledWith("server-3");

        // Verify both managers were removed from cache
        expect(mcpManagerCache.managers.has(cachedConnectionKey1)).toBe(false);
        expect(mcpManagerCache.managers.has(connectionKey2)).toBe(false);
      });

      it("should handle missing manager gracefully", async () => {
        const connectionKey = MCPConnectionKey.parse("https://missing.com/mcp::company");
        const event = createEvent<MCPDisconnectRequestEvent>({
          type: "MCP:DISCONNECT_REQUEST",
          data: { connectionKey },
          metadata: {},
          triggerLLMRequest: false,
        });

        const reducedState = createMockState({
          mcpConnections: {
            [connectionKey as string]: createMockConnection({
              integrationSlug: "missing",
              serverId: "server-missing",
              serverUrl: "https://missing.com/mcp",
              mode: "company",
            }),
          },
        });

        // Don't add to cache to simulate missing manager
        const result = await runMCPEventHooks({
          event,
          reducedState,

          getFinalRedirectUrl: createMockGetFinalRedirectUrl(),
          agentDurableObjectId: "agent123",
          agentDurableObjectName: "agent123",
        });

        expect(result).toEqual([]);
      });
    });

    describe("connection queue with abort controller", () => {
      it("should have separate queues and controllers for different connection keys", () => {
        const key1 = MCPConnectionKey.parse("https://test1.com/mcp::company");
        const key2 = MCPConnectionKey.parse("https://test2.com/mcp::company");

        // Get queues for different keys
        const entry1 = getConnectionQueue(key1);
        const entry2 = getConnectionQueue(key2);

        // Should have different controllers
        expect(entry1.controller).not.toBe(entry2.controller);
        expect(entry1.queue).not.toBe(entry2.queue);

        // Abort one should not affect the other
        abortPendingConnections(key1, "Test abort");
        expect(entry1.controller.signal.aborted).toBe(true);
        expect(entry2.controller.signal.aborted).toBe(false);

        // After abort, getting the same key returns the same entry (not deleted immediately)
        const sameEntry1 = getConnectionQueue(key1);
        expect(sameEntry1).toBe(entry1);
        expect(sameEntry1.controller.signal.aborted).toBe(true);

        // But if we manually delete and get a new one, it should have fresh controller
        connectionQueues.delete(key1);
        const newEntry1 = getConnectionQueue(key1);
        expect(newEntry1.controller.signal.aborted).toBe(false);
      });

      it("should abort controller when aborting pending connections", async () => {
        const key = MCPConnectionKey.parse("https://test.com/mcp::company");

        // Get queue entry
        const entry = getConnectionQueue(key);

        // Add a task to the queue with abort signal
        const taskPromise = entry.queue.add(
          async ({ signal }) => {
            // This task should check the signal and fail if aborted
            if (signal?.aborted) {
              throw new Error(signal.reason || "Aborted");
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return "should not complete";
          },
          { signal: entry.controller.signal },
        );

        // Queue should have pending task
        expect(entry.queue.size + entry.queue.pending).toBeGreaterThan(0);

        // Abort connections
        abortPendingConnections(key, "Test abort");

        // Controller should be aborted
        expect(entry.controller.signal.aborted).toBe(true);

        // Queue entry should NOT be removed immediately (cleanup happens in finally block)
        expect(connectionQueues.has(key)).toBe(true);

        // The task promise should be rejected due to abort
        await expect(taskPromise).rejects.toThrow("Test abort");
      });
    });

    describe("unknown event type", () => {
      it("should throw error for unknown event type", async () => {
        const event = {
          type: "UNKNOWN:EVENT",
          data: {},
          metadata: {},
          triggerLLMRequest: false,
        } as any;

        await expect(
          runMCPEventHooks({
            event,
            reducedState: createMockState(),
            agentDurableObjectId: "agent123",
            agentDurableObjectName: "agent123",

            getFinalRedirectUrl: createMockGetFinalRedirectUrl(),
          }),
        ).rejects.toThrow("Exhaustive matching guard triggered");
      });
    });
  });
});
