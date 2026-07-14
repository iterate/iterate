import { expect, test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";
import { appendEvents } from "../test-support/append-events.ts";

const HISTORY_RESET = "events.iterate.com/agent/history-reset";
const INPUT_ADDED = "events.iterate.com/agent/input-added";

test("agent checkpoint reconstructs chunked history after eviction and catches up new writes", async () => {
  await using handle = await createTestProject({ slugPrefix: "agent-checkpoint" });
  using itx = handle.itx();
  const agent = itx.agents.get(`/agents/checkpoint-${crypto.randomUUID()}`);
  const history = Array.from({ length: 320 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `${index}:`.padEnd(512, "x"),
  }));
  const [reset] = await appendEvents(agent.stream, {
    type: HISTORY_RESET,
    payload: { history, systemPrompt: "checkpoint eviction test" },
  });
  await agent.processor.waitUntilEvent({ offset: reset!.offset, timeoutMs: 30_000 });

  await killAgent(agent);
  const reactivated = await agent.processor.snapshot();
  expect(reactivated.offset).toBeGreaterThanOrEqual(reset!.offset);
  expect(reactivated.state).toMatchObject({ history });

  const [appended] = await appendEvents(agent.stream, {
    type: INPUT_ADDED,
    payload: {
      content: "after eviction",
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    },
  });
  const caughtUp = await agent.processor.snapshot();
  expect(caughtUp.offset).toBeGreaterThanOrEqual(appended!.offset);
  expect(caughtUp.state.history.at(-1)).toEqual({ role: "user", content: "after eviction" });

  await killAgent(agent);
  expect((await agent.processor.snapshot()).state).toMatchObject({
    history: caughtUp.state.history,
  });
});

async function killAgent(agent: { kill(): Promise<void> }): Promise<void> {
  try {
    await agent.kill();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("kill requested")) throw error;
  }
}
