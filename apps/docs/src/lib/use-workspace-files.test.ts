import { describe, expect, test } from "vitest";
import type { WorkspaceStatus } from "iterate/client";
import { rootOf, workspaceRoots, workspaceTree } from "./use-workspace-files.ts";

const status: WorkspaceStatus = {
  mounts: [
    {
      path: "/repos/other",
      policy: "commit-to-main",
      repoPath: "/repos/other",
      changes: [{ change: "modified", path: "/repos/other/src/index.ts" }],
    },
    {
      path: "/repos/config",
      policy: "commit-to-main",
      repoPath: "/repos/config",
      changes: [
        { change: "added", path: "/repos/config/docs/new.md" },
        { change: "deleted", path: "/repos/config/docs/gone.md" },
      ],
    },
    { path: "/repos/iterate", policy: "read-only", repoPath: "/repos/iterate", changes: [] },
  ],
  unmounted: [{ change: "added", path: "/workspaces/scratch/x1/notes.md" }],
};

describe("workspace roots", () => {
  test("every mount plus the workspace's own directory, from status alone", () => {
    expect(workspaceRoots(status, "/workspaces/scratch/x1")).toEqual([
      "/repos/config",
      "/repos/iterate",
      "/repos/other",
      "/workspaces/scratch/x1",
    ]);
  });

  test("a path resolves to the root it lives under", () => {
    const roots = workspaceRoots(status, "/workspaces/scratch/x1");
    expect(rootOf(roots, "/repos/config/docs/new.md")).toBe("/repos/config");
    expect(rootOf(roots, "/repos/config")).toBe("/repos/config");
    expect(rootOf(roots, "/repos/config-2/x.md")).toBeNull();
    expect(rootOf(roots, "/workspaces/scratch/x1/notes.md")).toBe("/workspaces/scratch/x1");
  });
});

describe("workspaceTree", () => {
  test("HEAD is the loaded listings minus additions plus deletions; unloaded roots stay folders", () => {
    const tree = workspaceTree(
      workspaceRoots(status, "/workspaces/scratch/x1"),
      new Map([
        ["/repos/config", ["/repos/config/README.md", "/repos/config/docs/new.md"]],
        ["/workspaces/scratch/x1", ["/workspaces/scratch/x1/notes.md"]],
      ]),
      status,
    );
    expect(tree.headPaths).toEqual(["/repos/config/README.md", "/repos/config/docs/gone.md"]);
    expect(tree.directories).toEqual([
      "/repos/config",
      "/repos/iterate",
      "/repos/other",
      "/workspaces/scratch/x1",
    ]);
    expect([...tree.changes]).toEqual([
      ["/repos/config/docs/gone.md", "deleted"],
      ["/repos/config/docs/new.md", "added"],
      ["/repos/other/src/index.ts", "modified"],
      ["/workspaces/scratch/x1/notes.md", "added"],
    ]);
    // Dirty mounts only, sorted by mount path, the own directory last with no scope.
    expect(tree.mounts.map((mount) => [mount.scope, mount.policy, mount.changes.length])).toEqual([
      ["/repos/config", "commit-to-main", 2],
      ["/repos/other", "commit-to-main", 1],
      [null, null, 1],
    ]);
  });

  test("a clean workspace has no dirty mounts and an empty change map", () => {
    const tree = workspaceTree(
      ["/repos/config", "/workspaces/scratch/x1"],
      new Map([["/repos/config", ["/repos/config/README.md"]]]),
      {
        mounts: [
          {
            path: "/repos/config",
            policy: "commit-to-main",
            repoPath: "/repos/config",
            changes: [],
          },
        ],
        unmounted: [],
      },
    );
    expect(tree.headPaths).toEqual(["/repos/config/README.md"]);
    expect(tree.changes.size).toBe(0);
    expect(tree.mounts).toEqual([]);
  });
});
