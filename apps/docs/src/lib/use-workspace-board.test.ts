import { describe, expect, test } from "vitest";
import {
  boardKey,
  boardKeyUnderRepo,
  changeMap,
  presenceByBoardKey,
  qualifyBoardPath,
  readTaskFiles,
  versionsByBoardKey,
} from "./use-workspace-board.ts";

describe("board path keys", () => {
  test("one canonical form: stray leading slashes and repo-relative agree", () => {
    expect(boardKey("/tasks/a.md")).toBe("tasks/a.md");
    expect(boardKey("tasks/a.md")).toBe("tasks/a.md");
    expect(boardKey("//tasks/a.md")).toBe("tasks/a.md");
  });

  test("board keys and platform paths round-trip through the repo mount", () => {
    expect(qualifyBoardPath("/repos/config", "tasks/a.md")).toBe("/repos/config/tasks/a.md");
    expect(qualifyBoardPath("/repos/config", "/tasks/a.md")).toBe("/repos/config/tasks/a.md");
    expect(boardKeyUnderRepo("/repos/config", "/repos/config/tasks/a.md")).toBe("tasks/a.md");
    expect(boardKeyUnderRepo("/repos/config", "/repos/other/tasks/a.md")).toBeNull();
    expect(boardKeyUnderRepo("/repos/config", "/repos/config-2/tasks/a.md")).toBeNull();
  });

  test("live versions and carets outside the board's repo stay out of the board", () => {
    expect(
      versionsByBoardKey(
        { "/repos/config/tasks/a.md": 3, "/repos/other/tasks/b.md": 9, "/workspaces/x/n.md": 1 },
        "/repos/config",
      ),
    ).toEqual({ "tasks/a.md": 3 });
    expect(
      presenceByBoardKey(
        {
          clientIds: ["u-a", "u-b", "u-c"],
          paths: [
            "/repos/config/tasks/a.md",
            "/repos/other/tasks/b.md",
            "/repos/config/tasks/a.md",
          ],
        },
        "/repos/config",
      ),
    ).toEqual(new Map([["tasks/a.md", ["u-a", "u-c"]]]));
  });

  test("the board seed globs the repo's task files and skips vanished reads", async () => {
    const calls: string[][] = [];
    const seeded = await readTaskFiles(
      {
        glob: async (pattern) => {
          expect(pattern).toBe("/repos/config/**/tasks/**/*.md");
          return ["/repos/config/tasks/a.md", "/repos/config/tasks/gone.md"];
        },
        readFiles: async (paths) => {
          calls.push(paths);
          return { "/repos/config/tasks/a.md": "# A", "/repos/config/tasks/gone.md": null };
        },
      },
      "/repos/config",
    );
    expect(seeded).toEqual({ "tasks/a.md": "# A" });
    expect(calls).toEqual([["/repos/config/tasks/a.md", "/repos/config/tasks/gone.md"]]);
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
