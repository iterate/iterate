import { describe, expect, test } from "vitest";
import { withDocumentExtension, workspaceFileKind } from "./file-kinds.ts";

describe("workspace file kinds", () => {
  test.each([
    ["docs/plan.md", { kind: "document" }],
    ["page.HTML", { kind: "document" }],
    ["worker.ts", { kind: "text", language: "typescript" }],
    ["tsconfig.base.json", { kind: "text", language: "jsonc" }],
    ["Dockerfile", { kind: "text", language: "text" }],
    ["logo.png", { kind: "opaque" }],
  ])("%s → %j", (path, kind) => {
    expect(workspaceFileKind(path)).toEqual(kind);
  });

  test.each([
    ["review", "review.md"],
    ["review.md", "review.md"],
    ["page.html", "page.html"],
    ["notes/2026", "notes/2026.md"],
    ["worker.ts", "worker.ts"],
    ["src/config.json", "src/config.json"],
    [".env", ".env"],
  ])("%s is named %s", (typed, becomes) => {
    expect(withDocumentExtension(typed)).toBe(becomes);
  });
});
