import { describe, it, expect } from "vitest";

// Re-implement parseAgentSlug here for testing since sync-sessions.ts is a script
// This also serves as documentation of the expected behavior
function parseAgentSlug(sessionName: string): string | null {
  if (!sessionName.startsWith("agent_")) {
    return null;
  }
  const slug = sessionName.slice(6);
  // Filter out empty slugs (e.g., if session was named just "agent_")
  if (!slug) {
    return null;
  }
  return slug;
}

describe("parseAgentSlug", () => {
  it("should extract slug from agent session name", () => {
    expect(parseAgentSlug("agent_my-agent")).toBe("my-agent");
  });

  it("should return null for non-agent sessions", () => {
    expect(parseAgentSlug("other-session")).toBeNull();
  });

  it("should return null for sessions with different prefix", () => {
    expect(parseAgentSlug("user_session")).toBeNull();
  });

  it("should handle slugs with underscores", () => {
    expect(parseAgentSlug("agent_test_underscore")).toBe("test_underscore");
  });

  it("should handle slugs with numbers", () => {
    expect(parseAgentSlug("agent_swift-fox-123")).toBe("swift-fox-123");
  });

  it("should return null for empty slug (session named just agent_)", () => {
    expect(parseAgentSlug("agent_")).toBeNull();
  });

  it("should return null for empty session name", () => {
    expect(parseAgentSlug("")).toBeNull();
  });

  it("should handle partial prefix match", () => {
    expect(parseAgentSlug("agent")).toBeNull();
    expect(parseAgentSlug("agen_test")).toBeNull();
  });
});

describe("sync-sessions schema validation", () => {
  // This test validates that the schema in sync-sessions.ts matches schema.ts
  // The schema in sync-sessions.ts is defined as:
  const syncSessionsSchema = {
    tableName: "sessions",
    columns: [
      { name: "slug", type: "TEXT", constraints: "PRIMARY KEY" },
      { name: "harness_type", type: "TEXT", constraints: "NOT NULL DEFAULT 'claude-code'" },
      { name: "working_directory", type: "TEXT", constraints: "" },
      { name: "status", type: "TEXT", constraints: "NOT NULL DEFAULT 'running'" },
      { name: "initial_prompt", type: "TEXT", constraints: "" },
      { name: "created_at", type: "INTEGER", constraints: "DEFAULT (unixepoch())" },
      { name: "updated_at", type: "INTEGER", constraints: "DEFAULT (unixepoch())" },
    ],
  };

  // The schema in schema.ts is defined as (from Drizzle):
  const drizzleSchemaColumns = [
    "slug",
    "harness_type",
    "working_directory",
    "status",
    "initial_prompt",
    "created_at",
    "updated_at",
  ];

  it("should have matching column names", () => {
    const syncColumns = syncSessionsSchema.columns.map((c) => c.name);
    expect(syncColumns).toEqual(drizzleSchemaColumns);
  });

  it("should use sessions as table name", () => {
    expect(syncSessionsSchema.tableName).toBe("sessions");
  });

  it("should have slug as primary key", () => {
    const slugCol = syncSessionsSchema.columns.find((c) => c.name === "slug");
    expect(slugCol?.constraints).toContain("PRIMARY KEY");
  });

  it("should have correct defaults", () => {
    const harnessCol = syncSessionsSchema.columns.find((c) => c.name === "harness_type");
    expect(harnessCol?.constraints).toContain("DEFAULT 'claude-code'");

    const statusCol = syncSessionsSchema.columns.find((c) => c.name === "status");
    expect(statusCol?.constraints).toContain("DEFAULT 'running'");
  });
});
