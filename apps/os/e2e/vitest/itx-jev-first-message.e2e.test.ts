import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";

test("the userland Jev template spends at most one first-message window and restores normal chat", async () => {
  await using fixture = await createTestProject({ slugPrefix: "jev-first" });
  using project = fixture.itx();
  await project.repo.commitFiles({
    message: "Install first-message Jev template",
    changes: ["worker.ts", "documentation.ts", "AGENTS.md"].map((path) => ({
      path,
      content: readFileSync(
        new URL(`../../../../configs/jev-docs/${path}`, import.meta.url),
        "utf8",
      ),
    })),
  });
  // Build the actual template before agent creation. An empty query does not call Jev.
  expect(
    await project.worker.invokeCapability({
      path: ["documentation", "prepare"],
      args: [{ agentPath: "/", messages: [] }],
    }),
  ).toMatchObject({ metadata: { selected: [] } });

  const requests: any[] = [];
  using _interception = await project.ai.intercept(async (call) => {
    // Jev is real. Capture only the answering model's exact request.
    expect(call).toMatchObject({ source: "agent-turn" });
    requests.push(call.request.body);
    return Response.json({ response: "Documentation received." });
  });
  using agent = await project.agents.get("/agents/first-message").create();
  await agent.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "intercepted/@cf/meta/llama-3.1-8b-instruct" } } },
  });
  const sent = await agent.message(
    "How do I upload image bytes to project file storage and get a signed download URL?",
  );
  const prepared = await agent.stream.waitForEvent({
    afterOffset: sent.offset,
    // Includes project-worker delivery and the one-second selection budget.
    timeoutMs: 10_000,
    eventTypes: ["events.iterate.com/jev-docs/settled"],
  });
  const firstSettled = await agent.stream.waitForEvent({
    afterOffset: sent.offset,
    // Includes request dispatch and transport through the live interceptor.
    timeoutMs: 10_000,
    eventTypes: ["events.iterate.com/agent/llm-request-settled"],
  });
  expect(firstSettled).toMatchObject({ payload: { result: { status: "succeeded" } } });
  expect(requests).toHaveLength(1);
  // A slow external model is an explicitly supported deadline outcome, not
  // a reason to retry the test or lengthen the first-message budget.
  expect(["selected", "timed-out"]).toContain(prepared.payload?.status);
  const events = await agent.stream.getEvents({ afterOffset: sent.offset });
  const context = events.find((event) => event.idempotencyKey === "jev-docs/context:v1");
  const requested = events.find(
    (event) => event.type === "events.iterate.com/agent/llm-request-requested",
  )!;
  if (prepared.payload?.status === "selected") {
    expect(context!.offset).toBeLessThan(requested.offset);
    expect(requests[0].messages.map((message: any) => message.content).join("\n")).toContain(
      context!.payload!.content,
    );
    expect(prepared.payload).toMatchObject({
      model: expect.stringContaining("jev"),
      selected: expect.any(Array),
    });
  } else {
    expect(context).toBeUndefined();
  }
  const released = events.find((event) => event.idempotencyKey === "jev-docs/released:v1")!;
  await agent.processor.waitUntilProcessed({
    offset: Math.max(firstSettled.offset, released.offset),
  });
  expect((await agent.processor.snapshot()).state).toMatchObject({
    config: { llmRequestDebounceMs: 250 },
    openRequest: null,
    pendingLlmRequestTrigger: null,
  });

  const second = await agent.message(
    "How do I schedule a recurring reminder every fifteen minutes?",
  );
  const secondSettled = await agent.stream.waitForEvent({
    afterOffset: second.offset,
    // Includes request dispatch and transport through the live interceptor.
    timeoutMs: 10_000,
    eventTypes: ["events.iterate.com/agent/llm-request-settled"],
  });
  expect(secondSettled).toMatchObject({ payload: { result: { status: "succeeded" } } });
  expect(requests).toHaveLength(2);
  await agent.processor.waitUntilProcessed({ offset: secondSettled.offset });
  expect((await agent.processor.snapshot()).state).toMatchObject({
    config: { llmRequestDebounceMs: 250 },
    openRequest: null,
    pendingLlmRequestTrigger: null,
    consecutiveLlmFailures: 0,
  });
  expect(
    await agent.stream.getEvents({ eventTypes: ["events.iterate.com/jev-docs/started"] }),
  ).toHaveLength(1);
  expect(
    await agent.stream.getEvents({ eventTypes: ["events.iterate.com/jev-docs/settled"] }),
  ).toHaveLength(1);
  for (const path of ["/", "/repos/config", "/agents/first-message"]) {
    expect(
      await project.streams.get(path).getEvents({
        eventTypes: [
          "events.iterate.com/stream/error-occurred",
          "events.iterate.com/stream/subscription-delivery-halted",
        ],
      }),
    ).toEqual([]);
  }
  console.info("First-message Jev evidence", {
    project: fixture.project.slug,
    preparation: prepared.payload,
    contextOffset: context?.offset,
    requestOffset: requested.offset,
    requestDelayMs: Date.parse(requested.createdAt) - Date.parse(sent.createdAt),
  });
});
