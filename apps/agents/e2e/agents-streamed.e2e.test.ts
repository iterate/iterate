// e2e/agents-streamed.e2e.test.ts — the streamed answer, in a file of its own: it waits out whole chunk
// windows (one of the suite's longest rows) and runs beside the other agent stories.
import { expect, test } from "vitest";
import { collector, freshCtx, until } from "../../os/e2e/support/client.ts";
import { FakeAi, sseResponse } from "../../os/e2e/support/fake-ai.ts";
import { openAgentItx } from "./support.ts";
import { configureModel, settledLog } from "./fixtures.ts";

test("streamed: the answer reaches a live subscriber as ephemeral chunk windows before it settles — never a stored row", async () => {
  const itx = await openAgentItx(freshCtx("agent-chunks"));
  const support = itx.cd("/agents/support");
  const ai = new FakeAi(["Four words, no code."]);
  await support.provide("itx.ai", ai);
  const windows = collector();
  await support.subscribe({
    name: "chunks",
    consumes: ["events.iterate.com/agent/llm-response-frame"],
    target: windows.fn,
  });
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await configureModel(support);
  await agent.message("Say four words.");
  const log = await settledLog(support, "the settled request");
  const requested = log.find((e) => e.type === "events.iterate.com/agent/llm-request-requested");
  await until("the chunk window", () => windows.invocations.length >= 1);
  // The fake answers whole, so its answer is ONE window: the request it belongs to, the text it
  // adds, the first sequence number.
  expect(windows.types()).toEqual(["events.iterate.com/agent/llm-response-frame"]);
  // Exact: an extra key on the window must fail.
  const { payload: chunkWindow } = windows.invocations[0]!.events[0]!;
  expect(chunkWindow).toEqual({
    llmRequestOffset: requested.offset,
    responseDelta: "Four words, no code.",
    thinkingDelta: "",
    sequence: 0,
  });
  // Ephemeral: the durable log holds no chunk row, and the settlement carries the text.
  expect(log.filter((e) => e.type === "events.iterate.com/agent/llm-response-frame")).toEqual([]);
  expect(
    log.find((e) => e.type === "events.iterate.com/agent/llm-request-settled")!.payload,
  ).toMatchObject({ result: { status: "succeeded", text: "Four words, no code." } });
});

test("streamed: a partner model's thinking and text reach a live subscriber as the deltas the processor read, every window in order", async () => {
  const itx = await openAgentItx(freshCtx("agent-deltas"));
  const support = itx.cd("/agents/support");
  const ai = new FakeAi([
    () =>
      sseResponse([
        { type: "response.reasoning_summary_text.delta", delta: "Counting " },
        { type: "response.reasoning_summary_text.delta", delta: "the words." },
        { type: "response.output_text.delta", delta: "Four words, " },
        { type: "response.output_text.delta", delta: "no code." },
        { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 4 } } },
      ]),
  ]);
  await support.provide("itx.ai", ai);
  const windows = collector();
  await support.subscribe({
    name: "deltas",
    consumes: ["events.iterate.com/agent/llm-response-frame"],
    target: windows.fn,
  });
  await itx.agents.create("/agents/support");
  await configureModel(support, "gpt-5.6-terra");
  await itx.agents.get("/agents/support").message("Say four words.");
  const log = await settledLog(support, "the settled request");
  const requested = log.find((e) => e.type === "events.iterate.com/agent/llm-request-requested");
  const frames = () => windows.invocations.flatMap((i) => i.events).map((e) => e.payload);
  const joined = (key: "responseDelta" | "thinkingDelta") =>
    frames()
      .map((frame) => frame[key])
      .join("");
  // However the windows fell, together they carry the text and the thinking once each.
  await until("every window", () => joined("responseDelta") === "Four words, no code.");
  expect(joined("thinkingDelta")).toBe("Counting the words.");
  // Each window names its request and its place, and adds something: the completion event adds
  // nothing, so it opens no window.
  for (const [sequence, frame] of frames().entries()) {
    expect(frame).toEqual({
      llmRequestOffset: requested.offset,
      responseDelta: expect.any(String),
      thinkingDelta: expect.any(String),
      sequence,
    });
    expect(frame.responseDelta + frame.thinkingDelta).not.toBe("");
  }
  expect(
    log.find((e) => e.type === "events.iterate.com/agent/llm-request-settled")!.payload,
  ).toMatchObject({ result: { status: "succeeded", text: "Four words, no code." } });
});
