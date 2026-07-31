import { describe, expect, test } from "vitest";
import { boardKey, changeMap } from "./use-workspace-board.ts";

describe("board path keys", () => {
  test("one canonical form: stray leading slashes and repo-relative agree", () => {
    expect(boardKey("/tasks/a.md")).toBe("tasks/a.md");
    expect(boardKey("tasks/a.md")).toBe("tasks/a.md");
    expect(boardKey("//tasks/a.md")).toBe("tasks/a.md");
  });

  test("status changes land as repo-relative keys from the matching mount only", () => {
    const changes = changeMap(
      {
        mounts: [
          {
            changes: [
              { change: "modified", path: "/repos/config/tasks/a.md" },
              { change: "added", path: "/repos/config/sub/tasks/b.md" },
              { change: "deleted", path: "/repos/config/tasks/gone.md" },
              // Not a task file — no badge, even though the mount matches.
              { change: "modified", path: "/repos/config/README.md" },
            ],
            path: "/repos/config",
          },
          {
            // Another repo's mount: its changes are not this board's.
            changes: [{ change: "modified", path: "/repos/other/tasks/c.md" }],
            path: "/repos/other",
          },
        ],
      },
      "/repos/config",
    );
    expect(changes.get("tasks/a.md")).toBe("modified");
    expect(changes.get("sub/tasks/b.md")).toBe("added");
    expect(changes.get("tasks/gone.md")).toBe("deleted");
    expect(changes.size).toBe(3);
  });
});
