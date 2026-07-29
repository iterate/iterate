import { describe, expect, test } from "vitest";
import { requireDocumentPath, requireWorkspacePath } from "./rpc-api.ts";

describe("Docs deep-link paths", () => {
  test("accepts canonical workspace and document paths", () => {
    expect(requireWorkspacePath("/workspaces/agents/reviewer")).toBe("/workspaces/agents/reviewer");
    expect(requireDocumentPath("/reviews/launch-plan.markdown")).toBe(
      "/reviews/launch-plan.markdown",
    );
    expect(requireDocumentPath("/generated/report.html")).toBe("/generated/report.html");
  });

  test.each([
    "/agents/reviewer",
    "/workspaces/agents/../reviewer",
    "/workspaces//reviewer",
    "/workspaces/reviewer/",
  ])("rejects non-canonical workspace path %s", (path) => {
    expect(() => requireWorkspacePath(path)).toThrow("invalid workspace path");
  });

  test.each(["plan.md", "/plan.txt", "/a/../plan.md", "/folder/"])(
    "rejects unsupported document path %s",
    (path) => {
      expect(() => requireDocumentPath(path)).toThrow();
    },
  );
});
