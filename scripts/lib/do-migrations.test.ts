import { describe, expect, it } from "vitest";
import {
  convergeDoMigrations,
  desiredClassesFromMigrations,
  type DoMigrationStep,
} from "./do-migrations.ts";

describe("desiredClassesFromMigrations", () => {
  it("nets creates, renames and deletes in order", () => {
    const migrations: DoMigrationStep[] = [
      { tag: "v1", new_sqlite_classes: ["A", "B"], new_classes: ["Legacy"] },
      { tag: "v2", renamed_classes: [{ from: "Legacy", to: "C" }] },
      { tag: "v3", deleted_classes: ["B"] },
    ];
    expect([...desiredClassesFromMigrations(migrations)].sort()).toEqual(["A", "C"]);
  });
});

describe("convergeDoMigrations", () => {
  const configMigrations: DoMigrationStep[] = [
    { tag: "v1", new_sqlite_classes: ["Agent", "Stream", "Sandbox"] },
    { tag: "v2", new_sqlite_classes: ["Scheduler"] },
    { tag: "v3", new_sqlite_classes: ["Workspace"] },
    { tag: "v4", new_sqlite_classes: ["SandboxLite"], deleted_classes: ["Sandbox"] },
  ];
  // What the list nets out to: Agent, Stream, Scheduler, Workspace, SandboxLite.

  it("keeps the static list for a worker that never carried DOs (fresh env or reset placeholder)", () => {
    expect(convergeDoMigrations({ configMigrations, liveTag: null, liveClasses: [] })).toBeNull();
  });

  it("does nothing for apps without migrations", () => {
    expect(
      convergeDoMigrations({ configMigrations: [], liveTag: "v1", liveClasses: ["A"] }),
    ).toBeNull();
  });

  it("creates only the genuinely missing classes when a tag was renumbered (the preview-2 / PR #1747 wedge)", () => {
    // The slot was deployed when THIS branch's v3 meant the sandbox split;
    // after merging main (whose v3 is Workspace) the same tag names a
    // different step. Wrangler's own diff would replay "create SandboxLite"
    // onto live instances (API 10074). The converged diff sees SandboxLite
    // already exists and only creates what is actually absent.
    const result = convergeDoMigrations({
      configMigrations,
      liveTag: "v3",
      liveClasses: ["Agent", "Stream", "Scheduler", "SandboxLite"],
    });
    expect(result?.migrations).toHaveLength(2);
    expect(result?.migrations[0]).toEqual({ tag: "v3" });
    expect(result?.migrations[1].new_sqlite_classes).toEqual(["Workspace"]);
    expect(result?.migrations[1].deleted_classes).toBeUndefined();
  });

  it("tears down another branch's classes on a slot handover (unknown tag)", () => {
    const result = convergeDoMigrations({
      configMigrations,
      liveTag: "other-branch-v7",
      liveClasses: ["Agent", "Stream", "Scheduler", "Workspace", "SandboxLite", "Foreign"],
    });
    expect(result?.migrations[0]).toEqual({ tag: "other-branch-v7" });
    expect(result?.migrations[1].new_sqlite_classes).toBeUndefined();
    expect(result?.migrations[1].deleted_classes).toEqual(["Foreign"]);
  });

  it("emits a no-step list when the live classes already match", () => {
    const result = convergeDoMigrations({
      configMigrations,
      liveTag: "whatever-tag",
      liveClasses: ["Agent", "Stream", "Scheduler", "Workspace", "SandboxLite"],
    });
    expect(result?.migrations).toEqual([{ tag: "whatever-tag" }]);
  });

  it("adopts a tag when the script has classes but never got one", () => {
    const matching = convergeDoMigrations({
      configMigrations,
      liveTag: null,
      liveClasses: ["Agent", "Stream", "Scheduler", "Workspace", "SandboxLite"],
    });
    expect(matching?.migrations).toHaveLength(1);
    expect(matching?.migrations[0].new_sqlite_classes).toBeUndefined();

    const diverged = convergeDoMigrations({
      configMigrations,
      liveTag: null,
      liveClasses: ["Agent"],
    });
    // No live tag to anchor on: the single entry IS the full replay wrangler
    // will send, so it must contain exactly the diff.
    expect(diverged?.migrations).toHaveLength(1);
    expect(diverged?.migrations[0].new_sqlite_classes).toEqual([
      "SandboxLite",
      "Scheduler",
      "Stream",
      "Workspace",
    ]);
  });

  it("names sync tags deterministically by diff, never colliding with the live tag", () => {
    const inputs = {
      configMigrations,
      liveTag: "v3",
      liveClasses: ["Agent", "Stream", "Scheduler", "SandboxLite"],
    };
    const first = convergeDoMigrations(inputs);
    const second = convergeDoMigrations(inputs);
    expect(first?.migrations[1].tag).toEqual(second?.migrations[1].tag);
    expect(first?.migrations[1].tag).not.toEqual("v3");

    const differentDiff = convergeDoMigrations({ ...inputs, liveClasses: ["Agent"] });
    expect(differentDiff?.migrations[1].tag).not.toEqual(first?.migrations[1].tag);
  });
});
