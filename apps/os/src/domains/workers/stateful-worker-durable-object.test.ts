import { describe, expect, it } from "vitest";
import { canCommitStaleFacetRefresh } from "./stateful-worker-durable-object.ts";

describe("stale facet refresh ownership", () => {
  it("does not abort a facet mounted by cache-miss recovery while the refresh awaited", () => {
    expect(
      canCommitStaleFacetRefresh({
        currentVersion: "v2",
        previousVersion: "v1",
        resolvedVersion: "v2",
      }),
    ).toBe(false);
  });

  it("commits only a changed version while its original marker is still current", () => {
    expect(
      canCommitStaleFacetRefresh({
        currentVersion: "v1",
        previousVersion: "v1",
        resolvedVersion: "v2",
      }),
    ).toBe(true);
    expect(
      canCommitStaleFacetRefresh({
        currentVersion: "v1",
        previousVersion: "v1",
        resolvedVersion: "v1",
      }),
    ).toBe(false);
  });
});
