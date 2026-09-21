import { expect, test } from "vitest";
import { makeProcessorHarness } from "iterate/processors/testing";
import { KEEPALIVE_ALARM_LEAD_MS } from "iterate/processors";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";

test("new messages wait for project context before their first answering request", async () => {
  const prepared = Promise.withResolvers<{ content: string; metadata: object }>();
  const calls: any[] = [];
  const inputs: any[] = [];
  const h = makeProcessorHarness<AgentProcessorContract>({
    path: "/agents/docs",
    createProcessor: (deps) =>
      new AgentProcessor({
        ...deps,
        prepareContext: async (input) => {
          inputs.push(input);
          return prepared.promise;
        },
        callLlm: async (input) => {
          calls.push(input);
          return { text: "done" };
        },
      }),
  });
  await h.play([
    "append",
    { type: "events.iterate.com/agent/created", payload: {} },
    {
      type: "events.iterate.com/agent/configured",
      payload: {
        config: {
          llm: { model: "test" },
          llmRequestDebounceMs: 0,
          contextPreparation: {
            workerMethod: ["documentation", "prepare"],
            timeoutMs: 1000,
          },
        },
      },
    },
    {
      type: "events.iterate.com/agents/context-added",
      payload: { role: "user", content: "How do I upload a file?" },
    },
  ]);
  expect(inputs).toMatchObject([{ messages: [{ content: "How do I upload a file?" }] }]);
  expect(calls).toEqual([]);
  await h.play(() =>
    prepared.resolve({
      content: "Use itx.files.get(path).put({ data })",
      metadata: { selected: ["Files"] },
    }),
  );
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls[0].messages)).toContain("itx.files.get(path).put");
});

test("a new message arriving during selection cannot use the older preparation to start its request", async () => {
  const first = Promise.withResolvers<any>();
  const second = Promise.withResolvers<any>();
  const calls: any[] = [];
  const h = contextHarness(
    async (input) => (input.messages.length === 1 ? first.promise : second.promise),
    calls,
  );
  await start(h, "Upload an image");
  await h.play([
    "append",
    {
      type: "events.iterate.com/agents/context-added",
      payload: { role: "user", content: "Also email its link" },
    },
  ]);
  await h.play(() => first.resolve({ content: "stale selection", metadata: {} }));
  expect(calls).toEqual([]);
  await h.play(() => second.resolve({ content: "Files and Email APIs", metadata: {} }));
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls[0].messages)).toContain("Files and Email APIs");
  expect(JSON.stringify(calls[0].messages)).not.toContain("stale selection");
});

test("a later message selects new docs, while script continuation does not rerun selection", async () => {
  const calls: any[] = [];
  const queries: any[] = [];
  const h = contextHarness(async (input) => {
    queries.push(input.messages);
    return { content: `docs: ${input.messages.at(-1).content}`, metadata: {} };
  }, calls);
  await start(h, "Upload an image");
  await h.play([
    "append",
    {
      type: "events.iterate.com/agents/context-added",
      payload: {
        role: "developer",
        actor: { type: "script", executionId: "upload" },
        content: "Uploaded",
      },
    },
  ]);
  expect(calls).toHaveLength(2);
  expect(queries).toHaveLength(1);
  await h.play([
    "append",
    {
      type: "events.iterate.com/agents/context-added",
      payload: { role: "user", content: "Schedule a reminder" },
    },
  ]);
  expect(queries).toEqual([
    [{ role: "user", content: "Upload an image" }],
    [{ role: "user", content: "Schedule a reminder" }],
  ]);
  expect(JSON.stringify(calls[2].messages)).toContain("docs: Schedule a reminder");
});

test.each(["error", "timeout", "malformed"])(
  "preparation %s records the outcome and permits one answering request",
  async (mode) => {
    const calls: any[] = [];
    const h = contextHarness(async () => {
      if (mode === "error") throw new Error("Jev unavailable");
      if (mode === "timeout") return new Promise(() => {});
      return { content: 123 };
    }, calls);
    await start(h, "Upload an image");
    // Real timer: this exercises the bounded external-RPC deadline, not the virtual debounce clock.
    await expect
      .poll(async () => {
        await h.settle();
        return calls.length;
      })
      .toBe(1);
    expect(h.events("events.iterate.com/agent/context-prepared")).toMatchObject([
      {
        payload: {
          status: mode === "timeout" ? "timed-out" : "failed",
          metadata: { error: expect.any(String) },
        },
      },
    ]);
    expect(JSON.stringify(calls[0].messages)).toContain("documentation could not be prepared");
  },
);

test("eviction while selecting docs retries preparation before one answering request", async () => {
  const lost = Promise.withResolvers<any>();
  const calls: any[] = [];
  let attempts = 0;
  const h = contextHarness(async () => {
    attempts++;
    return attempts === 1 ? lost.promise : { content: "Recovered documentation", metadata: {} };
  }, calls);
  await start(h, "Upload an image");
  expect(calls).toEqual([]);
  await h.play(["crash"], ["advanceTime", KEEPALIVE_ALARM_LEAD_MS + 1]);
  expect(attempts).toBe(2);
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls[0].messages)).toContain("Recovered documentation");
  await h.play(() => lost.resolve({ content: "Late result from dead worker", metadata: {} }));
  expect(h.events("events.iterate.com/agent/llm-request-requested")).toHaveLength(1);
});

test.each([
  { type: "slack", userId: "U123" },
  { type: "telegram", userId: "123" },
  { type: "email", address: "sender@iterate.com" },
  { type: "github", login: "sender" },
  { type: "integration", name: "custom-inbox" },
  { type: "agent", path: "/agents/sender" },
])(
  "incoming $type messages select docs even though their stored role is developer",
  async (actor) => {
    const inputs: any[] = [];
    const calls: any[] = [];
    const h = contextHarness(async (input) => {
      inputs.push(input.messages);
      return { content: "File storage documentation", metadata: {} };
    }, calls);
    await start(h, "Previous turn");
    inputs.length = 0;
    calls.length = 0;
    await h.play([
      "append",
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "developer",
          actor: actor as any,
          content: "How do I store an image?",
        },
      },
    ]);
    expect(inputs).toEqual([[{ role: "developer", content: "How do I store an image?" }]]);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].messages)).toContain("File storage documentation");
  },
);

function contextHarness(prepareContext: (input: any) => Promise<any>, calls: any[]) {
  return makeProcessorHarness<AgentProcessorContract>({
    path: "/agents/docs",
    createProcessor: (deps) =>
      new AgentProcessor({
        ...deps,
        prepareContext,
        callLlm: async (input) => {
          calls.push(input);
          return { text: "done" };
        },
      }),
  });
}

async function start(h: ReturnType<typeof contextHarness>, content: string) {
  await h.play([
    "append",
    { type: "events.iterate.com/agent/created", payload: {} },
    {
      type: "events.iterate.com/agent/configured",
      payload: {
        config: {
          llm: { model: "test" },
          llmRequestDebounceMs: 0,
          contextPreparation: { workerMethod: ["documentation", "prepare"], timeoutMs: 50 },
        },
      },
    },
    { type: "events.iterate.com/agents/context-added", payload: { role: "user", content } },
  ]);
}
