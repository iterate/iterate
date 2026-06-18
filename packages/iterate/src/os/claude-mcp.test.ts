import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertMcpAdminBearerAccepted,
  buildClaudeShellCommand,
  defaultMcpUrlFromEnv,
} from "./claude-mcp.ts";

describe("buildClaudeShellCommand", () => {
  it("quotes JSON mcp config for shell copy-paste", () => {
    const command = buildClaudeShellCommand([
      "--mcp-config",
      '{"mcpServers":{"iterate":{"type":"http"}}}',
      "--strict-mcp-config",
      "hello world",
    ]);

    expect(command).toBe(
      'claude --mcp-config \'{"mcpServers":{"iterate":{"type":"http"}}}\' --strict-mcp-config \'hello world\'',
    );
  });
});

describe("defaultMcpUrlFromEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses the normal local Start route when only the app base URL is configured", () => {
    delete process.env.APP_CONFIG_MCP__BASE_URL;
    process.env.APP_CONFIG_BASE_URL = "http://localhost:5176";

    expect(defaultMcpUrlFromEnv()).toBe("http://localhost:5176/api/mcp");
  });

  it("prefers the configured canonical MCP URL", () => {
    process.env.APP_CONFIG_BASE_URL = "http://localhost:5176";
    process.env.APP_CONFIG_MCP__BASE_URL = "https://mcp.iterate-preview-5.com";

    expect(defaultMcpUrlFromEnv()).toBe("https://mcp.iterate-preview-5.com");
  });
});

describe("assertMcpAdminBearerAccepted", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects 401 with a doppler prd hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Invalid bearer token", { status: 401 })),
    );

    await expect(
      assertMcpAdminBearerAccepted({
        mcpUrl: "https://mcp.iterate.com",
        token: "wrong",
      }),
    ).rejects.toThrow(/APP_CONFIG_ADMIN_API_SECRET/);
  });

  it("accepts a successful initialize response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("event: message\ndata: {}\n\n", { status: 200 })),
    );

    await expect(
      assertMcpAdminBearerAccepted({
        mcpUrl: "https://mcp.iterate.com",
        token: "secret",
      }),
    ).resolves.toBeUndefined();
  });
});
