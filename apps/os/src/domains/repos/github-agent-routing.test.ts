// The repo-side GitHub router, path codec, and existing repo creation lane.

import { describe, expect, it } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { appendTestEvents } from "../streams/test-helpers.ts";
import {
  GITHUB_LINK,
  MemoryStream,
  MemoryStreamNetwork,
  deliverNewEvents,
  pullRequestBody,
  webhookPayload,
} from "./github-agent-test-helpers.ts";
import {
  githubAgentPath,
  isGithubAgentPath,
  pullRequestNumbersFromWebhookBody,
} from "./github-agent-utils.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";

const WIDGETS_PR_7 = await githubAgentPath({ ...GITHUB_LINK, repoPath: "/repos/config" }, 7);
const WIDGETS_PR_8 = await githubAgentPath({ ...GITHUB_LINK, repoPath: "/repos/config" }, 8);
const GADGETS_PR_7 = await githubAgentPath(
  { ...GITHUB_LINK, repo: "gadgets", repoPath: "/repos/config" },
  7,
);
const OTHER_INSTALLATION_PR_7 = await githubAgentPath(
  { ...GITHUB_LINK, installationId: "999", repo: "gadgets", repoPath: "/repos/config" },
  7,
);

function newRepoProcessor(stream: MemoryStream, path = "/repos/config") {
  return new RepoProcessor({
    stream,
    path,
    projectId: "prj_1",
    taskChangesForArtifactPush: async () => [],
    syncFromGithubPush: async () => ({ commitOid: "github-head" }),
    createRepoArtifact: async () => {
      throw new Error("not under test");
    },
  });
}

describe("github-agent path scheme", () => {
  it("derives stable, isolated, bounded paths", async () => {
    expect(WIDGETS_PR_7).toMatch(/^\/agents\/repos\/g~[a-f0-9]{64}\/pull-requests\/7$/);
    expect(await githubAgentPath({ ...GITHUB_LINK, repoPath: "/repos/config" }, 7)).toBe(
      WIDGETS_PR_7,
    );
    expect(await githubAgentPath({ ...GITHUB_LINK, repoPath: "/repos/foo" }, 7)).not.toBe(
      WIDGETS_PR_7,
    );
    await expect(githubAgentPath({ ...GITHUB_LINK, repoPath: "/repos/config" }, 0)).rejects.toThrow(
      /positive integer/,
    );
    await expect(githubAgentPath({ ...GITHUB_LINK, repoPath: "/" }, 7)).rejects.toThrow(
      /non-root repo path/,
    );

    const maximalPath = await githubAgentPath(
      {
        installationId: "9".repeat(20),
        owner: "o".repeat(39),
        repo: "r".repeat(100),
        repoPath: `/repos/${"deep/".repeat(100)}`,
      },
      999_999,
    );
    expect(() =>
      DurableObjectNameCodec.stringify({ projectId: `prj_${"p".repeat(32)}`, path: maximalPath }),
    ).not.toThrow();
  });

  it("recognizes PR agent paths and only those", () => {
    expect(isGithubAgentPath(WIDGETS_PR_7)).toBe(true);
    expect(isGithubAgentPath("/agents/repos/r~foo/pull-requests/12")).toBe(false);
    expect(isGithubAgentPath("/agents/repos/r~foo/pull-requests/nope")).toBe(false);
    expect(isGithubAgentPath("/agents/repos/pull-requests/7")).toBe(false);
    expect(isGithubAgentPath("/agents/email/t1")).toBe(false);
    expect(isGithubAgentPath("/agents/onboarding")).toBe(false);
  });

  it("extracts PR numbers from the webhook shapes that carry them", () => {
    expect(pullRequestNumbersFromWebhookBody(pullRequestBody({ number: 42 }))).toEqual([42]);
    expect(
      pullRequestNumbersFromWebhookBody(pullRequestBody({ comment: { body: "hi" }, number: 9 })),
    ).toEqual([9]);
    expect(
      pullRequestNumbersFromWebhookBody({
        action: "created",
        issue: { number: 3 },
        comment: { body: "hi" },
      }),
    ).toEqual([]);
    expect(pullRequestNumbersFromWebhookBody({ ref: "refs/heads/main", after: "abc" })).toEqual([]);
    expect(pullRequestNumbersFromWebhookBody(null)).toEqual([]);
    expect(pullRequestNumbersFromWebhookBody("push")).toEqual([]);
    expect(
      pullRequestNumbersFromWebhookBody({
        check_run: { pull_requests: [{ number: 7 }, { number: 8 }, { number: 7 }] },
      }),
    ).toEqual([7, 8]);
  });
});

describe("RepoProcessor PR webhook forward (router)", () => {
  it("forwards PR webhooks to the per-PR agent stream, route fact first", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const processor = newRepoProcessor(stream);
    const cursors = new Map<object, number>();

    await stream.append(
      { type: "events.iterate.com/repo/github-link-configured", payload: GITHUB_LINK },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 7 })),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    const routed = network.eventsAt(WIDGETS_PR_7);
    expect(routed.map((event) => event.type)).toEqual([
      "events.iterate.com/github-agent/route-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/github/webhook-received",
    ]);
    expect(routed[0]!.payload).toEqual({
      ...GITHUB_LINK,
      number: 7,
      repoPath: "/repos/config",
      streamPath: WIDGETS_PR_7,
    });
    expect(routed[1]!.payload).toMatchObject({
      subscriptionKey: expect.stringMatching(/#github-agent$/),
      delivery: { processorSlug: "github-agent" },
    });
    expect(routed[2]!.payload).toEqual(webhookPayload(pullRequestBody({ number: 7 })));
  });

  it("routes each PR to its own stream and dedupes the route fact per PR", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const processor = newRepoProcessor(stream);
    const cursors = new Map<object, number>();

    await stream.append(
      { type: "events.iterate.com/repo/github-link-configured", payload: GITHUB_LINK },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 7 })),
      },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ comment: { body: "nice" }, number: 7 })),
      },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 8 })),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    expect(network.eventsAt(WIDGETS_PR_7).map((event) => event.type)).toEqual([
      "events.iterate.com/github-agent/route-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/github/webhook-received",
      "events.iterate.com/github/webhook-received",
    ]);
    expect(network.eventsAt(WIDGETS_PR_8).map((event) => event.type)).toEqual([
      "events.iterate.com/github-agent/route-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/github/webhook-received",
    ]);
  });

  it("relinking GitHub coordinates, including installation only, emits a fresh route fact", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const processor = newRepoProcessor(stream);
    const cursors = new Map<object, number>();

    await stream.append(
      { type: "events.iterate.com/repo/github-link-configured", payload: GITHUB_LINK },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 7 })),
      },
      {
        type: "events.iterate.com/repo/github-link-configured",
        payload: { ...GITHUB_LINK, repo: "gadgets" },
      },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 7 })),
      },
      {
        type: "events.iterate.com/repo/github-link-configured",
        payload: { ...GITHUB_LINK, installationId: "999", repo: "gadgets" },
      },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: { ...webhookPayload(pullRequestBody({ number: 7 })), installationId: "999" },
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    const routePayload = (path: string) =>
      network
        .eventsAt(path)
        .find((event) => event.type === "events.iterate.com/github-agent/route-configured")
        ?.payload;
    expect(routePayload(WIDGETS_PR_7)).toMatchObject({
      installationId: "789",
      repo: "widgets",
    });
    expect(routePayload(GADGETS_PR_7)).toMatchObject({
      installationId: "789",
      repo: "gadgets",
    });
    expect(routePayload(OTHER_INSTALLATION_PR_7)).toMatchObject({
      installationId: "999",
      repo: "gadgets",
    });
  });

  it("routes one CI delivery to every associated pull request", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const processor = newRepoProcessor(stream);
    const cursors = new Map<object, number>();
    const checkRun = {
      action: "completed",
      check_run: {
        conclusion: "failure",
        name: "test",
        pull_requests: [{ number: 7 }, { number: 8 }],
      },
    };

    await stream.append(
      { type: "events.iterate.com/repo/github-link-configured", payload: GITHUB_LINK },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(checkRun, "check_run"),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    for (const number of [7, 8]) {
      expect(
        network
          .eventsAt(await githubAgentPath({ ...GITHUB_LINK, repoPath: "/repos/config" }, number))
          .map((event) => event.type),
      ).toEqual([
        "events.iterate.com/github-agent/route-configured",
        "events.iterate.com/stream/subscription-configured",
        "events.iterate.com/github/webhook-received",
      ]);
    }
  });

  it("ignores non-PR webhooks and webhooks on unlinked repos", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const processor = newRepoProcessor(stream);
    const cursors = new Map<object, number>();

    await stream.append(
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 7 })),
      },
      { type: "events.iterate.com/repo/github-link-configured", payload: GITHUB_LINK },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload({ ref: "refs/heads/main", after: "abc123" }),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    expect(network.streams.size).toBe(1);
  });
});

describe("RepoProcessor create lane (creation as an at-head obligation)", () => {
  const createdArtifact = {
    artifactName: "prj_1--L3JlcG9zL2NvbmZpZw",
    defaultBranch: "main",
    remote: "https://example.artifacts.cloudflare.net/git/ns/prj_1--L3JlcG9zL2NvbmZpZw.git",
  };
  const createRequested = {
    type: "events.iterate.com/repo/create-requested" as const,
    payload: { projectId: "prj_1", path: "/repos/config" },
  };

  function newCreatingRepoProcessor(stream: MemoryStream, createCalls: unknown[]) {
    return new RepoProcessor({
      stream,
      taskChangesForArtifactPush: async () => [],
      syncFromGithubPush: async () => ({ commitOid: "github-head" }),
      createRepoArtifact: async (input) => {
        createCalls.push(input);
        return createdArtifact;
      },
      path: "/repos/config",
      projectId: "prj_1",
    });
  }

  it("creates the artifact once at head and journals repo/created", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const createCalls: unknown[] = [];
    const processor = newCreatingRepoProcessor(stream, createCalls);
    const cursors = new Map<object, number>();

    await stream.append(createRequested);
    await deliverNewEvents({ cursors, processor, stream });

    expect(createCalls).toEqual([{ path: "/repos/config", projectId: "prj_1" }]);
    const created = stream.events.filter(
      (event) => event.type === "events.iterate.com/repo/created",
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      idempotencyKey: "repo/created",
      payload: { ...createdArtifact, path: "/repos/config", projectId: "prj_1" },
    });

    await deliverNewEvents({ cursors, processor, stream });
    expect(processor.state).toMatchObject({ createRequested: true, created: true });
    expect(createCalls).toHaveLength(1);
  });

  it("defers creation while the fold is behind the head, then creates once caught up", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const createCalls: unknown[] = [];
    const processor = newCreatingRepoProcessor(stream, createCalls);
    const [requested, linked] = await appendTestEvents(stream, createRequested, {
      type: "events.iterate.com/repo/github-link-configured",
      payload: GITHUB_LINK,
    });

    await processor.ingest({ events: [requested!], streamMaxOffset: 2 });
    expect(createCalls).toHaveLength(0);
    await processor.ingest({ events: [linked!], streamMaxOffset: 2 });
    expect(createCalls).toHaveLength(1);
  });

  it("refold: a journal that already contains repo/created never re-creates", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const createCalls: unknown[] = [];
    const processor = newCreatingRepoProcessor(stream, createCalls);
    const cursors = new Map<object, number>();

    await stream.append(createRequested);
    await deliverNewEvents({ cursors, processor, stream });
    await deliverNewEvents({ cursors, processor, stream });
    expect(createCalls).toHaveLength(1);
    const journalBeforeRefold = stream.events.length;

    const refolded = new RepoProcessor({
      stream,
      taskChangesForArtifactPush: async () => [],
      syncFromGithubPush: async () => ({ commitOid: "github-head" }),
      createRepoArtifact: async () => {
        throw new Error("refold must not re-create an existing repo");
      },
      path: "/repos/config",
      projectId: "prj_1",
    });
    await deliverNewEvents({ cursors, processor: refolded, stream });

    expect(stream.events).toHaveLength(journalBeforeRefold);
    expect(refolded.state).toEqual(processor.state);
  });
});
