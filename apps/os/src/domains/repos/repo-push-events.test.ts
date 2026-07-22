import { describe, expect, it } from "vitest";
import {
  repoArtifactPushFromEventPayload,
  repoGithubPushFromWebhookPayload,
} from "./repo-push-events.ts";

describe("repo push event projection", () => {
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
        body: { ref: "refs/heads/main", after: "abc123", repository: { id: 101 } },
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
        body: { ref: "refs/heads/main", after: "abc123", repository: { id: 101 } },
        delivery: { id: "delivery-1", name: "pull_request" },
        installationId: "789",
      }),
    ).toBeNull();
    expect(
      repoGithubPushFromWebhookPayload({
        body: {
          ref: "refs/heads/main",
          after: "0".repeat(40),
          repository: { id: 101 },
        },
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
