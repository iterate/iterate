import { describe, expect, it, test } from "vitest";
import type { StreamEvent, StreamEventInput } from "@iterate-com/streams/shared/event";
import { RepoStreamProcessor, type RepoStreamProcessorDeps } from "./repo-stream-processor.ts";

describe("Repo stream processor", () => {
  test("derives Repo state from events.iterate.com/repo/created", async () => {
    const { processor } = createProcessor();

    await processor.ingest({
      events: [
        {
          createdAt: "2026-05-11T12:00:00.000Z",
          offset: 1,
          payload: {
            defaultBranch: "main",
            remote: "https://git.cloudflare.com/artifacts/os/project--banana.git",
            slug: "banana",
            tokenExpiresAt: "2036-05-09T12:00:00.000Z",
          },
          type: "events.iterate.com/repo/created",
        },
      ],
      streamMaxOffset: 1,
    });

    expect(processor.state.repo).toEqual({
      defaultBranch: "main",
      remote: "https://git.cloudflare.com/artifacts/os/project--banana.git",
      slug: "banana",
      tokenExpiresAt: "2036-05-09T12:00:00.000Z",
    });
  });
});

const REPO_CREATED = {
  type: "events.iterate.com/repo/created",
  payload: {
    defaultBranch: "main",
    remote: "https://artifacts.example.com/repos/site",
    slug: "site",
    tokenExpiresAt: null,
  },
};

const REMOTE = {
  provider: "github" as const,
  account: "default",
  owner: "iterate",
  repo: "site",
  sync: { pull: "auto" as const, push: "manual" as const },
};

function pushBody(overrides: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    after: "abc1234def5678",
    repository: { full_name: "iterate/site", default_branch: "main" },
    commits: [{ added: ["src/new.ts"], modified: ["README.md"], removed: ["old.txt"] }],
    ...overrides,
  };
}

function pushEnvelope(body: unknown) {
  return {
    type: "events.iterate.com/integration/event-received",
    payload: {
      integration: "github",
      transport: "webhook" as const,
      routingKey: "installation:1234",
      account: "default",
      body,
    },
  };
}

describe("Repo stream processor remotes", () => {
  it("reacts to remote-configured by registering the route on the github account stream", async () => {
    const { appends, processor } = createProcessor();

    await ingest(processor, [
      REPO_CREATED,
      { type: "events.iterate.com/repo/remote-configured", payload: REMOTE },
    ]);

    expect(processor.state.remotes).toEqual({ "github:iterate/site": REMOTE });
    expect(appends).toEqual([
      {
        streamPath: "/integrations/github/default",
        event: {
          type: "events.iterate.com/github/repo-route-configured",
          idempotencyKey: "github-repo-route:github:iterate/site:site",
          payload: { fullName: "iterate/site", repoStreamPath: "/repos/site" },
        },
      },
    ]);
  });

  it("releases the prior account's route when the same repo is reconfigured onto another github account", async () => {
    const { appends, processor } = createProcessor();

    await ingest(processor, [
      REPO_CREATED,
      { type: "events.iterate.com/repo/remote-configured", payload: REMOTE },
      // Same owner/repo (the fold key), different github account.
      {
        type: "events.iterate.com/repo/remote-configured",
        payload: { ...REMOTE, account: "secondary" },
      },
    ]);

    // The route is released on the old account and registered on the new one,
    // so github-route stops forwarding this repo's webhooks from the old fold.
    const removed = appends.find(
      (entry) => entry.event.type === "events.iterate.com/github/repo-route-removed",
    );
    expect(removed).toEqual({
      streamPath: "/integrations/github/default",
      event: {
        type: "events.iterate.com/github/repo-route-removed",
        idempotencyKey: "github-repo-route-removed:github:iterate/site:site:default",
        payload: { fullName: "iterate/site", repoStreamPath: "/repos/site" },
      },
    });
    expect(
      appends.filter(
        (entry) =>
          entry.event.type === "events.iterate.com/github/repo-route-configured" &&
          entry.streamPath === "/integrations/github/secondary",
      ),
    ).toHaveLength(1);
  });

  it("turns a push to the mirrored branch into a sync request with NET file changes", async () => {
    const { appends, processor } = createProcessor();

    await ingest(processor, [
      REPO_CREATED,
      { type: "events.iterate.com/repo/remote-configured", payload: REMOTE },
      pushEnvelope(
        pushBody({
          commits: [
            { added: ["a.txt"], modified: [], removed: [] },
            // Later commit deletes a.txt — the net change is a delete.
            { added: ["b.txt"], modified: ["c.txt"], removed: ["a.txt"] },
          ],
        }),
      ),
    ]);

    const syncRequest = appends.find(
      (entry) => entry.event.type === "events.iterate.com/repo/remote-sync-requested",
    );
    expect(syncRequest?.event.payload).toEqual({
      remoteKey: "github:iterate/site",
      headSha: "abc1234def5678",
      changedPaths: [
        { path: "a.txt", change: "delete" },
        { path: "b.txt", change: "upsert" },
        { path: "c.txt", change: "upsert" },
      ],
    });
  });

  it("ignores pushes to other branches and to unlinked repositories", async () => {
    const { appends, processor } = createProcessor();

    await ingest(processor, [
      REPO_CREATED,
      { type: "events.iterate.com/repo/remote-configured", payload: REMOTE },
      pushEnvelope(pushBody({ ref: "refs/heads/feature-branch" })),
      pushEnvelope(
        pushBody({ repository: { full_name: "iterate/other", default_branch: "main" } }),
      ),
    ]);

    expect(
      appends.filter(
        (entry) => entry.event.type === "events.iterate.com/repo/remote-sync-requested",
      ),
    ).toEqual([]);
  });

  it("does not request syncs when the remote's pull policy is manual", async () => {
    const { appends, processor } = createProcessor();

    await ingest(processor, [
      REPO_CREATED,
      {
        type: "events.iterate.com/repo/remote-configured",
        payload: { ...REMOTE, sync: { pull: "manual", push: "manual" } },
      },
      pushEnvelope(pushBody()),
    ]);

    expect(
      appends.filter(
        (entry) => entry.event.type === "events.iterate.com/repo/remote-sync-requested",
      ),
    ).toEqual([]);
  });

  it("reacts to a sync request by pulling through the host dep and journaling the outcome", async () => {
    const pulls: unknown[] = [];
    const { appends, processor } = createProcessor({
      pullFromGithub: async (input) => {
        pulls.push(input);
        return { commitOid: "mirror-commit-1" };
      },
    });

    await ingest(processor, [
      REPO_CREATED,
      { type: "events.iterate.com/repo/remote-configured", payload: REMOTE },
      {
        type: "events.iterate.com/repo/remote-sync-requested",
        payload: {
          remoteKey: "github:iterate/site",
          headSha: "abc1234def5678",
          changedPaths: [{ path: "README.md", change: "upsert" }],
        },
      },
    ]);

    expect(pulls).toEqual([
      {
        remote: REMOTE,
        headSha: "abc1234def5678",
        changedPaths: [{ path: "README.md", change: "upsert" }],
      },
    ]);
    const synced = appends.find(
      (entry) => entry.event.type === "events.iterate.com/repo/remote-synced",
    );
    expect(synced?.event.payload).toMatchObject({
      remoteKey: "github:iterate/site",
      headSha: "abc1234def5678",
      commitOid: "mirror-commit-1",
    });
  });

  it("journals a sync FAILURE when the pull throws, and folds it into lastSync", async () => {
    const { appends, processor } = createProcessor({
      pullFromGithub: async () => {
        throw new Error("GitHub contents x.txt@abc: HTTP 404");
      },
    });

    await ingest(processor, [
      REPO_CREATED,
      { type: "events.iterate.com/repo/remote-configured", payload: REMOTE },
      {
        type: "events.iterate.com/repo/remote-sync-requested",
        payload: {
          remoteKey: "github:iterate/site",
          headSha: "abc1234def5678",
          changedPaths: [{ path: "x.txt", change: "upsert" }],
        },
      },
    ]);

    const failed = appends.find(
      (entry) => entry.event.type === "events.iterate.com/repo/remote-sync-failed",
    );
    expect(failed?.event.payload).toMatchObject({
      remoteKey: "github:iterate/site",
      reason: "GitHub contents x.txt@abc: HTTP 404",
    });

    // Folding the failure fact updates lastSync.
    await ingest(processor, [{ ...failed!.event, type: failed!.event.type }], { startOffset: 10 });
    expect(processor.state.lastSync).toMatchObject({ status: "failed" });
  });
});

function createProcessor(deps: Partial<RepoStreamProcessorDeps> = {}) {
  const appends: Array<{ streamPath?: string; event: StreamEventInput }> = [];
  const processor = new RepoStreamProcessor({
    iterateContext: {
      stream: {
        append: async (input: { streamPath?: string; event: StreamEventInput }) => {
          appends.push(input);
          return committedEvent({ ...input.event, offset: 0 });
        },
        appendBatch: async ({ events }: { events: StreamEventInput[] }) =>
          events.map((event) => committedEvent({ ...event, offset: 0 })),
      },
    },
    ...deps,
  });
  return { appends, processor };
}

async function ingest(
  processor: RepoStreamProcessor,
  events: Array<{ type: string; payload?: unknown }>,
  options: { startOffset?: number } = {},
) {
  const startOffset = options.startOffset ?? 1;
  const committed = events.map((event, index) =>
    committedEvent({ ...event, offset: startOffset + index }),
  );
  await processor.ingest({
    events: committed,
    streamMaxOffset: startOffset + events.length - 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function committedEvent(args: {
  type: string;
  payload?: unknown;
  idempotencyKey?: string;
  offset: number;
}): StreamEvent {
  return {
    type: args.type,
    payload: args.payload,
    ...(args.idempotencyKey == null ? {} : { idempotencyKey: args.idempotencyKey }),
    offset: args.offset,
    createdAt: "2026-06-11T00:00:00.000Z",
  };
}
