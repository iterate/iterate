import { describe, it, expect } from "vitest";
import { parseTaskFile, serializeTask } from "./scheduler.ts";

describe("parseTaskFile", () => {
  it("parses valid task with all fields", () => {
    const content = `---
state: pending
due: 2026-01-28T09:00:00Z
schedule: "0 9 * * *"
priority: high
workingDirectory: /home/user/project
harnessType: opencode
---

# Daily Report

Send a summary to Slack.`;

    const task = parseTaskFile(content, "daily-report.md");

    expect(task).not.toBeNull();
    expect(task!.filename).toBe("daily-report.md");
    expect(task!.frontmatter.state).toBe("pending");
    expect(task!.frontmatter.due).toBe("2026-01-28T09:00:00Z");
    expect(task!.frontmatter.schedule).toBe("0 9 * * *");
    expect(task!.frontmatter.priority).toBe("high");
    expect(task!.frontmatter.workingDirectory).toBe("/home/user/project");
    expect(task!.frontmatter.harnessType).toBe("opencode");
    expect(task!.body).toContain("# Daily Report");
  });

  it("parses task without optional fields", () => {
    const content = `---
state: pending
due: 2026-01-28T09:00:00Z
workingDirectory: /tmp
harnessType: opencode
---

Simple task.`;

    const task = parseTaskFile(content, "simple.md");

    expect(task).not.toBeNull();
    expect(task!.frontmatter.schedule).toBeUndefined();
    expect(task!.frontmatter.priority).toBeUndefined();
    expect(task!.frontmatter.lockedBy).toBeUndefined();
  });

  it("returns null for missing frontmatter", () => {
    const content = "# No frontmatter\n\nJust content.";
    const task = parseTaskFile(content, "bad.md");
    expect(task).toBeNull();
  });

  it("returns null for missing required fields", () => {
    const content = `---
state: pending
---

Missing due and workingDirectory.`;

    const task = parseTaskFile(content, "incomplete.md");
    expect(task).toBeNull();
  });
});

describe("serializeTask", () => {
  it("round-trips a task", () => {
    const original = `---
state: pending
due: 2026-01-28T09:00:00Z
schedule: "0 9 * * *"
priority: normal
workingDirectory: /home/user/project
harnessType: opencode
---

# Daily Report

Send a summary to Slack.`;

    const task = parseTaskFile(original, "test.md")!;
    const serialized = serializeTask(task);
    const reparsed = parseTaskFile(serialized, "test.md")!;

    expect(reparsed.frontmatter).toEqual(task.frontmatter);
    expect(reparsed.body).toEqual(task.body);
  });

  it("handles task without optional fields", () => {
    const task = {
      filename: "simple.md",
      frontmatter: {
        state: "pending" as const,
        due: "2026-01-28T09:00:00Z",
        workingDirectory: "/tmp",
        harnessType: "opencode" as const,
      },
      body: "Simple task.",
      raw: "",
    };

    const serialized = serializeTask(task);

    expect(serialized).toContain("state: pending");
    expect(serialized).toContain("due: 2026-01-28T09:00:00Z");
    expect(serialized).not.toContain("schedule:");
    expect(serialized).not.toContain("lockedBy:");
    expect(serialized).toContain("priority: normal"); // Default
  });
});
