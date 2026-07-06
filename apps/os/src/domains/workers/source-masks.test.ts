import { describe, expect, it } from "vitest";
import { filterWorkerSnapshotPaths } from "./source-masks.ts";

const paths = [
  ".dev.vars",
  ".git/config",
  "AGENTS.md",
  "apps/counter/worker.ts",
  "apps/hello/worker.ts",
  "node_modules/left-pad/index.js",
  "package.json",
  "worker.ts",
];

describe("filterWorkerSnapshotPaths", () => {
  it("includes everything by default", () => {
    expect(filterWorkerSnapshotPaths(paths, {})).toEqual(paths);
  });

  it("applies include masks with dotfile matching", () => {
    expect(filterWorkerSnapshotPaths(paths, { include: ["apps/hello/**", "*.json"] })).toEqual([
      "apps/hello/worker.ts",
      "package.json",
    ]);
    expect(filterWorkerSnapshotPaths(paths, { include: ["**"] })).toContain(".dev.vars");
  });

  it("applies exclude masks after includes", () => {
    expect(
      filterWorkerSnapshotPaths(paths, { exclude: [".git/**", "node_modules/**", "*.md"] }),
    ).toEqual([
      ".dev.vars",
      "apps/counter/worker.ts",
      "apps/hello/worker.ts",
      "package.json",
      "worker.ts",
    ]);
  });
});
