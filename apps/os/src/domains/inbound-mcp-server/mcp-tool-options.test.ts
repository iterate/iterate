import { describe, expect, it } from "vitest";
import { readInboundMcpToolOptions } from "./mcp-tool-options.ts";

describe("readInboundMcpToolOptions", () => {
  it("defaults to the exec_typescript-only surface", () => {
    expect(readInboundMcpToolOptions(new Request("https://mcp.test/api/mcp"))).toEqual({
      withAgent: false,
    });
  });

  it("enables the assistant tool only with an explicit URL opt-in", () => {
    expect(
      readInboundMcpToolOptions(new Request("https://mcp.test/api/mcp?withAgent=true")),
    ).toEqual({
      withAgent: true,
    });

    expect(
      readInboundMcpToolOptions(new Request("https://mcp.test/api/mcp?withAgent=false")),
    ).toEqual({
      withAgent: false,
    });
  });
});
