import { describe, expect, test, vi } from "vitest";
import { eventsOfType, makeProcessorHarness, type MemoryStream } from "../streams/test-helpers.ts";
import { GITHUB_LINK, webhookPayload } from "./github-agent-test-helpers.ts";
import type { RepoCommittedFileChange } from "./repo-task-events.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";

function newRepoProcessor(
  stream: MemoryStream,
  taskChangesForArtifactPush: (input: {
    afterCommitOid: string | null;
    beforeCommitOid: string | null;
    branch: string;
  }) => Promise<RepoCommittedFileChange[]>,
  syncFromGithubPush: (input: {
    afterCommitOid: string;
    branch: string;
  }) => Promise<{ commitOid: string }> = async () => ({ commitOid: "github-head" }),
) {
  return new RepoProcessor({
    stream,
    path: "/repos/config",
    projectId: "prj_1",
    taskChangesForArtifactPush,
    syncFromGithubPush,
    createRepoArtifact: async () => {
      throw new Error("not under test");
    },
  });
}

/** The suite preamble: the canonical harness (epoch-pinned clock, like the
 * repo/GitHub suites) building a RepoProcessor over /repos/config. */
function repoHarness(
  taskChangesForArtifactPush: Parameters<typeof newRepoProcessor>[1],
  syncFromGithubPush?: Parameters<typeof newRepoProcessor>[2],
) {
  return makeProcessorHarness({
    build: ({ stream }) => newRepoProcessor(stream, taskChangesForArtifactPush, syncFromGithubPush),
    now: () => 0,
    path: "/repos/config",
  });
}

const REPO_CREATED = {
  type: "events.iterate.com/repo/created" as const,
  payload: {
    artifactName: "artifact",
    defaultBranch: "main",
    path: "/repos/config",
    projectId: "prj_1",
    remote: "https://example.com/repo.git",
  },
};

const GITHUB_LINK_CONFIGURED = {
  type: "events.iterate.com/repo/github-link-configured" as const,
  payload: GITHUB_LINK,
};

function artifactPush(branch: string) {
  return {
    type: "events.iterate.com/repo/cloudflare-artifact-event-received" as const,
    payload: {
      artifactName: "artifact",
      body: {
        type: "cf.artifacts.repo.pushed",
        payload: { ref: `refs/heads/${branch}`, before: "before123", after: "after456" },
      },
      cloudflareEventType: "cf.artifacts.repo.pushed",
      namespace: "os-prd-repos",
    },
  };
}

describe("RepoProcessor task change events", () => {
  test("imports connected GitHub main pushes and waits for the Artifacts queue to emit facts", async () => {
    const syncFromGithubPush = vi.fn(async () => ({ commitOid: "github-head" }));
    const taskChangesForArtifactPush = vi.fn(async () => []);
    const { deliver, processor, stream } = repoHarness(
      taskChangesForArtifactPush,
      syncFromGithubPush,
    );

    await stream.append(REPO_CREATED, GITHUB_LINK_CONFIGURED, {
      type: "events.iterate.com/github/webhook-received",
      payload: webhookPayload(
        { ref: "refs/heads/main", before: "before123", after: "after456" },
        "push",
      ),
    });
    await deliver();

    expect(syncFromGithubPush).not.toHaveBeenCalled();
    expect(
      eventsOfType(stream, "events.iterate.com/repo/github-import-requested"),
    ).not.toHaveLength(0);

    await deliver();
    await vi.waitFor(() => expect(syncFromGithubPush).toHaveBeenCalledOnce());

    expect(syncFromGithubPush).toHaveBeenCalledOnce();
    expect(syncFromGithubPush).toHaveBeenCalledWith({
      afterCommitOid: "after456",
      branch: "main",
    });
    expect(taskChangesForArtifactPush).not.toHaveBeenCalled();
    expect(eventsOfType(stream, "events.iterate.com/repo/commit-completed")).toHaveLength(0);

    await vi.waitFor(() =>
      expect(
        eventsOfType(stream, "events.iterate.com/repo/github-import-completed"),
      ).not.toHaveLength(0),
    );
    await deliver();
    expect(processor.state.githubImport).toBeNull();

    // A full journal refold sees the terminal import fact and must not dial
    // GitHub again.
    const refoldSync = vi.fn(async () => {
      throw new Error("refold must not sync");
    });
    const refolded = newRepoProcessor(stream, taskChangesForArtifactPush, refoldSync);
    await deliver(refolded);
    expect(refoldSync).not.toHaveBeenCalled();
  });

  test("journals an import failure without pinning later repo events", async () => {
    const syncFromGithubPush = vi.fn(async () => {
      throw new Error("GitHub and Artifacts diverged");
    });
    const taskChangesForArtifactPush = vi.fn(async () => []);
    const { deliver, processor, stream } = repoHarness(
      taskChangesForArtifactPush,
      syncFromGithubPush,
    );

    await stream.append(REPO_CREATED, GITHUB_LINK_CONFIGURED, {
      type: "events.iterate.com/github/webhook-received",
      payload: webhookPayload(
        { ref: "refs/heads/main", before: "before123", after: "after456" },
        "push",
      ),
    });
    await deliver();
    await deliver();
    await vi.waitFor(() =>
      expect(eventsOfType(stream, "events.iterate.com/repo/github-import-failed")).not.toHaveLength(
        0,
      ),
    );
    await deliver();
    expect(processor.state.githubImport).toBeNull();

    await stream.append(artifactPush("main"));
    await deliver();
    await deliver();

    expect(taskChangesForArtifactPush).toHaveBeenCalledWith({
      afterCommitOid: "after456",
      beforeCommitOid: "before123",
      branch: "main",
    });
    expect(eventsOfType(stream, "events.iterate.com/repo/commit-completed")).not.toHaveLength(0);
  });

  test("re-drives an import whose running incarnation was evicted", async () => {
    const syncFromGithubPush = vi.fn(async () => ({ commitOid: "current-github-head" }));
    const { deliver, stream } = repoHarness(async () => [], syncFromGithubPush);

    await stream.append(
      REPO_CREATED,
      GITHUB_LINK_CONFIGURED,
      {
        type: "events.iterate.com/repo/github-import-requested",
        payload: {
          branch: "main",
          requestId: "/repos/config:42",
          requestedCommitOid: "requested-head",
        },
      },
      {
        type: "events.iterate.com/repo/github-import-started",
        payload: {
          branch: "main",
          requestId: "/repos/config:42",
          requestedCommitOid: "requested-head",
        },
      },
    );
    await deliver();

    await vi.waitFor(() => expect(syncFromGithubPush).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        eventsOfType(stream, "events.iterate.com/repo/github-import-completed"),
      ).not.toHaveLength(0),
    );
  });

  test("projects default-branch task file changes into subscribable repo/task facts", async () => {
    const taskChangesForArtifactPush = vi.fn(async () => [
      { kind: "created" as const, path: "tasks/new-task.md" },
      { kind: "updated" as const, path: "apps/os/tasks/board.markdown" },
      { kind: "deleted" as const, path: "packages/ui/tasks/old.md" },
    ]);
    const { deliver, stream } = repoHarness(taskChangesForArtifactPush);

    await stream.append(REPO_CREATED, artifactPush("main"));
    await deliver();
    await deliver();

    expect(
      stream.events
        .filter((event) => event.type.startsWith("events.iterate.com/repo/task-"))
        .map((event) => ({ type: event.type, payload: event.payload })),
    ).toEqual([
      {
        type: "events.iterate.com/repo/task-created",
        payload: { branch: "main", commitOid: "after456", path: "tasks/new-task.md" },
      },
      {
        type: "events.iterate.com/repo/task-updated",
        payload: {
          branch: "main",
          commitOid: "after456",
          path: "apps/os/tasks/board.markdown",
        },
      },
      {
        type: "events.iterate.com/repo/task-deleted",
        payload: { branch: "main", commitOid: "after456", path: "packages/ui/tasks/old.md" },
      },
    ]);
    expect(
      eventsOfType(stream, "events.iterate.com/repo/commit-completed").map(
        (event) => event.payload,
      ),
    ).toEqual([{ beforeCommitOid: "before123", branch: "main", commitOid: "after456" }]);
    expect(taskChangesForArtifactPush).toHaveBeenCalledWith({
      afterCommitOid: "after456",
      beforeCommitOid: "before123",
      branch: "main",
    });
  });

  test("ignores pushes to non-default branches", async () => {
    const taskChangesForArtifactPush = vi.fn(async () => []);
    const { deliver, stream } = repoHarness(taskChangesForArtifactPush);

    await stream.append(REPO_CREATED, artifactPush("feature"));
    await deliver();

    expect(taskChangesForArtifactPush).not.toHaveBeenCalled();
    expect(eventsOfType(stream, "events.iterate.com/repo/commit-completed")).toHaveLength(0);
  });

  test("is idempotent when a commit fact is refolded", async () => {
    const taskChangesForArtifactPush = async () => [
      { kind: "created" as const, path: "tasks/new-task.md" },
    ];
    const { deliver, stream } = repoHarness(taskChangesForArtifactPush);

    await stream.append(REPO_CREATED, artifactPush("main"));
    await deliver();
    await deliver();
    const journalLength = stream.events.length;

    const refolded = newRepoProcessor(stream, taskChangesForArtifactPush);
    await deliver(refolded);

    expect(stream.events).toHaveLength(journalLength);
    expect(eventsOfType(stream, "events.iterate.com/repo/task-created")).toHaveLength(1);
  });
});
