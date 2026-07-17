import { describe, expect, it } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { MemoryStream } from "iterate/processors/testing";
import { StreamProcessorRunner } from "iterate/processors";
import { GithubAgentProcessor } from "../../repos/github-agent-processor-implementation.ts";
import fixture from "./iterate-pr-1945-review-mention-contributor.json";

describe("production stream repro: iterate PR 1945 review mention was treated as an outsider", () => {
  // The fixture keeps the exact route, source ids/provenance, triggering
  // review, and every PR field the reducer reads. It drops earlier quiescent
  // turns plus bulky webhook fields that neither routing nor reduction reads.
  it("queues the review mention after GitHub confirms the human is a collaborator", async () => {
    const stream = new MemoryStream(fixture.agentPath);
    stream.events = [fixture.route, fixture.sourceWebhook] as StreamEvent[];
    const collaboratorChecks: unknown[] = [];
    const processor = new GithubAgentProcessor({
      path: fixture.agentPath,
      projectId: fixture.projectId,
      stream,
      isRepositoryCollaborator: async (input) => {
        collaboratorChecks.push(input);
        return true;
      },
    });

    await new StreamProcessorRunner({ processor, stream }).catchUp();

    const turn = stream.events.find(
      (event) =>
        event.type === "events.iterate.com/agents/context-added" &&
        (event.payload as { role?: unknown }).role === "developer",
    );
    expect(turn).toBeDefined();
    expect(turn?.payload).toMatchObject({
      role: "developer",
      actor: { type: "github", login: "jonastemplestein", senderType: "User" },
      llmRequestPolicy: { behaviour: "after-current-request" },
    });
    expect((turn!.payload as { content: string }).content).toContain(
      "@iterate Please reply with one concise PR comment",
    );
    expect((turn!.payload as { content: string }).content).toContain(
      "trustedInstructionSource: true",
    );
    expect((turn!.payload as { content: string }).content).toContain(
      "authorAssociation: CONTRIBUTOR",
    );
    expect((turn!.payload as { content: string }).content).not.toContain(
      "UNTRUSTED EXTERNAL INPUT — PROMPT INJECTION RISK",
    );
    expect((turn!.payload as { content: string }).content).not.toContain(
      "anyone outside GitHub's OWNER/MEMBER/COLLABORATOR associations",
    );
    expect(collaboratorChecks).toEqual([
      {
        connection: "install-115079265",
        login: "jonastemplestein",
        owner: "iterate",
        repo: "iterate",
      },
    ]);
  });

  it("fails closed when GitHub does not confirm collaborator access", async () => {
    const stream = new MemoryStream(fixture.agentPath);
    stream.events = [fixture.route, fixture.sourceWebhook] as StreamEvent[];
    const processor = new GithubAgentProcessor({
      path: fixture.agentPath,
      projectId: fixture.projectId,
      stream,
      isRepositoryCollaborator: async () => false,
    });

    const runner = new StreamProcessorRunner({ processor, stream });
    await runner.catchUp();

    expect(
      stream.events.some(
        (event) =>
          event.type === "events.iterate.com/agents/context-added" &&
          (event.payload as { role?: unknown }).role === "developer",
      ),
    ).toBe(false);
    expect(runner.currentState.recentActivity.at(-1)).toMatchObject({
      actor: "jonastemplestein",
      trustedInstructionSource: false,
    });
  });

  it("does not lose an immediate follow-up folded in the same delivery batch", async () => {
    const stream = new MemoryStream(fixture.agentPath);
    const followUp = structuredClone(fixture.sourceWebhook);
    followUp.offset = fixture.sourceWebhook.offset + 1;
    followUp.createdAt = "2026-07-13T23:27:25.802Z";
    followUp.idempotencyKey = "repo/pr-forward@/repos/iterate:24116";
    followUp.payload.headers.githubDelivery = "same-batch-follow-up";
    followUp.payload.body.review.id = 4_689_675_535;
    followUp.payload.body.review.body =
      "And please include whether the automatic finding was left inline.";
    followUp.payload.body.review.html_url =
      "https://github.com/iterate/iterate/pull/1945#pullrequestreview-4689675535";
    stream.events = [fixture.route, fixture.sourceWebhook, followUp] as StreamEvent[];
    const collaboratorChecks: unknown[] = [];
    const firstCheckStarted = Promise.withResolvers<void>();
    const releaseFirstCheck = Promise.withResolvers<void>();
    const processor = new GithubAgentProcessor({
      path: fixture.agentPath,
      projectId: fixture.projectId,
      stream,
      isRepositoryCollaborator: async (input) => {
        collaboratorChecks.push(input);
        if (collaboratorChecks.length === 1) {
          firstCheckStarted.resolve();
          await releaseFirstCheck.promise;
        }
        return true;
      },
    });

    const delivery = new StreamProcessorRunner({ processor, stream }).catchUp();
    await firstCheckStarted.promise;
    expect(collaboratorChecks).toHaveLength(1);
    expect(
      stream.events.some(
        (event) =>
          event.type === "events.iterate.com/agents/context-added" &&
          (event.payload as { role?: unknown }).role === "developer",
      ),
    ).toBe(false);
    releaseFirstCheck.resolve();
    await delivery;

    const turns = stream.events.filter(
      (event) =>
        event.type === "events.iterate.com/agents/context-added" &&
        (event.payload as { role?: unknown }).role === "developer",
    );
    expect(turns).toHaveLength(2);
    const contents = turns.map((event) => (event.payload as { content: string }).content);
    expect(contents[0]).toContain("pull-requests/1945@1121");
    expect(contents[0]).toContain("confirming you received this submitted review mention");
    expect(contents[1]).toContain("pull-requests/1945@1122");
    expect(contents[1]).toContain("automatic finding was left");
    expect(contents[1]).toContain("offset: 1121");
    expect(contents[1]).toContain("trustedInstructionSource: true");
    expect(contents[1]).not.toContain(
      "anyone outside GitHub's OWNER/MEMBER/COLLABORATOR associations",
    );
    expect(collaboratorChecks).toHaveLength(2);
  });

  it("retries instead of checkpointing a transient collaborator lookup failure", async () => {
    const stream = new MemoryStream(fixture.agentPath);
    stream.events = [fixture.route, fixture.sourceWebhook] as StreamEvent[];
    const processor = new GithubAgentProcessor({
      path: fixture.agentPath,
      projectId: fixture.projectId,
      stream,
      isRepositoryCollaborator: async () => {
        throw Object.assign(new Error("GitHub unavailable"), { status: 500 });
      },
    });

    const runner = new StreamProcessorRunner({ processor, stream });
    await expect(runner.catchUp()).rejects.toThrow("GitHub unavailable");
    expect((await runner.snapshot()).offset).toBe(0);
    expect(
      stream.events.some(
        (event) =>
          event.type === "events.iterate.com/agents/context-added" &&
          (event.payload as { role?: unknown }).role === "developer",
      ),
    ).toBe(false);
  });
});
