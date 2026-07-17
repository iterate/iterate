import { test } from "vitest";
import fixture from "../../src/domains/agents/stream-repros/boop-web-2026-07-15t21-56-48-076z-slow-script-execution.json";
import { createTestProject } from "../test-support/create-test-project.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";

const MAX_REQUEST_TO_VISIBLE_MESSAGE_MS = 2_500;

test(
  "the exact boop tiny chat script reaches the visible-message event promptly",
  { timeout: 60_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "tiny-chat-latency" });
    using project = handle.itx();
    const agentPath = `/agents/web/${crypto.randomUUID()}`;
    using agent = project.agents.get(agentPath);
    await agent.create();

    const code = String(fixture.events[0]!.payload.code);
    const wallStartedAt = performance.now();
    const execution = await agent.capabilityHost.runScript(code);
    const wallMs = Math.round(performance.now() - wallStartedAt);

    const events = await agent.stream.getEvents({ afterOffset: 0 });
    const requested = events.find(
      (event) =>
        event.type === "events.iterate.com/capability-host/script-run-requested" &&
        event.payload?.executionId === execution.executionId,
    );
    const visibleMessage = events.find(
      (event) =>
        event.type === "events.iterate.com/agents/web-message-sent" &&
        event.payload?.message === "Yo dawg 👋 What’s up?",
    );

    expect(requested).toBeDefined();
    expect(visibleMessage).toBeDefined();
    const requestToVisibleMessageMs =
      Date.parse(visibleMessage!.createdAt) - Date.parse(requested!.createdAt);
    const requestToSettlementMs =
      Date.parse(execution.completedEvent.createdAt) - Date.parse(requested!.createdAt);

    console.info(
      "tiny-agent-script-latency",
      JSON.stringify({
        agentPath,
        executionId: execution.executionId,
        projectId: handle.project.id,
        requestToSettlementMs,
        requestToVisibleMessageMs,
        wallMs,
      }),
    );

    expect(requestToVisibleMessageMs).toBeLessThan(MAX_REQUEST_TO_VISIBLE_MESSAGE_MS);

    // The latency fix moves only the derived search projection out of the
    // producer's response gate. It must still catch up durably after its
    // bounded window; otherwise a fast script would be hiding lost work.
    let searchProjection: { ackedOffset?: number; lag?: number } | undefined;
    await waitForCondition(
      async () => {
        const state = (await agent.stream.runtimeState()) as {
          runtime?: {
            subscriptions?: Record<string, { ackedOffset?: number; lag?: number }>;
          };
        };
        searchProjection = state.runtime?.subscriptions?.["platform-search-index"];
        return (
          searchProjection?.lag === 0 &&
          (searchProjection.ackedOffset ?? -1) >= execution.completedEvent.offset
        );
      },
      {
        description: () =>
          `the platform search projection to catch up through offset ${execution.completedEvent.offset} (latest ${JSON.stringify(searchProjection)})`,
        timeoutMs: 15_000,
      },
    );
    console.info(
      "tiny-agent-script-search-projection",
      JSON.stringify({
        acknowledgedOffset: searchProjection!.ackedOffset,
        completionOffset: execution.completedEvent.offset,
        lag: searchProjection!.lag,
      }),
    );
  },
);
