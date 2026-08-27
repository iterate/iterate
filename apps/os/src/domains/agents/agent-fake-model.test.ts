// intercepted/* models through the agent processor: attempts on an intercepted/*
// model are served by the host's consultAiInterceptor dep (in production, the
// project's live itx.ai.intercept handler) instead of any provider dial. Same
// generic step harness as agent-processor.test.ts; the interceptor here is an
// ordinary in-test async function — exactly what a live capnweb handler is.

import { expect, test } from "vitest";
import { makeProcessorHarness } from "iterate/processors/testing";
import type { ConsumedInput } from "iterate/processors";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AgentProcessor, type AgentProcessorDeps } from "./agent-processor-implementation.ts";

const REQUESTED = "events.iterate.com/agent/llm-request-requested";
const SETTLED = "events.iterate.com/agent/llm-request-settled";
const RESPONSE_CHUNK = "events.iterate.com/agent/llm-response-chunk";
const RESPONSE_CHUNKS = "events.iterate.com/agent/llm-response-chunks";

test("an intercepted/* turn is served by the interceptor: prompt in, text out, usage estimated, chunks journaled", async () => {
  const seen: { source: string; model: string; body: { messages: { content: string }[] } }[] = [];
  const h = makeInterceptedModelHarness(async (input) => {
    seen.push(input as never);
    return "well well well, look who needs a deterministic model";
  });

  await h.play(
    ["append", ...newFakeAgentEvents("intercepted/main"), userMessage("Hello fake model")],
    ["advanceTime", 10_000],
  );

  expect(seen).toMatchObject([{ source: "agent-turn", model: "intercepted/main" }]);
  expect(seen[0]!.body.messages.some((m) => m.content.includes("Hello fake model"))).toBe(true);

  const requested = h.events(REQUESTED)[0]!;
  expect(h.events(SETTLED)).toMatchObject([
    {
      payload: {
        requestOffset: requested.offset,
        result: {
          status: "succeeded",
          text: "well well well, look who needs a deterministic model",
        },
      },
    },
  ]);
  // Usage was estimated from text length (~4 chars/token), not invented by the handler.
  expect(h.events("events.iterate.com/agent/token-usage-reported")).toMatchObject([
    { payload: { model: "intercepted/main", outputTokens: 13 } },
  ]);
  // Word-split chunk delivery kept journaled chunks flowing — coalesced into
  // windowed llm-response-chunks events, never the legacy singular type.
  const chunkWindows = h.events(RESPONSE_CHUNKS);
  expect(chunkWindows.flatMap((event) => event.payload.chunks as unknown[]).length).toBeGreaterThan(
    1,
  );
  expect(h.events(RESPONSE_CHUNK)).toEqual([]);
});

test("a handler returning { text, usage } reports that usage verbatim", async () => {
  const h = makeInterceptedModelHarness(async () => ({
    text: "counted precisely",
    usage: { inputTokens: 123_456, outputTokens: 7 },
  }));

  await h.play(
    ["append", ...newFakeAgentEvents("intercepted/main"), userMessage("count your tokens")],
    ["advanceTime", 10_000],
  );

  expect(h.events("events.iterate.com/agent/token-usage-reported")).toMatchObject([
    { payload: { inputTokens: 123_456, outputTokens: 7 } },
  ]);
});

test("an intercepted/* model with no interceptor consult dep fails the attempt with the canonical loud error", async () => {
  // No consultAiInterceptor dep at all — the bare-host analogue of "nothing
  // installed": the attempt must fail recorded, not hang or dial anything.
  const h = makeInterceptedModelHarness(undefined);

  await h.play(
    ["append", ...newFakeAgentEvents("intercepted/anything"), userMessage("anyone there?")],
    ["advanceTime", 10_000],
  );

  expect(h.events(SETTLED)).toMatchObject([{ payload: { result: { status: "failed" } } }]);
  expect((h.events(SETTLED)[0]!.payload as any).result.errorMessage).toContain(
    'No AI interceptor installed for "intercepted/anything"',
  );
});

test("a rejecting interceptor (handler died with its session) fails the attempt recorded", async () => {
  const h = makeInterceptedModelHarness(async () => {
    throw new Error("RPC session lost");
  });

  await h.play(
    ["append", ...newFakeAgentEvents("intercepted/main"), userMessage("still there?")],
    ["advanceTime", 10_000],
  );

  expect(h.events(SETTLED)).toMatchObject([
    { payload: { result: { status: "failed", errorMessage: "RPC session lost" } } },
  ]);
});

test("callLlm outranks the interceptor: a scripted transport takes intercepted/* attempts too", async () => {
  // Unit suites script EVERYTHING through callLlm regardless of model string;
  // the intercepted-model branch must sit behind that dependency, not in front of it.
  let interceptorCalls = 0;
  const h = makeProcessorHarness<AgentProcessorContract>({
    createProcessor: (deps) =>
      new AgentProcessor({
        ...deps,
        callLlm: async () => ({ text: "scripted wins" }),
        consultAiInterceptor: async () => {
          interceptorCalls++;
          return "interceptor should not run";
        },
      }),
    path: "/agents/test",
  });

  await h.play(
    ["append", ...newFakeAgentEvents("intercepted/main"), userMessage("who answers?")],
    ["advanceTime", 10_000],
  );

  expect(interceptorCalls).toBe(0);
  expect(h.events(SETTLED)).toMatchObject([
    { payload: { result: { status: "succeeded", text: "scripted wins" } } },
  ]);
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type AgentEventInput = ConsumedInput<AgentProcessorContract>;

function newFakeAgentEvents(model: string): AgentEventInput[] {
  return [
    { type: "events.iterate.com/agent/created", payload: {} },
    { type: "events.iterate.com/agent/configured", payload: { config: { llm: { model } } } },
    {
      type: "events.iterate.com/agents/context-added",
      payload: {
        role: "system",
        key: "agent/system-prompt",
        content: "You are a fake test agent.",
      },
    },
  ];
}

function userMessage(content: string): AgentEventInput {
  return {
    type: "events.iterate.com/agents/context-added",
    payload: {
      role: "user",
      content,
      actor: { type: "user", origin: "web" },
      llmRequestPolicy: { behaviour: "after-current-request" },
    },
  };
}

/** Harness with NO callLlm (so the intercepted-model branch is reachable) and the given interceptor consult. */
function makeInterceptedModelHarness(
  consultAiInterceptor: AgentProcessorDeps["consultAiInterceptor"],
) {
  return makeProcessorHarness<AgentProcessorContract>({
    createProcessor: (deps) =>
      new AgentProcessor({
        ...deps,
        ...(consultAiInterceptor === undefined ? {} : { consultAiInterceptor }),
      }),
    path: "/agents/test",
  });
}
