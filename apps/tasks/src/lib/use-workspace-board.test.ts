import { describe, expect, test } from "vitest";
import { boardKey, changeMap } from "./use-workspace-board.ts";

describe("board path keys", () => {
  test("one canonical form: absolute platform paths and repo-relative agree", () => {
    expect(boardKey("/tasks/a.md")).toBe("tasks/a.md");
    expect(boardKey("tasks/a.md")).toBe("tasks/a.md");
    expect(boardKey("//tasks/a.md")).toBe("tasks/a.md");
  });

  test("status changes and file keys land on the same form", () => {
    const changes = changeMap({
      mounts: [{ changes: [{ change: "modified", path: "/tasks/a.md" }] }],
    });
    expect(changes.get(boardKey("/tasks/a.md"))).toBe("modified");
  });
});
