import { expect, test } from "vitest";
import { makeProcessorHarness } from "iterate/processors/testing";
import ProjectWorker from "../../../../../configs/jev-docs/worker.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import type { AgentProcessorContract } from "./agent-processor-contract.ts";

test("the template includes first-message docs and restores the ordinary 250ms debounce", async () => {
  const { h, worker, calls, selections } = fixture(async () => decisions());
  const [created] = await h.stream.append(
    { type: "events.iterate.com/agent/created", payload: {} },
    {
      type: "events.iterate.com/agent/configured",
      payload: { config: { llmRequestDebounceMs: 60_000 } },
    },
  );
  await worker.processEventBatch({ events: [created] } as any);
  await h.settle();
  expect(h.state().config).toMatchObject({ llmRequestDebounceMs: 1_000 });
  const [message] = await h.stream.append({
    type: "events.iterate.com/agents/context-added",
    payload: { role: "user", content: "How do I upload a file?" },
  });
  await h.settle();
  await worker.processEventBatch({ events: [message] } as any);
  await h.play(["advanceTime", 250]);
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls[0].messages)).toContain("Use itx.files.get(path).put({ data })");
  expect(h.state().config).toMatchObject({ llmRequestDebounceMs: 250 });
  expect(selections).toHaveLength(1);

  // A replay must not select again or restore the old one-second birth value.
  await worker.processEventBatch({ events: [created, message] } as any);
  const [second] = await h.stream.append({
    type: "events.iterate.com/agents/context-added",
    payload: { role: "user", content: "Now schedule a reminder" },
  });
  await worker.processEventBatch({ events: [second] } as any);
  await h.play(["advanceTime", 249]);
  expect(calls).toHaveLength(1);
  await h.play(["advanceTime", 1]);
  expect(calls).toHaveLength(2);
  expect(selections).toHaveLength(1);
  expect(h.events("events.iterate.com/jev-docs/settled")).toMatchObject([
    { payload: { status: "selected", selected: ["Files"] } },
  ]);
  // The old one-second timer is harmless after the shortened request won.
  await h.play(["advanceTime", 1_000]);
  expect(calls).toHaveLength(2);
});

test("a hanging Jev call cannot hold the first answer past one second or inject a late result", async () => {
  const selection = Promise.withResolvers<any>();
  const { h, worker, calls, selections } = fixture(() => selection.promise);
  const message = await firstMessage(h, worker);
  const processing = worker.processEventBatch({ events: [message] } as any);
  await expect.poll(() => selections.length).toBe(1);
  await h.play(["advanceTime", 999]);
  expect(calls).toHaveLength(0);
  await h.play(["advanceTime", 1]);
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls[0].messages)).not.toContain("itx.files.get");
  // The worker's real deadline is independent of the processor's virtual clock.
  await processing;
  await h.settle();
  expect(h.state().config).toMatchObject({ llmRequestDebounceMs: 250 });
  expect(h.events("events.iterate.com/jev-docs/settled")).toMatchObject([
    { payload: { status: "timed-out" } },
  ]);
  selection.resolve(decisions());
  await h.settle();
  expect(await h.stream.getEvent({ idempotencyKey: "jev-docs/context:v1" })).toBeUndefined();
  expect(calls).toHaveLength(1);
});

test.each(["failure", "malformed", "no-matches"])(
  "%s restores 250ms without retrying Jev",
  async (mode) => {
    const { h, worker, calls, selections } = fixture(async () => {
      if (mode === "failure") throw new Error("Jev unavailable");
      if (mode === "malformed") return { not: "decisions" };
      return { ...decisions(), answers: { d0: { type: "score", score: 0, confidence: 1 } } };
    });
    const message = await firstMessage(h, worker);
    await worker.processEventBatch({ events: [message] } as any);
    await h.play(["advanceTime", 250]);
    expect(calls).toHaveLength(1);
    expect(h.state().config).toMatchObject({ llmRequestDebounceMs: 250 });
    expect(h.events("events.iterate.com/jev-docs/settled")).toMatchObject([
      { payload: { status: mode === "no-matches" ? "no-matches" : "failed" } },
    ]);
    await worker.processEventBatch({ events: [message] } as any);
    expect(selections).toHaveLength(1);
  },
);

test("late event delivery spends no further time on Jev and restores 250ms", async () => {
  const { h, worker, calls, selections } = fixture(async () => decisions());
  h.clock.now = Date.now() - 1_100;
  const message = await firstMessage(h, worker);
  await h.play(["advanceTime", 1_000]);
  expect(calls).toHaveLength(1);
  await worker.processEventBatch({ events: [message] } as any);
  await h.settle();
  expect(selections).toHaveLength(0);
  expect(h.state().config).toMatchObject({ llmRequestDebounceMs: 250 });
  expect(h.events("events.iterate.com/jev-docs/settled")).toMatchObject([
    { payload: { status: "timed-out" } },
  ]);
});

test("installing the template leaves an existing agent's later messages alone", async () => {
  const { h, worker, calls, selections } = fixture(async () => decisions());
  await h.play(["append", { type: "events.iterate.com/agent/created", payload: {} }]);
  const [message] = await h.stream.append({
    type: "events.iterate.com/agents/context-added",
    payload: { role: "user", content: "An existing conversation" },
  });
  await worker.processEventBatch({ events: [message] } as any);
  await h.play(["advanceTime", 250]);
  expect(calls).toHaveLength(1);
  expect(selections).toHaveLength(0);
});

function fixture(run: () => Promise<any>) {
  const calls: any[] = [];
  const selections: any[] = [];
  const h = makeProcessorHarness<AgentProcessorContract>({
    path: "/agents/jev",
    createProcessor: (deps) =>
      new AgentProcessor({
        ...deps,
        callLlm: async (input) => {
          calls.push(input);
          return { text: "Done" };
        },
      }),
  });
  h.clock.now = Date.now();
  const project = {
    agents: { get: () => ({ stream: h.stream, append: h.stream.append.bind(h.stream) }) },
    scope: () => ({
      docs: {
        search: async () => [{ name: "Files", kind: "type", summary: "Upload files" }],
        get: async () => "Use itx.files.get(path).put({ data })",
      },
    }),
    ai: {
      run: async (...args: any[]) => {
        selections.push(args);
        return run();
      },
    },
  };
  const worker = new ProjectWorker({} as any, { ITX: { get: () => project } } as any);
  return { h, worker, calls, selections };
}

async function firstMessage(h: ReturnType<typeof fixture>["h"], worker: ProjectWorker) {
  const [created] = await h.stream.append(
    { type: "events.iterate.com/agent/created", payload: {} },
    {
      type: "events.iterate.com/agent/configured",
      payload: { config: { llmRequestDebounceMs: 60_000 } },
    },
  );
  await worker.processEventBatch({ events: [created] } as any);
  const [message] = await h.stream.append({
    type: "events.iterate.com/agents/context-added",
    payload: { role: "user", content: "How do I upload a file?" },
  });
  await h.settle();
  return message;
}

function decisions() {
  return {
    model: "jev-1.13.0",
    answers: { d0: { type: "score", score: 2, confidence: 1 } },
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}
