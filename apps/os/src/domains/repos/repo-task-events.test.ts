import { describe, expect, it } from "vitest";
import {
  diffRepoTaskFiles,
  isRepoTaskMarkdownPath,
  repoArtifactPushFromEventPayload,
} from "./repo-task-events.ts";

describe("repo task change projection", () => {
  it("recognizes Markdown under any tasks directory", () => {
    expect(isRepoTaskMarkdownPath("tasks/root.md")).toBe(true);
    expect(isRepoTaskMarkdownPath("apps/os/tasks/ship.markdown")).toBe(true);
    expect(isRepoTaskMarkdownPath("apps/os/task/ship.md")).toBe(false);
    expect(isRepoTaskMarkdownPath("tasks/notes.txt")).toBe(false);
  });

  it("classifies created, updated, and deleted task files", () => {
    expect(
      diffRepoTaskFiles(
        {
          "tasks/deleted.md": "old",
          "tasks/unchanged.md": "same",
          "apps/os/tasks/updated.md": "before",
        },
        {
          "tasks/created.md": "new",
          "tasks/unchanged.md": "same",
          "apps/os/tasks/updated.md": "after",
        },
      ),
    ).toEqual([
      { kind: "updated", path: "apps/os/tasks/updated.md" },
      { kind: "created", path: "tasks/created.md" },
      { kind: "deleted", path: "tasks/deleted.md" },
    ]);
  });

  it("reads branch heads from Cloudflare Artifacts pushed events", () => {
    expect(
      repoArtifactPushFromEventPayload({
        artifactName: "repo",
        body: {
          type: "cf.artifacts.repo.pushed",
          payload: { ref: "refs/heads/main", before: "aaa", after: "bbb" },
        },
      }),
    ).toEqual({ afterCommitOid: "bbb", beforeCommitOid: "aaa", branch: "main" });
    expect(
      repoArtifactPushFromEventPayload({
        body: {
          type: "cf.artifacts.repo.pushed",
          payload: { ref: "refs/tags/v1", before: "aaa", after: "bbb" },
        },
      }),
    ).toBeNull();
  });
});
