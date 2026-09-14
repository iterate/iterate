import { describe, expect, test } from "vitest";
import { requireDocumentPath, requireWorkspacePath } from "./config-bridge.ts";
import { resolveDocumentPath } from "./rpc-api.ts";

describe("Docs deep-link paths", () => {
  test("accepts canonical workspace and document paths", () => {
    expect(requireWorkspacePath("/agents/reviewer")).toBe("/agents/reviewer");
    expect(requireDocumentPath("review.md")).toBe("review.md");
    expect(requireDocumentPath("reviews/launch-plan.markdown")).toBe(
      "reviews/launch-plan.markdown",
    );
    expect(requireDocumentPath("/workspace/review.md")).toBe("/workspace/review.md");
    expect(requireDocumentPath("/repos/config/docs/report.html")).toBe(
      "/repos/config/docs/report.html",
    );
  });

  test("joins relative document paths onto the workspace and keeps absolute paths verbatim", () => {
    expect(resolveDocumentPath("review.md")).toBe("/workspace/review.md");
    expect(resolveDocumentPath("reviews/launch-plan.md")).toBe("/workspace/reviews/launch-plan.md");
    expect(resolveDocumentPath("/repos/config/docs/plan.md")).toBe("/repos/config/docs/plan.md");
  });

  test.each(["/agents", "/agents/../reviewer", "/workspaces//reviewer", "/workspaces/reviewer/"])(
    "rejects non-canonical workspace path %s",
    (path) => {
      expect(() => requireWorkspacePath(path)).toThrow("invalid workspace path");
    },
  );

  test.each([
    "",
    "plan.txt",
    "/plan.txt",
    "../plan.md",
    "./plan.md",
    "a/../plan.md",
    "/a/../plan.md",
    "a//b.md",
    "/folder/",
    "folder/",
    // Absolute paths must be fully qualified stream paths — a bare
    // "/review.md" would dead-end on the workspace write guard later.
    "/review.md",
    "/notes/review.md",
    "/agents/reviewer/review.md",
    "/workspaces/scratch/x1/review.md",
  ])("rejects unsupported document path %s", (path) => {
    expect(() => requireDocumentPath(path)).toThrow();
  });
});
