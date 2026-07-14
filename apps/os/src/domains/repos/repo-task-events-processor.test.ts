import { describe, expect, it, vi } from "vitest";
import {
  MemoryStream,
  MemoryStreamNetwork,
  deliverNewEvents,
} from "./github-agent-test-helpers.ts";
import type { RepoCommittedFileChange } from "./repo-task-events.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";

function newRepoProcessor(
  stream: MemoryStream,
  taskChangesForArtifactPush: (input: {
    afterCommitOid: string | null;
    beforeCommitOid: string | null;
    branch: string;
  }) => Promise<RepoCommittedFileChange[]>,
) {
  return new RepoProcessor({
    stream,
    path: "/repos/config",
    projectId: "prj_1",
    taskChangesForArtifactPush,
    createRepoArtifact: async () => {
      throw new Error("not under test");
    },
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
  it("projects default-branch task file changes into subscribable repo/task facts", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const taskChangesForArtifactPush = vi.fn(async () => [
      { kind: "created" as const, path: "tasks/new-task.md" },
      { kind: "updated" as const, path: "apps/os/tasks/board.markdown" },
      { kind: "deleted" as const, path: "packages/ui/tasks/old.md" },
    ]);
    const processor = newRepoProcessor(stream, taskChangesForArtifactPush);
    const cursors = new Map<object, number>();

    await stream.append(REPO_CREATED, artifactPush("main"));
    await deliverNewEvents({ cursors, processor, stream });
    await deliverNewEvents({ cursors, processor, stream });

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
      stream.events
        .filter((event) => event.type === "events.iterate.com/repo/commit-completed")
        .map((event) => event.payload),
    ).toEqual([{ beforeCommitOid: "before123", branch: "main", commitOid: "after456" }]);
    expect(taskChangesForArtifactPush).toHaveBeenCalledWith({
      afterCommitOid: "after456",
      beforeCommitOid: "before123",
      branch: "main",
    });
  });

  it("ignores pushes to non-default branches", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const taskChangesForArtifactPush = vi.fn(async () => []);
    const processor = newRepoProcessor(stream, taskChangesForArtifactPush);

    await stream.append(REPO_CREATED, artifactPush("feature"));
    await deliverNewEvents({ cursors: new Map(), processor, stream });

    expect(taskChangesForArtifactPush).not.toHaveBeenCalled();
    expect(
      stream.events.some((event) => event.type === "events.iterate.com/repo/commit-completed"),
    ).toBe(false);
  });

  it("is idempotent when a commit fact is refolded", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const taskChangesForArtifactPush = async () => [
      { kind: "created" as const, path: "tasks/new-task.md" },
    ];
    const processor = newRepoProcessor(stream, taskChangesForArtifactPush);
    const cursors = new Map<object, number>();

    await stream.append(REPO_CREATED, artifactPush("main"));
    await deliverNewEvents({ cursors, processor, stream });
    await deliverNewEvents({ cursors, processor, stream });
    const journalLength = stream.events.length;

    const refolded = newRepoProcessor(stream, taskChangesForArtifactPush);
    await deliverNewEvents({ cursors: new Map(), processor: refolded, stream });

    expect(stream.events).toHaveLength(journalLength);
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/repo/task-created"),
    ).toHaveLength(1);
  });
});
