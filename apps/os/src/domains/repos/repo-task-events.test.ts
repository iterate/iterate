import { describe, expect, it } from "vitest";
import {
  diffRepoTaskFiles,
  isRepoTaskMarkdownPath,
  repoArtifactPushFromEventPayload,
  repoGithubPushFromWebhookPayload,
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

  it("recognizes GitHub branch pushes without projecting commit facts", () => {
    expect(
      repoGithubPushFromWebhookPayload({
        associations: { repository: { id: 101 } },
        body: { ref: "refs/heads/main", after: "abc123" },
        delivery: { id: "delivery-1", name: "push" },
        installationId: "789",
      }),
    ).toEqual({
      afterCommitOid: "abc123",
      branch: "main",
      installationId: "789",
      repositoryId: 101,
    });
    expect(
      repoGithubPushFromWebhookPayload({
        associations: { repository: { id: 101 } },
        body: { ref: "refs/heads/main", after: "abc123" },
        delivery: { id: "delivery-1", name: "pull_request" },
        installationId: "789",
      }),
    ).toBeNull();
    expect(
      repoGithubPushFromWebhookPayload({
        associations: { repository: { id: 101 } },
        body: { ref: "refs/heads/main", after: "0".repeat(40) },
        delivery: { id: "delivery-1", name: "push" },
        installationId: "789",
      }),
    ).toBeNull();
    expect(
      repoGithubPushFromWebhookPayload({
        body: { ref: "refs/heads/main", after: "abc123" },
        delivery: { id: "delivery-1", name: "push" },
      }),
    ).toBeNull();
  });
});
