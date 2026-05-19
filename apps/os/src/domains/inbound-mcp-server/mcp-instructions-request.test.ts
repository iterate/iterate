import { describe, expect, it } from "vitest";
import { isBrowserMcpInstructionsRequest } from "./mcp-instructions-request.ts";

function request(input: { accept?: string; authorization?: string; method?: string }) {
  const headers = new Headers();
  if (input.accept) {
    headers.set("accept", input.accept);
  }
  if (input.authorization) {
    headers.set("authorization", input.authorization);
  }

  return new Request("https://os.iterate.com/mcp", {
    method: input.method ?? "GET",
    headers,
  });
}

describe("isBrowserMcpInstructionsRequest", () => {
  it("matches unauthenticated browser visits", () => {
    expect(isBrowserMcpInstructionsRequest(request({ accept: "text/html" }))).toBe(true);
  });

  it("rejects MCP clients that also negotiate JSON or SSE", () => {
    expect(
      isBrowserMcpInstructionsRequest(
        request({ accept: "text/html, application/json, text/event-stream" }),
      ),
    ).toBe(false);
  });

  it("rejects authenticated requests even when Accept includes text/html", () => {
    expect(
      isBrowserMcpInstructionsRequest(
        request({
          accept: "text/html, application/json, text/event-stream",
          authorization: "Bearer oauth-token",
        }),
      ),
    ).toBe(false);
  });
});
