import { describe, expect, it } from "vitest";
import { agentPathFromInput, agentPathFromSplat, agentPathToSplat } from "./agent-links.ts";

describe("agent links", () => {
  it("normalizes entered paths under /agents", () => {
    expect(agentPathFromInput("alice/bla")).toBe("/agents/alice/bla");
    expect(agentPathFromInput("/alice/bla/")).toBe("/agents/alice/bla");
    expect(agentPathFromInput("/agents/alice/bla/")).toBe("/agents/alice/bla");
  });

  it("round trips route splats without duplicating the /agents prefix", () => {
    expect(agentPathFromSplat("alice/bla")).toBe("/agents/alice/bla");
    expect(agentPathToSplat("/agents/alice/bla")).toBe("alice/bla");
  });
});
