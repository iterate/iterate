import { describe, expect, it } from "vitest";
import { GithubAgentProcessor } from "../../repos/github-agent-processor-implementation.ts";
import type { StreamEvent } from "../../streams/schemas.ts";
import { deliverNewEvents, MemoryStream } from "../test-helpers.ts";
import fixture from "./iterate-pr-1945-review-mention-contributor.json";

describe("production stream repro: iterate PR 1945 review mention was treated as an outsider", () => {
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

    await deliverNewEvents({ processor, stream, cursors: new Map() });

    const turn = stream.events.find(
      (event) => event.type === "events.iterate.com/agents/message-received",
    );
    expect(turn).toBeDefined();
    expect(turn?.payload).toMatchObject({
      from: { kind: "github", login: "jonastemplestein", senderType: "User" },
      llmRequestPolicy: { behaviour: "after-current-request" },
    });
    expect((turn?.payload as { content: string }).content).toContain(
      "@iterate Please reply with one concise PR comment",
    );
    expect((turn?.payload as { content: string }).content).toContain(
      "trustedInstructionSource: true",
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
});
