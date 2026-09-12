import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/processors";
import type { AgentHost } from "./agent-host.ts";
import { AgentLlmRequest } from "./agent-llm-request.ts";
import {
  buildAgentLlmRequestBody,
  buildAgentLlmRequestBodyFromState,
} from "./agent-prompt-fold.ts";

test("does not fetch past a page ending at the requested offset", async () => {
  const page = [
    event(1, "events.iterate.com/agents/context-added", {
      role: "user",
      content: "Only this prefix is needed.",
      actor: { type: "user", origin: "web" },
      llmRequestPolicy: { behaviour: "after-current-request" },
    }),
    event(2, "events.iterate.com/agent/llm-request-requested", {
      model: "test-model",
      expiresAt: Date.parse("2030-01-01T00:00:00Z"),
    }),
  ];
  let calls = 0;
  const request = new AgentLlmRequest(
    lazyHost(async () => {
      calls += 1;
      if (calls === 1) return page;
      throw new Error("reader fetched after a complete request page");
    }),
  );

  const state = await request.readPromptStateThrough(2);
  expect(buildAgentLlmRequestBodyFromState(state)).toEqual(
    buildAgentLlmRequestBody({ events: page, llmRequestOffset: 2 }),
  );
  expect(calls).toBe(1);
});

test("folding lazy raw-result pages retains only the prompt projection", async () => {
  const system = event(1, "events.iterate.com/agents/context-added", {
    role: "system",
    key: "agent/system-prompt",
    content: "Be concise.",
    llmRequestPolicy: { behaviour: "dont-trigger-request" },
  });
  const prefixTail = [
    event(19, "events.iterate.com/agents/context-added", {
      role: "user",
      content: "Review this change.",
      actor: { type: "user", origin: "web" },
      llmRequestPolicy: { behaviour: "after-current-request" },
    }),
    event(20, "events.iterate.com/agent/llm-request-requested", {
      model: "test-model",
      expiresAt: Date.parse("2030-01-01T00:00:00Z"),
    }),
  ];
  const prefix = [system, ...prefixTail];
  const requestOffset = 20;
  let pageCalls = 0;
  const request = new AgentLlmRequest(
    lazyHost(async () => {
      pageCalls += 1;
      if (pageCalls === 1) return [system];

      // Each page is fresh and individually under the production 8MiB cap. The
      // whole lazy history exceeds a 128MiB DO, modelling raw script settlements
      // that do not belong in the reduced prompt state.
      const resultIndex = pageCalls - 2;
      if (resultIndex < 17) {
        const sentinel = `GIANT_RAW_RESULT_${resultIndex}_`;
        const page = [
          event(resultIndex + 2, "events.iterate.com/capability-host/script-run-settled", {
            executionId: `settlement-${resultIndex}`,
            settlement: {
              status: "succeeded",
              result: sentinel + "x".repeat(7_900_000 - sentinel.length),
            },
          }),
        ];
        // Force the rope into the serialized shape a durable read hands to the
        // processor, rather than letting V8 defer allocating the repeated text.
        expect(JSON.stringify(page).length).toBeGreaterThan(7_900_000);
        return page;
      }
      if (resultIndex === 17) {
        // The requested offset pins a strict prefix even when its final storage
        // page has later input behind it.
        return [
          ...prefixTail,
          event(21, "events.iterate.com/agents/context-added", {
            role: "user",
            content: "This later input must not leak into @20.",
            actor: { type: "user", origin: "web" },
            llmRequestPolicy: { behaviour: "after-current-request" },
          }),
        ];
      }
      throw new Error("reader fetched after the page ending at the request");
    }),
  );

  const state = await request.readPromptStateThrough(requestOffset);

  expect(buildAgentLlmRequestBodyFromState(state)).toEqual(
    buildAgentLlmRequestBody({ events: prefix, llmRequestOffset: requestOffset }),
  );
  expect(JSON.stringify(buildAgentLlmRequestBodyFromState(state))).not.toContain("must not leak");
  expect(JSON.stringify(state)).not.toContain("GIANT_RAW_RESULT_");
  expect(pageCalls).toBe(19);
});

function lazyHost(next: () => Promise<StreamEvent[]>): AgentHost {
  return {
    path: "/agents/test",
    deps: {},
    idempotencyKey: (suffix) => `agent/${suffix}`,
    readEvents: () => ({ next, [Symbol.dispose]: () => {} }),
    append: async () => undefined,
    now: () => 0,
    sleep: async () => {},
  };
}

function event(offset: number, type: string, payload: unknown): StreamEvent {
  return {
    type,
    payload: payload as Record<string, unknown>,
    offset,
    createdAt: new Date(1_700_000_000_000 + offset * 1000).toISOString(),
    path: "/agents/test",
  };
}
