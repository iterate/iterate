import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpManagerCache } from "./mcp-event-hooks.ts";
import { MCPConnectionKey, type MCPConnection, type MCPTool } from "./mcp-slice.ts";
import {
  computeToolMapping,
  createRuntimeToolFromMCPTool,
  generateRuntimeToolsFromConnections,
  generateToolName,
  processMCPContent,
} from "./mcp-tool-mapping.ts";

// mock the mcp manager cache
vi.mock("./mcp-event-hooks.ts", () => ({
  mcpManagerCache: {
    managers: new Map(),
  },
}));

describe("mcp-tool-mapping", () => {
  // shared test helpers
  const createMockUploadFile = () => {
    return vi.fn().mockResolvedValue({
      fileId: "file-123",
      openAIFileId: "file-openai-456",
      size: 1024,
    });
  };

  const createMockConnection = (
    integrationSlug: string,
    serverId: string,
    mode: "personal" | "company",
    tools: MCPTool[],
    userId?: string,
  ): MCPConnection => ({
    integrationSlug,
    serverId,
    serverUrl: "https://mcp.example.com/mcp",
    serverName: integrationSlug.charAt(0).toUpperCase() + integrationSlug.slice(1),
    mode,
    userId,
    connectedAt: new Date().toISOString(),
    tools,
    prompts: [],
    resources: [],
  });

  const createMockTool = (name: string, description?: string): MCPTool => ({
    name,
    description: description || `Tool: ${name}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  });

  describe("processMCPContent", () => {
    it("should process text content", async () => {
      const mockUploadFile = createMockUploadFile();
      const content = [
        {
          type: "text",
          text: "Hello world",
        },
      ];

      const result = await processMCPContent(content, mockUploadFile);

      expect(result.textContent).toEqual(["Hello world"]);
      expect(result.processedContent).toEqual([
        {
          type: "text",
          text: "Hello world",
        },
      ]);
      expect(result.fileEvents).toEqual([]);
      expect(mockUploadFile).not.toHaveBeenCalled();
    });

    it("should process text content with annotations", async () => {
      const mockUploadFile = createMockUploadFile();
      const content = [
        {
          type: "text",
          text: "Hello world",
          annotations: {
            audience: ["user"],
            priority: 1,
          },
        },
      ];

      const result = await processMCPContent(content, mockUploadFile);

      expect(result.textContent).toEqual(["Hello world"]);
      expect(result.processedContent).toEqual([
        {
          type: "text",
          text: "Hello world",
          annotations: {
            audience: ["user"],
            priority: 1,
          },
        },
      ]);
      expect(result.fileEvents).toEqual([]);
    });

    it("should process image content and upload to iterate", async () => {
      const mockUploadFile = createMockUploadFile();
      const content = [
        {
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
      ];

      const result = await processMCPContent(content, mockUploadFile);

      expect(result.textContent).toEqual([]);
      expect(result.processedContent).toHaveLength(1);
      expect(result.processedContent[0]).toMatchObject({
        type: "image",
        mimeType: "image/png",
        iterateFileId: "file-123",
      });
      expect(result.fileEvents).toHaveLength(1);
      expect(result.fileEvents[0]).toMatchObject({
        type: "CORE:FILE_SHARED",
        data: {
          direction: "from-agent-to-user",
          iterateFileId: "file-123",
          openAIFileId: "file-openai-456",
        },
      });
      expect(mockUploadFile).toHaveBeenCalledWith({
        content: expect.any(ReadableStream),
        filename: expect.stringMatching(/^mcp-image-\d+\.png$/),
        contentLength: expect.any(Number),
        mimeType: "image/png",
        metadata: expect.objectContaining({
          source: "mcp-tool-result",
        }),
      });
    });

    it("should process audio content and upload to iterate", async () => {
      const mockUploadFile = createMockUploadFile();
      const content = [
        {
          type: "audio",
          data: "UklGRkIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YR4AAAAAAAEBAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fIA==",
          mimeType: "audio/wav",
        },
      ];

      const result = await processMCPContent(content, mockUploadFile);

      expect(result.textContent).toEqual([]);
      expect(result.processedContent).toHaveLength(1);
      expect(result.processedContent[0]).toMatchObject({
        type: "audio",
        mimeType: "audio/wav",
        iterateFileId: "file-123",
      });
      expect(result.fileEvents).toHaveLength(1);
      expect(mockUploadFile).toHaveBeenCalledWith({
        content: expect.any(ReadableStream),
        filename: expect.stringMatching(/^mcp-audio-\d+\.wav$/),
        contentLength: expect.any(Number),
        mimeType: "audio/wav",
        metadata: expect.objectContaining({
          source: "mcp-tool-result",
        }),
      });
    });

    it("should handle upload failure gracefully", async () => {
      const mockUploadFile = vi.fn().mockRejectedValue(new Error("Upload failed"));
      const content = [
        {
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
      ];

      const result = await processMCPContent(content, mockUploadFile);

      expect(result.textContent).toEqual([]);
      expect(result.processedContent).toHaveLength(1);
      expect(result.processedContent[0]).toMatchObject({
        type: "image",
        mimeType: "image/png",
        error: "Failed to upload file",
      });
      expect(result.fileEvents).toEqual([]);
    });

    it("should process resource_link content", async () => {
      const mockUploadFile = createMockUploadFile();
      const content = [
        {
          type: "resource_link",
          uri: "https://example.com/resource",
          name: "Example Resource",
          description: "An example resource",
        },
      ];

      const result = await processMCPContent(content, mockUploadFile);

      expect(result.textContent).toEqual([]);
      expect(result.processedContent).toEqual([
        {
          type: "resource_link",
          uri: "https://example.com/resource",
          name: "Example Resource",
          description: "An example resource",
        },
      ]);
      expect(result.fileEvents).toEqual([]);
      expect(mockUploadFile).not.toHaveBeenCalled();
    });

    it("should process resource content", async () => {
      const mockUploadFile = createMockUploadFile();
      const content = [
        {
          type: "resource",
          resource: {
            uri: "https://example.com/data",
            title: "Data Resource",
            text: "Some resource text",
          },
        },
      ];

      const result = await processMCPContent(content, mockUploadFile);

      expect(result.textContent).toEqual([]);
      expect(result.processedContent).toEqual([
        {
          type: "resource",
          resource: {
            uri: "https://example.com/data",
            title: "Data Resource",
            text: "Some resource text",
          },
        },
      ]);
      expect(result.fileEvents).toEqual([]);
      expect(mockUploadFile).not.toHaveBeenCalled();
    });

    it("should handle invalid content items gracefully", async () => {
      const mockUploadFile = createMockUploadFile();
      const content = [
        {
          type: "text",
          text: "Valid text",
        },
        {
          invalid: "content",
        },
      ];

      const result = await processMCPContent(content, mockUploadFile);

      expect(result.textContent).toEqual(["Valid text"]);
      expect(result.processedContent).toHaveLength(2);
      expect(result.processedContent[0]).toMatchObject({
        type: "text",
        text: "Valid text",
      });
      expect(result.processedContent[1]).toEqual({
        invalid: "content",
      });
      expect(result.fileEvents).toEqual([]);
    });

    it("should process mixed content types", async () => {
      const mockUploadFile = createMockUploadFile();
      const content = [
        {
          type: "text",
          text: "Some text",
        },
        {
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
        {
          type: "resource_link",
          uri: "https://example.com/resource",
        },
      ];

      const result = await processMCPContent(content, mockUploadFile);

      expect(result.textContent).toEqual(["Some text"]);
      expect(result.processedContent).toHaveLength(3);
      expect(result.fileEvents).toHaveLength(1);
      expect(mockUploadFile).toHaveBeenCalledOnce();
    });
  });

  describe("generateToolName", () => {
    it("should generate tool name with integration slug prefix", () => {
      const result = generateToolName({ slug: "github", toolName: "search_repositories" });
      expect(result).toBe("github_search_repositories");
    });

    it("should handle long tool names by truncating", () => {
      const longToolName = "a".repeat(100);
      const result = generateToolName({ slug: "github", toolName: longToolName });

      expect(result).toHaveLength(64);
      expect(result.startsWith("github_")).toBe(true);
      expect(result.endsWith("___")).toBe(true); // sanitizeToolName converts ... to ___
    });

    it("should sanitize tool names", () => {
      const result = generateToolName({ slug: "github", toolName: "search@repositories.v2" });
      expect(result).toBe("github_search_repositories_v2");
    });

    it("should handle short integration slug", () => {
      const result = generateToolName({ slug: "gh", toolName: "search" });
      expect(result).toBe("gh_search");
    });

    it("should handle edge case where integration slug is very long", () => {
      const longSlug = "a".repeat(60);
      const result = generateToolName({ slug: longSlug, toolName: "tool" });

      expect(result).toHaveLength(64);
      expect(result.startsWith(longSlug + "_")).toBe(true);
    });
  });

  describe("computeToolMapping", () => {
    it("should compute tool mapping from single connection", () => {
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::personal::user123");
      const connections: Record<MCPConnectionKey, MCPConnection> = {
        [connectionKey]: createMockConnection(
          "github",
          "server-123",
          "personal",
          [createMockTool("search_repositories")],
          "user123",
        ),
      };

      const result = computeToolMapping(connections);

      expect(result).toEqual({
        github_search_repositories: {
          integrationSlug: "github",
          originalName: "search_repositories",
          connections: {
            [connectionKey]: {
              serverId: "server-123",
              mode: "personal",
              userId: "user123",
              toolSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
              },
            },
          },
        },
      });
    });

    it("should deduplicate tools across multiple connections", () => {
      const connectionKey1 = MCPConnectionKey.parse(
        "https://mcp.github.com/mcp::personal::user123",
      );
      const connectionKey2 = MCPConnectionKey.parse(
        "https://mcp.github.com/mcp::personal::user456",
      );
      const connections: Record<MCPConnectionKey, MCPConnection> = {
        [connectionKey1]: createMockConnection(
          "github",
          "server-123",
          "personal",
          [createMockTool("search_repositories")],
          "user123",
        ),
        [connectionKey2]: createMockConnection(
          "github",
          "server-456",
          "personal",
          [createMockTool("search_repositories")],
          "user456",
        ),
      };

      const result = computeToolMapping(connections);

      expect(result["github_search_repositories"]).toBeDefined();
      expect(Object.keys(result["github_search_repositories"]!.connections)).toHaveLength(2);
      expect(result["github_search_repositories"]!.connections).toHaveProperty(connectionKey1);
      expect(result["github_search_repositories"]!.connections).toHaveProperty(connectionKey2);
    });

    it("should handle multiple tools from single connection", () => {
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::company");
      const connections: Record<MCPConnectionKey, MCPConnection> = {
        [connectionKey]: createMockConnection("github", "server-123", "company", [
          createMockTool("search_repositories"),
          createMockTool("create_issue"),
          createMockTool("list_pulls"),
        ]),
      };

      const result = computeToolMapping(connections);

      expect(Object.keys(result)).toEqual([
        "github_search_repositories",
        "github_create_issue",
        "github_list_pulls",
      ]);
    });

    it("should skip connections without connectedAt", () => {
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::personal::user123");
      const connections: Record<MCPConnectionKey, MCPConnection> = {
        [connectionKey]: {
          integrationSlug: "github",
          serverId: "server-123",
          serverUrl: "wss://example.com",
          serverName: "GitHub",
          mode: "personal",
          userId: "user123",
          connectedAt: "", // not connected
          tools: [createMockTool("search_repositories")],
          prompts: [],
          resources: [],
        },
      };

      const result = computeToolMapping(connections);

      expect(result).toEqual({});
    });

    it("should skip connections without tools", () => {
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::personal::user123");
      const connections: Record<MCPConnectionKey, MCPConnection> = {
        [connectionKey]: {
          integrationSlug: "github",
          serverId: "server-123",
          serverUrl: "wss://example.com",
          serverName: "GitHub",
          mode: "personal",
          userId: "user123",
          connectedAt: new Date().toISOString(),
          tools: [], // no tools
          prompts: [],
          resources: [],
        },
      };

      const result = computeToolMapping(connections);

      expect(result).toEqual({});
    });

    it("should handle connections with empty tools array", () => {
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::personal::user123");
      const connections: Record<MCPConnectionKey, MCPConnection> = {
        [connectionKey]: createMockConnection(
          "github",
          "server-123",
          "personal",
          [], // empty tools array
          "user123",
        ),
      };

      const result = computeToolMapping(connections);

      expect(result).toEqual({});
    });

    it("should handle mixed integration slugs", () => {
      const githubConnectionKey = MCPConnectionKey.parse(
        "https://mcp.github.com/mcp::personal::user123",
      );
      const slackConnectionKey = MCPConnectionKey.parse("https://mcp.slack.com/mcp::company");
      const connections: Record<MCPConnectionKey, MCPConnection> = {
        [githubConnectionKey]: createMockConnection(
          "github",
          "server-123",
          "personal",
          [createMockTool("search_repositories")],
          "user123",
        ),
        [slackConnectionKey]: createMockConnection("slack", "server-456", "company", [
          createMockTool("send_message"),
        ]),
      };

      const result = computeToolMapping(connections);

      expect(Object.keys(result)).toEqual(["github_search_repositories", "slack_send_message"]);
      expect(result["github_search_repositories"]!.integrationSlug).toBe("github");
      expect(result["slack_send_message"]!.integrationSlug).toBe("slack");
    });
  });

  describe("generateRuntimeToolsFromConnections", () => {
    it("should generate runtime tools from connections", () => {
      const mockUploadFile = createMockUploadFile();
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::company");
      const connections: Record<MCPConnectionKey, MCPConnection> = {
        [connectionKey]: createMockConnection("github", "server-123", "company", [
          createMockTool("search_repositories", "Search GitHub repositories"),
        ]),
      };

      const result = generateRuntimeToolsFromConnections(connections, mockUploadFile);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: "function",
        name: "github_search_repositories",
        description: "Search GitHub repositories",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
        strict: false,
      });
      expect(typeof result[0]!.execute).toBe("function");
    });

    it("should add impersonateUserId parameter for personal connections", () => {
      const mockUploadFile = createMockUploadFile();
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::personal::user123");
      const connections: Record<MCPConnectionKey, MCPConnection> = {
        [connectionKey]: createMockConnection(
          "github",
          "server-123",
          "personal",
          [createMockTool("search_repositories")],
          "user123",
        ),
      };

      const result = generateRuntimeToolsFromConnections(connections, mockUploadFile);

      expect(result).toHaveLength(1);
      expect(result[0]!.parameters).toMatchObject({
        type: "object",
        properties: {
          query: { type: "string" },
          impersonateUserId: {
            type: "string",
            description: "ID of the user to impersonate for this tool call",
          },
        },
        required: ["query", "impersonateUserId"],
      });
    });

    it("should skip tools with schema conflicts", () => {
      const mockUploadFile = createMockUploadFile();
      const tool1 = createMockTool("search");
      const tool2 = {
        ...createMockTool("search"),
        inputSchema: {
          type: "object",
          properties: {
            term: { type: "string" }, // different schema
          },
        },
      };

      const connectionKey1 = MCPConnectionKey.parse(
        "https://mcp.github.com/mcp::personal::user123",
      );
      const connectionKey2 = MCPConnectionKey.parse(
        "https://mcp.github.com/mcp::personal::user456",
      );
      const connections: Record<MCPConnectionKey, MCPConnection> = {
        [connectionKey1]: createMockConnection(
          "github",
          "server-123",
          "personal",
          [tool1],
          "user123",
        ),
        [connectionKey2]: createMockConnection(
          "github",
          "server-456",
          "personal",
          [tool2],
          "user456",
        ),
      };

      // spy on console.error to verify the conflict is logged
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = generateRuntimeToolsFromConnections(connections, mockUploadFile);

      expect(result).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[MCP] Schema conflict detected for tool github_search"),
      );

      consoleSpy.mockRestore();
    });

    it("should handle empty connections", () => {
      const mockUploadFile = createMockUploadFile();
      const connections: Record<MCPConnectionKey, MCPConnection> = {};

      const result = generateRuntimeToolsFromConnections(connections, mockUploadFile);

      expect(result).toEqual([]);
    });

    it("should skip connections missing in the connections map", () => {
      const mockUploadFile = createMockUploadFile();
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::company");
      const connections: Record<MCPConnectionKey, MCPConnection> = {
        [connectionKey]: createMockConnection("github", "server-123", "company", [
          createMockTool("search_repositories"),
        ]),
      };

      // manually delete the connection to simulate missing connection
      delete connections[connectionKey];

      const result = generateRuntimeToolsFromConnections(connections, mockUploadFile);

      expect(result).toEqual([]);
    });
  });

  describe("createRuntimeToolFromMCPTool", () => {
    const createMockManager = () => ({
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Tool executed successfully" }],
      }),
      readResource: vi.fn().mockResolvedValue({
        uri: "resource://test",
        text: "Resource content",
      }),
      mcpConnections: {
        "server-123": {
          state: "connected",
          transport: {} as any,
        },
      },
    });

    beforeEach(() => {
      vi.clearAllMocks();
      mcpManagerCache.managers.clear();
    });

    it("should create runtime tool for team connection", async () => {
      const mockUploadFile = createMockUploadFile();
      const tool = createMockTool("search_repos", "Search repositories");
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::company");
      const connections = {
        [connectionKey]: {
          serverId: "server-123",
          mode: "company" as const,
          toolSchema: tool.inputSchema,
        },
      };

      const runtimeTool = createRuntimeToolFromMCPTool({
        tool,
        toolName: "github_search_repos",
        integrationSlug: "github",
        connections,
        uploadFile: mockUploadFile,
      });

      expect(runtimeTool.type).toBe("function");
      expect(runtimeTool.name).toBe("github_search_repos");
      expect(runtimeTool.description).toBe("Search repositories");
      expect(runtimeTool.parameters).toEqual(tool.inputSchema);
      expect(runtimeTool.strict).toBe(false);
      expect(typeof runtimeTool.execute).toBe("function");
    });

    it("should add impersonateUserId parameter for personal connections", async () => {
      const mockUploadFile = createMockUploadFile();
      const tool = createMockTool("search_repos");
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::personal::user123");
      const connections = {
        [connectionKey]: {
          serverId: "server-123",
          mode: "personal" as const,
          userId: "user123",
          toolSchema: tool.inputSchema,
        },
      };

      const runtimeTool = createRuntimeToolFromMCPTool({
        tool,
        toolName: "github_search_repos",
        integrationSlug: "github",
        connections,
        uploadFile: mockUploadFile,
      });

      expect(runtimeTool.parameters).toEqual({
        type: "object",
        properties: {
          query: { type: "string" },
          impersonateUserId: {
            type: "string",
            description: "ID of the user to impersonate for this tool call",
          },
        },
        required: ["query", "impersonateUserId"],
      });
    });

    it("should execute tool for team connection", async () => {
      const mockManager = createMockManager();
      const mockUploadFile = createMockUploadFile();
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::company");

      mcpManagerCache.managers.set(connectionKey, mockManager as any);

      const tool = createMockTool("search_repos");
      const connections = {
        [connectionKey]: {
          serverId: "server-123",
          mode: "company" as const,
          toolSchema: tool.inputSchema,
        },
      };

      const runtimeTool = createRuntimeToolFromMCPTool({
        tool,
        toolName: "github_search_repos",
        integrationSlug: "github",
        connections,
        uploadFile: mockUploadFile,
      });

      const result = await runtimeTool.execute(
        { id: "call-123", name: "github_search_repos", arguments: '{"query": "test"}' } as any,
        { query: "test" },
      );

      expect(mockManager.callTool).toHaveBeenCalledWith({
        serverId: "server-123",
        name: "search_repos",
        arguments: { query: "test" },
      });

      expect(result).toEqual({
        toolCallResult: {
          content: [{ type: "text", text: "Tool executed successfully" }],
          textSummary: "Tool executed successfully",
        },
        triggerLLMRequest: true,
        addEvents: [],
      });
    });

    it("should throw error when impersonateUserId is missing for personal connection", async () => {
      const mockUploadFile = createMockUploadFile();
      const tool = createMockTool("search_repos");
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::personal::user123");
      const connections = {
        [connectionKey]: {
          serverId: "server-123",
          mode: "personal" as const,
          userId: "user123",
          toolSchema: tool.inputSchema,
        },
      };

      const runtimeTool = createRuntimeToolFromMCPTool({
        tool,
        toolName: "github_search_repos",
        integrationSlug: "github",
        connections,
        uploadFile: mockUploadFile,
      });

      await expect(
        runtimeTool.execute(
          { id: "call-123", name: "github_search_repos", arguments: '{"query": "test"}' } as any,
          { query: "test" },
        ),
      ).rejects.toThrow(
        "Missing required parameter 'impersonateUserId' for personal MCP tool github_search_repos",
      );
    });

    it("should throw error when user not found for personal connection", async () => {
      const mockUploadFile = createMockUploadFile();
      const tool = createMockTool("search_repos");
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::personal::user123");
      const connections = {
        [connectionKey]: {
          serverId: "server-123",
          mode: "personal" as const,
          userId: "user123",
          toolSchema: tool.inputSchema,
        },
      };

      const runtimeTool = createRuntimeToolFromMCPTool({
        tool,
        toolName: "github_search_repos",
        integrationSlug: "github",
        connections,
        uploadFile: mockUploadFile,
      });

      await expect(
        runtimeTool.execute(
          {
            id: "call-123",
            name: "github_search_repos",
            arguments: '{"query": "test", "impersonateUserId": "user456"}',
          } as any,
          { query: "test", impersonateUserId: "user456" },
        ),
      ).rejects.toThrow(
        "No personal MCP connection found for user user456 for tool github_search_repos. Available users: user123",
      );
    });

    it("should throw error when manager not found", async () => {
      const mockUploadFile = createMockUploadFile();
      const tool = createMockTool("search_repos");
      const connectionKey = MCPConnectionKey.parse("https://mcp.github.com/mcp::company");
      const connections = {
        [connectionKey]: {
          serverId: "server-123",
          mode: "company" as const,
          toolSchema: tool.inputSchema,
        },
      };

      const runtimeTool = createRuntimeToolFromMCPTool({
        tool,
        toolName: "github_search_repos",
        integrationSlug: "github",
        connections,
        uploadFile: mockUploadFile,
      });

      await expect(
        runtimeTool.execute(
          { id: "call-123", name: "github_search_repos", arguments: '{"query": "test"}' } as any,
          { query: "test" },
        ),
      ).rejects.toThrow(
        "MCP manager not found for connection and lazy connection deps not provided. The connection may need to be re-established.",
      );
    });
  });
});
