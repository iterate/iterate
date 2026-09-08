import { expect, test } from "vitest";
import { makeProcessorHarness } from "iterate/processors/testing";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";

test("a budget stop settles once, survives restart and new input, and resumes only on an explicit retry", async () => {
  let calls = 0;
  const h = makeProcessorHarness<AgentProcessorContract>({
    path: "/agents/budget",
    createProcessor: (deps) =>
      new AgentProcessor({
        ...deps,
        callLlm: async () => {
          calls++;
          return {
            status: "budget-exhausted",
            budget: { provider: "openai", ruleId: null, resetsAt: null },
          };
        },
      }),
  });
  await h.play(
    [
      "append",
      { type: "events.iterate.com/agent/created", payload: {} },
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "user",
          content: "Hello",
          actor: { type: "user", origin: "web" },
        },
      },
    ],
    ["advanceTime", 10_000],
  );
  expect(h.events("events.iterate.com/agent/llm-request-settled")).toMatchObject([
    { payload: { result: { status: "budget-exhausted" } } },
  ]);
  expect(h.state()).toMatchObject({
    openRequest: null,
    consecutiveLlmFailures: 0,
    paused: { budget: { provider: "openai" } },
  });
  expect(h.events("events.iterate.com/stream/error-occurred")).toEqual([]);
  const pauseOffset = h.state().paused!.atOffset;
  await h.play(
    ["crash"],
    ["advanceTime", 60_000],
    [
      "append",
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "user",
          content: "Another message",
          actor: { type: "user", origin: "web" },
        },
      },
    ],
    ["advanceTime", 60_000],
  );
  expect(calls).toBe(1);
  await h.play(
    [
      "append",
      { type: "events.iterate.com/agent/resumed", payload: { budgetPauseOffset: pauseOffset - 1 } },
    ],
    ["advanceTime", 60_000],
  );
  expect(calls).toBe(1);
  await h.play(
    [
      "append",
      { type: "events.iterate.com/agent/resumed", payload: { budgetPauseOffset: pauseOffset } },
    ],
    ["advanceTime", 60_000],
  );
  expect(calls).toBe(2);
  expect(h.events("events.iterate.com/agent/llm-request-settled")).toHaveLength(2);
});

test("automatic retries share cost attribution while a fresh operation gets its own offset", async () => {
  let calls = 0;
  const h = makeProcessorHarness<AgentProcessorContract>({
    path: "/agents/budget",
    createProcessor: (deps) =>
      new AgentProcessor({
        ...deps,
        callLlm: async () => {
          calls++;
          if (calls === 1) throw new Error("temporary provider failure");
          return { text: "Done" };
        },
      }),
  });
  await h.play(
    [
      "append",
      { type: "events.iterate.com/agent/created", payload: {} },
      {
        type: "events.iterate.com/agents/context-added",
        payload: { role: "user", content: "Hello", actor: { type: "user", origin: "web" } },
      },
    ],
    ["advanceTime", 10_000],
  );
  const first = h.events("events.iterate.com/agent/llm-request-requested")[0]!;
  await h.play(["advanceTime", 60_000]);
  expect(calls).toBeGreaterThanOrEqual(2);
  await h.play(
    [
      "append",
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "user",
          content: "A fresh operation",
          actor: { type: "user", origin: "web" },
        },
      },
    ],
    ["advanceTime", 10_000],
  );
  const fresh = h.events("events.iterate.com/agent/llm-request-requested").at(-1)!;
  // Replay the actual requested/settled journal; the reducer carries original attribution through retry triggers.
  const { reduceAgentEvent } = await import("./agent-prompt-fold.ts");
  let state = AgentProcessorContract.stateSchema.parse({});
  const requests: any[] = [];
  for (const event of h.stream.events) {
    if (!AgentProcessorContract.consumes.includes(event.type as any)) continue;
    state = reduceAgentEvent({ state, event: AgentProcessorContract.parseEvent(event) });
    if (event.type === "events.iterate.com/agent/llm-request-requested")
      requests.push(state.openRequest);
  }
  expect(requests.at(-1)).toMatchObject({
    requestedAtOffset: fresh.offset,
    costEventOffset: fresh.offset,
  });
  expect(fresh.offset).toBeGreaterThan(first.offset);
  expect(requests.slice(0, 2)).toMatchObject([
    { requestedAtOffset: first.offset, costEventOffset: first.offset },
    { costEventOffset: first.offset },
  ]);
});

test("rate limits use bounded retries without budget pauses or generic stream errors", async () => {
  let calls = 0;
  const h = makeProcessorHarness<AgentProcessorContract>({
    path: "/agents/rate",
    createProcessor: (deps) =>
      new AgentProcessor({
        ...deps,
        callLlm: async () => {
          calls++;
          return { status: "rate-limited", retryAfterMs: 1000 };
        },
      }),
  });
  await h.play(
    [
      "append",
      { type: "events.iterate.com/agent/created", payload: {} },
      {
        type: "events.iterate.com/agents/context-added",
        payload: { role: "user", content: "Hello", actor: { type: "user", origin: "web" } },
      },
    ],
    ["advanceTime", 600_000],
  );
  expect(calls).toBe(h.state().config.llmRequestRetryPolicy.maxAttempts);
  expect(h.state()).toMatchObject({
    paused: null,
    openRequest: null,
    pendingLlmRequestTrigger: null,
  });
  expect(h.events("events.iterate.com/stream/error-occurred")).toEqual([]);
});

test("a crash after the compaction budget stop commits cannot repeat its provider call", async () => {
  let calls = 0;
  const h = makeProcessorHarness<AgentProcessorContract>({
    path: "/agents/compaction-budget",
    createProcessor: (deps) =>
      new AgentProcessor({
        ...deps,
        callLlm: async () => {
          calls++;
          return calls === 1
            ? { text: "An answer to compact" }
            : {
                status: "budget-exhausted",
                budget: { provider: "openai", ruleId: "project", resetsAt: null },
              };
        },
      }),
  });
  await h.play(
    [
      "append",
      { type: "events.iterate.com/agent/created", payload: {} },
      {
        type: "events.iterate.com/agents/context-added",
        payload: { role: "user", content: "Hello", actor: { type: "user", origin: "web" } },
      },
    ],
    ["advanceTime", 10_000],
  );
  const requestOffset = h.events("events.iterate.com/agent/llm-request-requested")[0]!.offset;
  const commit = h.stream.append.bind(h.stream);
  let crashed = false;
  h.stream.append = async (...events) => {
    const result = await commit(...events);
    if (
      !crashed &&
      events.some((event) => event.type === "events.iterate.com/agent/compaction-stopped")
    ) {
      crashed = true;
      h.crash();
    }
    return result;
  };
  await h.play([
    "append",
    {
      type: "events.iterate.com/agent/token-usage-reported",
      payload: {
        llmRequestOffset: requestOffset,
        model: "test",
        inputTokens: 900,
        outputTokens: 50,
        maxContextTokens: 1000,
      },
    },
  ]);
  await h.play(["crash"], ["advanceTime", 600_000]);
  expect(crashed).toBe(true);
  expect(calls).toBe(2);
  expect(h.events("events.iterate.com/agent/compaction-stopped")).toHaveLength(1);
  expect(h.state()).toMatchObject({ paused: { budget: { ruleId: "project" } } });
});
