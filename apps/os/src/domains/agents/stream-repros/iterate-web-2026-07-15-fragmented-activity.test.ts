import { expect, it } from "vitest";
import {
  initialAgentUiState,
  reduceAgentUi,
  type AgentUiItem,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import fixture from "./iterate-web-2026-07-15-fragmented-activity.json";

it("groups the production autonomous loop into one activity at run-level idle", () => {
  // Exact production offsets/times/ids from the reported stream, reduced only
  // to fields the UI lens reads. Production never reached idle because its
  // final script hung; the terminal status below is the fact a bounded run
  // produces after its last step settles.
  const terminalStatus = {
    type: "events.iterate.com/agent/status-changed",
    payload: { busy: false, sinceOffset: 13860 },
    offset: 13861,
    createdAt: "2026-07-15T20:30:06.550Z",
    path: fixture.agentPath,
  };
  let state = initialAgentUiState();
  const items: AgentUiItem[] = [];

  for (const event of [...fixture.events, terminalStatus].map((entry) => ({
    ...entry,
    streamPath: fixture.agentPath,
  }))) {
    const reduced = reduceAgentUi(state, event);
    state = reduced.endState;
    items.push(...reduced.items);
  }

  const activities = items.filter((item) => item.kind === "activity");
  expect(activities).toHaveLength(1);
  expect(activities[0]).toMatchObject({
    kind: "activity",
    status: "done",
    steps: [
      { kind: "llm", llmRequestOffset: 13352, status: "done" },
      { kind: "code", executionId: "agent-output:13647", status: "done" },
      { kind: "llm", llmRequestOffset: 13657, status: "done" },
      { kind: "code", executionId: "agent-output:13854", status: "done" },
    ],
  });
  expect(state.live).toBeNull();
});

it("settles the production script that had passed its deadline before the next user message", () => {
  let state = initialAgentUiState();
  const items: AgentUiItem[] = [];

  for (const event of fixture.overdueExecutionEvents.map((entry) => ({
    ...entry,
    streamPath: fixture.agentPath,
  }))) {
    const reduced = reduceAgentUi(state, event);
    state = reduced.endState;
    items.push(...reduced.items);
  }

  expect(items).toMatchObject([
    {
      kind: "activity",
      status: "done",
      steps: [
        {
          kind: "code",
          executionId: "agent-output:13980",
          status: "done",
          success: false,
          errorMessage: expect.stringContaining("deadline"),
        },
      ],
    },
    { kind: "user", text: "hello?" },
  ]);
  expect(state.live).toBeNull();
  expect(state.queuedUserMessages).toEqual([]);
});
