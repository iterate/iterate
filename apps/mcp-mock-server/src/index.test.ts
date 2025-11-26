import { verifyBearerAuth } from "./auth.ts";

describe("bearer auth for /mcp", () => {
  test("returns 401 when MCP_BEARER_TOKEN set and Authorization missing", async () => {
    const req = new Request("http://localhost/mcp");
    const res = verifyBearerAuth(req, "secret")!;
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  test("returns 401 when MCP_BEARER_TOKEN set and Authorization invalid", async () => {
    const req = new Request("http://localhost/mcp", {
      headers: { Authorization: "Bearer wrong" },
    });
    const res = verifyBearerAuth(req, "secret")!;
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });
});


