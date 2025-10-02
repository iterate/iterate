import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentCoreTest } from "../agent-core-test-harness.ts";

// Mock Cloudflare Workers environment
vi.mock("../../env.ts", () => ({
  CloudflareEnv: {},
}));

// Mock MCP tool mapping
vi.mock("./mcp-tool-mapping.ts", () => ({
  generateRuntimeToolsFromConnections: vi.fn().mockReturnValue([]),
}));

import type { LocalFunctionRuntimeTool } from "../tool-schemas.ts";
import {
  getConnectionKey,
  MCPConnectionKey,
  mcpSlice,
  parseConnectionKey,
  type MCPConnection,
  type MCPConnectionErrorEventInput,
  type MCPConnectionEstablishedEventInput,
  type MCPConnectRequestEventInput,
  type MCPDisconnectRequestEventInput,
  type MCPOAuthRequiredEventInput,
  type MCPSliceDeps,
} from "./mcp-slice.ts";

// Import the mocked module
const { generateRuntimeToolsFromConnections } = await import("./mcp-tool-mapping.ts");

describe("mcp-slice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // helper to create mock dependencies
  const createMockDeps = (options?: {
    uploadFile?: MCPSliceDeps["uploadFile"];
    env?: any;
  }): MCPSliceDeps => {
    const mockUploadFile =
      options?.uploadFile ||
      vi.fn().mockResolvedValue({
        fileId: "file-123",
        openAIFileId: "file-openai-456",
        size: 1024,
      });

    return {
      env: options?.env || ({ TEST_MODE: "test" } as any),
      uploadFile: mockUploadFile,
    };
  };

  // helper to create mock connection
  const createMockConnection = (overrides?: Partial<MCPConnection>): MCPConnection => ({
    serverId: "server-123",
    serverUrl: "https://github.com/mcp",
    serverName: "GitHub",
    mode: "company" as const,
    integrationSlug: "github",
    userId: "user123",
    tools: [],
    prompts: [],
    resources: [],
    connectedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  });

  describe("schema validation", () => {
    describe("MCPConnectionKey", () => {
      it.each([
        {
          name: "valid personal connection key",
          input: "https://github.com/mcp::personal::user123",
          expectValid: true,
        },
        {
          name: "valid company connection key",
          input: "https://github.com/mcp::company",
          expectValid: true,
        },
        {
          name: "invalid format - missing mode",
          input: "https://github.com/mcp",
          expectValid: false,
        },
        {
          name: "invalid format - personal without userId",
          input: "https://github.com/mcp::personal",
          expectValid: false,
        },
        {
          name: "invalid format - extra parts",
          input: "https://github.com/mcp::personal::user123::extra",
          expectValid: false,
        },
        {
          name: "invalid format - wrong mode",
          input: "https://github.com/mcp::invalid::user123",
          expectValid: false,
        },
      ])("$name", ({ input, expectValid }) => {
        if (expectValid) {
          expect(() => MCPConnectionKey.parse(input)).not.toThrow();
        } else {
          expect(() => MCPConnectionKey.parse(input)).toThrow();
        }
      });
    });

    describe("event schemas", () => {
      it("should validate MCP:CONNECT_REQUEST event", () => {
        const validEvent: MCPConnectRequestEventInput = {
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "personal",
            userId: "user123",
            integrationSlug: "github",
            triggerLLMRequestOnEstablishedConnection: false,
          },
          metadata: {},
          triggerLLMRequest: false,
        };

        expect(() => mcpSlice.eventInputSchema.parse(validEvent)).not.toThrow();
      });

      it("should validate MCP:CONNECTION_ESTABLISHED event", () => {
        const validEvent: MCPConnectionEstablishedEventInput = {
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey: "https://github.com/mcp::company",
            serverId: "server-123",
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "company",
            integrationSlug: "github",
            tools: [
              {
                name: "search_repos",
                description: "Search repositories",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                },
              },
            ],
            prompts: [],
            resources: [],
          },
          metadata: {},
          triggerLLMRequest: false,
        };

        expect(() => mcpSlice.eventInputSchema.parse(validEvent)).not.toThrow();
      });

      it("should validate MCP:DISCONNECT_REQUEST event", () => {
        const validEvent: MCPDisconnectRequestEventInput = {
          type: "MCP:DISCONNECT_REQUEST",
          data: {
            connectionKey: MCPConnectionKey.parse("https://github.com/mcp::company"),
          },
          metadata: {},
          triggerLLMRequest: false,
        };

        expect(() => mcpSlice.eventInputSchema.parse(validEvent)).not.toThrow();
      });

      it("should validate MCP:CONNECTION_ERROR event", () => {
        const validEvent: MCPConnectionErrorEventInput = {
          type: "MCP:CONNECTION_ERROR",
          data: {
            connectionKey: MCPConnectionKey.parse("https://github.com/mcp::company"),
            serverUrl: "https://github.com/mcp",
            error: "Connection failed",
          },
          metadata: {},
          triggerLLMRequest: false,
        };

        expect(() => mcpSlice.eventInputSchema.parse(validEvent)).not.toThrow();
      });

      it("should validate MCP:OAUTH_REQUIRED event", () => {
        const validEvent: MCPOAuthRequiredEventInput = {
          type: "MCP:OAUTH_REQUIRED",
          data: {
            connectionKey: "https://github.com/mcp::personal::user123",
            serverUrl: "https://github.com/mcp",
            mode: "personal",
            userId: "user123",
            integrationSlug: "github",
            oauthUrl: "https://github.com/oauth/authorize",
          },
          metadata: {},
          triggerLLMRequest: false,
        };

        expect(() => mcpSlice.eventInputSchema.parse(validEvent)).not.toThrow();
      });
    });
  });

  describe("helper functions", () => {
    describe("getConnectionKey", () => {
      it("should generate personal connection key", () => {
        const result = getConnectionKey({
          serverUrl: "https://github.com/mcp",
          mode: "personal",
          userId: "user123",
        });
        expect(result).toBe("https://github.com/mcp::personal::user123");
      });

      it("should generate company connection key", () => {
        const result = getConnectionKey({ serverUrl: "https://github.com/mcp", mode: "company" });
        expect(result).toBe("https://github.com/mcp::company");
      });

      it("should handle personal mode without userId by defaulting to company", () => {
        const result = getConnectionKey({ serverUrl: "https://github.com/mcp", mode: "personal" });
        expect(result).toBe("https://github.com/mcp::company");
      });
    });

    describe("parseConnectionKey", () => {
      it("should parse personal connection key", () => {
        const key = MCPConnectionKey.parse("https://github.com/mcp::personal::user123");
        const result = parseConnectionKey(key);

        expect(result).toEqual({
          serverUrl: "https://github.com/mcp",
          mode: "personal",
          userId: "user123",
        });
      });

      it("should parse company connection key", () => {
        const key = MCPConnectionKey.parse("https://github.com/mcp::company");
        const result = parseConnectionKey(key);

        expect(result).toEqual({
          serverUrl: "https://github.com/mcp",
          mode: "company",
          userId: undefined,
        });
      });
    });
  });

  describe("slice behavior", () => {
    const deps = createMockDeps();
    const test = createAgentCoreTest([mcpSlice] as const, {
      extraDeps: deps,
    });

    test("should have correct initial state", async ({ h }) => {
      await h.initializeAgent();

      const state = h.agentCore.state as any;
      expect(state.mcpConnections).toEqual({});
    });

    describe("MCP:CONNECT_REQUEST", () => {
      const deps1 = createMockDeps();
      const test1 = createAgentCoreTest([mcpSlice] as const, {
        extraDeps: deps1,
      });

      test1("should add connection to pending and remove from mcpConnections", async ({ h }) => {
        await h.initializeAgent();

        // Add existing connection first
        const connectionKey = "https://github.com/mcp::company";
        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey,
            serverId: "server-123",
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "company" as const,
            integrationSlug: "github",
            tools: [],
            prompts: [],
            resources: [],
          },
        });

        // Now request reconnection
        await h.agentCore.addEvent({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "company" as const,
            userId: "user123",
            integrationSlug: "github",
            triggerLLMRequestOnEstablishedConnection: false,
          },
        });

        const state = h.agentCore.state as any;
        expect(state.mcpConnections).not.toHaveProperty(connectionKey);
      });
    });

    describe("MCP:CONNECTION_ESTABLISHED", () => {
      const deps2 = createMockDeps();
      const test2 = createAgentCoreTest([mcpSlice] as const, {
        extraDeps: deps2,
      });

      test2("should establish connection and update runtime tools", async ({ h }) => {
        await h.initializeAgent();

        const connectionKey = "https://github.com/mcp::company";

        // Mock the runtime tools generation
        const mockTool = {
          type: "function" as const,
          name: "github_search_repos",
          description: "Search repositories",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
          strict: false,
          execute: vi.fn(),
          metadata: {
            source: "mcp" as const,
          },
        };
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([mockTool]);

        // Add to pending first
        await h.agentCore.addEvent({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "company" as const,
            userId: "user123",
            integrationSlug: "github",
            triggerLLMRequestOnEstablishedConnection: false,
          },
        });

        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey,
            serverId: "server-123",
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "company" as const,
            integrationSlug: "github",
            tools: [
              {
                name: "search_repos",
                description: "Search repositories",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                },
              },
            ],
            prompts: [],
            resources: [],
          },
        });

        const state = h.agentCore.state as any;
        expect(state.mcpConnections).toHaveProperty(connectionKey);
        expect(state.mcpConnections[connectionKey]).toMatchObject({
          serverId: "server-123",
          serverUrl: "https://github.com/mcp",
          mode: "company",
          integrationSlug: "github",
          isConnected: true,
        });

        // Should add developer message
        const devMessages = state.inputItems.filter(
          (item: any) => item.type === "message" && item.role === "developer",
        );
        expect(devMessages).toHaveLength(1);
        expect(devMessages[0].content[0].text).toContain("connected to github");

        // Should call generateRuntimeToolsFromConnections
        expect(generateRuntimeToolsFromConnections).toHaveBeenCalled();

        // Should add runtime tools
        const mcpTools = state.runtimeTools.filter(
          (tool: any) => tool.type === "function" && tool.name.startsWith("github_"),
        );
        expect(mcpTools).toHaveLength(1);
        expect(mcpTools[0].name).toBe("github_search_repos");
      });

      test2("should trigger LLM when no pending connections remain", async ({ h }) => {
        await h.initializeAgent();

        const connectionKey = "https://github.com/mcp::company";

        // Add to pending first
        await h.agentCore.addEvent({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "company" as const,
            userId: "user123",
            integrationSlug: "github",
            triggerLLMRequestOnEstablishedConnection: false,
          },
        });

        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey,
            serverId: "server-123",
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "company" as const,
            integrationSlug: "github",
            tools: [],
            prompts: [],
            resources: [],
          },
          triggerLLMRequest: false, // Event doesn't trigger, but reducer should
        });

        // Check that LLM was triggered by the reducer
        const events = h.getEvents();
        const llmStartEvents = events.filter((e: any) => e.type === "CORE:LLM_REQUEST_START");
        expect(llmStartEvents).toHaveLength(1);
      });
    });

    describe("MCP:DISCONNECT_REQUEST", () => {
      const deps3 = createMockDeps();
      const test3 = createAgentCoreTest([mcpSlice] as const, {
        extraDeps: deps3,
      });

      test3("should remove connection by connectionKey", async ({ h }) => {
        await h.initializeAgent();

        const connectionKey = "https://github.com/mcp::company";

        // Mock runtime tools for initial connection
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([
          {
            type: "function" as const,
            name: "github_search_repos",
            description: "Search repositories",
            parameters: { type: "object" },
            strict: false,
            execute: vi.fn(),
            metadata: {
              source: "mcp" as const,
            },
          },
        ]);

        // Establish connection first
        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey,
            serverId: "server-123",
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "company" as const,
            integrationSlug: "github",
            tools: [
              {
                name: "search_repos",
                inputSchema: { type: "object" },
              },
            ],
            prompts: [],
            resources: [],
          },
        });

        const beforeState = h.agentCore.state as any;
        expect(beforeState.mcpConnections).toHaveProperty(connectionKey);
        expect(beforeState.runtimeTools.some((t: any) => t.name === "github_search_repos")).toBe(
          true,
        );

        // Mock empty tools after disconnect
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([]);

        // Disconnect
        await h.agentCore.addEvent({
          type: "MCP:DISCONNECT_REQUEST",
          data: {
            connectionKey: MCPConnectionKey.parse(connectionKey),
          },
        });

        const afterState = h.agentCore.state as any;
        expect(afterState.mcpConnections).not.toHaveProperty(connectionKey);
        expect(afterState.runtimeTools.some((t: any) => t.name === "github_search_repos")).toBe(
          false,
        );
      });

      test3("should handle missing connectionKey gracefully", async ({ h }) => {
        await h.initializeAgent();

        await h.agentCore.addEvent({
          type: "MCP:DISCONNECT_REQUEST",
          data: {
            serverUrl: "https://missing.com/mcp",
          },
        });

        // Should not throw and state should remain unchanged
        const state = h.agentCore.state as any;
        expect(state.mcpConnections).toEqual({});
      });
    });

    describe("MCP:TOOLS_CHANGED", () => {
      const deps4 = createMockDeps();
      const test4 = createAgentCoreTest([mcpSlice] as const, {
        extraDeps: deps4,
      });

      test4("should update tools for existing connection", async ({ h }) => {
        await h.initializeAgent();

        const connectionKey = "https://github.com/mcp::company";

        // Mock runtime tools for initial connection
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([
          {
            type: "function" as const,
            name: "github_search_repos",
            description: "Search repositories",
            parameters: { type: "object" },
            strict: false,
            execute: vi.fn(),
            metadata: {
              source: "mcp" as const,
            },
          },
        ]);

        // Establish connection first
        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey,
            serverId: "server-123",
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "company" as const,
            integrationSlug: "github",
            tools: [
              {
                name: "search_repos",
                inputSchema: { type: "object" },
              },
            ],
            prompts: [],
            resources: [],
          },
        });

        // Mock updated runtime tools
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([
          {
            type: "function" as const,
            name: "github_search_repos",
            description: "Search repositories",
            parameters: { type: "object" },
            strict: false,
            execute: vi.fn(),
            metadata: {
              source: "mcp" as const,
            },
          },
          {
            type: "function" as const,
            name: "github_create_issue",
            description: "Create issue",
            parameters: { type: "object" },
            strict: false,
            execute: vi.fn(),
            metadata: {
              source: "mcp" as const,
            },
          },
        ]);

        // Update tools
        await h.agentCore.addEvent({
          type: "MCP:TOOLS_CHANGED",
          data: {
            connectionKey: MCPConnectionKey.parse(connectionKey),
            serverId: "server-123",
            tools: [
              {
                name: "search_repos",
                inputSchema: { type: "object" },
              },
              {
                name: "create_issue",
                inputSchema: { type: "object" },
              },
            ],
          },
        });

        const state = h.agentCore.state as any;
        expect(state.mcpConnections[connectionKey].tools).toHaveLength(2);
        expect(state.mcpConnections[connectionKey].tools[1].name).toBe("create_issue");

        // Should update runtime tools
        const mcpTools = state.runtimeTools.filter(
          (tool: any) => tool.type === "function" && tool.name.startsWith("github_"),
        );
        expect(mcpTools).toHaveLength(2);
      });

      test4("should remove connection if not connected", async ({ h }) => {
        await h.initializeAgent();

        const connectionKey = "https://github.com/mcp::company";

        // Add connection without connectedAt (not fully connected)
        const state = h.agentCore.state as any;
        state.mcpConnections[connectionKey] = createMockConnection({
          connectedAt: "", // Not connected
        });

        await h.agentCore.addEvent({
          type: "MCP:TOOLS_CHANGED",
          data: {
            connectionKey: MCPConnectionKey.parse(connectionKey),
            serverId: "server-123",
            tools: [],
          },
        });

        const afterState = h.agentCore.state as any;
        expect(afterState.mcpConnections).not.toHaveProperty(connectionKey);
      });

      test4("should handle missing connection gracefully", async ({ h }) => {
        await h.initializeAgent();

        await h.agentCore.addEvent({
          type: "MCP:TOOLS_CHANGED",
          data: {
            connectionKey: MCPConnectionKey.parse("https://missing.com/mcp::company"),
            serverId: "server-123",
            tools: [],
          },
        });

        // Should not throw and state should remain unchanged
        const state = h.agentCore.state as any;
        expect(state.mcpConnections).toEqual({});
      });
    });

    describe("MCP:CONNECTION_ERROR", () => {
      const deps5 = createMockDeps();
      const test5 = createAgentCoreTest([mcpSlice] as const, {
        extraDeps: deps5,
      });

      test5("should handle connection error and clean up state", async ({ h }) => {
        await h.initializeAgent();

        const connectionKey = "https://github.com/mcp::company";

        // Add to pending first
        await h.agentCore.addEvent({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "company" as const,
            userId: "user123",
            integrationSlug: "github",
            triggerLLMRequestOnEstablishedConnection: false,
          },
        });

        // Mock empty tools after error
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([]);

        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ERROR",
          data: {
            connectionKey: MCPConnectionKey.parse(connectionKey),
            serverUrl: "https://github.com/mcp",
            error: "Authentication failed",
          },
        });

        const state = h.agentCore.state as any;
        expect(state.mcpConnections).not.toHaveProperty(connectionKey);

        // Should add error message
        const devMessages = state.inputItems.filter(
          (item: any) => item.type === "message" && item.role === "developer",
        );
        expect(devMessages).toHaveLength(1);
        expect(devMessages[0].content[0].text).toContain("Failed to connect");
        expect(devMessages[0].content[0].text).toContain("Authentication failed");
      });

      test5("should trigger LLM when no pending connections remain after error", async ({ h }) => {
        await h.initializeAgent();

        const connectionKey = "https://github.com/mcp::company";

        // Add to pending first
        await h.agentCore.addEvent({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "company" as const,
            userId: "user123",
            integrationSlug: "github",
            triggerLLMRequestOnEstablishedConnection: false,
          },
        });

        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ERROR",
          data: {
            connectionKey: MCPConnectionKey.parse(connectionKey),
            serverUrl: "https://github.com/mcp",
            error: "Authentication failed",
          },
          triggerLLMRequest: false, // Event doesn't trigger, but reducer should
        });

        // Check that LLM was triggered by the reducer
        const events = h.getEvents();
        const llmStartEvents = events.filter((e: any) => e.type === "CORE:LLM_REQUEST_START");
        expect(llmStartEvents).toHaveLength(1);
      });
    });

    describe("MCP:OAUTH_REQUIRED", () => {
      const deps6 = createMockDeps();
      const test6 = createAgentCoreTest([mcpSlice] as const, {
        extraDeps: deps6,
      });

      test6("should create placeholder connection and add OAuth message", async ({ h }) => {
        await h.initializeAgent();

        const connectionKey = "https://github.com/mcp::personal::user123";

        // Add to pending first
        await h.agentCore.addEvent({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: "https://github.com/mcp",
            mode: "personal" as const,
            userId: "user123",
            integrationSlug: "github",
            triggerLLMRequestOnEstablishedConnection: false,
          },
        });

        await h.agentCore.addEvent({
          type: "MCP:OAUTH_REQUIRED",
          data: {
            connectionKey,
            serverUrl: "https://github.com/mcp",
            mode: "personal" as const,
            userId: "user123",
            integrationSlug: "github",
            oauthUrl: "https://github.com/oauth/authorize",
          },
        });

        const state = h.agentCore.state as any;
        expect(state.mcpConnections).toHaveProperty(connectionKey);
        expect(state.mcpConnections[connectionKey]).toMatchObject({
          serverId: "",
          serverUrl: "https://github.com/mcp",
          mode: "personal",
          userId: "user123",
          integrationSlug: "github",
          tools: [],
          prompts: [],
          resources: [],
        });

        // Should add OAuth message
        const devMessages = state.inputItems.filter(
          (item: any) => item.type === "message" && item.role === "developer",
        );
        expect(devMessages).toHaveLength(1);
        expect(devMessages[0].content[0].text).toContain("Authorization needed to access");
        expect(devMessages[0].content[0].text).toContain("https://github.com/oauth/authorize");
      });

      test6("should handle missing oauthUrl gracefully", async ({ h }) => {
        await h.initializeAgent();

        await h.agentCore.addEvent({
          type: "MCP:OAUTH_REQUIRED",
          data: {
            connectionKey: "https://github.com/mcp::company",
            serverUrl: "https://github.com/mcp",
            mode: "company" as const,
            integrationSlug: "github",
            oauthUrl: "",
          },
        });

        // Should not create connection or add messages when oauthUrl is empty
        const state = h.agentCore.state as any;
        expect(state.mcpConnections).toEqual({});
        expect(state.inputItems).toHaveLength(0);
      });

      test6("should use existing transport type from connection", async ({ h }) => {
        await h.initializeAgent();

        const connectionKey = "https://github.com/mcp::company";

        // Establish connection with streamable-http transport first
        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey,
            serverId: "server-123",
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "company" as const,
            integrationSlug: "github",
            tools: [],
            prompts: [],
            resources: [],
          },
        });

        // Now trigger OAuth required
        await h.agentCore.addEvent({
          type: "MCP:OAUTH_REQUIRED",
          data: {
            connectionKey,
            serverUrl: "https://github.com/mcp",
            mode: "company" as const,
            integrationSlug: "github",
            oauthUrl: "https://github.com/oauth/authorize",
          },
        });
      });
    });

    describe("runtime tools integration", () => {
      const deps7 = createMockDeps();
      const test7 = createAgentCoreTest([mcpSlice] as const, {
        extraDeps: deps7,
      });

      test7("should preserve existing non-MCP tools", async ({ h }) => {
        await h.initializeAgent();

        // Add a non-MCP tool first
        h.registerMockTool("custom_tool", async () => ({
          toolCallResult: { success: true },
        }));

        h.agentCore.addEvent({
          type: "CORE:ADD_CONTEXT_RULES",
          data: {
            rules: [
              {
                key: "custom-tool-rule",
                tools: [{ type: "agent_durable_object_tool", methodName: "custom_tool" }],
              },
            ],
          },
        });

        const beforeState = h.agentCore.state as any;
        const customTool = beforeState.runtimeTools.find((t: any) => t.name === "custom_tool");
        expect(customTool).toBeDefined();

        // Mock runtime tools to return only the new MCP tool (preserving existing tools)
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([
          {
            type: "function" as const,
            name: "github_search_repos",
            description: "Search repositories",
            parameters: { type: "object" },
            strict: false,
            execute: vi.fn(),
            metadata: {
              source: "mcp" as const,
            },
          },
        ]);

        // Add MCP connection
        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey: "https://github.com/mcp::company",
            serverId: "server-123",
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "company" as const,
            integrationSlug: "github",
            tools: [
              {
                name: "search_repos",
                inputSchema: { type: "object" },
              },
            ],
            prompts: [],
            resources: [],
          },
        });

        const afterState = h.agentCore.state as any;

        // Should have both custom tool and MCP tool
        const customToolAfter = afterState.runtimeTools.find((t: any) => t.name === "custom_tool");
        const mcpTool = afterState.runtimeTools.find((t: any) => t.name === "github_search_repos");

        expect(customToolAfter).toBeDefined();
        expect(mcpTool).toBeDefined();
        expect(afterState.runtimeTools).toHaveLength(2);
      });

      test7("should replace MCP tools on connection changes", async ({ h }) => {
        await h.initializeAgent();

        const connectionKey = "https://github.com/mcp::company";

        // Mock initial runtime tools
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([
          {
            type: "function" as const,
            name: "github_search_repos",
            description: "Search repositories",
            parameters: { type: "object" },
            strict: false,
            execute: vi.fn(),
            metadata: {
              source: "mcp" as const,
            },
          },
        ]);

        // Establish connection with one tool
        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey,
            serverId: "server-123",
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "company" as const,
            integrationSlug: "github",
            tools: [
              {
                name: "search_repos",
                inputSchema: { type: "object" },
              },
            ],
            prompts: [],
            resources: [],
          },
        });

        let state = h.agentCore.state as any;
        expect(state.runtimeTools.find((t: any) => t.name === "github_search_repos")).toBeDefined();

        // Mock updated runtime tools
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([
          {
            type: "function" as const,
            name: "github_create_issue",
            description: "Create issue",
            parameters: { type: "object" },
            strict: false,
            execute: vi.fn(),
            metadata: {
              source: "mcp" as const,
            },
          },
        ]);

        // Update with different tools
        await h.agentCore.addEvent({
          type: "MCP:TOOLS_CHANGED",
          data: {
            connectionKey: MCPConnectionKey.parse(connectionKey),
            serverId: "server-123",
            tools: [
              {
                name: "create_issue",
                inputSchema: { type: "object" },
              },
            ],
          },
        });

        state = h.agentCore.state as any;
        expect(
          state.runtimeTools.find((t: any) => t.name === "github_search_repos"),
        ).toBeUndefined();
        expect(state.runtimeTools.find((t: any) => t.name === "github_create_issue")).toBeDefined();
      });
    });

    describe("edge cases and error handling", () => {
      const deps8 = createMockDeps();
      const test8 = createAgentCoreTest([mcpSlice] as const, {
        extraDeps: deps8,
      });

      test8("should maintain state integrity across multiple events", async ({ h }) => {
        await h.initializeAgent();

        const events = [
          {
            type: "MCP:CONNECT_REQUEST" as const,
            data: {
              serverUrl: "https://github.com/mcp",
              mode: "company" as const,
              userId: "user123",
              integrationSlug: "github",
              triggerLLMRequestOnEstablishedConnection: false,
            },
          },
          {
            type: "MCP:CONNECTION_ERROR" as const,
            data: {
              connectionKey: MCPConnectionKey.parse("https://github.com/mcp::company"),
              serverUrl: "https://github.com/mcp",
              error: "First attempt failed",
            },
          },
          {
            type: "MCP:CONNECT_REQUEST" as const,
            data: {
              serverUrl: "https://github.com/mcp",
              mode: "company" as const,
              userId: "user123",
              integrationSlug: "github",
              triggerLLMRequestOnEstablishedConnection: false,
            },
          },
          {
            type: "MCP:CONNECTION_ESTABLISHED" as const,
            data: {
              connectionKey: "https://github.com/mcp::company",
              serverId: "server-123",
              serverUrl: "https://github.com/mcp",
              serverName: "GitHub",
              mode: "company" as const,
              integrationSlug: "github",
              tools: [],
              prompts: [],
              resources: [],
            },
          },
        ];

        for (const event of events) {
          h.agentCore.addEvent(event);
        }

        const finalState = h.agentCore.state as any;
        expect(finalState.mcpConnections).toHaveProperty("https://github.com/mcp::company");

        // Should have error message and success message
        const devMessages = finalState.inputItems.filter(
          (item: any) => item.type === "message" && item.role === "developer",
        );
        expect(devMessages).toHaveLength(2);
        expect(devMessages[0].content[0].text).toContain("Failed to connect");
        expect(devMessages[1].content[0].text).toContain("connected to github");
      });
    });

    describe("complex connection scenarios", () => {
      const deps9 = createMockDeps();
      const test9 = createAgentCoreTest([mcpSlice] as const, {
        extraDeps: deps9,
      });

      test9("should handle multiple connections with different modes", async ({ h }) => {
        await h.initializeAgent();

        // Mock runtime tools for company connection
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([
          {
            type: "function" as const,
            name: "github_admin_tool",
            description: "Admin tool",
            parameters: { type: "object" },
            strict: false,
            execute: vi.fn(),
            metadata: {
              source: "mcp" as const,
            },
          },
        ]);

        // Add company connection
        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey: "https://github.com/mcp::company",
            serverId: "server-company",
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "company" as const,
            integrationSlug: "github",
            tools: [
              {
                name: "admin_tool",
                inputSchema: { type: "object" },
              },
            ],
            prompts: [],
            resources: [],
          },
        });

        // Mock runtime tools for both connections
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([
          {
            type: "function" as const,
            name: "github_admin_tool",
            description: "Admin tool",
            parameters: { type: "object" },
            strict: false,
            execute: vi.fn(),
            metadata: {
              source: "mcp" as const,
            },
          },
          {
            type: "function" as const,
            name: "github_user_tool",
            description: "User tool",
            parameters: { type: "object" },
            strict: false,
            execute: vi.fn(),
            metadata: {
              source: "mcp" as const,
            },
          },
        ]);

        // Add personal connection for user
        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey: "https://github.com/mcp::personal::user123",
            serverId: "server-personal",
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "personal" as const,
            userId: "user123",
            integrationSlug: "github",
            tools: [
              {
                name: "user_tool",
                inputSchema: { type: "object" },
              },
            ],
            prompts: [],
            resources: [],
          },
        });

        const state = h.agentCore.state as any;
        expect(Object.keys(state.mcpConnections)).toHaveLength(2);
        expect(state.mcpConnections["https://github.com/mcp::company"]).toBeDefined();
        expect(state.mcpConnections["https://github.com/mcp::personal::user123"]).toBeDefined();

        // Should have both tools available
        const mcpTools = state.runtimeTools.filter(
          (tool: any) => tool.type === "function" && tool.name.startsWith("github_"),
        );
        expect(mcpTools).toHaveLength(2);
        expect(mcpTools.map((t: any) => t.name).sort()).toEqual([
          "github_admin_tool",
          "github_user_tool",
        ]);
      });

      test9("should handle connection key conflicts gracefully", async ({ h }) => {
        await h.initializeAgent();

        const connectionKey = "https://github.com/mcp::company";

        // Mock runtime tools for first connection
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([
          {
            type: "function" as const,
            name: "github_tool_v1",
            description: "Tool v1",
            parameters: { type: "object" },
            strict: false,
            execute: vi.fn(),
            metadata: {
              source: "mcp" as const,
            },
          },
        ]);

        // Establish first connection
        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey,
            serverId: "server-1",
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "company" as const,
            integrationSlug: "github",
            tools: [
              {
                name: "tool_v1",
                inputSchema: { type: "object" },
              },
            ],
            prompts: [],
            resources: [],
          },
        });

        // Mock runtime tools for new connection after reconnect
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([]);

        // Disconnect the existing connection
        await h.agentCore.addEvent({
          type: "MCP:DISCONNECT_REQUEST",
          data: {
            connectionKey,
          },
        });

        {
          const mcpTools = h.agentCore.state.runtimeTools.filter(
            (tool): tool is LocalFunctionRuntimeTool =>
              tool.type === "function" && tool.name.startsWith("github_"),
          );
          expect(mcpTools).toHaveLength(0);
          expect(Object.keys(h.agentCore.state.mcpConnections)).toHaveLength(0);
        }

        // Mock runtime tools for new connection after reconnect
        vi.mocked(generateRuntimeToolsFromConnections).mockReturnValue([
          {
            type: "function" as const,
            name: "github_tool_v2",
            description: "Tool v2",
            parameters: { type: "object" },
            strict: false,
            execute: vi.fn(),
            metadata: {
              source: "mcp" as const,
            },
          },
        ]);

        // Establish new connection after disconnect (reconnection scenario)
        await h.agentCore.addEvent({
          type: "MCP:CONNECTION_ESTABLISHED",
          data: {
            connectionKey,
            serverId: "server-1", // Same server reconnecting
            serverUrl: "https://github.com/mcp",
            serverName: "GitHub",
            mode: "company" as const,
            integrationSlug: "github",
            tools: [
              {
                name: "tool_v2", // Updated tools after reconnection
                inputSchema: { type: "object" },
              },
            ],
            prompts: [],
            resources: [],
          },
        });

        const state = h.agentCore.state;
        expect(Object.keys(state.mcpConnections)).toHaveLength(1);
        expect(state.mcpConnections[connectionKey as MCPConnectionKey].serverId).toBe("server-1");

        // Should only have the new tool after reconnection
        const mcpTools = state.runtimeTools.filter(
          (tool): tool is LocalFunctionRuntimeTool =>
            tool.type === "function" && tool.name.startsWith("github_"),
        );
        expect(mcpTools).toHaveLength(1);
        expect(mcpTools[0].name).toBe("github_tool_v2");
      });
    });
  });
});
