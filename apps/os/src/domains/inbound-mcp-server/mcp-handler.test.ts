import { describe, expect, it } from "vitest";
import { resolveAskAssistantAgentPath } from "./ask-assistant-agent-path.ts";

describe("resolveAskAssistantAgentPath", () => {
  it("scopes ask_assistant to the MCP transport session when present", async () => {
    const request = new Request("https://mcp.test/api/mcp", {
      headers: { "Mcp-Session-Id": "mcp_session_1" },
    });

    const path = await resolveAskAssistantAgentPath({
      auth: { askAssistantSessionKey: "oauth-session:sess_1" },
      request,
    });

    expect(path).toMatch(/^\/agents\/mcp\/inbound\/mcp-[a-f0-9]{16}$/);
    await expect(
      resolveAskAssistantAgentPath({
        auth: { askAssistantSessionKey: "oauth-session:sess_1" },
        request,
      }),
    ).resolves.toBe(path);
  });

  it("falls back to the OAuth session key", async () => {
    const path = await resolveAskAssistantAgentPath({
      auth: { askAssistantSessionKey: "oauth-session:sess_1" },
      request: new Request("https://mcp.test/api/mcp"),
    });

    expect(path).toMatch(/^\/agents\/mcp\/inbound\/session-[a-f0-9]{16}$/);
  });

  it("uses a request-scoped path when no stable session identifier exists", async () => {
    const first = await resolveAskAssistantAgentPath({
      auth: {},
      request: new Request("https://mcp.test/api/mcp"),
    });
    const second = await resolveAskAssistantAgentPath({
      auth: {},
      request: new Request("https://mcp.test/api/mcp"),
    });

    expect(first).toMatch(/^\/agents\/mcp\/inbound\/request-[a-f0-9]{16}$/);
    expect(second).toMatch(/^\/agents\/mcp\/inbound\/request-[a-f0-9]{16}$/);
    expect(second).not.toBe(first);
  });
});
