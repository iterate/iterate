import { describe, it, expect } from "vitest";
import { validateAgentPath, extractAgentPathFromUrl } from "./agent-path.ts";

describe("validateAgentPath", () => {
  it("rejects paths without leading slash", () => {
    expect(validateAgentPath("foo").valid).toBe(false);
  });

  it("rejects root path '/'", () => {
    expect(validateAgentPath("/").valid).toBe(false);
  });

  it("rejects paths with uppercase", () => {
    expect(validateAgentPath("/Foo").valid).toBe(false);
  });

  it("rejects paths with special chars", () => {
    expect(validateAgentPath("/foo@bar").valid).toBe(false);
  });

  it("accepts valid single-segment path", () => {
    expect(validateAgentPath("/foo").valid).toBe(true);
  });

  it("accepts valid multi-segment path", () => {
    expect(validateAgentPath("/slack/thread-123").valid).toBe(true);
  });
});

describe("extractAgentPathFromUrl", () => {
  it("extracts a path from the prefix", () => {
    expect(extractAgentPathFromUrl("/api/agents/slack/foo", "/api/agents")).toBe("/slack/foo");
  });

  it("returns null when no path exists", () => {
    expect(extractAgentPathFromUrl("/api/agents", "/api/agents")).toBeNull();
  });
});
