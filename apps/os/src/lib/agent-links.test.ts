import { describe, expect, it } from "vitest";
import { agentPathFromInput } from "./agent-links.ts";

describe("agent links", () => {
  it("accepts entered full agent paths", () => {
    expect(agentPathFromInput("/agents/alice/bla")).toBe("/agents/alice/bla");
    expect(() => agentPathFromInput("alice/bla")).toThrow("Agent path must start with /agents/.");
    expect(() => agentPathFromInput("/alice/bla")).toThrow("Agent path must start with /agents/.");
  });
});
