// The repo processor's executable spec, as step scenarios on the generic
// harness (makeProcessorHarness from iterate/processors/testing): the REAL
// StreamProcessorRunner over the shared MemoryStream (production idempotency
// semantics: a same-key append with a different body is REJECTED), virtual
// time, and eviction-faithful crash(). The home stream lives inside a
// MemoryStreamNetwork so the catalog cross-post onto the project root stream
// "/" is observable. The four vendor deps (artifact seed, GitHub sync, task
// diff, branch-head cache) are scriptable fakes wired in createProcessor —
// swap `impl` mid-scenario or across crashes; `calls` records every dial.
//
// The registry-level recovery suite (fake DurableObjectState, REAL registry +
// keepalive alarm) lives in repo-recovery.test.ts.

import { describe, expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStreamNetwork,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import type { RepoCommittedFileChange } from "./repo-task-events.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";

type RepoEventInput = ConsumedInput<RepoProcessorContract>;

const REPO_PATH = "/repos/config";
// The harness names every processor's project "proj_harness" — the webhook
// provenance guard compares against it.
const PROJECT_ID = "proj_harness";

const SEEDED_ARTIFACT = {
  artifactName: "proj_harness--L3JlcG9zL2NvbmZpZw",
  defaultBranch: "main",
  remote: "https://example.artifacts.cloudflare.net/git/ns/proj_harness--L3JlcG9zL2NvbmZpZw.git",
};

const REPO_CREATED = {
  type: "events.iterate.com/repo/created",
  payload: { config: {} },
} satisfies RepoEventInput;

const GITHUB_LINK_CONFIGURED = {
  type: "events.iterate.com/repo/github-link-configured",
  payload: {
    connection: "install-789",
    installationId: "789",
    owner: "acme",
    repo: "widgets",
    repositoryId: 101,
  },
} satisfies RepoEventInput;

const REVIVED = {
  type: "events.iterate.com/stream/processor-revived",
  payload: { processorSlug: "repo", revivals: 1, version: "test" },
} satisfies RepoEventInput;

/** A GitHub push delivery as the connection stream cross-posts it. Event
 * BUILDER (data), not an append wrapper — the overrides produce the
 * wrong-provenance variants. */
function githubPush(input?: {
  connection?: string;
  installationId?: string;
  provenance?: boolean;
  repositoryId?: number;
  subscriptionKey?: string;
}): RepoEventInput {
  const connection = input?.connection ?? "install-789";
  return {
    type: "events.iterate.com/github/webhook-received",
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
                subscriptionKey: input?.subscriptionKey ?? `github-repo:${REPO_PATH}`,
                createdAt: "2026-07-17T12:00:00.000Z",
                offset: 12,
                path: `/integrations/github/${connection}`,
                projectId: PROJECT_ID,
                type: "events.iterate.com/github/webhook-received",
              },
            ],
          },
        }),
  };
}

/** A Cloudflare Artifacts pushed event as the queue router captures it. */
function artifactPush(branch: string, oids?: { after?: string; before?: string }): RepoEventInput {
  return {
    type: "events.iterate.com/repo/cloudflare-artifact-event-received",
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

/** The generic harness over a MemoryStreamNetwork (so the catalog cross-post
 * to "/" lands somewhere observable) plus the repo's scriptable vendor fakes.
 * Pass another harness's substrate for a replay incarnation over the SAME
 * stream. */
function makeRepoHarness(substrate?: HarnessSubstrate) {
  if (substrate === undefined) {
    const clock = { now: Date.parse("2026-07-20T12:00:00Z") };
    const network = new MemoryStreamNetwork(() => clock.now);
    substrate = { clock, stream: network.get(REPO_PATH), progress: makeMemoryProgressStore() };
  }
  const artifactSeed = {
    calls: [] as { path: string; projectId: string | null }[],
    impl: async (): Promise<typeof SEEDED_ARTIFACT> => SEEDED_ARTIFACT,
  };
  const githubSync = {
    calls: [] as { afterCommitOid: string; branch: string }[],
    impl: async (): Promise<{ commitOid: string }> => ({ commitOid: "github-head" }),
  };
  const taskDiff = {
    calls: [] as {
      afterCommitOid: string | null;
      beforeCommitOid: string | null;
      branch: string;
    }[],
    impl: async (): Promise<RepoCommittedFileChange[]> => [],
  };
  const headCache = {
    observed: [] as {
      afterCommitOid: string | null;
      beforeCommitOid: string | null;
      branch: string;
    }[],
  };
  const harness = makeProcessorHarness<RepoProcessorContract>({
    createProcessor: (deps) =>
      new RepoProcessor({
        stream: deps.stream,
        path: deps.path,
        projectId: deps.projectId,
        createRepoArtifact: (input) => {
          artifactSeed.calls.push(input);
          return artifactSeed.impl();
        },
        syncFromGithubPush: (input) => {
          githubSync.calls.push(input);
          return githubSync.impl();
        },
        taskChangesForArtifactPush: (input) => {
          taskDiff.calls.push(input);
          return taskDiff.impl();
        },
        observeArtifactPush: (input) => void headCache.observed.push(input),
      }),
    substrate,
  });
  const network = harness.stream.network!;
  return {
    ...harness,
    network,
    artifactSeed,
    githubSync,
    taskDiff,
    headCache,
    catalog: () => network.eventsAt("/"),
  };
}

// =============================================================================
// Birth: the artifact-seed obligation and the catalog cross-post
// =============================================================================

describe("RepoProcessor birth", () => {
  it("seeds the backing artifact once at head, records repo/ready under the offset-free key, and cross-posts the created fact to the root catalog", async () => {
    const h = makeRepoHarness();
    await h.play(["append", REPO_CREATED]);

    // The seed ran exactly once even though later deliveries (the ready event
    // itself) re-ran the at-head pass over a state where ready already holds.
    expect(h.artifactSeed.calls).toEqual([{ path: REPO_PATH, projectId: PROJECT_ID }]);
    expect(h.events("events.iterate.com/repo/ready")).toMatchObject([
      {
        // NO event offset in the key: a redelivery/revival cannot rotate it
        // and re-seed.
        idempotencyKey: "repo/ready",
        payload: { ...SEEDED_ARTIFACT, path: REPO_PATH, projectId: PROJECT_ID },
      },
    ]);
    expect(h.state()).toMatchObject({
      birthCertificate: { config: {} },
      ready: true,
      defaultBranch: "main",
      artifactName: SEEDED_ARTIFACT.artifactName,
      remote: SEEDED_ARTIFACT.remote,
    });

    // The per-event consequence: the created fact re-appended onto "/", keyed
    // on the consumed event's coordinates so a redelivered frame dedupes.
    expect(h.catalog()).toMatchObject([
      {
        type: "events.iterate.com/repo/created",
        idempotencyKey: `repo/catalog-created@${REPO_PATH}:1`,
        payload: { config: {} },
      },
    ]);
  });

  it("a second created event is a no-op: the first birth certificate wins", async () => {
    const h = makeRepoHarness();
    await h.play(["append", REPO_CREATED]);
    const before = h.state();
    // Conflicting births are rejected at the create() door (same-key-
    // different-body); a duplicate that still reaches reduce must not wedge
    // the frame, and must not re-birth.
    await h.append(REPO_CREATED);
    expect(h.state()).toEqual(before);
  });
});

// =============================================================================
// Commit facts: Artifacts queue pushes → commit-completed → task facts
// =============================================================================

describe("RepoProcessor commit facts", () => {
  it("projects default-branch task file changes into subscribable repo/task facts", async () => {
    const h = makeRepoHarness();
    h.taskDiff.impl = async () => [
      { kind: "created", path: "tasks/new-task.md" },
      { kind: "updated", path: "apps/os/tasks/board.markdown" },
      { kind: "deleted", path: "packages/ui/tasks/old.md" },
    ];
    await h.play(["append", REPO_CREATED], ["append", artifactPush("main")]);

    expect(
      h
        .events()
        .filter((event) => event.type.startsWith("events.iterate.com/repo/task-"))
        .map((event) => ({ type: event.type, payload: event.payload })),
    ).toEqual([
      {
        type: "events.iterate.com/repo/task-created",
        payload: { branch: "main", commitOid: "after456", path: "tasks/new-task.md" },
      },
      {
        type: "events.iterate.com/repo/task-updated",
        payload: { branch: "main", commitOid: "after456", path: "apps/os/tasks/board.markdown" },
      },
      {
        type: "events.iterate.com/repo/task-deleted",
        payload: { branch: "main", commitOid: "after456", path: "packages/ui/tasks/old.md" },
      },
    ]);
    // ONE commit fact, keyed on the push coordinates (natural identity, no
    // synthetic ids), derived through the tree diff exactly once.
    expect(h.events("events.iterate.com/repo/commit-completed")).toMatchObject([
      {
        idempotencyKey: "repo/commit-completed:before123:after456:main",
        payload: { beforeCommitOid: "before123", branch: "main", commitOid: "after456" },
      },
    ]);
    expect(h.taskDiff.calls).toEqual([
      { afterCommitOid: "after456", beforeCommitOid: "before123", branch: "main" },
    ]);
  });

  it("ignores pushes to non-default branches: no head-cache poke, no commit fact, no tree diff", async () => {
    const h = makeRepoHarness();
    await h.play(["append", REPO_CREATED], ["append", artifactPush("feature")]);

    expect(h.headCache.observed).toEqual([]);
    expect(h.taskDiff.calls).toEqual([]);
    expect(h.events("events.iterate.com/repo/commit-completed")).toHaveLength(0);
  });

  it("observes every default-branch push — a ref DELETION invalidates the head cache despite appending no commit facts", async () => {
    const h = makeRepoHarness();
    const zeroOid = "0".repeat(40);
    await h.play(
      ["append", REPO_CREATED],
      [
        "append",
        artifactPush("main"),
        artifactPush("main", { after: zeroOid, before: "after456" }),
      ],
    );

    expect(h.headCache.observed).toEqual([
      { afterCommitOid: "after456", beforeCommitOid: "before123", branch: "main" },
      { afterCommitOid: null, beforeCommitOid: "after456", branch: "main" },
    ]);
    // The deletion produced no commit fact — only the live push did.
    expect(h.events("events.iterate.com/repo/commit-completed")).toHaveLength(1);
  });
});

// =============================================================================
// GitHub ingress: webhook → durable import obligation → idempotent sync
// =============================================================================

describe("RepoProcessor GitHub imports", () => {
  it("imports a linked default-branch push: webhook → requested → started → sync → completed; Artifacts stays the only source of commit facts", async () => {
    const h = makeRepoHarness();
    await h.play(["append", REPO_CREATED], ["append", GITHUB_LINK_CONFIGURED, githubPush()]);

    // The full obligation story is on the stream, in order.
    expect(h.events("events.iterate.com/repo/github-import-requested")).toMatchObject([
      {
        payload: {
          branch: "main",
          requestId: expect.stringMatching(/^\/repos\/config:\d+$/),
          requestedCommitOid: "after456",
        },
      },
    ]);
    expect(h.events("events.iterate.com/repo/github-import-started")).toHaveLength(1);
    expect(h.events("events.iterate.com/repo/github-import-completed")).toMatchObject([
      { payload: { branch: "main", commitOid: "github-head", requestedCommitOid: "after456" } },
    ]);
    expect(h.githubSync.calls).toEqual([{ afterCommitOid: "after456", branch: "main" }]);
    expect(h.state().githubImport).toBeNull();

    // The webhook itself produced NO commit facts — those only ever come from
    // the Artifacts queue event the sync will trigger.
    expect(h.events("events.iterate.com/repo/commit-completed")).toHaveLength(0);
    expect(h.taskDiff.calls).toEqual([]);
  });

  it.each([
    ["a direct unprovenanced event", { provenance: false }],
    ["the wrong connection", { connection: "install-other" }],
    ["the wrong installation", { installationId: "456" }],
    ["the wrong repository", { repositoryId: 202 }],
    ["the wrong subscription", { subscriptionKey: "userspace:other" }],
  ])("does not import %s", async (_case, webhookInput) => {
    const h = makeRepoHarness();
    await h.play(
      ["append", REPO_CREATED],
      ["append", GITHUB_LINK_CONFIGURED, githubPush(webhookInput)],
    );

    expect(h.githubSync.calls).toEqual([]);
    expect(h.events("events.iterate.com/repo/github-import-requested")).toHaveLength(0);
  });

  it("journals an import failure without pinning later repo events", async () => {
    const h = makeRepoHarness();
    h.githubSync.impl = async () => {
      throw new Error("GitHub and Artifacts diverged");
    };
    await h.play(["append", REPO_CREATED], ["append", GITHUB_LINK_CONFIGURED, githubPush()]);

    expect(h.events("events.iterate.com/repo/github-import-failed")).toMatchObject([
      { payload: { error: expect.stringContaining("diverged"), branch: "main" } },
    ]);
    expect(h.state().githubImport).toBeNull();

    // The failed import closed instead of wedging: the next Artifacts push
    // still produces its commit fact and tree diff.
    await h.play(["append", artifactPush("main")]);
    expect(h.taskDiff.calls).toEqual([
      { afterCommitOid: "after456", beforeCommitOid: "before123", branch: "main" },
    ]);
    expect(h.events("events.iterate.com/repo/commit-completed")).toHaveLength(1);
  });

  it("re-drives an import whose driving incarnation was evicted mid-sync, under the same request identity", async () => {
    const h = makeRepoHarness();
    // Incarnation 1's sync HANGS: the started fact is journaled, the attempt
    // parks forever.
    h.githubSync.impl = () => new Promise<never>(() => {});
    await h.play(["append", REPO_CREATED], ["append", GITHUB_LINK_CONFIGURED, githubPush()]);
    expect(h.events("events.iterate.com/repo/github-import-started")).toHaveLength(1);
    expect(h.events("events.iterate.com/repo/github-import-completed")).toHaveLength(0);
    expect(h.githubSync.calls).toHaveLength(1);

    // Eviction; the successor's revival turn finds the started obligation
    // with no live driver and RE-drives it — the sync is an idempotent
    // current-head fast-forward, so re-driving is safe by design.
    await h.play(
      ["crash"],
      () => {
        h.githubSync.impl = async () => ({ commitOid: "current-github-head" });
      },
      ["append", REVIVED],
    );

    expect(h.githubSync.calls).toHaveLength(2);
    expect(h.events("events.iterate.com/repo/github-import-completed")).toMatchObject([
      { payload: { commitOid: "current-github-head" } },
    ]);
    // The re-driven attempt's started fact deduped on the per-requestId key —
    // one started row, not two.
    expect(h.events("events.iterate.com/repo/github-import-started")).toHaveLength(1);
    expect(h.state().githubImport).toBeNull();
  });
});

// =============================================================================
// Reduced state: link lifecycle and the mirror status board
// =============================================================================

describe("RepoProcessor reduced state", () => {
  it("mirrors the link lifecycle and the NEWEST mirror-push outcome; unlink clears the board", async () => {
    const h = makeRepoHarness();
    await h.play(["append", REPO_CREATED], ["append", GITHUB_LINK_CONFIGURED]);
    expect(h.state().github).toEqual({
      connection: "install-789",
      installationId: "789",
      owner: "acme",
      repo: "widgets",
      repositoryId: 101,
    });
    expect(h.state().lastGithubPush).toBeNull();

    await h.play([
      "append",
      {
        type: "events.iterate.com/repo/github-push-failed",
        payload: {
          branch: "main",
          commitOid: null,
          error: "no usable installation token",
          owner: "acme",
          repo: "widgets",
        },
      },
    ]);
    expect(h.state().lastGithubPush).toMatchObject({
      ok: false,
      commitOid: null,
      error: "no usable installation token",
    });

    await h.play([
      "append",
      {
        type: "events.iterate.com/repo/github-push-completed",
        payload: { branch: "main", commitOid: "abc123", owner: "acme", repo: "widgets" },
      },
    ]);
    expect(h.state().lastGithubPush).toMatchObject({ ok: true, commitOid: "abc123", error: null });

    await h.play([
      "append",
      {
        type: "events.iterate.com/repo/github-synced",
        payload: {
          branch: "main",
          commitOid: "def456",
          forced: false,
          owner: "acme",
          previousCommitOid: "abc123",
          repo: "widgets",
        },
      },
    ]);
    expect(h.state().lastGithubPush).toMatchObject({ ok: true, commitOid: "def456" });

    await h.play([
      "append",
      {
        type: "events.iterate.com/repo/github-unlinked",
        payload: { connection: "install-789", owner: "acme", repo: "widgets", repositoryId: 101 },
      },
    ]);
    expect(h.state()).toMatchObject({ github: null, lastGithubPush: null, githubImport: null });
  });
});

// =============================================================================
// Full replay — the harshest at-least-once redelivery
// =============================================================================

describe("RepoProcessor full replay", () => {
  it("a fresh cursor over the same stream re-executes no vendor work, appends nothing new, and reaches the same state", async () => {
    // Live flow first: birth (artifact seeded), link, a webhook import that
    // completes, then an Artifacts push whose commit carries task changes.
    const h = makeRepoHarness();
    const taskChanges: RepoCommittedFileChange[] = [{ kind: "created", path: "tasks/new-task.md" }];
    h.taskDiff.impl = async () => taskChanges;
    await h.play(
      ["append", REPO_CREATED],
      ["append", GITHUB_LINK_CONFIGURED, githubPush()],
      ["append", artifactPush("main")],
      // The clock moves well past every original append: replayed per-event
      // appends must still produce byte-identical bodies (they derive from
      // event payloads and commit coordinates, never from now()), or the
      // same-key append would be REJECTED and wedge the replay.
      ["advanceTime", 60_000],
    );
    const headState = h.state();
    const committedOffsets = h.events().map((row) => row.offset);
    expect(h.events("events.iterate.com/repo/task-created")).toHaveLength(1);
    expect(h.catalog()).toHaveLength(1);

    // A SECOND harness over the SAME stream and clock with a FRESH progress
    // store: replays every event from offset 0. Completed obligations must
    // provably not re-run — the seed and sync fakes THROW if reached; the
    // tree diff (deterministic from commit coordinates) legitimately re-runs
    // and its re-appended facts dedupe.
    const replay = makeRepoHarness({
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(),
    });
    replay.artifactSeed.impl = () => {
      throw new Error("replay must not re-create an existing repo");
    };
    replay.githubSync.impl = () => {
      throw new Error("replay must not sync");
    };
    replay.taskDiff.impl = async () => taskChanges;
    await replay.settle(); // a wedge or a re-run vendor dial would throw here

    expect(replay.events().map((row) => row.offset)).toEqual(committedOffsets);
    expect(replay.state()).toEqual(headState);
    expect(replay.events("events.iterate.com/repo/task-created")).toHaveLength(1);
    // The replayed catalog cross-post deduped on its key instead of
    // double-cataloging.
    expect(replay.catalog()).toHaveLength(1);
  });
});
