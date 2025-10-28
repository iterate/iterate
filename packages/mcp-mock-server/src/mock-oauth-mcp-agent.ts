import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.ts";
import { registerDeterministicTools } from "./tools/deterministic-tools.ts";
import { registerErrorTools } from "./tools/error-tools.ts";
import { registerAsyncTools } from "./tools/async-tools.ts";
import { z } from "zod";

/**
 * Props from the OAuth authentication flow
 */
export interface MockOAuthProps {
  userId: string;
  userName: string;
  email: string;
  sessionId: string;
  accessToken: string;
  [key: string]: unknown;
}

/**
 * Mock MCP Agent with OAuth authentication for E2E testing.
 *
 * This agent includes user context from the OAuth flow and provides
 * authenticated tools for testing OAuth-enabled MCP servers.
 */
export class MockOAuthMCPAgent extends McpAgent<Env, Record<string, never>, MockOAuthProps> {
  server = new McpServer({
    name: "Mock MCP Server with OAuth",
    version: "1.0.0",
  });

  async init() {
    // Register standard test tools
    registerDeterministicTools(this.server);
    registerErrorTools(this.server);
    registerAsyncTools(this.server);

    // Add authenticated user info tool
    this.server.tool("userInfo", "Get information about the authenticated user", {}, async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              userId: this.props?.userId,
              userName: this.props?.userName,
              email: this.props?.email,
              sessionId: this.props?.sessionId,
              authenticated: !!this.props,
            },
            null,
            2,
          ),
        },
      ],
    }));

    // Add a tool that demonstrates using auth context
    this.server.tool(
      "greet",
      "Get a personalized greeting for the authenticated user",
      {
        formal: z.boolean().optional().describe("Whether to use formal greeting"),
      },
      async ({ formal }) => {
        if (!this.props) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Not authenticated",
              },
            ],
          };
        }

        const greeting = formal
          ? `Good day, ${this.props.userName}. Your user ID is ${this.props.userId}.`
          : `Hey ${this.props.userName}! 👋`;

        return {
          content: [
            {
              type: "text",
              text: greeting,
            },
          ],
        };
      },
    );

    // Add a tool that simulates permission-based access
    this.server.tool(
      "adminAction",
      "Perform an admin action (only for specific users)",
      {
        action: z.string().describe("The admin action to perform"),
      },
      async ({ action }) => {
        if (!this.props) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Not authenticated",
              },
            ],
          };
        }

        // Simulate permission check - only users with "admin" in their userId
        if (!this.props.userId.includes("admin")) {
          return {
            content: [
              {
                type: "text",
                text: `Permission denied: User ${this.props.userName} does not have admin privileges`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Admin action "${action}" performed successfully by ${this.props.userName}`,
            },
          ],
        };
      },
    );
  }
}
