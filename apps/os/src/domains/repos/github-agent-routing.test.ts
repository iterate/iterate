// The repo-side GitHub router and path codec. The repo CREATION lane (the
// at-head obligation) and eviction recovery live in repo-recovery.test.ts,
// driven through the real registry + durableObjectRecovery path.

import { describe, expect, it } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { StreamProcessorRunner } from "../streams/stream-processor-runner.ts";
import {
  GITHUB_LINK,
  MemoryStream,
  MemoryStreamNetwork,
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
const REPO_ARTIFACT = {
  artifactName: "prj_1--L3JlcG9zL2NvbmZpZw",
  defaultBranch: "main",
  remote: "https://example.artifacts.cloudflare.net/git/ns/prj_1--L3JlcG9zL2NvbmZpZw.git",
};

function seedReadyRepo(stream: MemoryStream): void {
  stream.events.push(
    {
      type: "events.iterate.com/repo/created",
      idempotencyKey: "repo/created:test",
      payload: { config: {} },
      createdAt: new Date(0).toISOString(),
      offset: 1,
      path: stream.path,
    },
    {
      type: "events.iterate.com/repo/ready",
      idempotencyKey: "repo/ready:test",
      payload: { ...REPO_ARTIFACT, path: stream.path, projectId: "prj_1" },
      createdAt: new Date(0).toISOString(),
      offset: 2,
      path: stream.path,
    },
  );
}

/** REAL runner drive (the production registry's driver): PR forwards launch
 * from per-event `processEvent` under the runner exactly as deployed; one
 * `catchUp()` is one delivery pass to the current head. */
function newRepoProcessor(stream: MemoryStream, path = "/repos/config") {
  seedReadyRepo(stream);
  const processor = new RepoProcessor({
    stream,
    path,
    projectId: "prj_1",
    taskChangesForArtifactPush: async () => [],
    syncFromGithubPush: async () => ({ commitOid: "github-head" }),
    createRepoArtifact: async () => {
      throw new Error("not under test");
    },
  });
  const runner = new StreamProcessorRunner({ processor, stream });
  return { processor, runner };
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
  it("forwards PR webhooks to an explicitly created per-PR agent stream", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const repo = newRepoProcessor(stream);

    await stream.append(
      { type: "events.iterate.com/repo/github-link-configured", payload: GITHUB_LINK },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 7 })),
      },
    );
    await repo.runner.catchUp();

    const routed = network.eventsAt(WIDGETS_PR_7);
    expect(routed.map((event) => event.type)).toEqual([
      "events.iterate.com/agent/created",
      "events.iterate.com/agent/binding-set",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/github-agent/created",
      "events.iterate.com/capability-host/capability-provided",
      "events.iterate.com/agents/context-added",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/github/webhook-received",
    ]);
    expect(routed[1]!.payload).toEqual({
      type: "github_pull_request",
      connection: "install-789",
      installationId: "789",
      number: 7,
      owner: "acme",
      repo: "widgets",
    });
    expect(routed[3]!.payload).toEqual({
      config: {
        ...GITHUB_LINK,
        number: 7,
        repoPath: "/repos/config",
      },
    });
    expect(routed.slice(6, 9).map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          delivery: expect.objectContaining({ processorSlug: "agent" }),
        }),
        expect.objectContaining({
          delivery: expect.objectContaining({ processorSlug: "capability-host" }),
        }),
        expect.objectContaining({
          delivery: expect.objectContaining({ processorSlug: "github-agent" }),
        }),
      ]),
    );
    expect(routed[9]!.payload).toEqual(webhookPayload(pullRequestBody({ number: 7 })));
  });

  it("routes each PR to its own stream and dedupes the route fact per PR", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const repo = newRepoProcessor(stream);

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
    await repo.runner.catchUp();

    expect(network.eventsAt(WIDGETS_PR_7).map((event) => event.type)).toEqual([
      "events.iterate.com/agent/created",
      "events.iterate.com/agent/binding-set",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/github-agent/created",
      "events.iterate.com/capability-host/capability-provided",
      "events.iterate.com/agents/context-added",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/github/webhook-received",
      "events.iterate.com/github/webhook-received",
    ]);
    expect(network.eventsAt(WIDGETS_PR_8).map((event) => event.type)).toEqual([
      "events.iterate.com/agent/created",
      "events.iterate.com/agent/binding-set",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/github-agent/created",
      "events.iterate.com/capability-host/capability-provided",
      "events.iterate.com/agents/context-added",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/github/webhook-received",
    ]);
  });

  it("relinking GitHub coordinates, including installation only, emits a fresh route fact", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const repo = newRepoProcessor(stream);

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
    await repo.runner.catchUp();

    const routePayload = (path: string) =>
      network
        .eventsAt(path)
        .find((event) => event.type === "events.iterate.com/github-agent/created")?.payload?.config;
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
    const repo = newRepoProcessor(stream);
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
    await repo.runner.catchUp();

    for (const number of [7, 8]) {
      expect(
        network
          .eventsAt(await githubAgentPath({ ...GITHUB_LINK, repoPath: "/repos/config" }, number))
          .map((event) => event.type),
      ).toEqual([
        "events.iterate.com/agent/created",
        "events.iterate.com/agent/binding-set",
        "events.iterate.com/capability-host/created",
        "events.iterate.com/github-agent/created",
        "events.iterate.com/capability-host/capability-provided",
        "events.iterate.com/agents/context-added",
        "events.iterate.com/stream/subscription-configured",
        "events.iterate.com/stream/subscription-configured",
        "events.iterate.com/stream/subscription-configured",
        "events.iterate.com/github/webhook-received",
      ]);
    }
  });

  it("ignores non-PR webhooks and webhooks on unlinked repos", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/repos/config");
    const repo = newRepoProcessor(stream);

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
    await repo.runner.catchUp();

    expect(network.eventsAt(WIDGETS_PR_7)).toEqual([]);
  });
});
