import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.ts";
import { registerDeterministicTools } from "./tools/deterministic-tools.ts";
import { registerErrorTools } from "./tools/error-tools.ts";
import { registerAsyncTools } from "./tools/async-tools.ts";

/**
 * Mock MCP Agent for E2E testing.
 *
 * Provides a set of deterministic tools for testing MCP connection,
 * tool invocation, error handling, and async behavior.
 */
export class MockMCPAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "Mock MCP Server for E2E Testing",
    version: "1.0.0",
  });

  async init() {
    // Register all tool categories
    registerDeterministicTools(this.server);
    registerErrorTools(this.server);
    registerAsyncTools(this.server);
  }
}
