import { describe, expect, it } from "vitest";
import { githubFastForwardTransferDepth, githubSyncBaseCommitOid } from "./github-sync-utils.ts";

describe("githubFastForwardTransferDepth", () => {
  it("includes the previous Artifacts head after a multi-commit GitHub advance", () => {
    expect(githubFastForwardTransferDepth({ aheadBy: 4 })).toBe(5);
  });

  it("keeps a deeper operator-requested history window", () => {
    expect(githubFastForwardTransferDepth({ aheadBy: 2, requestedDepth: 20 })).toBe(20);
  });

  it("does not allow depth one to discard the before commit", () => {
    expect(githubFastForwardTransferDepth({ aheadBy: 1, requestedDepth: 1 })).toBe(2);
  });
});

describe("githubSyncBaseCommitOid", () => {
  it("uses the imported branch floor before a content-hash head is materialized", () => {
    expect(
      githubSyncBaseCommitOid({ cachedHeadCommitOid: null, pushedFloor: "imported-head" }),
    ).toBe("imported-head");
  });

  it("prefers a later materialized head", () => {
    expect(
      githubSyncBaseCommitOid({
        cachedHeadCommitOid: "materialized-head",
        pushedFloor: "imported-head",
      }),
    ).toBe("materialized-head");
  });
});
