import { describe, expect, it } from "vitest";
import { isMcpAgentPath, resolveMcpSessionAgentPath } from "./mcp-session-agent-path.ts";

describe("resolveMcpSessionAgentPath", () => {
  it("scopes the session to the MCP transport session when present", async () => {
    const request = new Request("https://mcp.test/api/mcp", {
      headers: { "Mcp-Session-Id": "mcp_session_1" },
    });

    const path = await resolveMcpSessionAgentPath({
      auth: { sessionKey: "oauth-session:sess_1" },
      request,
    });

    expect(path).toMatch(/^\/agents\/mcp\/mcp-[a-f0-9]{16}$/);
    await expect(
      resolveMcpSessionAgentPath({
        auth: { sessionKey: "oauth-session:sess_1" },
        request,
      }),
    ).resolves.toBe(path);
  });

  it("falls back to the OAuth session key", async () => {
    const path = await resolveMcpSessionAgentPath({
      auth: { sessionKey: "oauth-session:sess_1" },
      request: new Request("https://mcp.test/api/mcp"),
    });

    expect(path).toMatch(/^\/agents\/mcp\/session-[a-f0-9]{16}$/);
  });

  it("uses a request-scoped path when no stable session identifier exists", async () => {
    const first = await resolveMcpSessionAgentPath({
      auth: {},
      request: new Request("https://mcp.test/api/mcp"),
    });
    const second = await resolveMcpSessionAgentPath({
      auth: {},
      request: new Request("https://mcp.test/api/mcp"),
    });

    expect(first).toMatch(/^\/agents\/mcp\/request-[a-f0-9]{16}$/);
    expect(second).toMatch(/^\/agents\/mcp\/request-[a-f0-9]{16}$/);
    expect(second).not.toBe(first);
  });
});

describe("isMcpAgentPath", () => {
  it("matches /agents/mcp and everything under it, nothing else", () => {
    expect(isMcpAgentPath("/agents/mcp")).toBe(true);
    expect(isMcpAgentPath("/agents/mcp/session-abc")).toBe(true);
    expect(isMcpAgentPath("/agents/MCP/session-abc")).toBe(true);
    expect(isMcpAgentPath("/agents/mcpish")).toBe(false);
    expect(isMcpAgentPath("/agents/slack/c1/ts-1")).toBe(false);
  });
});
