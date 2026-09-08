import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import budgetFixture from "../apps/os/src/domains/agents/fixtures/cloudflare-budget-exceeded.json" with { type: "json" };
import { test } from "./test-support/test.ts";

test("budget stop stays visible across reload and new input, then explicit Retry resumes", async ({
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("agent-budget");
  const agent = await fixture.createAgent({ useRealLlm: true });
  await agent.append({
    type: "events.iterate.com/agent/configured",
    payload: {
      config: { llm: { model: "intercepted/openai/test" }, llmRequestDebounceMs: 250 },
    },
  });
  let calls = 0;
  await using _interception = await fixture.interceptAi(async (input) => {
    if (input.source !== "agent-turn") throw new Error(`Unexpected source ${input.source}`);
    calls++;
    assert.equal(input.request.headers.authorization, undefined);
    const metadata = JSON.parse(input.request.headers["cf-aig-metadata"]!);
    assert.equal(metadata.streamPath, agent.path);
    assert.deepEqual(Object.keys(metadata).sort(), [
      "environment",
      "projectId",
      "projectSlug",
      "streamPath",
    ]);
    if (calls === 1) return budgetFixture;
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        "data: " +
        JSON.stringify({
          choices: [
            {
              delta: {
                content: 'async (itx) => { await itx.chat.sendMessage("Budget retry succeeded") }',
              },
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    };
  });
  await page.goto(agent.webUrl);
  await page.getByPlaceholder("Message this agent").fill("Please start");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("Budget exhausted", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Budget exhausted", { exact: true }).waitFor();
  await page.getByPlaceholder("Message this agent").fill("More context while paused");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("More context while paused", { exact: true }).waitFor();
  expect(calls).toBe(1);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Budget retry succeeded", { exact: true }).waitFor();
  expect(calls).toBe(2);
});
