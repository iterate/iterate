import { describe, it, expect } from "vitest";
import { buildSessionName, parseSlugFromSessionName } from "./tmux-control.ts";

describe("buildSessionName", () => {
  it("should prefix slug with agent_", () => {
    expect(buildSessionName("my-agent")).toBe("agent_my-agent");
  });

  it("should handle slugs with numbers", () => {
    expect(buildSessionName("swift-fox-123")).toBe("agent_swift-fox-123");
  });

  it("should handle empty slug", () => {
    expect(buildSessionName("")).toBe("agent_");
  });

  it("should handle special characters in slug", () => {
    expect(buildSessionName("test_underscore")).toBe("agent_test_underscore");
  });
});

describe("parseSlugFromSessionName", () => {
  it("should extract slug from session name", () => {
    expect(parseSlugFromSessionName("agent_my-agent")).toBe("my-agent");
  });

  it("should return null for non-agent sessions", () => {
    expect(parseSlugFromSessionName("other-session")).toBeNull();
  });

  it("should return null for sessions with different prefix", () => {
    expect(parseSlugFromSessionName("user_session")).toBeNull();
  });

  it("should handle slugs with underscores", () => {
    expect(parseSlugFromSessionName("agent_test_underscore")).toBe("test_underscore");
  });

  it("should handle empty session name", () => {
    expect(parseSlugFromSessionName("")).toBeNull();
  });

  it("should return empty string for session named just agent_", () => {
    // This is the edge case - session named exactly "agent_"
    expect(parseSlugFromSessionName("agent_")).toBe("");
  });
});

describe("buildSessionName and parseSlugFromSessionName roundtrip", () => {
  it("should roundtrip correctly for valid slugs", () => {
    const slugs = ["my-agent", "swift-fox-123", "test-session"];
    for (const slug of slugs) {
      const sessionName = buildSessionName(slug);
      const parsed = parseSlugFromSessionName(sessionName);
      expect(parsed).toBe(slug);
    }
  });
});
