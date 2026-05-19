import { describe, expect, test } from "vitest";
import {
  CF_EVENT_TYPES,
  CF_TO_GLOBAL_REPOS_TYPE,
  CF_TO_REPO_STREAM_TYPE,
  CfArtifactEvent,
  REPO_ARTIFACT_CREATED_TYPE,
  REPO_ARTIFACT_DELETED_TYPE,
  REPO_ARTIFACT_FORKED_TYPE,
  REPO_ARTIFACT_IMPORTED_TYPE,
  REPO_CLONED_TYPE,
  REPO_FETCHED_TYPE,
  REPO_PUSHED_TYPE,
  deriveArtifactNameFromEvent,
  parseArtifactName,
} from "./artifact-event-types.ts";

describe("parseArtifactName", () => {
  test("parses valid artifact name", () => {
    expect(parseArtifactName("proj-123--my-repo")).toEqual({
      projectId: "proj-123",
      repoSlug: "my-repo",
    });
  });

  test("handles project IDs with dashes", () => {
    expect(parseArtifactName("some-long-project-id--config-base")).toEqual({
      projectId: "some-long-project-id",
      repoSlug: "config-base",
    });
  });

  test("returns null for names without separator", () => {
    expect(parseArtifactName("no-separator-here")).toBeNull();
  });

  test("returns null for empty parts", () => {
    expect(parseArtifactName("--slug")).toBeNull();
    expect(parseArtifactName("project--")).toBeNull();
  });
});

describe("deriveArtifactNameFromEvent", () => {
  test("extracts repo_name from source", () => {
    const event: CfArtifactEvent = {
      type: CF_EVENT_TYPES.PUSHED,
      source: { type: "artifacts.repo", namespace: "ns", repo_name: "proj--repo" },
      payload: {},
    };
    expect(deriveArtifactNameFromEvent(event)).toBe("proj--repo");
  });

  test("extracts camelCase repoName from source", () => {
    const event: CfArtifactEvent = {
      type: CF_EVENT_TYPES.REPO_FORKED,
      source: { type: "artifacts", repoName: "proj--repo" },
      payload: {},
    };
    expect(deriveArtifactNameFromEvent(event)).toBe("proj--repo");
  });

  test("prefers repo_name over repoName", () => {
    const event: CfArtifactEvent = {
      type: CF_EVENT_TYPES.PUSHED,
      source: { type: "artifacts.repo", repo_name: "snake--case", repoName: "camel--case" },
      payload: {},
    };
    expect(deriveArtifactNameFromEvent(event)).toBe("snake--case");
  });

  test("returns null when source is missing", () => {
    const event: CfArtifactEvent = {
      type: CF_EVENT_TYPES.PUSHED,
      payload: {},
    };
    expect(deriveArtifactNameFromEvent(event)).toBeNull();
  });

  test("returns null when repo_name and repoName are both missing", () => {
    const event: CfArtifactEvent = {
      type: CF_EVENT_TYPES.PUSHED,
      source: { type: "artifacts.repo" },
      payload: {},
    };
    expect(deriveArtifactNameFromEvent(event)).toBeNull();
  });
});

describe("CfArtifactEvent schema", () => {
  test("parses a pushed event", () => {
    const result = CfArtifactEvent.safeParse({
      type: "cf.artifacts.pushed",
      source: { type: "artifacts.repo", namespace: "ns", repo_name: "proj--repo" },
      payload: {
        ref: "refs/heads/main",
        before: "abc123",
        after: "def456",
        commits: [],
        totalCommitsCount: 0,
      },
      metadata: {
        accountId: "acct-1",
        eventSubscriptionId: "sub-1",
        eventSchemaVersion: "1.0",
        eventTimestamp: "2026-05-19T00:00:00Z",
      },
    });
    expect(result.success).toBe(true);
  });

  test("parses a repo.created event", () => {
    const result = CfArtifactEvent.safeParse({
      type: "cf.artifacts.repo.created",
      source: { type: "artifacts" },
      payload: {
        repoId: "abc",
        defaultBranch: "main",
        description: "test",
        readOnly: false,
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing type", () => {
    const result = CfArtifactEvent.safeParse({ payload: {} });
    expect(result.success).toBe(false);
  });
});

describe("event type mappings", () => {
  test("repo-level CF types map to iterate event types", () => {
    expect(CF_TO_REPO_STREAM_TYPE[CF_EVENT_TYPES.PUSHED]).toBe(REPO_PUSHED_TYPE);
    expect(CF_TO_REPO_STREAM_TYPE[CF_EVENT_TYPES.CLONED]).toBe(REPO_CLONED_TYPE);
    expect(CF_TO_REPO_STREAM_TYPE[CF_EVENT_TYPES.FETCHED]).toBe(REPO_FETCHED_TYPE);
  });

  test("account-level CF types map to iterate event types", () => {
    expect(CF_TO_GLOBAL_REPOS_TYPE[CF_EVENT_TYPES.REPO_CREATED]).toBe(REPO_ARTIFACT_CREATED_TYPE);
    expect(CF_TO_GLOBAL_REPOS_TYPE[CF_EVENT_TYPES.REPO_DELETED]).toBe(REPO_ARTIFACT_DELETED_TYPE);
    expect(CF_TO_GLOBAL_REPOS_TYPE[CF_EVENT_TYPES.REPO_FORKED]).toBe(REPO_ARTIFACT_FORKED_TYPE);
    expect(CF_TO_GLOBAL_REPOS_TYPE[CF_EVENT_TYPES.REPO_IMPORTED]).toBe(REPO_ARTIFACT_IMPORTED_TYPE);
  });
});
