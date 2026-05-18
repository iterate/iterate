import { afterEach, describe, expect, it, vi } from "vitest";

import { assertMcpAdminBearerAccepted } from "./claude-mcp.ts";

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
        mcpUrl: "https://mcp__iterate.iterate.app/",
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
        mcpUrl: "https://mcp__demo.iterate.app/",
        token: "secret",
      }),
    ).resolves.toBeUndefined();
  });
});
