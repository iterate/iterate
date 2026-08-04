// The repo processor's executable spec, as step scenarios on the generic
// harness (makeProcessorHarness from iterate/processors/testing): the REAL
// StreamProcessorRunner over the shared MemoryStream (production idempotency
// semantics: a same-key append with a different body is REJECTED), virtual
// time, and eviction-faithful crash(). The vendor deps (artifact seed, public
// import, GitHub link/sync, branch-head cache) are scriptable fakes wired in
// createProcessor — swap `impl` mid-scenario or across crashes; `calls`
// records every dial.
//
// The harness's real keepalive and recovery adapters drive the eviction
// scenarios; repo-recovery.test.ts keeps the focused creation recovery proofs.

import { describe, expect, it } from "vitest";
import { KEEPALIVE_ALARM_LEAD_MS, type ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import { RepoProcessorContract, type RepoProcessorState } from "./repo-processor-contract.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";
import { GithubTemplateSourceError } from "./github-template-source.ts";

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
const RESOLVED_TEMPLATE = {
  branch: "main",
  commitSha: "a".repeat(40),
  owner: "iterate",
  path: "configs/with-voice",
  ref: "main",
  repo: "iterate",
};

const CREATE_REQUESTED = {
  type: "events.iterate.com/repos/create-requested",
  payload: { type: "empty" },
} satisfies RepoEventInput;

/** The saga's terminal certificate, appended manually by scenarios that start
 * from an ALREADY-CREATED repo (the seed fake then never dials). */
const CREATED = {
  type: "events.iterate.com/repos/created",
  payload: { ...SEEDED_ARTIFACT, request: { type: "empty" } },
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

/** A GitHub push delivery as the connection stream copies it. Event
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
            copiedFrom: [
              {
                subscriptionKey: input?.subscriptionKey ?? `github-repo:${REPO_PATH}`,
                streamId: "11111111-1111-4111-8111-111111111111",
                streamCreatedAt: "2026-07-17T11:00:00.000Z",
                cursorChangedAtSourceOffset: 1,
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

/** The generic harness plus the repo's scriptable vendor fakes. Pass another
 * harness's substrate for a replay incarnation over the SAME stream. */
function makeRepoHarness(substrate?: HarnessSubstrate) {
  const creationAlarm = {
    at: null as number | null,
    calls: [] as Array<number | null>,
  };
  const createEmpty = {
    calls: 0,
    impl: async (): Promise<typeof SEEDED_ARTIFACT> => SEEDED_ARTIFACT,
  };
  const importPublic = {
    calls: [] as { depth?: number; owner: string; repo: string }[],
    impl: async (): Promise<typeof SEEDED_ARTIFACT> => SEEDED_ARTIFACT,
  };
  const createTemplate = {
    calls: [] as NonNullable<RepoProcessorState["templateSource"]>[],
    impl: async (): Promise<typeof SEEDED_ARTIFACT> => SEEDED_ARTIFACT,
  };
  const resolveTemplate = {
    calls: [] as { owner: string; path?: string; ref?: string; repo: string }[],
    impl: async (): Promise<typeof RESOLVED_TEMPLATE> => RESOLVED_TEMPLATE,
  };
  const link = {
    calls: [] as { connection: string; owner: string; repo: string }[],
    impl: async (): Promise<void> => {},
  };
  const syncPrivate = {
    calls: 0,
    impl: async (): Promise<void> => {},
  };
  const githubSync = {
    calls: [] as { afterCommitOid: string; branch: string }[],
    impl: async (): Promise<{ commitOid: string }> => ({ commitOid: "github-head" }),
  };
  const headCache = {
    observed: [] as {
      afterCommitOid: string | null;
      beforeCommitOid: string | null;
      branch: string;
    }[],
  };
  const harness = makeProcessorHarness<RepoProcessorContract, RepoProcessor>({
    createProcessor: (deps) =>
      new RepoProcessor({
        stream: deps.stream,
        path: deps.path,
        projectId: deps.projectId,
        now: deps.now,
        ensureCreationAlarm: async (atMs) => {
          if (creationAlarm.at !== null) return;
          creationAlarm.at = atMs;
          creationAlarm.calls.push(atMs);
        },
        repointCreationAlarm: async (atMs) => {
          creationAlarm.at = atMs;
          creationAlarm.calls.push(atMs);
        },
        createEmptyArtifact: () => {
          createEmpty.calls += 1;
          return createEmpty.impl();
        },
        createGithubTemplateArtifact: (source) => {
          createTemplate.calls.push(source);
          return createTemplate.impl();
        },
        importPublicGithubArtifact: (input) => {
          importPublic.calls.push(input);
          return importPublic.impl();
        },
        linkGithub: (input) => {
          link.calls.push(input);
          return link.impl();
        },
        syncPrivateGithub: () => {
          syncPrivate.calls += 1;
          return syncPrivate.impl();
        },
        syncFromGithubPush: (input) => {
          githubSync.calls.push(input);
          return githubSync.impl();
        },
        observeArtifactPush: (input) => void headCache.observed.push(input),
        resolveGithubTemplateSource: (input) => {
          resolveTemplate.calls.push(input);
          return resolveTemplate.impl();
        },
      }),
    path: REPO_PATH,
    substrate,
  });
  return {
    ...harness,
    creationAlarm,
    createEmpty,
    importPublic,
    createTemplate,
    resolveTemplate,
    link,
    syncPrivate,
    githubSync,
    headCache,
  };
}

async function driveCreation(harness: ReturnType<typeof makeRepoHarness>): Promise<void> {
  await harness.processor().driveCreation(harness.state());
  await harness.settle();
}

// =============================================================================
// The creation saga: create-requested → created | create-failed
// =============================================================================

describe("RepoProcessor creation saga", () => {
  it("seeds an empty Artifact once at head and appends the terminal certificate under the offset-free key", async () => {
    const h = makeRepoHarness();
    await h.play(["append", CREATE_REQUESTED]);

    // The seed ran exactly once even though later deliveries (the terminal
    // certificate itself) re-ran the at-head pass over a state where the
    // birth certificate already holds.
    expect(h.createEmpty.calls).toBe(1);
    expect(h.events("events.iterate.com/repos/created")).toMatchObject([
      {
        // NO event offset in the key: a redelivery/revival cannot rotate it
        // and double-birth.
        idempotencyKey: "repo/created",
        payload: { ...SEEDED_ARTIFACT, request: { type: "empty" } },
      },
    ]);
    expect(h.state()).toMatchObject({
      createRequest: { type: "empty" },
      createFailure: null,
      birthCertificate: { request: { type: "empty" } },
      defaultBranch: "main",
      artifactName: SEEDED_ARTIFACT.artifactName,
      remote: SEEDED_ARTIFACT.remote,
    });
  });

  it("imports a public GitHub repo through Artifacts, then links it", async () => {
    const h = makeRepoHarness();
    await h.play([
      "append",
      {
        type: "events.iterate.com/repos/create-requested",
        payload: {
          type: "github-public",
          connection: "install-789",
          depth: 1,
          owner: "acme",
          repo: "widgets",
        },
      },
    ]);

    // The hosted source callback only arms the Repo DO. Vendor work and
    // outcome appends start later, from the alarm's independent call tree.
    expect(h.importPublic.calls).toEqual([]);
    expect(h.creationAlarm.at).toBe(h.clock.now + 1_000);
    await driveCreation(h);

    expect(h.importPublic.calls).toMatchObject([{ depth: 1, owner: "acme", repo: "widgets" }]);
    expect(h.link.calls).toMatchObject([
      { connection: "install-789", owner: "acme", repo: "widgets" },
    ]);
    expect(h.createEmpty.calls).toBe(0);
    expect(h.syncPrivate.calls).toBe(0);
    expect(h.events("events.iterate.com/repos/created")).toHaveLength(1);
  });

  it("journals an immutable GitHub template source before materializing it", async () => {
    const h = makeRepoHarness();
    const request = {
      type: "github-public-template" as const,
      owner: "iterate",
      path: "configs/with-voice",
      ref: "main",
      repo: "iterate",
    };
    await h.play([
      "append",
      { type: "events.iterate.com/repos/create-requested", payload: request },
    ]);

    expect(h.resolveTemplate.calls).toEqual([]);
    expect(h.createTemplate.calls).toEqual([]);
    expect(h.creationAlarm.at).toBe(h.clock.now + 1_000);
    await driveCreation(h);

    expect(h.resolveTemplate.calls).toEqual([request]);
    expect(h.events("events.iterate.com/repos/template-source-resolved")).toMatchObject([
      {
        idempotencyKey:
          'iterate-internal/repo-template-source-resolved:["proj_harness","/repos/config"]',
        payload: RESOLVED_TEMPLATE,
      },
    ]);
    expect(h.createTemplate.calls).toEqual([RESOLVED_TEMPLATE]);
    expect(h.events("events.iterate.com/repos/created")).toMatchObject([{ payload: { request } }]);
    expect(h.state()).toMatchObject({ templateSource: RESOLVED_TEMPLATE });
  });

  it("arms template creation before a hosted delivery reaches the raw stream head", async () => {
    const h = makeRepoHarness();
    await h.stream.append({
      type: "events.iterate.com/repos/create-requested",
      payload: {
        type: "github-public-template",
        owner: "iterate",
        path: "configs/with-voice",
        ref: "main",
        repo: "iterate",
      },
    });
    await h.stream.append({ type: "stream/connection-opened", payload: {} });
    const request = h.stream.events[0]!;
    const opened = await h.runner().openEventBatchCallback(h.stream.streamId, {
      sourceScansAllEvents: true,
    });

    await opened.processEventBatch({
      events: [request],
      scannedAfterOffset: 0,
      scannedThroughOffset: request.offset,
      streamId: h.stream.streamId,
      streamMaxOffset: 2,
    });

    await expect(h.runner().snapshot()).resolves.toMatchObject({ offset: request.offset });
    expect(h.creationAlarm.at).toBe(h.clock.now + 1_000);
    expect(h.resolveTemplate.calls).toEqual([]);
    expect(h.createTemplate.calls).toEqual([]);
  });

  it("keeps retryable GitHub failures open and settles missing template input", async () => {
    const request = {
      type: "github-public-template" as const,
      owner: "iterate",
      path: "configs/missing",
      repo: "iterate",
    };
    const retry = makeRepoHarness();
    retry.resolveTemplate.impl = async () => {
      throw new GithubTemplateSourceError("GitHub unavailable", { retryable: true });
    };
    await retry.stream.append({
      type: "events.iterate.com/repos/create-requested",
      payload: request,
    });
    await retry.settle();
    await expect(retry.processor().driveCreation(retry.state())).rejects.toThrow(
      "GitHub unavailable",
    );
    expect(retry.events("events.iterate.com/repos/create-failed")).toEqual([]);

    // alarm() owns the retry cadence. A later caught-up source callback may
    // confirm the obligation is still open, but must not pull that coarse
    // retry forward and create a hot loop during a vendor outage.
    retry.creationAlarm.at = retry.clock.now + 60_000;
    const alarmCalls = retry.creationAlarm.calls.length;
    await retry.play([
      "append",
      { type: "events.iterate.com/repos/create-requested", payload: request },
    ]);
    expect(retry.creationAlarm.at).toBe(retry.clock.now + 60_000);
    expect(retry.creationAlarm.calls).toHaveLength(alarmCalls);

    retry.resolveTemplate.impl = async () => RESOLVED_TEMPLATE;
    await driveCreation(retry);
    expect(retry.events("events.iterate.com/repos/created")).toHaveLength(1);

    const terminal = makeRepoHarness();
    terminal.resolveTemplate.impl = async () => {
      throw new GithubTemplateSourceError("Template path does not exist", { retryable: false });
    };
    await terminal.play([
      "append",
      { type: "events.iterate.com/repos/create-requested", payload: request },
    ]);
    await driveCreation(terminal);
    expect(terminal.events("events.iterate.com/repos/create-failed")).toMatchObject([
      { payload: { error: "Template path does not exist", request } },
    ]);
  });

  it("seeds an Artifact, links a private GitHub repo, then performs its depth-one sync", async () => {
    const h = makeRepoHarness();
    await h.play([
      "append",
      {
        type: "events.iterate.com/repos/create-requested",
        payload: {
          type: "github-private",
          connection: "install-789",
          owner: "acme",
          repo: "widgets",
        },
      },
    ]);
    await driveCreation(h);

    expect(h.createEmpty.calls).toBe(1);
    expect(h.link.calls).toMatchObject([
      { connection: "install-789", owner: "acme", repo: "widgets" },
    ]);
    expect(h.syncPrivate.calls).toBe(1);
    expect(h.importPublic.calls).toEqual([]);
    expect(h.events("events.iterate.com/repos/created")).toHaveLength(1);
  });

  it("settles a non-retryable Artifacts input failure as create-failed", async () => {
    const h = makeRepoHarness();
    h.importPublic.impl = async () => {
      throw Object.assign(new Error("The repository name is invalid."), {
        code: "INVALID_REPO_NAME",
        name: "ArtifactsError",
      });
    };
    const request = {
      type: "github-public" as const,
      connection: "install-789",
      owner: "acme",
      repo: "widgets",
    };
    await h.play([
      "append",
      { type: "events.iterate.com/repos/create-requested", payload: request },
    ]);
    await driveCreation(h);

    expect(h.events("events.iterate.com/repos/created")).toHaveLength(0);
    expect(h.events("events.iterate.com/repos/create-failed")).toMatchObject([
      {
        idempotencyKey: "repo/create-failed",
        payload: { error: "The repository name is invalid.", request },
      },
    ]);
    expect(h.state()).toMatchObject({ createFailure: { request }, birthCertificate: null });
  });

  it("is fail-closed: after a terminal failure nothing reacts — no head-cache poke, no commit facts, no import", async () => {
    const h = makeRepoHarness();
    await h.play([
      "append",
      CREATE_REQUESTED,
      {
        type: "events.iterate.com/repos/create-failed",
        payload: { error: "boom", request: CREATE_REQUESTED.payload },
      },
      artifactPush("main"),
      GITHUB_LINK_CONFIGURED,
      githubPush(),
    ]);

    expect(h.headCache.observed).toEqual([]);
    expect(h.githubSync.calls).toEqual([]);
    expect(h.events("events.iterate.com/repo/commit-completed")).toHaveLength(0);
    expect(h.events("events.iterate.com/repo/github-import-requested")).toHaveLength(0);
  });

  it("preserves a creation push that arrives before the terminal certificate", async () => {
    // The default branch is known the moment create-requested reduces, so an
    // Artifacts push racing the certificate still lands its commit fact.
    const h = makeRepoHarness();
    await h.play(["append", CREATE_REQUESTED, artifactPush("main")]);

    expect(h.events("events.iterate.com/repo/commit-completed")).toMatchObject([
      { payload: { beforeCommitOid: "before123", branch: "main", commitOid: "after456" } },
    ]);
    expect(h.headCache.observed).toEqual([
      { afterCommitOid: "after456", beforeCommitOid: "before123", branch: "main" },
    ]);
  });

  it("a duplicate request and a duplicate certificate both reduce to a no-op: the first ones win", async () => {
    const h = makeRepoHarness();
    await h.play(["append", CREATE_REQUESTED]);
    const before = h.state();

    // Conflicting requests are rejected at the create() door (the committed-
    // payload comparison); duplicates that still reach reduce must not wedge
    // the frame, must not re-birth, and must not clobber the first story.
    await h.append({
      type: "events.iterate.com/repos/create-requested",
      payload: { type: "github-public", connection: "install-x", owner: "a", repo: "b" },
    });
    await h.append({
      type: "events.iterate.com/repos/created",
      payload: { ...SEEDED_ARTIFACT, artifactName: "impostor", request: { type: "empty" } },
    });

    expect(h.state()).toEqual(before);
    expect(h.createEmpty.calls).toBe(1);
  });
});

// =============================================================================
// Commit facts: Artifacts queue pushes → commit-completed
// =============================================================================

describe("RepoProcessor commit facts", () => {
  it("projects a default-branch Artifact push into a commit-completed fact", async () => {
    const h = makeRepoHarness();
    await h.play(["append", CREATE_REQUESTED, CREATED], ["append", artifactPush("main")]);

    // ONE commit fact, keyed on the push coordinates (natural identity, no
    // synthetic ids).
    expect(h.events("events.iterate.com/repo/commit-completed")).toMatchObject([
      {
        idempotencyKey: "repo/commit-completed:before123:after456:main",
        payload: { beforeCommitOid: "before123", branch: "main", commitOid: "after456" },
      },
    ]);
    expect(h.headCache.observed).toEqual([
      { afterCommitOid: "after456", beforeCommitOid: "before123", branch: "main" },
    ]);
    // The certificate was appended manually — the seed never dialed.
    expect(h.createEmpty.calls).toBe(0);
  });

  it("ignores pushes to non-default branches: no head-cache poke, no commit fact", async () => {
    const h = makeRepoHarness();
    await h.play(["append", CREATE_REQUESTED, CREATED], ["append", artifactPush("feature")]);

    expect(h.headCache.observed).toEqual([]);
    expect(h.events("events.iterate.com/repo/commit-completed")).toHaveLength(0);
  });

  it("observes every default-branch push — a ref DELETION invalidates the head cache despite appending no commit facts", async () => {
    const h = makeRepoHarness();
    const zeroOid = "0".repeat(40);
    await h.play(
      ["append", CREATE_REQUESTED, CREATED],
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
    await h.play(
      ["append", CREATE_REQUESTED, CREATED],
      ["append", GITHUB_LINK_CONFIGURED, githubPush()],
    );

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
      ["append", CREATE_REQUESTED, CREATED],
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
    await h.play(
      ["append", CREATE_REQUESTED, CREATED],
      ["append", GITHUB_LINK_CONFIGURED, githubPush()],
    );

    expect(h.events("events.iterate.com/repo/github-import-failed")).toMatchObject([
      { payload: { error: expect.stringContaining("diverged"), branch: "main" } },
    ]);
    expect(h.state().githubImport).toBeNull();

    // The failed import closed instead of wedging: the next Artifacts push
    // still produces its commit fact.
    await h.play(["append", artifactPush("main")]);
    expect(h.events("events.iterate.com/repo/commit-completed")).toHaveLength(1);
  });

  it("re-drives an import whose driving incarnation was evicted mid-sync, under the same request identity", async () => {
    const h = makeRepoHarness();
    // Incarnation 1's sync HANGS: the started fact is in the stream, the attempt
    // parks forever.
    h.githubSync.impl = () => new Promise<never>(() => {});
    await h.play(
      ["append", CREATE_REQUESTED, CREATED],
      ["append", GITHUB_LINK_CONFIGURED, githubPush()],
    );
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
      ["advanceTime", KEEPALIVE_ALARM_LEAD_MS + 1],
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
    await h.play(["append", CREATE_REQUESTED, CREATED], ["append", GITHUB_LINK_CONFIGURED]);
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
// The creation request schema — the create() door's vocabulary
// =============================================================================

describe("repos/create-requested payload schema", () => {
  const requestSchema =
    RepoProcessorContract.events["events.iterate.com/repos/create-requested"].payloadSchema;

  it.each([
    { type: "empty" },
    { type: "github-private", connection: "install-1", owner: "acme", repo: "private" },
    {
      type: "github-public-template",
      owner: "iterate",
      path: "configs/default",
      ref: "main",
      repo: "iterate",
    },
    { type: "github-public", connection: "install-1", owner: "acme", repo: "public" },
    { type: "github-public", connection: "install-1", depth: 1, owner: "acme", repo: "public" },
  ])("accepts $type", (request) => {
    expect(requestSchema.parse(request)).toEqual(request);
  });

  it("rejects source fields on an empty repo request", () => {
    expect(() => requestSchema.parse({ type: "empty", owner: "acme" })).toThrow();
  });

  it("requires GitHub coordinates for both GitHub modes", () => {
    expect(() => requestSchema.parse({ type: "github-public", owner: "acme" })).toThrow();
    expect(() => requestSchema.parse({ type: "github-private", repo: "private" })).toThrow();
    expect(() => requestSchema.parse({ type: "github-public-template", owner: "acme" })).toThrow();
  });

  it.each(["../private", ".git/objects", "/configs/default", "configs\\default"])(
    "rejects unsafe template path %s",
    (path) => {
      expect(() =>
        requestSchema.parse({ type: "github-public-template", owner: "acme", path, repo: "app" }),
      ).toThrow();
    },
  );

  it("requires a positive public import depth", () => {
    expect(() =>
      requestSchema.parse({
        type: "github-public",
        connection: "install-1",
        depth: 0,
        owner: "acme",
        repo: "public",
      }),
    ).toThrow();
  });
});

// =============================================================================
// Full replay — the harshest at-least-once redelivery
// =============================================================================

describe("RepoProcessor full replay", () => {
  it("a fresh cursor over the same stream re-executes no vendor work, appends nothing new, and reaches the same state", async () => {
    // Live flow first: the creation saga (artifact seeded, certificate
    // appended), link, a webhook import that completes, then an Artifacts
    // push that produces a commit fact.
    const h = makeRepoHarness();
    await h.play(
      ["append", CREATE_REQUESTED],
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
    expect(h.events("events.iterate.com/repos/created")).toHaveLength(1);
    expect(h.events("events.iterate.com/repo/commit-completed")).toHaveLength(1);

    // A SECOND harness over the SAME stream and clock with a FRESH progress
    // store: replays every event from offset 0. Completed obligations must
    // provably not re-run — the seed and sync fakes THROW if reached.
    const replay = makeRepoHarness({
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(RepoProcessorContract),
    });
    replay.createEmpty.impl = () => {
      throw new Error("replay must not re-create an existing repo");
    };
    replay.githubSync.impl = () => {
      throw new Error("replay must not sync");
    };
    await replay.settle(); // a wedge or a re-run vendor dial would throw here

    expect(replay.events().map((row) => row.offset)).toEqual(committedOffsets);
    expect(replay.state()).toEqual(headState);
    expect(replay.events("events.iterate.com/repos/created")).toHaveLength(1);
    expect(replay.events("events.iterate.com/repo/commit-completed")).toHaveLength(1);
  });
});
