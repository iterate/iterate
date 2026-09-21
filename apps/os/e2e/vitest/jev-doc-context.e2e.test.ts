import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";

test("Jev template injects real Iterate docs into the first request for each normal chat message", async () => {
  await using fixture = await createTestProject({ slugPrefix: "jev-docs" });
  using project = fixture.itx();
  // Commit the actual checked-in template through the public repo API. This
  // exercises the current working tree too; no published branch or PR is needed.
  await project.repo.commitFiles({
    message: "Install the Jev documentation experiment",
    changes: ["worker.ts", "documentation.ts", "AGENTS.md"].map((path) => ({
      path,
      content: readFileSync(
        new URL(`../../../../configs/jev-docs/${path}`, import.meta.url),
        "utf8",
      ),
    })),
  });
  // Loading the worker here proves its source built before we create an agent.
  expect(
    await project.worker.invokeCapability({
      path: ["documentation", "prepare"],
      args: [{ agentPath: "/", messages: [] }],
    }),
  ).toMatchObject({ metadata: { selected: [] } });

  const requests: any[] = [];
  using _interception = await project.ai.intercept(async (call) => {
    // Jev is real; only the answering model is replaced so we can inspect the
    // exact first request without a second model's nondeterminism or tool calls.
    expect(call).toMatchObject({ source: "agent-turn" });
    requests.push(call.request.body);
    return Response.json({ response: "Documentation received." });
  });
  using agent = await project.agents.get("/agents/documentation-proof").create();
  await agent.append({
    type: "events.iterate.com/agent/configured",
    payload: {
      config: { llm: { model: "intercepted/@cf/meta/llama-3.1-8b-instruct" } },
    },
  });

  for (const [index, message] of [
    "How do I upload image bytes to project file storage and get a signed download URL?",
    "How do I schedule a recurring reminder every fifteen minutes and cancel the schedule later?",
  ].entries()) {
    const sent = await agent.message(message);
    const settled = await agent.stream.waitForEvent({
      afterOffset: sent.offset,
      // Includes the template's bounded 10-second selection plus request dispatch.
      timeoutMs: 30_000,
      eventTypes: ["events.iterate.com/agent/llm-request-settled"],
    });
    expect(settled).toMatchObject({ payload: { result: { status: "succeeded" } } });
    expect(requests).toHaveLength(index + 1);
    const events = await agent.stream.getEvents({ afterOffset: sent.offset });
    const prepared = events.find(
      (event) => event.type === "events.iterate.com/agent/context-prepared",
    )!;
    const requested = events.find(
      (event) => event.type === "events.iterate.com/agent/llm-request-requested",
    )!;
    expect(prepared).toMatchObject({
      payload: {
        status: "succeeded",
        metadata: { model: expect.stringContaining("jev"), selected: expect.any(Array) },
      },
    });
    expect(prepared.offset).toBeLessThan(requested.offset);
    const selection = prepared.payload as any;
    expect(selection.metadata.selected.length).toBeGreaterThan(0);
    expect(selection.metadata.selected.length).toBeLessThanOrEqual(3);
    expect(requests[index].messages.map((message: any) => message.content).join("\n")).toContain(
      selection.content,
    );
    expect(selection.content).toMatch(index === 0 ? /file|upload/i : /schedul/i);
    expect(
      events.filter((event) => event.type === "events.iterate.com/stream/error-occurred"),
    ).toEqual([]);
    console.info("Jev context evidence", {
      project: fixture.project.slug,
      message,
      preparedOffset: prepared.offset,
      requestOffset: requested.offset,
      durationMs: selection.durationMs,
      ...selection.metadata,
    });
  }
  const settled = (
    await agent.stream.getEvents({ eventTypes: ["events.iterate.com/agent/llm-request-settled"] })
  ).at(-1)!;
  await agent.processor.waitUntilProcessed({ offset: settled.offset, timeoutMs: 10_000 });
  expect((await agent.processor.snapshot()).state).toMatchObject({
    openRequest: null,
    pendingLlmRequestTrigger: null,
    consecutiveLlmFailures: 0,
  });
  for (const path of ["/", "/repos/config", "/agents/documentation-proof"]) {
    expect(
      await project.streams.get(path).getEvents({
        eventTypes: [
          "events.iterate.com/stream/error-occurred",
          "events.iterate.com/stream/subscription-delivery-halted",
        ],
      }),
    ).toEqual([]);
  }
});
