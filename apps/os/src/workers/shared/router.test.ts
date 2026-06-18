import { describe, expect, it } from "vitest";
import { decideIngressRoute } from "./router.ts";

describe("decideIngressRoute", () => {
  it.each([
    ["https://os.iterate.com", ["iterate.app"], "https://demo.iterate.app/api/mcp"],
    [
      "http://localhost:5176",
      ["localhost"],
      "http://127.0.0.1:5176/api/mcp/.well-known/oauth-protected-resource",
    ],
  ])("keeps %s MCP routes on the app lane", async (baseUrl, projectHostnameBases, url) => {
    await expect(
      decideIngressRoute({
        config: { baseUrl, projectHostnameBases },
        db: {} as D1Database,
        method: "GET",
        url,
      }),
    ).resolves.toEqual({ lane: "os" });
  });
});
