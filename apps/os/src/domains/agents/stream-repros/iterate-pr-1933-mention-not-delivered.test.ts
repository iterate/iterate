import { describe, expect, it } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { MemoryStreamNetwork } from "iterate/processors/testing";
import { StreamProcessorRunner } from "iterate/processors";
import { GithubAgentProcessor } from "../../repos/github-agent-processor-implementation.ts";
import { githubAgentPath } from "../../repos/github-agent-utils.ts";
import { RepoProcessor } from "../../repos/repo-processor-implementation.ts";
import fixture from "./iterate-pr-1933-mention-not-delivered.json";

describe("production stream repro: iterate PR 1933 mention was never delivered", () => {
  it("isolates obsolete history and forwards the next webhook to the current agent", async () => {
    const network = new MemoryStreamNetwork();
    const repo = network.get(fixture.repoPath);
    const legacyAgent = network.get(fixture.agentPath);
    legacyAgent.events = fixture.legacyTargetEvents as StreamEvent[];
    const agentPath = await githubAgentPath(
      { ...fixture.githubLink, repoPath: fixture.repoPath },
      1933,
    );
    const agent = network.get(agentPath);
    repo.events = [
      {
        type: "events.iterate.com/repo/created",
        payload: { config: {} },
        idempotencyKey: "fixture/repo-created",
        offset: 1,
        createdAt: "2026-07-13T13:41:58.000Z",
        path: fixture.repoPath,
      },
      {
        type: "events.iterate.com/repo/ready",
        payload: {
          artifactName: "fixture-repo",
          defaultBranch: "main",
          path: fixture.repoPath,
          projectId: fixture.projectId,
          remote: "https://example.invalid/fixture-repo.git",
        },
        idempotencyKey: "fixture/repo-ready",
        offset: 2,
        createdAt: "2026-07-13T13:41:59.000Z",
        path: fixture.repoPath,
      },
      {
        type: "events.iterate.com/repo/github-link-configured",
        payload: fixture.githubLink,
        idempotencyKey: "fixture/github-link",
        offset: 3,
        createdAt: "2026-07-13T13:42:00.000Z",
        path: fixture.repoPath,
      },
      fixture.sourceWebhook as StreamEvent,
    ];

    const processor = new RepoProcessor({
      taskChangesForArtifactPush: async () => [],
      syncFromGithubPush: async () => ({ commitOid: "github-head" }),
      createRepoArtifact: async () => {
        throw new Error("not part of this repro");
      },
      path: fixture.repoPath,
      projectId: fixture.projectId,
      stream: repo,
    });
    await new StreamProcessorRunner({ processor, stream: repo }).catchUp();

    const currentBirth = agent.events.find(
      (event) => event.type === "events.iterate.com/github-agent/created",
    );
    const currentSubscription = agent.events.find((event) => {
      const payload = event.payload as { delivery?: { processorSlug?: unknown } };
      return (
        event.type === "events.iterate.com/stream/subscription-configured" &&
        payload.delivery?.processorSlug === "github-agent"
      );
    });
    const forwardedMention = agent.events.find((event) => {
      const payload = event.payload as { body?: { comment?: { id?: unknown } } };
      return (
        event.type === "events.iterate.com/github/webhook-received" &&
        payload.body?.comment?.id === 4962404485
      );
    });

    expect(currentBirth?.idempotencyKey).not.toBe(
      "repo/pr-route:install-115079265:iterate/iterate:1933",
    );
    expect(currentSubscription?.payload?.subscriptionKey).toMatch(/#github-agent$/);
    expect(currentBirth!.offset).toBeLessThan(currentSubscription!.offset);
    expect(currentSubscription!.offset).toBeLessThan(forwardedMention!.offset);

    const reactions: unknown[] = [];
    const githubAgent = new GithubAgentProcessor({
      addEyesReaction: async (input) => {
        reactions.push(input);
      },
      path: agentPath,
      projectId: fixture.projectId,
      stream: agent,
    });
    await new StreamProcessorRunner({ processor: githubAgent, stream: agent }).catchUp();

    const turn = agent.events.find(
      (event) =>
        event.type === "events.iterate.com/agents/context-added" &&
        (event.payload as { role?: unknown }).role === "developer",
    );
    expect(turn).toBeDefined();
    const turnPayload = turn!.payload as {
      role: "developer";
      actor: { type: "github"; login?: string };
      content: string;
      llmRequestPolicy: { behaviour: string };
    };
    expect(turnPayload).toMatchObject({
      role: "developer",
      actor: { type: "github", login: "jonastemplestein" },
    });
    expect(turnPayload.content).toContain("@iterate can you see this?");
    expect(turnPayload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });
    expect(reactions).toEqual([
      {
        connection: "install-115079265",
        kind: "issue-comment",
        owner: "iterate",
        repo: "iterate",
        targetId: 4962404485,
      },
    ]);
    expect(legacyAgent.events).toEqual(fixture.legacyTargetEvents);
  });
});
