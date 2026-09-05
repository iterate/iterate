import { describe, expect, test } from "vitest";
import {
  isJamWorkspacePath,
  jamAgentPath,
  jamDocumentPath,
  jamInvitation,
  jamWorkspacePath,
  withDocumentExtension,
} from "./jam.ts";

describe("jam naming", () => {
  test("a jam id names its workspace, seed document, and agent", () => {
    expect(jamWorkspacePath("20260904-1230-ab12")).toBe("/workspaces/scratch/20260904-1230-ab12");
    expect(jamDocumentPath("20260904-1230-ab12")).toBe("/repos/config/jams/20260904-1230-ab12.md");
    expect(jamAgentPath("/workspaces/scratch/20260904-1230-ab12")).toBe(
      "/agents/jams/20260904-1230-ab12",
    );
  });

  test.each([
    { workspacePath: "/workspaces/scratch/abc", becomes: true },
    { workspacePath: "/workspaces/agents/reviewer", becomes: false },
    { workspacePath: "/workspaces/tasks/b1~repos--config-1234abcd", becomes: false },
  ])("$workspacePath is a jam workspace: $becomes", ({ workspacePath, becomes }) => {
    expect(isJamWorkspacePath(workspacePath)).toBe(becomes);
    expect(jamAgentPath(workspacePath) !== null).toBe(becomes);
  });

  test("an agent path never carries a nested or exotic jam id", () => {
    expect(jamAgentPath("/workspaces/scratch/a/b")).toBeNull();
    expect(jamAgentPath("/workspaces/scratch/.hidden")).toBeNull();
  });
});

describe("document names", () => {
  test.each([
    { typed: "ideas", becomes: "ideas.md" },
    { typed: "ideas.md", becomes: "ideas.md" },
    { typed: "plan.markdown", becomes: "plan.markdown" },
    { typed: "page.html", becomes: "page.html" },
    { typed: "notes/2026", becomes: "notes/2026.md" },
  ])("$typed → $becomes", ({ typed, becomes }) => {
    expect(withDocumentExtension(typed)).toBe(becomes);
  });
});

describe("invitation", () => {
  test("names the workspace, the open file, and forbids committing", () => {
    const text = jamInvitation("/workspaces/scratch/x1", "/repos/config/jams/x1.md");
    expect(text).toContain('itx.workspaces.get("/workspaces/scratch/x1")');
    expect(text).toContain("The file open right now is /repos/config/jams/x1.md");
    expect(text).toContain("must not commit");
  });

  test("without an open file, points at listing the workspace", () => {
    expect(jamInvitation("/workspaces/scratch/x1", null)).toContain("Nobody has a file open yet");
  });
});
