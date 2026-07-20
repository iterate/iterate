import { describe, expect, it, vi } from "vitest";
import { StreamProcessorRunner } from "iterate/processors";
import { MemoryStream, MemoryStreamNetwork } from "iterate/processors/testing";
import type { RepoCommittedFileChange } from "./repo-task-events.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";

/** REAL runner drive (the production registry's driver): the GitHub-import
 * obligation launches from the runner's at-head `onCaughtUp` pass — exactly
 * as the repo DO's registry drives it. `runner.currentState` is the committed
 * fold; the processor instance's own checkpoint never advances under runner
 * drive. One `catchUp()` call is one delivery pass to the current head, the
 * same cadence the legacy `deliverNewEvents` cursor pull had. */
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
  observeArtifactPush: (input: {
    afterCommitOid: string | null;
    beforeCommitOid: string | null;
    branch: string;
  }) => void = () => {},
) {
  const processor = new RepoProcessor({
    stream,
    path: "/repos/config",
    projectId: "prj_1",
    observeArtifactPush,
    taskChangesForArtifactPush,
    syncFromGithubPush,
    createEmptyArtifact: async () => {
      throw new Error("not under test");
    },
    importPublicGithubArtifact: async () => {
      throw new Error("not under test");
    },
    linkGithub: async () => {
      throw new Error("not under test");
    },
    syncPrivateGithub: async () => {
      throw new Error("not under test");
    },
  });
  const runner = new StreamProcessorRunner({ processor, stream });
  return { processor, runner };
}

const REPO_CREATE_REQUESTED = {
  type: "events.iterate.com/repos/create-requested" as const,
  payload: { type: "empty" as const },
};

const REPO_CREATED = {
  type: "events.iterate.com/repos/created" as const,
  payload: {
    request: REPO_CREATE_REQUESTED.payload,
    artifactName: "artifact",
    defaultBranch: "main",
    remote: "https://example.com/repo.git",
  },
};

const GITHUB_LINK_CONFIGURED = {
  type: "events.iterate.com/repo/github-link-configured" as const,
  payload: {
    connection: "install-789",
    installationId: "789",
    owner: "acme",
    repo: "widgets",
    repositoryId: 101,
  },
};

function githubPush(input?: {
  connection?: string;
  installationId?: string;
  provenance?: boolean;
  repositoryId?: number;
  subscriptionKey?: string;
}) {
  const connection = input?.connection ?? "install-789";
  return {
    type: "events.iterate.com/github/webhook-received" as const,
    payload: {
      body: {
        ref: "refs/heads/main",
        before: "before123",
        after: "after456",
        repository: { id: input?.repositoryId ?? 101 },
      },
      delivery: { id: "delivery-1", name: "push" },
      installationId: input?.installationId ?? "789",
    },
    ...(input?.provenance === false
      ? {}
      : {
          source: {
            crossPostedFrom: [
              {
                subscriptionKey: input?.subscriptionKey ?? "github-repo:/repos/config",
                createdAt: "2026-07-17T12:00:00.000Z",
                offset: 12,
                path: `/integrations/github/${connection}`,
                projectId: "prj_1",
                type: "events.iterate.com/github/webhook-received",
              },
            ],
          },
        }),
  };
}

function artifactPush(branch: string, oids?: { after?: string; before?: string }) {
  return {
    type: "events.iterate.com/repo/cloudflare-artifact-event-received" as const,
    payload: {
      artifactName: "artifact",
      body: {
        type: "cf.artifacts.repo.pushed",
        payload: {
          ref: `refs/heads/${branch}`,
          before: oids?.before ?? "before123",
          after: oids?.after ?? "after456",
        },
      },
      cloudflareEventType: "cf.artifacts.repo.pushed",
      namespace: "os-prd-repos",
    },
  };
}

describe("RepoProcessor task change events", () => {
  it("throws when a second repo birth certificate is reduced", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const repo = newRepoProcessor(stream, async () => []);
    await stream.append(REPO_CREATE_REQUESTED, REPO_CREATED, REPO_CREATED);

    await expect(repo.runner.catchUp()).rejects.toThrow(
      "repo received more than one created event",
    );
  });

  it("imports connected GitHub main pushes and waits for the Artifacts queue to emit facts", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const syncFromGithubPush = vi.fn(async () => ({ commitOid: "github-head" }));
    const taskChangesForArtifactPush = vi.fn(async () => []);
    const repo = newRepoProcessor(stream, taskChangesForArtifactPush, syncFromGithubPush);

    await stream.append(REPO_CREATE_REQUESTED, REPO_CREATED, GITHUB_LINK_CONFIGURED, githubPush());
    await repo.runner.catchUp();

    expect(syncFromGithubPush).not.toHaveBeenCalled();
    expect(
      stream.events.some(
        (event) => event.type === "events.iterate.com/repo/github-import-requested",
      ),
    ).toBe(true);

    await repo.runner.catchUp();
    await vi.waitFor(() => expect(syncFromGithubPush).toHaveBeenCalledOnce());

    expect(syncFromGithubPush).toHaveBeenCalledOnce();
    expect(syncFromGithubPush).toHaveBeenCalledWith({
      afterCommitOid: "after456",
      branch: "main",
    });
    expect(taskChangesForArtifactPush).not.toHaveBeenCalled();
    expect(
      stream.events.some((event) => event.type === "events.iterate.com/repo/commit-completed"),
    ).toBe(false);

    await vi.waitFor(() =>
      expect(
        stream.events.some(
          (event) => event.type === "events.iterate.com/repo/github-import-completed",
        ),
      ).toBe(true),
    );
    await repo.runner.catchUp();
    expect(repo.runner.currentState.githubImport).toBeNull();

    // A full journal refold sees the terminal import fact and must not dial
    // GitHub again.
    const refoldSync = vi.fn(async () => {
      throw new Error("refold must not sync");
    });
    const refolded = newRepoProcessor(stream, taskChangesForArtifactPush, refoldSync);
    await refolded.runner.catchUp();
    expect(refoldSync).not.toHaveBeenCalled();
  });

  it.each([
    ["a direct unprovenanced event", { provenance: false }],
    ["the wrong connection", { connection: "install-other" }],
    ["the wrong installation", { installationId: "456" }],
    ["the wrong repository", { repositoryId: 202 }],
    ["the wrong subscription", { subscriptionKey: "userspace:other" }],
  ])("does not import %s", async (_case, webhookInput) => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const syncFromGithubPush = vi.fn(async () => ({ commitOid: "github-head" }));
    const repo = newRepoProcessor(stream, async () => [], syncFromGithubPush);

    await stream.append(
      REPO_CREATE_REQUESTED,
      REPO_CREATED,
      GITHUB_LINK_CONFIGURED,
      githubPush(webhookInput),
    );
    await repo.runner.catchUp();
    await repo.runner.catchUp();

    expect(syncFromGithubPush).not.toHaveBeenCalled();
    expect(
      stream.events.some(
        (event) => event.type === "events.iterate.com/repo/github-import-requested",
      ),
    ).toBe(false);
  });

  it("journals an import failure without pinning later repo events", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const syncFromGithubPush = vi.fn(async () => {
      throw new Error("GitHub and Artifacts diverged");
    });
    const taskChangesForArtifactPush = vi.fn(async () => []);
    const repo = newRepoProcessor(stream, taskChangesForArtifactPush, syncFromGithubPush);

    await stream.append(REPO_CREATE_REQUESTED, REPO_CREATED, GITHUB_LINK_CONFIGURED, githubPush());
    await repo.runner.catchUp();
    await repo.runner.catchUp();
    await vi.waitFor(() =>
      expect(
        stream.events.some(
          (event) => event.type === "events.iterate.com/repo/github-import-failed",
        ),
      ).toBe(true),
    );
    await repo.runner.catchUp();
    expect(repo.runner.currentState.githubImport).toBeNull();

    await stream.append(artifactPush("main"));
    await repo.runner.catchUp();
    await repo.runner.catchUp();

    expect(taskChangesForArtifactPush).toHaveBeenCalledWith({
      afterCommitOid: "after456",
      beforeCommitOid: "before123",
      branch: "main",
    });
    expect(
      stream.events.some((event) => event.type === "events.iterate.com/repo/commit-completed"),
    ).toBe(true);
  });

  it("re-drives an import whose running incarnation was evicted", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const syncFromGithubPush = vi.fn(async () => ({ commitOid: "current-github-head" }));
    const repo = newRepoProcessor(stream, async () => [], syncFromGithubPush);

    await stream.append(
      REPO_CREATE_REQUESTED,
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
    await repo.runner.catchUp();

    await vi.waitFor(() => expect(syncFromGithubPush).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        stream.events.some(
          (event) => event.type === "events.iterate.com/repo/github-import-completed",
        ),
      ).toBe(true),
    );
  });

  it("projects default-branch task file changes into subscribable repo/task facts", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const taskChangesForArtifactPush = vi.fn(async () => [
      { kind: "created" as const, path: "tasks/new-task.md" },
      { kind: "updated" as const, path: "apps/os/tasks/board.markdown" },
      { kind: "deleted" as const, path: "packages/ui/tasks/old.md" },
    ]);
    const repo = newRepoProcessor(stream, taskChangesForArtifactPush);

    await stream.append(REPO_CREATE_REQUESTED, REPO_CREATED, artifactPush("main"));
    await repo.runner.catchUp();
    await repo.runner.catchUp();

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
    const repo = newRepoProcessor(stream, taskChangesForArtifactPush);

    await stream.append(REPO_CREATE_REQUESTED, REPO_CREATED, artifactPush("feature"));
    await repo.runner.catchUp();

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
    const repo = newRepoProcessor(stream, taskChangesForArtifactPush);

    await stream.append(REPO_CREATE_REQUESTED, REPO_CREATED, artifactPush("main"));
    await repo.runner.catchUp();
    await repo.runner.catchUp();
    const journalLength = stream.events.length;

    const refolded = newRepoProcessor(stream, taskChangesForArtifactPush);
    await refolded.runner.catchUp();

    expect(stream.events).toHaveLength(journalLength);
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/repo/task-created"),
    ).toHaveLength(1);
  });

  it("observes every default-branch push — a ref DELETION invalidates despite appending no commit facts", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const observeArtifactPush = vi.fn();
    const repo = newRepoProcessor(stream, async () => [], undefined, observeArtifactPush);

    const zeroOid = "0".repeat(40);
    await stream.append(
      REPO_CREATE_REQUESTED,
      REPO_CREATED,
      artifactPush("main"),
      artifactPush("main", { after: zeroOid, before: "after456" }),
    );
    await repo.runner.catchUp();

    expect(observeArtifactPush).toHaveBeenCalledWith({
      afterCommitOid: "after456",
      beforeCommitOid: "before123",
      branch: "main",
    });
    expect(observeArtifactPush).toHaveBeenCalledWith({
      afterCommitOid: null,
      beforeCommitOid: "after456",
      branch: "main",
    });
    // The deletion produced no commit fact — only the live push did.
    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/repo/commit-completed"),
    ).toHaveLength(1);
  });

  it("never observes a push on a non-default branch", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const observeArtifactPush = vi.fn();
    const repo = newRepoProcessor(stream, async () => [], undefined, observeArtifactPush);

    await stream.append(REPO_CREATE_REQUESTED, REPO_CREATED, artifactPush("feature"));
    await repo.runner.catchUp();

    expect(observeArtifactPush).not.toHaveBeenCalled();
  });
});
